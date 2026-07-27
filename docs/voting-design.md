# CommunityVoting — Design Record

**Status:** IN PROGRESS (Step 0 of 9)
**Chain:** Base only (v1)
**Contract:** `contracts/core/CommunityVoting.sol` (new UUPS proxy, inherits `GovernanceModule`)
**Date started:** 2026-07-27

---

## 1. Purpose

A fair, transparent, whale-resistant community voting mechanism for FULA holders. Anyone with sufficient skin in the game can post a *subject* (a poll) with 2–100 short-text options and a close date. Token holders vote by locking FULA for the subject's duration. Voting power grows **sub-linearly** with tokens (quadratic-style), so a large holder cannot buy proportional influence. Locked tokens are released after close.

Results are **signaling only** — advisory, not self-executing. See §6.

## 2. Why a new contract rather than an existing audited platform

Every off-the-shelf option was evaluated and rejected for a concrete, verifiable reason:

| Option | Why not |
|---|---|
| **OpenZeppelin Governor** | Requires `IVotes` (checkpointed balances) on the token. `StorageToken` is at 23.950 of 24.000 KiB under EIP-170 (`hardhat.config.ts:83-116`, `contractSizer.strict = true`) and cannot absorb `ERC20Votes`. Governor also supports only for/against/abstain, not 2–100 arbitrary options, and is built for executable proposals. |
| **Snapshot** | Off-chain. Cannot lock tokens, which is a core requirement here, and is no more sybil-resistant than this design. Still useful later as a complementary, zero-cost temperature check. |
| **Aragon / Gitcoin Allo / clr.fund (MACI)** | Wrong shape — yes-no plugins, funding-round mechanics, or coordinator-dependent infrastructure. |

The contract we build still leans on **audited primitives**: OpenZeppelin 5.3.0 upgradeable (`Math.sqrt`, `Math.mulDiv`, `SafeCast`, `SafeERC20`, `AccessControl`, `ReentrancyGuard`, `Pausable`, UUPS) and this repo's Hashlock-audited `GovernanceModule`.

## 3. Voting power

```
weightedStake = mulDiv(sum(qualifying stake amounts), stakeWeightBps, 10_000)
basis         = freshLockReceived + weightedStake          // wei
rawPower      = sqrt(basis)                                // 1 FULA -> 1e9 power units
power         = mulDiv(rawPower, memberMultiplierBps, 10_000)
```

Three deliberate choices:

- **`sqrt` of wei, not of whole tokens.** Wei-scale keeps far more granularity; `sqrt(1e22) = 1e11` for the 10,000-FULA minimum, and `sqrt(2e27) ≈ 4.47e13` for the entire supply. Both sit far below `uint128`.
- **Multiplier applied *after* `sqrt`.** Applying it inside the root would turn a "2×" parameter into ≈1.414× actual power.
- **Stakes summed *before* weighting**, so `stakeWeightBps` is applied exactly once. Weighting per index would add a rounding step per stake and make splitting a stake marginally profitable.

Two floor operations are unavoidable (`sqrt` and `mulDiv`). They can move a result by a few raw power units, which matters only at an exact tie. This is documented as part of the voting rule rather than hidden.

### What counts as basis

| Source | Rule |
|---|---|
| Fresh lock | Tokens transferred in for *this* subject, credited by measured balance delta (the token has an optional platform fee). Per-subject: voting on N subjects requires N locks. |
| Staked FULA | `StakingEngineLinear` stakes that are `isActive`, whose lock end `>= closeTime`, and whose `startTime <= subject.createdAt`. Ownership is read **only** from `stakes[msg.sender][i]`. Counts toward every open subject, since it is genuinely immobilised 1–3 year capital. |

The `startTime <= createdAt` rule closes a snipe: without it, someone could buy FULA and open a 365-day stake in the final block before close and vote with power that costs them nothing on a per-subject basis. A qualifying stake also *cannot* be unstaked before close (`StakingEngineLinear.sol:848` reverts `LockPeriodNotEnded`), so the collateral is pinned for the whole window at no cost to us.

## 4. Sybil resistance — stated honestly

**Square-root voting is sybil-*positive*, not sybil-resistant.** Splitting capital `C` across `n` wallets yields `n · sqrt(C/n) = sqrt(n) · sqrt(C)` — an amplification of `sqrt(n)`, bounded above by plain linear voting. `minVoteBasis` sets the optimal sybil chunk size and is therefore the single cheapest dial for tightening this.

The brake is a DePIN identity multiplier: proven `StoragePool` membership multiplies power once per wallet. Eligibility requires **all** of:

1. `getPeerIdInfo(poolId, peerId)` returns `member == msg.sender` — live membership, checked every time.
2. That peer's **own** `lockedTokens >= minPoolJoinStake`.
3. `joinTimestamp[peerId] != 0` and `joinTimestamp[peerId] <= subject.createdAt - minMembershipAge`.
4. `!isForfeited(voter)`.

Rule 2 is the load-bearing one. A privileged `createPool` sets `lockedTokens = 0` (`StoragePool.sol:183`) and `POOL_ADMIN` can `addMember` directly (`:307`), so a pool can advertise a high `requiredTokens` while a given member has posted nothing. Checking the **peer's own locked balance** rather than the pool's advertised requirement is what makes the multiplier mean something.

Rule 1 is also load-bearing for a subtler reason: `joinTimestamp` is keyed by `peerId` globally, is overwritten on re-join, and is **not** cleared unless a member's *last* peerId is removed (`StoragePool.sol:118-128`). A stale non-zero timestamp can therefore outlive membership, so it must never be trusted on its own.

**Honest summary:** this is *whale friction and provider-weighting*, not whale resistance. Documentation and UI must say so. A determined whale with pre-established pool memberships can still out-vote the community; the design raises the cost and makes the attempt publicly visible on-chain, and the signaling-only scope caps the damage.

## 5. 🔴 The `Recovery` finding — why this contract overrides `createProposal`

`GovernanceModule` ships a `Recovery` proposal type (4). `createProposal:259-280` accepts it guarded only by `tokenAddress != address(this)`, and `_executeProposal:530-544` then executes:

```solidity
IERC20 token = IERC20(proposal.tokenAddress);
bool success = token.transfer(proposal.target, proposal.amount);
```

from the contract's own balance. CommunityVoting holds voter locks and creator deposits **in FULA**, so inheriting this unchanged would let two admins move every locked token to any address — precisely the power this design promises does not exist.

**Mitigation, shipped in the first deployed implementation:** `createProposal` is `external virtual`, so it is overridden to revert when `proposalType == Recovery && tokenAddress == address(token)`, then delegate to `super`. Recovery of *other* accidentally-sent ERC20s remains available, which is a genuine benefit at no cost.

This must be present from deployment. Retrofitting it would require an upgrade, and trusting the admins to perform that upgrade is exactly the assumption we are trying to remove.

## 6. Signaling-only, and finalization liveness

Results are advisory. Options are free text, which cannot map to calldata, and a signaling contract holds no privileged power over any other contract — so the worst outcome of a governance attack here is an embarrassing poll result, never a drained treasury or a hijacked upgrade. `finalize` emits structured events reserved as future execution hooks.

**`finalize` performs no external calls.** It only records the winner, the tie flag, and the deposit liability. A separate permissionless `settleDeposit` performs the burn. The reason: burning a failed deposit is an external call into FULA, and if the token is paused or the voting proxy is ever blacklisted, that call reverts — which would mean a poll could *never* be finalized. Splitting the two guarantees that recording a result can never be held hostage by token-level state.

Related determinism rules:
- Winner is the **lowest index among maxima**, with a `tied` flag meaning *no mandate*.
- An **all-zero tally is explicitly no mandate**, not "option 0 wins".
- Options must be non-empty, ≤64 bytes, and `keccak256`-unique within a subject, so duplicate or lookalike labels cannot fragment a vote or make a winner ambiguous to humans.

## 7. Economics

| Param | Default | Hard min | Hard max |
|---|---|---|---|
| `burnFee` | 50,000 FULA | 1,000 | 2,000,000 |
| `deposit` | 100,000 FULA | 10,000 | 10,000,000 |
| `minVoteBasis` | 10,000 FULA | 100 | 1,000,000 |
| `minDuration` / `maxDuration` | 3d / 30d | 1d | 90d (`min <= max`) |
| `memberMultiplierBps` | 20,000 (2×) | 10,000 | 50,000 |
| `stakeWeightBps` | 10,000 (100%) | 0 | 10,000 |
| `quorumBasis` | 5,000,000 FULA | 100,000 | 100,000,000 |
| `quorumVoters` | 15 | 3 | 1,000 |
| `maxOpenPerCreator` | 3 | 1 | 20 |
| `createCooldown` | 1d | 0 | 7d |
| `minPoolJoinStake` | 1 FULA | 0 | 10,000,000 |
| `minMembershipAge` | 14d | 0 | 90d |

At an assumed $1–5M market cap (FULA ≈ $0.0005–0.0025), creating a subject costs roughly $75–375, of which $25–125 is permanently burned. Reclaiming the deposit requires roughly $2.5–12.5k of committed basis — far more than the deposit is worth, so self-funding a refund is not economical.

Parameters are changed **only** through the existing 2-admin proposal flow (24h delay) via contract-local proposal type **14**, and every value is clamped to the compile-time bounds above at *both* proposal creation and execution — a proposal sits for 24–48 hours and the world can move in between.

**Quorum caveat.** Quorum is `voterCount >= quorumVoters && totalBasis >= quorumBasis`. The **basis term is the load-bearing one**; a voter count is cheap to sybil at roughly $0.50 per wallet. Quorum therefore proves committed capital, not independent community participation. A creator can also legitimately participate in their own subject. The deposit is best understood as an anti-spam capital requirement, not a guarantee of organic turnout.

## 8. Trust model — what admins can and cannot do

**Cannot:**
- Take locked FULA via `Recovery` (blocked — §5).
- Take locked FULA via any rescue/sweep function (none exists).
- Change any parameter outside its compile-time bounds.
- Trap user funds with a pause — claims and deposit refunds are deliberately **not** `whenNotPaused`. `emergencyAction` is a *single*-admin action with a shared 30-minute cooldown (`GovernanceModule.sol:594-618`), so pausing is one signature away and must never freeze completed positions. This intentionally departs from the `StoragePool.claimTokens:462` precedent.

**Can:**
- **Upgrade the implementation** (2 admins, quorum 2, 24h delay). This is the real trust root. An upgrade can rewrite claim accounting or drain custody regardless of every safeguard above. Because locks run up to 90 days, a 24-hour upgrade notice is **not** a user exit window — it is a courtesy. Stated plainly so depositors and voters can price it.
  - Recommended practice: announce any upgrade through a subject first, and dogfood the mechanism.
- Pause new participation (`createSubject`, `vote`, `finalize`).
- Retune parameters within bounds.

**Inherited token-level risks, outside this contract's control:**
- Blacklisting the voting proxy would freeze every lock and every burn.
- Blacklisting a voter freezes that voter's own claim. With `Recovery` blocked, their funds wait until StorageToken governance unblacklists them — an accepted consequence of removing the admin drain.
- Pausing FULA blocks `transfer` (`StorageToken.sol:190-203`) and therefore blocks claims.
- If `platformFeeBps` is ever raised above 0, outgoing claims lose the fee, so a claimant receives slightly less than the recorded amount. Inbound accounting is delta-based and stays correct.

## 9. Invariants (asserted continuously in the test suite)

1. **Solvency** — `balanceOf(contract) >= Σ unclaimed locks + unsettled deposits`, including with `platformFeeBps` anywhere in 1–500.
2. **Conservation** — every received token is exactly one of burned, currently owed, or already claimed; never assigned to two liabilities.
3. **Power integrity** — stored basis equals the measured fresh-lock delta plus the once-weighted sum of distinct qualifying caller-owned stakes.
4. **No double vote** — after a wallet's first successful vote, it can change no tally.
5. **Tally sum** — the sum of all option power equals total recorded voting power.
6. **Quorum purity** — only *basis* contributes to the capital quorum, never quadratic or multiplied power.
7. **Multiplier once** — membership applies at most once regardless of repeated pool/peer inputs.
8. **Finalize idempotence** — repeat calls cannot change winner, tie flag, deposit entitlement, open-subject count, or burn amount.
9. **Claim isolation** — claiming one subject cannot alter another subject's liabilities or claimability.
10. **No trapped funds** — after any randomized operation sequence, every participant can withdraw exactly what they are owed.

## 10. Implementation notes (decisions made while building, with their reasons)

### 10.1 `createProposal` is a hand-written mirror, not a guard-and-delegate

The intended shape of the §5 fix was:

```solidity
function createProposal(...) external override returns (bytes32) {
    if (isRecoveryOfGovernedToken) revert RecoveryBlocked();
    return super.createProposal(...);          // <-- does not compile
}
```

Solidity does not permit `super.f()` when the parent declared `f` as `external`; the compiler
reports *"Member createProposal not found or not visible after argument-dependent lookup in
type(contract super CommunityVoting)"*. Verified empirically, not assumed.

Alternatives considered and rejected:

| Option | Why not |
|---|---|
| Block at execution instead | `_executeProposal` is `internal` but not `virtual`, and `approveProposal` auto-executes once quorum and the delay are both met, so guarding `executeProposal` alone leaves that path open. |
| Hold funds in a separate vault so a Recovery finds no balance | Adds a contract, an external call on every lock and claim, and a second ownership question. |
| Inherit `NftGovernanceModule` (no proposal system, so no Recovery) | Loses the two-admin quorum on parameter changes and upgrades, which is the main reason for using the shared governance base at all. |

The chosen fix reimplements the parent's body with exactly one added branch. The duplication is
a real maintenance risk, so it is mitigated by testing **every** inherited branch — role changes,
upgrades, zero target, duplicate pending proposal, unknown role, unknown type, missing quorum,
and non-admin callers — rather than only the new one. If `GovernanceModule` ever changes, those
tests are what will catch the divergence.

### 10.2 Parameters are a flat array, not a packed struct

The packed-struct form required a 13-branch chain with masked read-modify-write SSTOREs in both
the setter and the getter, measured at **3.4 KiB** of bytecode. Since the contract inherits about
14 KiB of `GovernanceModule` before any of its own logic, that left too little room under the
24 KiB EIP-170 limit for the remaining voting logic.

Measured sizes along the way:

| State | Deployed size |
|---|---|
| Skeleton (Step 1) | 14.662 KiB |
| With packed-struct parameters | 18.089 KiB |
| Same, with `runs: 1` override | 17.755 KiB (only −0.334 — viaIR was already optimising hard) |
| With flat `uint256[14]` parameters | 16.005 KiB |

The array makes both get and set O(1) with no branching. The cost is a few extra cold SLOADs per
call — worth a fraction of a cent on Base — and it also removes a whole class of packing bug,
since no field is ever masked into a shared slot. Values are read with `paramValue(id)` or
`allParams()`.

### 10.3 Parameter proposals are serialised

Every parameter proposal uses `target == address(this)`, so `pendingProposals` allows only one at
a time. Worse, `GovernanceModule.createProposal:239` checks that slot **without testing expiry**,
so an abandoned proposal keeps blocking all parameter governance until an admin calls
`cleanupExpiredProposals`. A pseudo-target per parameter id would allow parallel proposals, but
it puts meaningless addresses into proposal events and storage. The serialisation was accepted
instead, and both the block and its cleanup recovery are covered by tests so the behaviour is
documented rather than discovered in production. **Operational note: if parameter proposals start
reverting `ExistingActiveProposal`, run `cleanupExpiredProposals`.**

## 11. Review provenance

This design was reviewed adversarially before implementation by three independent model families:

- **Cursor (Composer)** — established that `sqrt` amplifies wallet-splitting rather than resisting it, that `StoragePool` membership is not hardware-proven, that deposit settlement must be pull-based, that pausing must not block claims, and that quorum should not be denominated in sqrt-power.
- **Kimi K3 (repo-aware)** — found the `Recovery` drain (§5), the stale-proposal block, the `getPeerIdInfo` improvement over pool-level `requiredTokens`, the open-slot definition bug, and the `burnFrom` fee-leakage point. Every one was independently confirmed by reading the source.
- **Codex / GPT-5.5** — found the finalization-liveness problem (§6), sum-stakes-before-weighting, the explicit zero-vote no-mandate rule, unique option hashes, canonical-zero values for unused proposal fields, and contributed the invariant list in §9.

Advisors unavailable during that round, recorded for completeness rather than silently skipped: agy (needs interactive auth), GLM (rate-limited), Kimi K2.7 (Cloudflare quota), MiMo (router requires account binding), Qwen3-Coder and Nemotron (OpenRouter free slugs retired).

**Unresolved disagreements, carried deliberately:**
- *Stake reuse across subjects* — Cursor considers it a flaw and wants per-subject reservation; the owner chose full counting. Mitigated by `stakeWeightBps` (dialable 100%→0% with no upgrade) and the `startTime <= createdAt` anti-snipe rule.
- *Quorum shape* — Cursor wants voters + basis; Kimi argues basis only. Both are kept, with basis load-bearing and the voter count's weakness documented in §7.
- *Multiplier size* — Kimi recommends 4–5×; the default ships at 2× and is tunable to 5× once real turnout data exists.
- *On-chain option text* — Kimi suggests CID-only with options in events. The owner's requirement is short texts on-chain, so options stay on-chain with a 64-byte cap and are also emitted for indexers.
