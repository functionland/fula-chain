# Bridge verification record

What was actually tested and verified for the FULA lock/release escrow bridge, how to reproduce it,
and what was found. Companion to `docs/bridge-audit-escrow.md` (the findings) and
`scripts/bridge/testnet-deployments.md` (the live testnet state).

Contains no keys, no secrets and no private endpoints. Every address here is public on-chain data.

---

## 1. Mainnet safety

**No mainnet transaction was ever sent, and no mainnet contract was deployed, upgraded or modified
at any point during this work.** Every mainnet interaction was a read: `eth_call`, `eth_getLogs`,
`eth_getStorageAt`, `eth_getBalance`.

Two structural safeguards back this up:

- `hardhat.config.ts` defines an **`ethereum-alt`** network with `accounts: []`. With no signer
  configured, a state-changing transaction cannot be constructed even by mistake.
- Testnet networks are wired to `PK_TEST` / `ADMIN_PK_TEST` **only**. The mainnet-capable `PK` and
  `ADMIN_PK` variables are never referenced by any bridge script.

Fork tests, where used, ran against a local in-memory fork. A fork mutates only local state; the
live chain is untouched by construction. This was additionally confirmed after the fact by re-reading
each proxy's ERC-1967 implementation slot on the live chains and observing it unchanged.

## 2. Automated tests

| Suite | Result |
|---|---|
| `test/governance/integration/FulaOFTBridge.test.ts` | **45 passing** |
| + `StorageToken.test.ts` + `TokenBridgeContract.test.ts` | **120 passing, 0 failing** |
| Full repository suite | 703 passing / 47 failing (see below) |

```bash
npx hardhat test test/governance/integration/FulaOFTBridge.test.ts \
                 test/governance/integration/StorageToken.test.ts \
                 test/governance/integration/TokenBridgeContract.test.ts
```

### The 47 full-suite failures are pre-existing and unrelated

They fall entirely in `GovernanceModule`, `AirdropCalculation`, `CommunityVoting`, `RewardEngine`,
`RewardsProgram`, `StakingEngine`, the vesting-cap suites and `StoragePool`. **None** is in a bridge
or token suite. The count moved 43 → 46 → 47 during this work as unrelated concurrent development
landed on the branch; treat *the identity of the failing suites*, not the number, as the baseline.

### What the load-bearing tests actually prove

Grouped by the property each pins down, because a test suite's value is in what it would catch.

**Supply conservation.** `NEVER changes totalSupply on either chain — supply is conserved
structurally` — asserts `totalSupply()` on both simulated chains is byte-identical before the send,
*while the message is in flight*, and after delivery. Lock/release cannot change supply, and this
proves the property rather than assuming it.

**Escrow exactness.** `MockFeeOnTransferToken` splits every transfer, so the adapter receives less
than it was told. `reverts the outbound lock when the token delivers less than requested` proves the
balance-delta assertion converts a silent escrow leak into an immediate revert. This is the guard
against `platformFeeBps` ever being raised.

**Non-destructive failure.** `parks and retries an inbound transfer blocked by a blacklist` and
`parks and retries when the destination token is paused` prove that a failed `lzReceive` leaves the
payload intact and the same message delivers unchanged once the block clears. Delay, never loss.

**Privilege isolation.** `THE TOKEN GRANTS THE ADAPTER NO SPECIAL POWER AT ALL` asserts the adapter
holds no role and no minter entry — it is an ordinary holder.

**Owner drain (finding E-01).** `E-01: the OWNER can drain the whole escrow by rotating setPeer,
locking nothing` is a **deliberately passing attack test**. It rotates the peer to an unrelated
address, has that address emit a genuine source-chain packet through the permissionless endpoint,
and asserts (a) source escrow is unchanged — the attacker locked nothing, (b) the attacker receives
the entire destination balance, (c) `availableLiquidity()` ends at zero. It exists so the risk can
never be quietly forgotten, and so the mitigations below have something concrete to defeat.

**The two mitigations.** `MITIGATES E-01: a malicious peer rotation can now take only the cap, not
everything` bounds the same attack to one bucket. `ELIMINATES E-01: after locking, the owner cannot
redirect the lane at all` closes it, while asserting legitimate traffic still flows.

**Delegate rotation (finding E-03).** Three tests cover the lifecycle: the constructor seeds the
delegate, nomination does *not* move it, acceptance does. The third was verified to **fail when the
fix is disabled**, with the intended assertion message — so it is not passing for an unrelated
reason.

**Inbound bound (finding E-02).** Five tests: fail-closed when unconfigured, the bound holds with
escrow untouched, park-then-retry after the window refills, the inbound bucket is independent of the
outbound one, and the E-01 mitigation above.

**Multi-user contention (E-14).** The outbound bucket is one slot shared by every user of a lane,
not a per-sender allowance. Two tests: two different holders both succeed when the allowance covers
both, and one holder exhausting the lane denies a second holder who has never used the bridge —
asserting the loser keeps **every token** and only pays gas. That asymmetry is the whole reason the
throttle sits on the outbound side.

These use consecutive blocks rather than forcing a literal shared block. An earlier version disabled
`automine` to co-locate both sends; it hung, and because the hang preceded the restore it left
automine disabled and cascaded failures into unrelated suites. With a 24h window the bucket
regenerates roughly 0.014% per block, so consecutive blocks demonstrate the shared-bucket property
just as conclusively and without that hazard.

**Liquidity exhaustion and recovery (E-08).** Drains a destination to zero, confirms the next
transfer locks on the source and parks with `InsufficientLiquidity`, tops up by a plain ERC-20
transfer exactly as an operator would rebalance, and confirms **the same parked message** then
delivers — no resend. This is the recovery path the liquidity runbook describes.

**Supply and escrow conservation under arbitrary sequences.** A deterministic pseudo-random sweep
(fixed seed, so failures reproduce) runs 24 rounds of randomly chosen direction, sender and amount,
delivering only some messages so others stay in flight across iterations. It asserts combined
`totalSupply` is unchanged after **every** step, and that total escrow never falls below the seeded
amount. Refusals — rate limits, insufficient liquidity — are deliberately swept in too, because a
refusal must conserve just as strictly as a success.

## 3. Live-chain verification (read-only)

Performed against Ethereum and Base mainnet. Reproduce with the scripts in `scripts/bridge/`.

| Property | Ethereum | Base |
|---|---|---|
| `totalSupply` | 1,470,000,000 | 386,311,783 |
| Held by the token contract | 1,308,990,141 | **4,239** |
| Circulating | 161,009,859 | 386,307,544 |
| `paused` | false | false |
| `ADMIN_ROLE` quorum | 2 | 2 |
| `ADMIN_ROLE` transaction limit | 500,000,000 | 50,000,000 |
| `BRIDGE_OPERATOR_ROLE` transaction limit | 100,000,000 | 500,000,000 |

Global supply across all four deployed chains is **1,886,311,783** of the 2,000,000,000 cap
(Ethereum 1.47B, Base 386.3M, SKALE 15M, IoTeX 15M), leaving 113,688,217 of headroom.

### `BRIDGE_OPERATOR_ROLE` is live and has been used

`hasRole(BRIDGE_OPERATOR_ROLE, 0xc048089D2e1681e5B54dB985749D68970F8c199D)` returns **true on both
Ethereum and Base**. The role was granted on Ethereum at block 22024875 and **never revoked** — there
are zero `RoleRevoked` events for it.

It has been exercised. Six `bridgeOp` burns are recorded on Ethereum:

| Block | Amount | Target chainId |
|---|---|---|
| 22024894 | 1 wei | 8453 (Base) — a dry run |
| 22025225 | 500,000,000 | 8453 (Base) |
| 22025828 | 5,000,000 | 4689 (IoTeX) |
| 22027349 | 5,000,000 | 2046399126 (SKALE) |
| 22033533 | 10,000,000 | 4689 (IoTeX) |
| 22033541 | 10,000,000 | 2046399126 (SKALE) |

So the burn-here / mint-there path is **already provisioned and proven in production** — it needs no
new role grant, only a fresh single-use nonce per operation.

⚠️ **Unverified, and worth reconciling before relying on these numbers:** 500,000,000 was burned on
Ethereum for Base, yet Base's `totalSupply` is 386,311,783. Base's own `bridgeOp` history could not
be retrieved with the free tooling available (public Base RPCs reject wide `getLogs`; Etherscan's V2
multichain API requires a paid plan for Base; Alchemy's free tier caps `getLogs` at a 10-block
range). The discrepancy points in the safe direction — global supply is *below* what a naive
burn/mint pairing would imply, not above, so the 2B cap is not at risk — but the Base-side history
should be confirmed with an archive endpoint before anyone treats these figures as a reconciliation.

**Method note.** `getRoleMemberCount` **reverts** on this contract — the enumerable AccessControl
extension is not exposed. Use `hasRole` against a specific address. An early throwaway script wrapped
that call in a `try/catch` that defaulted to zero, and consequently reported "nobody holds the role",
which was false. This is the same defect that was found and fixed in `reconcileSupply.ts`: **never
let "could not read" collapse into "the answer is empty."** Any check whose failure mode is
indistinguishable from a legitimate negative result must report the failure explicitly.

**`platformFeeBps` is 0 on both chains.** Established two independent ways: no `PlatformFeeUpdated`
event has ever been emitted (scanned from each deployment block), and both Treasury balances are
zero. This matters because a non-zero fee would halt the bridge in both directions — see E-07.

**Implementation parity.** The Ethereum and Base deployments run identical logic. Raw runtime
bytecode differs by 38 bytes, which is entirely the `address private immutable __self` in
OpenZeppelin's `UUPSUpgradeable` — it stores each contract's own address. Recompiling the
Etherscan-verified source at solc `v0.8.24+commit.e11b9ed9`, `runs=300`, viaIR, shanghai reproduces
the deployed bytecode exactly. Compare masked hashes, never raw ones.

## 4. Testnet rehearsal

Sepolia ↔ Base Sepolia. Addresses and current state live in
`scripts/bridge/testnet-deployments.md`; that file is the source of truth and is not duplicated here.

Completed: adapters deployed and wired both directions; send/receive libraries, ULN and executor
config set; enforced options set; both rate limiters configured; cross-chain ULN digest confirmed
matching on all four sides. `verifyOAppConfig.ts` reports **5 expected failures per chain** — EOA
owner and 1-of-1 DVN ×2 (all testnet-only limitations), peers not yet locked (intentional, it is
irreversible), and zero escrow liquidity (the remaining step).

**Completed 2026-07-30 — the bridge works end to end on a live network.** Both adapters seeded with
200,000,000 FULA; a 100 FULA transfer delivered Sepolia → Base Sepolia in ~75s and a 25 FULA return
leg in ~180s. `lzReceive` gas measured at **143,659** against a fresh recipient (the expensive case:
crediting a zero balance is a cold storage write); 1.5× is 215,488, so the configured 250,000 is
adequate and needs no change.

**Supply conservation observed live, not simulated.** After both legs, global supply delta is **0**
and total escrow delta is **0** — Sepolia holds 200,000,125, Base Sepolia 199,999,875, summing to
exactly the 400,000,000 seeded. Tokens moved between escrows; none were created or destroyed.

**Fail/retry drill passed**, using the inbound rate limiter as an immediate kill switch rather than a
blacklist (which would need a 24h governance proposal) — so the drill also exercised the new control
live. With the inbound limit set to 0, a 50 FULA transfer locked on the source and did **not** deliver
for three minutes, leaving destination escrow and recipient balance untouched. Restoring the limit
caused the **same parked message to deliver automatically within ~15s**: the executor retried by
itself, with no manual step and no resend.

### Operational bugs the rehearsal caught

Recorded because they are the return on doing a rehearsal at all — every one would have surfaced on
mainnet instead.

1. `setConfig` ABI used unnamed tuple components and could not encode.
2. `setSendLibrary` was skipped as "already set" because `getSendLibrary` silently falls back to
   LayerZero's mutable default — the adapter would have ridden a default the project does not
   control. Now detected with `isDefaultSendLibrary`.
3. Public RPCs serve stale state for seconds after a deploy: a contract that exists reads back as
   `0x`. Deployment now polls for code.
4. Nonce races from re-querying transaction count per transaction; the nonce is now fetched once and
   advanced locally.
5. `reconcileSupply.ts` treated an unreadable or corrupt state file identically to a genuine first
   run, silently suppressing the alarm it exists to raise. Found by testing the failure path rather
   than the happy path.
6. `deployOFTAdapter.ts` passed four constructor arguments to a three-argument constructor — a
   leftover from the abandoned mint/burn design. Every explorer verification would have failed.
7. **`reconcileSupply.ts` — the designated canary — was watching a two-generation-stale adapter.**
   It still defaulted to the first mint/burn address after the escrow redesign, so it reported a
   permanent false "escrow is EMPTY" alarm while being completely blind to the real escrow. Watching
   the wrong address is worse than watching none: it manufactures noise *and* guarantees silence on
   the event it exists to catch. Caught only because seeding produced an alarm that contradicted a
   balance we had just confirmed.
8. `seedLiquidity.ts` verified the escrow delta with a single read immediately after the transfer.
   Public RPCs serve stale state for seconds, so a completed seeding reported as a failure claiming
   a transfer fee was active. Now polls. Same root cause as bug 3, in a different script.
9. `seedLiquidity.ts` required the *token contract* to hold the full amount even when the funder
   already held it, which made the script un-resumable: after hop 1 succeeded and hop 2 failed on
   gas, the retry aborted on a precondition that no longer applied. Now checks only the shortfall.

## 5. Contract behaviour established by reading the token

These are properties of the **unmodified, Hashlock-audited** `StorageToken` that determine escrow
behaviour. Verified by reading the source, and each has a consequence documented in the audit.

- `_update` (the universal transfer hook) checks the blacklist on **both** `from` and `to`, and
  applies `platformFeeBps` to the Treasury when non-zero.
- `transfer` **is** overridden: `whenNotPaused`, `nonReentrant`, rejects `amount <= 0` and
  `to == address(0)`.
- `transferFrom` is **not** overridden — no pause check, no reentrancy guard, no zero-amount check.
  This asymmetry is why pausing the token stops inbound releases but not outbound locks (E-06).
- `transferFromContract` requires `ADMIN_ROLE`, a **whitelisted** recipient (with a 24h lock), and
  `amount <= roleConfigs[ADMIN_ROLE].transactionLimit`.
- A plain ERC-20 `transfer` requires **no** whitelist — only the blacklist applies. Funding an
  adapter from circulating supply therefore needs no whitelist; funding it from the token contract
  does.
- `bridgeOp` mints with `_mint(address(this))` and burns with `_burn(address(this))` — both act on
  the **token contract's own balance**, not a wallet. It requires `BRIDGE_OPERATOR_ROLE` plus a
  single-use nonce pre-registered by `setBridgeOpNonce` (`ADMIN_ROLE`), which is a genuine two-key
  control: the operator cannot mint without an admin arming each operation.

## 6. Review panel

Five independent reviewers were run against the real repository or a byte-identical staged copy:
Google Antigravity, OpenAI GPT-5.5 (Codex), Moonshot Kimi K3 (web-enabled), Moonshot Kimi K2.7, and
the built-in reviewer. **Zhipu GLM-5.2 was commissioned but returned a quota-exhaustion error and
produced no review — its perspective is absent.**

Reviewers disagreed materially in three places; all three were settled by direct evidence rather than
by majority, and the reasoning is recorded in the audit's *Retracted and refuted* section. The
short version: a claim that the delegate finding was invalid came from a reviewer that had read the
already-fixed code; a proposed `address(endpoint) != address(0)` guard was recommended by one
reviewer and dismissed as unnecessary by another, when in fact it does not compile at all (`endpoint`
is `immutable`, and Solidity forbids reading an immutable during construction) — settled by compiling
it; and a suggestion to silently absorb a self-addressed credit was rejected because it would convert
a recoverable stuck message into a permanent silent loss.

## 7. Reproducing the live checks

All read-only. None requires a private key.

```bash
# Configuration + privilege + liquidity + rate limits, per chain
ADAPTER=0x… REMOTE=base npx hardhat run scripts/bridge/verifyOAppConfig.ts --network ethereum

# Cross-chain supply reconciliation (alarms on ANY supply movement, since a
# lock/release bridge cannot change supply)
npx hardhat run scripts/bridge/reconcileSupply.ts

# Governance proposal status, approvals and execution window
npx hardhat run scripts/bridge/approveProposal.ts --network sepolia
```

`verifyOAppConfig.ts` emits an **operator-name-based** ULN digest for cross-chain comparison. Do not
compare the address-based digest across chains — DVN operators have different contract addresses on
each chain, so that value can never match and a mismatch there means nothing.
