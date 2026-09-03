# Security Audit — FULA LayerZero OFT Bridge

> # ⚠️ LARGELY SUPERSEDED — the audited design was replaced on 2026-07-28
>
> This audit examined a **mint/burn** bridge that modified `StorageToken`. That design was
> abandoned in favour of **lock/release escrow**, which changes the token not at all. Re-audit
> before mainnet; this header records only how each finding fared.
>
> **Findings that no longer exist**, because the code they described was deleted:
> F-1 (withdrawn anyway), F-2 (`int96` downcast), F-5 (`_updateActivityTimestamp` on mint/burn),
> F-6 (type-12 target validation), F-7 (`bridgeOp` as a second mint authority), F-8 (cap of zero),
> F-13 (cap bounds inflation not theft), F-14 (layout verified ETH/Base only — **there is no
> upgrade now, so no layout risk at all**).
>
> **Findings that were FIXED and carry into the escrow adapter:**
> F-3 → `Ownable2Step`. F-11 → `renounceOwnership()` reverts. F-16 → NatSpec corrected
> (`uint192`, leaky-bucket semantics). F-12's concern is now explicit: the escrow guards depend on
> the token being non-reentrant and hook-free, which is documented in the adapter.
>
> **Findings that still apply unchanged:**
> F-9 (the rate limit is a single bucket shared by all users, so one large transfer can crowd out
> others) and F-10 (no invariant/fuzz test of the headline supply property).
>
> **The single biggest audit concern is now gone.** The escrow design has no
> `burn(address,uint256)`, no mint authority, and no token upgrade — so the "an authorized minter
> can burn any holder's balance" primitive, and the R-02 "malicious `setPeer` ⇒ unlimited mint"
> risk, do not exist. New escrow-specific risks (liquidity exhaustion, the adapter as a custodial
> honeypot) replace them and are covered in `docs/bridge-design.md`'s header.
>
> **New finding from the escrow test suite:** sub-dust sends silently succeeded as no-ops
> (`_removeDust` → 0, and an ERC-20 transfer of zero succeeds), letting a user pay a LayerZero fee
> for an empty message and bypass a zero rate limit. Fixed with `ZeroAmountAfterDust`.
>
> ---

**Target:** branch `claude/storagetoken-eth-base-bridge-xjfqpk`, diff `0384d94..HEAD`
**Date:** 2026-07-26
**Commit under review:** bridge branch HEAD

## Scope

In scope — the changes this branch introduces:

| File | What changed |
|---|---|
| `contracts/core/StorageToken.sol` | `_update` fee-bypass fix; new `mint(address,uint256)`; new `burn(address,uint256)`; overridden `burn(uint256)`/`burnFrom`; `bridgeOp` supply-cap change; proposal types 12/13; `ChangeTreasuryFee` amount bugfix; appended storage (`bridgeMinters`, `voluntarilyBurned`, `__gap`) |
| `contracts/bridge/FulaOFTAdapter.sol` | new contract |
| `contracts/governance/interfaces/IStorageToken.sol` | new events and errors |

**Out of scope.** `contracts/governance/GovernanceModule.sol` and the pre-existing StorageToken
behaviour were audited by **Hashlock** and are unmodified by this branch. The parent is inherited by
~10 live contracts. Findings that resolve to pre-existing, untouched code are excluded — notably the
two-`Transfer`-event fee split, `transferFrom`/`approve` lacking `whenNotPaused`, `RemoveRole`
clearing `whitelistLockTime`, and `_checkExpiredProposal` emitting zeroed fields.

**Severity definitions used**

| Severity | Meaning |
|---|---|
| Critical | Depletion or loss of user or contract funds, unauthorized mint, or profitable front-running |
| High | Serious impact requiring specific conditions; or fund loss requiring a trusted-party mistake |
| Medium | Bounded impact, DoS, or a missing control that materially raises risk |
| Low | Defence-in-depth, latent risk not exploitable at current parameters |
| Informational | Documentation, clarity, or process |

---

## Summary of findings

**No Critical or High findings.** No path was found to mint without authorization, to exceed a
minter's `cap` or `TOTAL_SUPPLY`, to burn a third party's balance through any adapter path, or to
extract value by reordering.

| # | Finding | Category | Severity |
|---|---|---|---|
| ~~F-1~~ | ~~DoS of inbound bridging via `voluntarilyBurned`~~ — **WITHDRAWN, raised in error** | — | ~~Medium~~ → **Invalid** |
| F-2 | Unguarded `int96` downcast in `burn`, asymmetric with `mint` | Security | Low |
| F-3 | Adapter uses single-step `Ownable`; owner is also the LayerZero delegate | Security | **Medium** |
| F-11 | `renounceOwnership()` is reachable — and the design record recommends calling it | Security | **Medium** |
| F-4 | Adapter does not enforce `token() == minterBurner()` | Security / Code quality | Low |
| F-5 | `_updateActivityTimestamp()` on the inbound hot path | Gas | Low |
| F-6 | Type-12 target validation is only `code.length > 0` | Code quality | Informational |
| F-7 | `bridgeOp` remains a second, independent mint authority | Documentation | Informational |
| F-8 | A cap of zero cannot be set | Code quality | Informational |
| F-9 | Rate-limit capacity is a shared, first-come-first-served resource | Security | Low |
| F-10 | No invariant or fuzz testing of the headline supply property | Testing | Low |
| F-12 | Adapter's supply guard silently depends on properties of an *upgradeable* token | Security | Low |
| F-13 | `cap` bounds *inflation*, not *theft* — risk-register framing is incomplete | Security / Docs | **Medium** |
| F-14 | Layout verified for Ethereum/Base only, but the code comment is absolute | Security | **Medium** |
| F-15 | A pending `SetBridgeMinter` blocks emergency revocation of the same adapter | Security | Low |
| F-16 | NatSpec inaccuracies an operator could act on (`uint192` limit; `Ownable` claim) | Documentation | Low |
| F-17 | Adapter has no rescue function — tokens or ETH sent to it are stuck forever | Code quality | Low |
| F-18 | Two different constants named `PROPOSAL_TIMEOUT` (48h live, 3 days dead) | Code quality | Low |

Recommended before mainnet: **F-11** (one-line override; the documented roadmap currently points at
an irreversible mistake), **F-3** (one-line change to `Ownable2Step`) and **F-4** (one-line
constructor `require`). F-2 and F-5 are cheap and worth folding into the same upgrade, subject to
the ~51-byte EIP-170 budget.

⚠️ **F-1 was raised in error and is withdrawn.** See the entry below for the arithmetic and for how
the mistake arose — a misleadingly-named test that passed for the wrong reason. No action is
required for it, and `docs/bridge-design.md` R-17 has been restored accordingly.

Note that F-3, F-4 and F-11 all sit in `FulaOFTAdapter`, which is **not** size-constrained — only
`StorageToken` is near the EIP-170 limit. Those three are therefore essentially free to fix.

---

## Findings

### F-1 · ~~Permissionless DoS of inbound bridging via `voluntarilyBurned`~~ — **WITHDRAWN, NOT A FINDING**
**Category:** — · **Severity:** ~~Medium~~ → **Invalid**

**This finding was raised in error and is retracted.** It is kept here rather than deleted because
the reasoning error is instructive and because earlier drafts of this report and of
`docs/bridge-design.md` (R-17) asserted it as real.

**The claim was:** a voluntary burn increases `voluntarilyBurned`, which appears in
`mint`'s gate `totalSupply() + voluntarilyBurned + amount <= TOTAL_SUPPLY`, so any holder could
permanently consume this chain's inbound bridge capacity.

**Why it is wrong.** A voluntary burn of `X` moves **both** terms of that sum, in opposite
directions and by the same amount:

```
burn(X):   voluntarilyBurned += X          // V -> V + X
           super.burn(X) -> _burn(...)     // S -> S - X
```

Headroom is `TOTAL_SUPPLY − totalSupply() − voluntarilyBurned`, so:

```
before:  TOTAL_SUPPLY − S − V
after:   TOTAL_SUPPLY − (S − X) − (V + X)  =  TOTAL_SUPPLY − S − V     ← identical
```

A voluntary burn is therefore **headroom-neutral**. It cannot create capacity (which is exactly the
bug `voluntarilyBurned` was introduced to prevent) and it cannot destroy it either. The quantity
`totalSupply() + voluntarilyBurned` is invariant under voluntary burns; it decreases only on a
**bridge** burn, which correctly returns capacity because those tokens were re-minted on another
chain.

Verified empirically by two tests in `test/governance/integration/FulaOFTBridge.test.ts`:
- *"a voluntary burn is headroom-NEUTRAL: it neither creates nor destroys mint capacity"*
- *"a BRIDGE burn does restore headroom (the chain becomes a net exporter)"*

**Root cause of the error.** An earlier test was named *"PINNED: voluntarilyBurned permanently
consumes this chain's inbound headroom"* and passed — but it minted the chain **to the cap first**,
so headroom was already zero before the burn. It demonstrated only that burning does not *restore*
headroom; the name asserted something stronger that the test never showed. The test has been
rewritten to measure headroom before and after directly, which is what actually settles it.

**Residual observation (not a finding).** `burn(uint256)` / `burnFrom` do lack `whenNotPaused`, so a
holder can still burn their own tokens while the contract is paused. Given the neutrality above this
has no effect on bridge accounting, only on the holder's own balance, and it is already recorded in
`docs/bridge-design.md` as a deliberate, pre-existing, out-of-scope item.

---

### F-2 · Unguarded `int96` downcast in `burn`, asymmetric with `mint`
**Category:** Security · **Severity:** Low

`StorageToken.burn(address,uint256)`:

```solidity
minter.netMinted = int96(int256(minter.netMinted) - int256(amount));
```

No bound check. The mint side *is* guarded — `_createCustomProposal` rejects any `cap` above
`int96.max` (`BridgeMintCapTooHigh`) precisely so that `int96(net)` in `mint` cannot truncate. The
burn side relies entirely on an **implicit** invariant.

In Solidity 0.8 an *explicit* narrowing conversion truncates **silently**; only implicit conversions
and arithmetic are checked. So this is a genuine unchecked narrowing.

**Why it is not exploitable today.** `netMinted` decreases only via burns, and a burn requires the
holder to have the balance, so cumulative burns are bounded by the tokens that have ever existed on
the chain. That gives `netMinted ≥ −TOTAL_SUPPLY = −2e27`, against `int96.min ≈ −3.96e28` — roughly
a 20× margin.

**Failure scenario.** The margin is a consequence of `TOTAL_SUPPLY`, not an enforced invariant. A
future upgrade raising `TOTAL_SUPPLY` above ~3.96e28 makes this wrap silently, corrupting a
minter's cap accounting (either bricking its mints or freeing cap it never earned). Damage stays
bounded by `cap` and the absolute supply check, so it is not a direct inflation vector.

**Remediation.** Use `SafeCast.toInt96(...)`, or add an explicit lower-bound `require`, and state
in a comment that the safety of this cast is a function of `TOTAL_SUPPLY`.

---

### F-3 · Adapter uses single-step `Ownable`, and the owner is also the LayerZero delegate
**Category:** Security · **Severity:** Medium

`FulaOFTAdapter` inherits OpenZeppelin `Ownable` through `OAppCore`. `transferOwnership` is
single-step and irreversible.

That one address simultaneously holds:
- the ability to configure the security stack (`setPeer`, libraries, `setConfig`, rate limits), and
- the **LayerZero delegate** role, which can `endpoint.burn`/`nilify` in-flight messages — i.e.
  destroy funds already burned on the source chain.

**Failure scenario.** A single mistyped `transferOwnership` permanently loses configuration
control. By the design document's own reasoning under "Ownership: why not ownerless", a bridge
whose config can no longer be changed cannot rotate out a dead or compromised DVN, and tokens
already burned on the source can then **never** be minted on the destination — permanent user fund
loss. Ownership is not recoverable.

Owner = TimelockController on mainnet mitigates this (transfers are deliberate and delayed) but does
not eliminate it.

**Remediation.** Use `Ownable2Step` so ownership only moves when the new owner accepts.

---

### F-4 · Adapter does not enforce `token() == minterBurner()`
**Category:** Security / Code quality · **Severity:** Low

The supply-conservation guard measures supply on `token()` but mutates through `minterBurner`:

```solidity
uint256 supplyBefore = IERC20(token()).totalSupply();
(amountSentLD, amountReceivedLD) = super._debit(...);   // burns via minterBurner
uint256 burned = supplyBefore - IERC20(token()).totalSupply();
```

The constructor takes them as two independent parameters and never checks they are equal.

**Failure scenario.** A deployment that passed two different addresses would have a guard that
measures a contract nothing is mutating. It **fails closed** — the first transfer reverts with
`SupplyInvariantViolated` — so it is not exploitable, but the misconfiguration is silent until first
use, and on mainnet that is discovered after the adapter has already been authorized as a minter.

**Remediation.** `require(_token == address(_minterBurner))` in the constructor. This is the one
invariant the whole supply guard rests on.

---

### F-5 · `_updateActivityTimestamp()` on the inbound hot path
**Category:** Gas · **Severity:** Low

Both `mint` and `burn` call `_updateActivityTimestamp()`, which writes
`timeConfigs[msg.sender].lastActivityTime`. For a bridge adapter `msg.sender` is the adapter
contract, and that field exists to track **admin** inactivity — it is meaningless for an adapter and
is never read for one.

**Impact.** An `SSTORE` on every cross-chain transfer in both directions. It raises the enforced
`lzReceive` gas that every inbound transfer must pay for (risk R-10) and is charged to users
forever. Removing it also shrinks bytecode, which is non-trivial at **23.950 KiB against the
24.000 KiB EIP-170 limit** (~51 bytes of headroom).

**Remediation.** Drop the call from `mint` and `burn`.

---

### F-6 · Type-12 target validation is only `code.length > 0`
**Category:** Code quality · **Severity:** Informational

`_createCustomProposal` rejects EOAs but accepts *any* contract, including `address(this)` and the
Treasury.

**Assessed as not exploitable.** Verified: the token exposes no external path that would make it
call its own `mint`, and `contracts/governance/Treasury.sol` contains no `call`/`delegatecall` or
arbitrary-execution function, so authorizing either would not yield an attack primitive. The real
control is governance review, and authorization already requires 2-of-N approval plus a 24h delay.

**Remediation.** Add `target != address(this)` (free), and make "target is an immutable,
non-upgradeable, source-verified OFT adapter" an explicit item on the governance review checklist,
since that is the actual security boundary.

---

### F-7 · `bridgeOp` remains a second, independent mint authority
**Category:** Documentation · **Severity:** Informational

The upgrade introduces `bridgeMinters` while retaining `BRIDGE_OPERATOR_ROLE`'s `bridgeOp(op == 1)`,
which mints to the token contract **outside** the `netMinted`/`cap` accounting and consumes the same
`TOTAL_SUPPLY` headroom that bridge mints check against.

**Failure scenario.** A compromised bridge operator can mint up to the remaining headroom, which
both dilutes holders and denies service to legitimate inbound bridge transfers (they revert
`ExceedsMaximumSupply` until supply falls). This is pre-existing authority, not new, but the
upgrade makes its blast radius overlap with the bridge.

**Remediation.** Retire `bridgeOp` in the planned follow-up upgrade, as the design already
schedules. Until then, treat `BRIDGE_OPERATOR_ROLE` as equal in privilege to a bridge minter.

---

### F-8 · A cap of zero cannot be set
**Category:** Code quality · **Severity:** Informational

`_createCustomProposal` rejects `amount == 0` for type 12, so governance cannot use "cap = 0" as a
reversible soft pause. The available levers are `setRateLimits(0)` (fast, adapter-side) or type-13
removal (24h, and `netMinted` is retained).

**Remediation.** Documentation only — the kill-switch list in the design record should state that
the token-side pause is type-13 removal and that cap-to-zero is deliberately unavailable.

---

### F-9 · Rate-limit capacity is a shared, first-come-first-served resource
**Category:** Security · **Severity:** Low

`RateLimiter` tracks one `amountInFlight` per destination eid, shared by all users of the lane.
There is no per-sender allocation.

**Failure scenario.** At Stage 1 the configured limit is 100,000 FULA / 24h. A searcher who wants to
block a competitor's cross-chain arbitrage can consume the remaining window with their own
transfers, causing the competitor's `send` to revert `RateLimitExceeded` until the window decays.
Because the limiter is NET (accepted risk R-18), the griefer can partly recycle their own capital by
bridging back, lowering the cost of sustaining the block.

No funds are lost and nothing is directly extracted, so this is griefing rather than theft — but at
the small early-stage limits it is cheap, and it is worth knowing before rate limits are advertised
as a user-facing guarantee.

**Remediation.** Accept and size the limits with this in mind; the constraint eases as limits grow
through the rollout stages. A per-sender sub-limit is possible but adds meaningful complexity to an
immutable contract.

---

### F-10 · No invariant or fuzz testing of the headline supply property
**Category:** Testing · **Severity:** Low

The suite is 62 example-based tests and covers the intended behaviours well, including a two-chain
round trip, dust retention and the supply-invariant guards. But the property the entire design
exists to guarantee — **Σ `totalSupply()` across chains is invariant under any sequence of bridge
operations** — is only asserted for a handful of hand-written sequences.

**Why it matters.** The interesting failures in a mint/burn bridge come from *orderings*:
interleaved sends in both directions, partial delivery, retries after a parked message, cap changes
mid-flight, voluntary burns interleaved with bridge burns. Example tests cannot cover that space.

**Remediation.** Add a stateful invariant/fuzz suite (Foundry `invariant_` handlers, or Echidna)
over a two-chain harness, asserting after every operation:
`supplyA + supplyB + burnedA + burnedB == constant`, and
`Σ netMinted_i ≤ Σ cap_i` per chain.

---

### F-11 · `renounceOwnership()` is reachable, and the design record recommends calling it
**Category:** Security · **Severity:** Medium

`FulaOFTAdapter` inherits OpenZeppelin `Ownable` and does **not** override `renounceOwnership()`.
The owner can therefore permanently set the owner to `address(0)` in a single call.

For this contract that is unrecoverable and load-bearing. The owner is the only party able to
`setPeer`, change message libraries, run `setConfig` (the DVN set), set enforced options and set
rate limits — and is also the LayerZero delegate. Once renounced, **none** of that can ever change.

**Why this is more than a theoretical footgun.** `docs/bridge-design.md` states the danger itself at
line 189:

> "if a required DVN goes dark and config is frozen, tokens already burned on Ethereum **can never
> be minted on Base** — permanent loss. A compromised DVN could not be rotated out."

and then, at line 191, recommends doing exactly that as the roadmap:

> "Path to further decentralization: timelock → optionally renounce later once the DVN set proves
> durable."

So an operator following the documented plan would freeze the security stack forever. "Once the DVN
set proves durable" is not a safe precondition: DVNs are off-chain companies, and their durability
to date says nothing about their future. Renouncing converts every future DVN outage — a
*recoverable* incident today — into permanent, unrecoverable loss of user funds that are already
burned on the source chain.

Note this differs from renouncing on an ordinary token, where it is a genuine decentralization win.
A mint/burn bridge has an ongoing liveness dependency on mutable off-chain infrastructure, so it
cannot be made safely immutable at the config layer.

**Remediation.**
1. Override `renounceOwnership()` to revert, making the mistake impossible:
   ```solidity
   /// @notice Disabled: the owner is the only party that can rotate a dead or compromised DVN.
   ///         Renouncing would freeze the security stack forever and turn any future DVN outage
   ///         into permanent loss of funds already burned on the source chain.
   function renounceOwnership() public pure override {
       revert("FulaOFTAdapter: ownership cannot be renounced");
   }
   ```
2. Remove or heavily qualify the "optionally renounce later" guidance in the design record so the
   roadmap does not point at an irreversible mistake.

---

### F-12 · The adapter's supply guard silently depends on properties of an *upgradeable* token
**Category:** Security · **Severity:** Low

Flagged by Slither (`reentrancy-balance`) and confirmed by review as a real cross-contract coupling,
though not currently exploitable.

Both guards measure state **across an external call**:

```solidity
uint256 balanceBefore = IERC20(token()).balanceOf(recipient);
super._credit(_to, _amountLD, _srcEid);          // external call -> minterBurner.mint(...)
uint256 credited = IERC20(token()).balanceOf(recipient) - balanceBefore;
```

That is only sound because of two properties of **StorageToken**, not of the adapter:
1. `mint`/`burn` are `nonReentrant`, and
2. `_mint`/`_burn`/`_update` make no external calls (no ERC-777-style hooks), so nothing can execute
   between the two reads.

**The asymmetry that makes this worth recording:** `FulaOFTAdapter` is **immutable**, but
`StorageToken` is an **upgradeable UUPS proxy**. A future token upgrade that added a transfer hook,
a callback, or removed `nonReentrant` would silently invalidate the adapter's central safety
property — and the adapter can never be patched, only replaced and re-authorized through governance.
Nothing in the adapter states or enforces this dependency.

**Not exploitable today.** With the current token, reentry is impossible, so the guards hold.

**Remediation.** Documentation and process, not code: record "StorageToken.mint/burn must remain
`nonReentrant` and hook-free" as a permanent invariant in `contracts/UPGRADING.md` alongside the
existing bridge invariants, so any future token upgrade is checked against it. Optionally add a
`nonReentrant` guard on the adapter side as belt-and-braces.

---

### F-13 · `cap` bounds *inflation*, not *theft* — the risk register's framing is incomplete
**Category:** Security / Documentation · **Severity:** Medium

`docs/bridge-design.md` states that "`bridgeMinters.cap` independently bounds damage at the token
layer" (R-01, R-02). That is true for **inflation** and false for **theft**, and the difference is
large enough to change how `cap` should be chosen.

A compromised authorized minter can burn any holder's balance, and **burning drives `netMinted`
negative, which frees cap for minting**:

```
start:            netMinted = 0,   cap = C
burn X from victims:  netMinted = −X       (attacker now holds nothing, victims lost X)
mint until net = C:   can mint X + C to itself
```

The attacker ends up holding `X + C` tokens: `X` effectively stolen from holders plus `C` freshly
minted. Net supply change is only `+C`, so the cap does bound **dilution** exactly as documented —
but the attacker's **take** is bounded by `C + (total balances it chooses to burn)`, i.e. in the
limit by the entire circulating supply on that chain, not by `C`.

**Impact.** This does not change the trust model — it is inherent to R-01, which is accepted — but
it means `cap` cannot be sized as "the maximum we could lose". The real bound on loss is the
circulating supply on the chain, and the only controls that reduce it are the ones that prevent a
minter being compromised at all (immutable adapter, source verification, governance diligence) plus
the rate limiter.

**Remediation.** Documentation: correct the R-01/R-02 mitigation wording to distinguish "bounds
inflation" from "bounds loss", so cap values are not chosen under a false sense of ceiling.
Credit: quantification contributed by an external reviewer.

---

### F-14 · Layout assumption is verified for Ethereum and Base only, but the code comment is absolute
**Category:** Security · **Severity:** Medium

`StorageToken.sol` states "StorageToken is in the 'Legacy' group (first child slot 11)" without
qualification, and `scripts/bridge/live.ts` publishes a single `SLOTS` map that lists **skale** and
**iotex-mainnet** alongside Ethereum and Base.

Live storage reads confirm slot 11 for **Ethereum and Base** (treasury at slot 13, `packedVars` at
15, slots 16+ zero — independently reproduced by an external reviewer and by this branch's fork
tests). But committed OpenZeppelin manifests for two other deployments in this repo
(`unknown-751.json`, `unknown-974399131.json`) record StorageToken's first child variable at
**slot 10**, with `packedVars` at 14 — a different vintage in which appended state would land at
slot 15, not 16.

**Failure scenario.** The design explicitly plans SKALE as a later addition ("Ethereum ↔ Base only,
scripts written generically so SKALE is a later config addition"). An operator extending the bridge
who trusts the absolute in-code comment and the shared `SLOTS` map would append `bridgeMinters` over
an occupied slot on a chain with the older layout — silent, irreversible storage corruption of a
live proxy.

`contracts/UPGRADING.md` already says classification must be done **per network**, so the process is
right; the contract comment and `live.ts` are what contradict it.

**Remediation.** Qualify the comment ("verified slot 11 on Ethereum and Base as of 2026-07-26;
re-verify per network before any other deployment"), and make `live.ts` carry the verification
status per chain rather than one shared `SLOTS` map. Do not deploy this implementation to
SKALE or IoTeX until their live layout is read and confirmed.

---

### F-15 · A pending `SetBridgeMinter` blocks emergency revocation of the same adapter
**Category:** Security · **Severity:** Low

`createProposal` enforces one pending proposal per target
(`if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target)`).

**Failure scenario.** A `SetBridgeMinter` (type 12) proposal is pending for adapter A — say a
routine cap raise. Adapter A is then discovered to be compromised. Governance **cannot** create the
type-13 `RemoveBridgeMinter` for A until the pending proposal either executes (which would *raise
its cap*) or expires (up to 48h).

**Why it is only Low.** Faster remedies exist and do not touch governance: `setRateLimits(0)` on the
adapter halts outbound within one block, and `emergencyAction(1)` pauses the token, which blocks
`mint`/`burn` entirely since both are `whenNotPaused`. Type-13 removal was always the slowest kill
switch by design.

**Remediation.** Note in the runbook that emergency response is pause / rate-limit-zero first, and
that type-13 may be temporarily unavailable if a type-12 is in flight for the same target.

---

### F-16 · NatSpec inaccuracies that could mislead an operator
**Category:** Documentation · **Severity:** Low

Two statements in `FulaOFTAdapter.sol` are wrong in ways an operator could act on:

1. **`setRateLimits` NatSpec:** *"For an intentionally unlimited lane, set `limit` to
   `type(uint256).max` explicitly."* `RateLimiter.RateLimitConfig.limit` is a **`uint192`**, so
   `type(uint256).max` is not representable and the call would fail. The correct value is
   `type(uint192).max`.
2. **Constructor NatSpec:** *"`OAppCore` inherits OZ v5 `Ownable` but its constructor never calls
   it, so without this the owner would default to the deployer."* The first clause is correct
   (`OAppCore`'s constructor takes `(address _endpoint, address _delegate)` and does not invoke
   `Ownable`), but the consequence is wrong: OZ v5 `Ownable` has a **mandatory** constructor
   argument, so omitting `Ownable(_owner)` would fail to **compile**, not silently default to the
   deployer.

**Remediation.** Correct both comments. The code itself is right in each case.

---

### F-17 · Adapter has no rescue function
**Category:** Code quality · **Severity:** Low

`FulaOFTAdapter` holds no assets by design — it mints and burns rather than escrowing — and it has
no way to recover anything sent to it. Anything that arrives is stuck permanently, because the
contract is immutable.

**How assets can arrive.** ETH cannot accumulate through normal operation (`OAppSender._payNative`
requires `msg.value` to equal the quoted fee exactly), but can still be forced in via
`selfdestruct` or block-reward payout. FULA can arrive by a mistaken direct `transfer`, or by any
user performing a cross-chain send with `to` set to the adapter address — the destination `_credit`
will happily mint to it.

**Remediation.** Either add an `onlyOwner` rescue for ERC20 and ETH — noting it widens the owner's
surface, which F-3/F-11 argue is already the most sensitive thing here — or explicitly document that
the adapter must never be sent assets and that anything sent is unrecoverable. Given the owner is a
timelock, adding a rescue is defensible; doing nothing is also defensible provided it is documented.

---

### F-18 · Two different constants named `PROPOSAL_TIMEOUT`
**Category:** Code quality · **Severity:** Low

- `GovernanceModule.sol:78` — `uint32 private constant PROPOSAL_TIMEOUT = 48 hours` ← **the live one**
- `ProposalTypes.sol:33` — `uint32 constant PROPOSAL_TIMEOUT = 3 days` ← **dead**

`_initializeProposal` (`GovernanceModule.sol:205`) writes
`expiryTime = block.timestamp + PROPOSAL_TIMEOUT`, and the unqualified name binds to
GovernanceModule's own private constant. `ProposalTypes.PROPOSAL_TIMEOUT` is referenced **nowhere**
in the codebase.

**Failure scenario — observed, not hypothetical.** During this very engagement the `ProposalTypes`
value was read as authoritative, and both `scripts/bridge/live.ts` and the design record's execution
window were "corrected" from 48h to 72h. Had that shipped, an operator computing an upgrade deadline
from `live.ts` would have targeted a moment **24 hours after the proposal had already expired**, and
the upgrade would have silently failed to be executable. Both have been reverted.

The constants themselves are pre-existing and strictly out of scope, but the trap is live and it
catches readers.

**Remediation.** Delete the unused `ProposalTypes.PROPOSAL_TIMEOUT`, or make `GovernanceModule` use
it and remove its private duplicate, so a single value is authoritative.

---

## Static analysis

Slither 0.11.5 was run against both in-scope contracts using solc `v0.8.24+commit.e11b9ed9`.
(Note: `slither .` against the Hardhat project fails with `Unknown file: contracts/core/MasterRegistry.sol`
— a **stale build-info artifact** referencing a source file that no longer exists. Analysis was run
per-file instead. The stale artifact is worth clearing; it is also the reason the storage-layout test
explicitly guards against reading a stale layout.)

**`FulaOFTAdapter.sol`** — 38 contracts, 101 detectors, 123 raw results. Nearly all are in LayerZero
dependencies (unindexed event parameters, mixed pragmas). Attributable to our code:

| Detector | Assessment |
|---|---|
| `reentrancy-balance` on `_credit` | **True positive as a pattern** → recorded as F-12. Not exploitable with the current token. |
| `reentrancy-benign` on `_debit`/`_credit` | Not an issue. `_outflow`/`_inflow` write after the external call, but a revert rolls the whole transaction back, so no inconsistent state can persist. |
| `shadowing-local` — constructor `_owner` shadows `Ownable._owner` | Cosmetic. Harmless; rename the parameter if desired. Informational. |
| `naming-convention` on `_configs` / `_eids` | Style only, and it matches LayerZero's own convention. Ignored. |

**`StorageToken.sol`** — 33 contracts, 101 detectors, 106 raw results. **No security-class finding
was reported against any of the new bridge code** (`mint`, `burn`, `_update`,
`_executeCustomProposal`). The single hit naming new code is:

| Detector | Assessment |
|---|---|
| `cyclomatic-complexity` = 26 on `_createCustomProposal` | Maintainability, not security. Informational. The parent `GovernanceModule.createProposal` has the same shape, so this is an existing house pattern rather than something this branch introduced. |

Everything else resolves to `GovernanceModule` (out of scope) — `reentrancy-no-eth`,
`mapping-deletion`, `incorrect-equality`, `timestamp` — or is a false positive
(`StorageToken.__gap is never used`, which is precisely what a storage gap is for;
`packedVars` shadowing, which is pre-existing and is exactly why the layout test asserts an ordered
slot list rather than looking variables up by name).

---

## Properties verified as SAFE

Stated explicitly rather than omitted, with the reason each holds.

| Property | Why it holds |
|---|---|
| **PreCrime cannot trigger a real mint** | `OAppPreCrimeSimulator.lzReceiveAndRevert` is public and unauthenticated, and does reach `_credit`. But it always ends in `revert SimulationResult(...)`, so the whole transaction — including any mint — is rolled back. `lzReceiveSimulate` is additionally gated by `OnlySelf`. Nothing persists. |
| **Compose (`SEND_AND_CALL`) cannot reenter `_credit`** | The compose callback executes in a **separate transaction** via `lzCompose`, not inline, so a malicious `composeMsg` recipient never re-enters the credit path. |
| **Zero-amount messages are impossible** | A `send` of 0 produces `amountSentLD == 0`, and `StorageToken.burn(from, 0)` reverts `AmountMustBePositive` — so the source transaction fails before any message is emitted. Both ends are guarded. |
| **No function-selector collisions** | `mint(address,uint256)`=0x40c10f19, `burn(address,uint256)`=0x9dc29fac, `burn(uint256)`=0x42966c68, `burnFrom(address,uint256)`=0x79cc6790 — all distinct, so the `burn` overload is unambiguous on-chain. |
| **Blacklisting the adapter is a no-op** | The adapter is never `from` or `to` in `_update`; it is `msg.sender` of `mint`/`burn`. Blacklisting it does not disable the bridge (use pause or rate-limit-zero). |
| **Live storage layout on Ethereum and Base** | Read directly from both mainnet proxies: `treasury` at slot 13, `packedVars` at 15, slots 16–20 all zero. Confirms first-child-slot-11 and that the appended state lands on free slots. (Scope caveat in F-14.) |
| **No unauthorized mint path** | `bridgeMinters` has exactly two writers, both inside `_executeCustomProposal` (enable+cap, disable). No other function in the contract writes the mapping. Reaching them requires a passed governance proposal. |
| **R-01: no adapter path burns a third party** | Verified in the LayerZero sources: `_debit` is called at exactly one site (`OFTCore._send`, line 206), `_send` is called at exactly one site (`send()`, line 180), and `send()` passes `msg.sender`. There is no calldata field that selects the victim. |
| **No reentrancy** | `mint`/`burn` are `nonReentrant`; `_mint`/`_burn`/`_update` make no external calls (no ERC-777 hooks), so nothing can be interleaved between the adapter's before/after `totalSupply()`/`balanceOf()` reads. |
| **Blacklist cannot be bypassed by the fee change** | The two blacklist checks sit outside the fee branch, so they still apply to mints and burns. |
| **`blacklisted[address(0)]` is unreachable** | `GovernanceModule.createProposal` rejects a zero `target` before dispatch, so the zero address can never be blacklisted — mints and burns cannot be bricked this way. |
| **No overflow into the `int256` cast in `mint`** | `totalSupply() + voluntarilyBurned + amount > TOTAL_SUPPLY` is checked arithmetic and reverts on overflow, bounding `amount` to ≤ 2e27 before `int256(amount)` is evaluated. |
| **`mint`'s `int96` downcast is safe** | `net ≤ cap ≤ int96.max` (enforced at proposal creation) and `net ≥ netMinted ≥ −2e27`. |
| **Multi-minter accounting is sound** | Supply increase equals Σ`netMinted` across minters, and each is bounded by its own `cap`, so total inflation ≤ Σ caps even when minters cross-burn each other's mints. |
| **No trapped ETH in the adapter** | `OAppSender._payNative` requires `msg.value` to equal the quoted fee exactly, so overpayment is impossible and no balance accrues. |
| **Storage layout** | Appended at slots 16/17 with `__gap` covering 18–64; asserted as an exact ordered layout offline, and confirmed against **live mainnet state on both Ethereum and Base** via fork tests (appended slots read zero, upgrade changes no pre-existing state). |
| **Failed inbound is a delay, not a loss** | A revert in `lzReceive` leaves the payload hash intact, so pause / blacklist / cap / supply blocks are all permissionlessly retryable. |
| **No value-extracting MEV in the transfer path** | `send()` burns the caller's own balance and mints to a recipient fixed in the message; there is no slippage surface, and `minAmountLD` bounds dust rounding. Nothing is extractable by reordering. See F-9 for the separate *griefing* surface. |

---

## Notes on process

- **Independent review was largely unavailable, and this materially limits corroboration.** Five
  external reviewers were engaged: `agy` declined to analyse a concrete target; `codex` exceeded its
  10-minute ceiling twice while still exploring; Kimi K2.7's daily quota was exhausted; MiMo returned
  HTTP 403 (the router now requires a Telegram binding on the account). Only the transcript-aware
  in-house reviewer responded — and it is what caught F-1, which the author had wrongly pre-classified
  as an accepted risk and explicitly excluded from all external briefs. **Their silence on F-1 is
  therefore the author's exclusion, not independent confirmation.**
- Because of that, this audit rests on first-principles source-level verification plus Slither, not
  on multiple concurring reviewers. Given the upgrade grants mint authority over a live token,
  an external audit of the F-1 remediation is recommended before mainnet.
- The Sepolia ↔ Base Sepolia rehearsal (Phase A) independently surfaced three **script-level**
  defects that would have affected mainnet operations — an unencodable `setConfig` ABI, a
  non-re-runnable wiring script, and a cross-chain digest check that could never match. Those are
  recorded in `scripts/bridge/testnet-deployments.md`. They are operational, not on-chain, so they
  are not listed as contract findings.
