# Security audit — FULA lock/release escrow bridge

**Scope.** Code that is NEW on this branch under the **escrow** design. Principally
`contracts/bridge/FulaOFTAdapter.sol`, plus the bridge scripts under `scripts/bridge/` and the
test-only `contracts/test/MockFeeOnTransferToken.sol`.

**Out of scope.** `contracts/core/StorageToken.sol` and the governance modules. The token is
**byte-for-byte identical to the Etherscan-verified source live on Ethereum and Base** and was
audited by Hashlock. It is unchanged by this branch. Where the token's behaviour determines an
escrow outcome it is analysed, but the token itself is not re-audited.

**Supersedes** `docs/bridge-audit.md`, which audited the abandoned mint/burn design.

**Reviewers.** Five independent models were run against the real repository or a byte-identical
staged copy: Google Antigravity, OpenAI GPT-5.5 (Codex), Moonshot Kimi K3 (web-enabled), Moonshot
Kimi K2.7, and the built-in reviewer. Zhipu GLM-5.2 was also commissioned but returned a
quota-exhaustion error and produced no review; its perspective is **absent** from this report.

**Severity key.** *Critical* = depletion of user or contract funds, or front-running.
*High* = fund loss requiring a privileged actor or an external compromise. *Medium* = availability
loss, or a trust assumption that must be stated and controlled. *Low* = bounded or self-inflicted.

---

## Verdict

**No permissionless Critical path was found.** Four reviewers independently probed for donation
manipulation of the balance-delta assertions, reentrancy, `_outflow`/`_inflow` ordering, `uint192`
narrowing, and MEV. None found a path by which an unprivileged actor takes funds.

The escrow redesign eliminated the entire class of risk that dominated the previous audit: there is
no token upgrade, no mint authority, no `burn(anyone)` primitive, and no way for this bridge to
change global supply.

**Two High findings remain open and both are decisions, not defects.** They are the same risk seen
from two sides: *what bounds a single inbound release, and who can authorise one.*

---

## High

### E-01 · Security · The owner can drain the entire escrow via `setPeer` — **OPEN**

`setPeer` is inherited from `OAppCore`, owner-controlled, and mutable. A malicious or compromised
owner can point a lane at an attacker-controlled address; that address then sends a well-formed OFT
message which passes `OAppReceiver` authentication — because it now *is* the trusted peer — naming
the attacker as recipient for up to the full escrow balance.

**No DVN compromise and no forged packet are required, and this is verified, not inferred.**
`EndpointV2.send` is permissionless and stamps the packet with `msg.sender`, so the attacker emits a
*genuine* source-chain packet from their own address. Honest DVNs attest to it precisely because it
really happened. The attacker locks nothing on the source chain — they never touch the adapter.

Pinned by the regression test *"E-01: the OWNER can drain the whole escrow by rotating setPeer,
locking nothing"*, which asserts source-side escrow is unchanged, the recipient receives the full
destination balance, and `availableLiquidity()` ends at zero.

**This disproves the claim that removing the withdraw function removes the owner's rug vector.** It
makes the path indirect, not absent. What escrow genuinely buys is a *bound*: the owner reaches only
what is escrowed, and holders who never bridged are untouched — versus mint/burn, where a
compromised adapter could dilute every holder on every chain. That is still a large improvement, but
it must be stated honestly.

*Status:* **MITIGATED — `lockPeers()` added**, a one-way irreversible latch: once called, `setPeer`
reverts forever with `PeersAreLocked`. Peers legitimately never change for a fixed two-chain bridge.

⚠️ **Mitigated, not eliminated — corrected after a second review.** Locking peers does not make a
compromised owner harmless. The owner is also the LayerZero delegate, so it can still `setDelegate`
to itself, repoint the receive library and DVN set, and have a malicious verifier attest to a
**forged** packet whose sender matches the now-frozen peer. That passes the peer check and drains the
escrow exactly as before. What locking removes is the *cheap* route: one transaction, no collusion,
no malicious DVN. The residual requires controlling the verification stack.

**This is why the inbound rate limit (E-02) is the more load-bearing of the two controls** — it
bounds the residual regardless of how a message came to be authorised. An earlier version of this
report and the corresponding test claimed locking "eliminates" E-01; that was too strong and has been
corrected here, in the contract NatSpec, and in the test name.

Note that "the owner should be a TimelockController" was **never implemented and is not enforced**.
The adapter does not override `setPeer` beyond the latch, there is no `TimelockController` anywhere
in the repo, and `deployOFTAdapter.ts` only *warns* on an EOA owner rather than refusing. The latch
is therefore the actual control, not the timelock.

**`lockPeers()` must be called explicitly** — deploying does not lock anything. Wire both lanes,
prove a real transfer end to end, then lock. `verifyOAppConfig.ts` now fails until it is called.
*The cost:* afterwards, neither adapter can be replaced without redeploying both and migrating
liquidity.

Two tests pin it: `lockPeers` is owner-only and permanently blocks `setPeer`, and after locking the
E-01 drain is unreachable while legitimate traffic still flows.

### E-02 · Security · No inbound rate limit — one message can release the whole escrow — **OPEN**

`RateLimiter` is applied to `_debit` (outbound) only. `_inflow` merely nets against the outbound
bucket; it does not constrain inbound volume. `_credit` therefore releases whatever a *verified*
message requests, bounded only by the escrow balance.

Every other defence in this contract — the balance-delta assertions, the zero-recipient and dust
checks — assumes the message is honest. They are checks on *arithmetic*, not on *authenticity*.

This is not theoretical. In the **KelpDAO rsETH exploit (April 2026, ~$292M)** attackers compromised
the infrastructure behind a **1-of-1 DVN**, injected a synthetic packet claiming a lock that never
happened, and a LayerZero `OFTAdapter` released the escrow. No contract was buggy; every contract
behaved as designed. That architecture is the one deployed here.

Note this reverses a decision made under the previous design. Outbound-only throttling was correct
for mint/burn, where an inbound limit would park user funds for no security gain. Under escrow,
inbound *is* the theft surface. LayerZero's own stablecoin guidance now recommends separate
directional limits.

*Status:* **FIXED — a separate inbound bucket was added**, configured at **20,000,000 / 24h**.

It is deliberately **not** the inherited `rateLimits` mapping. That one is *netted* (`_inflow`
subtracts inbound volume from the outbound bucket), which is fine for throttling flow but useless as
a theft bound, because an attacker draining escrow never sends anything back to offset. The new
bucket is **gross**: every release consumes it and only time refills it. The decay maths is reused
from the audited `RateLimiter._amountCanBeSent` rather than re-derived.

**Sizing rule:** the bucket starts full, so `limit` *is* the instant first-tranche loss. Size it
against the **escrow balance** on that chain, targeting 10–25%. Configured at a flat **20M / 24h
against a 200M seed** on both testnet and mainnet (owner decision, 2026-07-29).

⚠️ **A limit at or above escrow is INERT, not merely weak.** `_credit` checks liquidity before the
inbound limit, so anything larger than escrow reverts `InsufficientLiquidity` first and anything
smaller is under the limit by definition — the limiter can never fire. `verifyOAppConfig.ts` fails
on that condition. Seeding materially below the configured limit silently disables the control.

It is fail-closed like the outbound limiter, and refusal is non-destructive: an over-limit message
parks and delivers unchanged once the bucket refills. Five tests cover fail-closed behaviour, the
bound, park-then-retry, bucket independence from outbound, and that E-01 now yields only the cap
instead of the whole escrow.

### E-03 · Security · LayerZero delegate not rotated on ownership transfer — **FIXED**

`Ownable2Step.transferOwnership` does not touch the LayerZero delegate; `OAppCore.setDelegate` is a
separate entry point. An ownership handover therefore left the **old** owner as delegate, retaining
the ability to reconfigure the security stack and to `endpoint.burn`/`nilify` in-flight messages —
permanently stranding funds already locked on the source chain.

*Fix:* `_transferOwnership` now also calls `endpoint.setDelegate(newOwner)`. The guard is
`address(this).code.length > 0`, **not** `address(endpoint) != address(0)` — `endpoint` is
`immutable` and Solidity forbids reading an immutable during construction, which was confirmed by
compiling the alternative and observing it fail. Three tests pin the lifecycle, and the key one was
verified to fail when the fix is disabled.

---

## Medium

### E-04 · Security · Token governance can freeze or brick the bridge

`StorageToken._update` checks the blacklist on both `from` and `to`. Nothing prevents governance
from blacklisting **the adapter itself**, which reverts both directions and freezes the entire
escrow on that chain for as long as it stands. Combined with `pause()` and `platformFeeBps`,
bridge availability depends materially on token governance.

Reversible by un-blacklisting, and it requires the same 2-of-N admin quorum that already controls
the token. *Recommendation:* monitor `BlackListOp` events for the adapter addresses.

### E-05 · Security · The token is UUPS-upgradeable; the escrow inherits that trust — **DOC FIXED**

The adapter is immutable, but the token it escrows is not. An ADMIN_ROLE-approved token upgrade can
rewrite `_update`, add hooks, or reach the escrowed balance directly. The real ordering of risk for
escrowed funds is **token governance > LayerZero DVN configuration > this contract's code**.

The NatSpec previously claimed supply conservation was "trivial and unconditional"; that was an
overclaim, true of the bridge path but not of FULA generally (`bridgeOp` also still exists on the
token). *Fixed:* the NatSpec now scopes the claim explicitly.

### E-06 · Security · Pausing the token does not stop outbound bridging

`StorageToken.transfer` is overridden with `whenNotPaused`; `transferFrom` is **not** overridden and
carries no pause check. `_credit` uses `transfer`, `_debit` uses `transferFrom`. So during an
emergency pause, inbound releases correctly park (retryable, nothing lost) but **outbound locking
continues to work**.

No value is lost, and there is an argument this is a feature — pause is exactly the brake against a
forged-message drain, and it works on the release side where it matters. The risk is operational
surprise. *Recommendation:* the runbook must couple `pause()` with setting the outbound rate limit
to zero, which is the actual outbound kill switch.

### E-07 · Security · Enabling `platformFeeBps` halts the bridge in both directions

If governance raises the fee above zero, the adapter receives `amount - fee` on lock and the
recipient receives `amount - fee` on release. Both fail the balance-delta assertions and revert.
Fail-closed and fully reversible, but a complete outage.

Verified **0 on both Ethereum and Base** via `PlatformFeeUpdated` event scans from each deployment
block, corroborated by both Treasury balances being zero. *Recommendation:* operational rule —
never raise `platformFeeBps` while the bridge is live; monitor the event.

### E-08 · Security · Liquidity griefing / destination drain

Destination liquidity is unknowable at send time and nothing stops a user sending into an empty
escrow. One large transfer can drain the destination and park everyone else's inbound messages
until an operator rebalances.

Reviewers split on severity. Kimi K3 rated it Medium; Codex reduced it to Low on the grounds that
the sender locks equal value and receives equal value, so this is ordinary inventory movement rather
than cheap or profitable griefing — an attacker pays LayerZero fees each hop and gains nothing.
**Recorded as Medium**, because the *liveness* impact on third parties is real even when the
attacker profits nothing. Parked messages are retryable; no funds are lost.

---

## Low

| ID | Category | Finding | Status |
|---|---|---|---|
| E-09 | Security | Naming a bridge adapter as recipient produced a **permanently** undeliverable message: a self-transfer moves nothing, so the delta is zero and `EscrowInvariantViolated` reverts on every retry, leaving the sender's tokens locked forever. | **FIXED** — rejected at send time via `peers[dstEid]`, plus a defence-in-depth `_to == address(this)` check in `_credit`. |
| E-10 | Security | `_refundAddress == address(0)` silently burns excess `msg.value`, since the endpoint refunds with a bare `.call` that succeeds against the zero address. | **FIXED** — rejected in `send`. |
| E-11 | Code | `send` rejects outbound `composeMsg`, but inbound composed payloads are not rejected on receive. Only reachable from a non-conforming or compromised peer. | Open, accepted. |
| E-12 | Code | `deployOFTAdapter.ts` passed **four** constructor arguments to explorer verification for a **three**-argument constructor — a leftover from the mint/burn adapter. Every verification would have failed. Header comments also still described minter authorization. | **FIXED** |
| E-13 | Code | No rescue path for foreign ERC20s or ETH sent to the adapter by mistake. | Open, accepted — see below. |
| E-14 | Security | The outbound limiter is a single bucket shared by all users, so one large transfer can consume the window and make others revert until it refills. | Documented, accepted. |
| E-15 | Code | LayerZero dependencies float (`oft-evm ^4.0.1`, `oapp-evm ^0.4.1`, `lz-evm-protocol-v2 ^3.0.148`). No runtime risk — the base code compiles into immutable bytecode — but a build/verify mismatch risk. | Mitigated: both `package-lock.json` and `yarn.lock` are committed. |
| E-16 | Gas | `_outflow` runs after two balance reads and `safeTransferFrom`, so an over-limit caller pays for token work that is then reverted. Atomic and safe; a gas/ordering trade-off only. | Accepted — the ordering is deliberate, so the lock is confirmed exact before allowance is consumed. |

---

## On the absence of a rescue function

The design deliberately has no withdraw. Two reviewers pushed back on the framing rather than the
choice, and both were right:

- **Seed liquidity is not permanently locked.** It can always be moved out through the normal lane by
  bridging to a team address on the other chain. Only three categories are genuinely unrecoverable:
  stray non-FULA tokens, ETH dust, and escrow on a permanently abandoned lane.
- **"No withdraw" does not mean "no rug"** — see E-01. Since the owner already holds an indirect
  drain path, a timelocked rescue restricted to tokens *other than* `token()` would add no new trust
  assumption while recovering stray assets.

The precedent supports the choice: KelpDAO's rsETH adapter also had no rescue, and its post-exploit
recapitalisation was performed by transferring tokens *into* the adapter — the same donation channel
noted in E-13.

---

## Retracted and refuted

Recorded because a false finding is as costly as a missed one.

- **"Ownership transfer leaves a stale delegate" was reported as refuted** by one reviewer. It was
  not: that reviewer audited a snapshot taken *after* the fix landed, so it read the corrected code.
  The finding was real (E-03) and independently confirmed by two other reviewers.
- **Proposed guard `address(endpoint) != address(0)`** was recommended by one reviewer as correct and
  by another as unnecessary. Both were wrong — it does not compile. Settled empirically.
- **"OZ v5 `Ownable2Step` requires a constructor argument"** — incorrect; only `Ownable` does.
- **"Redirect a self-addressed credit to `0xdead`"** was recommended by one reviewer and rejected: it
  would consume the message while releasing nothing, converting a recoverable stuck payload into a
  silent, permanent loss. Rejecting at send time is strictly better.

---

## Decisions taken

Both High findings were closed by owner decision on 2026-07-28:

1. **E-02** — a separate gross inbound bucket at **20M/24h**. A *per-transfer* cap was considered
   and rejected: nothing prevents an attacker splitting into many messages in the same block, so a
   per-transfer limit bounds nothing cumulative and only adds gas and DVN fees. The bound has to be
   cumulative and windowed.
2. **E-01** — `lockPeers()`, to be called once both lanes are proven end to end.

Together these mean a forged or maliciously-authorised message takes at most 20M before the bucket
empties, and after the latch the owner has no peer-rotation path to the escrow at all.

## Pre-mainnet gates

- Owner is a TimelockController or multisig on both chains — **not** an EOA. Note this is checked by
  `verifyOAppConfig.ts` but **not enforced by the deploy script**, which only warns.
- **`lockPeers()` called on both adapters** once a real transfer has been observed end to end.
- Inbound rate limit set on both adapters and sized to ≤25% of that chain's escrow.
- **≥2 independent required DVNs** on every lane. A 1-of-1 configuration is the KelpDAO condition
  and must never ship.
- `verifyOAppConfig.ts` passes fully on both chains, including the cross-chain ULN digest match.
- `lzReceive` gas measured on testnet and enforced options set to 1.5× measured, replacing the
  current 250,000 placeholder.
- `reconcileSupply.ts` running on a schedule before liquidity is seeded at scale.
