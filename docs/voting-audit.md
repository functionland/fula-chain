# CommunityVoting — Security Audit Record

**Scope:** `contracts/core/CommunityVoting.sol`, `contracts/governance/interfaces/ICommunityVoting.sol`
**Version reviewed:** branch `claude/community-voting-quadratic`
**Date:** 2026-07-27
**Status:** PRE-DEPLOYMENT. Not yet deployed to any network.

Companion document: `docs/voting-design.md` (design record, threat model, rationale).
Follows the format of `docs/bridge-audit.md`.

---

## 1. Method

The contract was built in gated steps, each with its own tests, and reviewed adversarially at two
points: once at design time, before any code existed, and once against the finished
implementation. Reviews came from three independent model families (Cursor/Composer,
Moonshot Kimi K3, OpenAI Codex/GPT-5.5), two of which read the actual repository rather than a
pasted description.

Out of scope: `GovernanceModule`, `StorageToken`, `StakingEngineLinear` and `StoragePool`
themselves, which were audited separately by Hashlock. Their *interaction surface* with this
contract is in scope, and two findings below concern exactly that.

---

## 2. Findings register

Severity reflects impact on this contract's users.

### F-1 — CRITICAL — Inherited `Recovery` proposal drains all locked user funds — **FIXED**

`GovernanceModule` ships proposal type 4 (`Recovery`). `createProposal:259-280` accepts it guarded
only by `tokenAddress != address(this)`, and `_executeProposal:530-544` then executes
`IERC20(tokenAddress).transfer(target, amount)` from the inheriting contract's own balance.

CommunityVoting custodies voter locks and creator deposits denominated in FULA. Inheriting this
path unchanged would have let two admins transfer **every locked token** to any address — directly
contradicting the "no admin rescue" property the design is built on.

*Found by:* Kimi K3 (repo-aware design review). *Confirmed by:* reading the source directly.

*Fix:* `createProposal` is overridden to revert `RecoveryBlocked` when
`proposalType == Recovery && tokenAddress == address(token)`. Recovery of unrelated tokens
accidentally sent to the contract remains available.

*Implementation note:* Solidity forbids `super.f()` on a function the parent declared `external`,
so this could not be a guard-and-delegate. The parent body is mirrored with one added branch, and
**every** inherited branch (role change, upgrade, recovery-of-other-token, zero target, duplicate
pending proposal, unknown role, unknown type, missing quorum, non-admin caller) has a dedicated
test so future divergence from `GovernanceModule` is caught rather than assumed away.

*Verification:* proven by test while the contract holds a real 1,000,000 FULA balance.

### F-2 — HIGH — Token-level failure could permanently prevent finalization — **FIXED**

The original design burned a failed deposit inside `finalize`. Burning is an external call into
FULA, so if the token were paused, or this contract were blacklisted, `finalize` would revert —
meaning a poll's **result could never be recorded at all**, permanently.

*Found by:* Codex/GPT-5.5 (design review).

*Fix:* `finalize` now performs **no external calls whatsoever**. It only records the winner, the
tie flag and the deposit liability. A separate, permissionless `settleDeposit` performs the burn
and may be retried at any time.

*Verification:* a test finalizes a subject while the **token itself is paused**.

### F-3 — HIGH — Pausing would have trapped user funds — **FIXED**

Following the repo's prevailing idiom (`StoragePool.claimTokens:462` is `whenNotPaused`) would
have made claims pausable. `emergencyAction` is a **single-admin** call with a shared 30-minute
cooldown, so one signature could have frozen every voter's locked tokens indefinitely.

*Found by:* Cursor, independently reinforced by Kimi K3.

*Fix:* `claim`, `claimMany`, `claimDeposit` and `settleDeposit` are deliberately **not**
`whenNotPaused`. Pausing stops `createSubject`, `vote` and `finalize` — new participation — and
never completed positions. This is a conscious departure from the repo idiom, documented in code.

*Verification:* a test claims successfully while the contract is paused.

### F-4 — MEDIUM — Membership multiplier was backed by an unenforceable signal — **FIXED**

The multiplier originally keyed off pool membership plus the pool's advertised `requiredTokens`.
That is not evidence of anything: a privileged `createPool` records `lockedTokens = 0`
(`StoragePool.sol:183`) and a pool admin can `addMember` directly (`:307`), so a pool can advertise
a high requirement while a given member has staked nothing.

*Found by:* Kimi K3 and Codex independently.

*Fix:* eligibility now reads the peer's **own** `lockedTokens` via `getPeerIdInfo` and requires it
to meet `minPoolJoinStake`, plus a minimum membership age, live membership, and a not-forfeited
account.

*Residual risk:* see §4.1 — this raises the cost of a fake identity, it does not eliminate it.

### F-5 — MEDIUM — Stale `joinTimestamp` could outlive a membership — **FIXED**

`StoragePool.joinTimestamp` is keyed by peer id **globally**, is overwritten on re-join, and is
not cleared when a peer is removed unless it was the member's last (`StoragePool.sol:118-128`). A
non-zero timestamp can therefore describe a membership that no longer exists.

*Found by:* Kimi K3.

*Fix:* live membership is re-resolved on every vote; the timestamp is never trusted alone.

*Verification:* a test clears membership while deliberately leaving the timestamp behind, and
confirms the multiplier is refused.

### F-6 — MEDIUM — Abandoned subjects would occupy creator slots forever — **FIXED**

Defining "open" as "not yet finalized" would let a subject nobody bothers to finalize hold one of
a creator's three slots permanently, since finalization is voluntary.

*Found by:* Kimi K3.

*Fix:* a slot is occupied only while `closeTime` is in the future. The list is pruned on each
create, bounded by `maxOpenPerCreator`.

*Verification:* a test creates three subjects, confirms the cap bites, then creates a fourth after
one closes — **without ever calling `finalize`**.

### F-7 — MEDIUM — Governance could retroactively decide a creator's refund — **FIXED**

Evaluating the refund quorum against current parameters would let a post-hoc governance change
decide whether a creator gets their deposit back.

*Found during implementation* while writing `settleDeposit`.

*Fix:* `quorumBasisAt` and `quorumVotersAt` are snapshotted into the subject at creation. A
creator is judged against the rules they paid under.

*Verification:* covered by test.

### F-8 — MEDIUM — Last-block stake sniping — **FIXED**

Stake-derived power costs nothing per subject (the same stake counts toward every open subject).
Without an age rule, someone could buy FULA, open a 365-day stake moments before close, and swing
a result at no marginal cost.

*Found by:* Kimi K3, echoed by Codex.

*Fix:* a stake qualifies only if `startTime <= subject.createdAt`.

*Verification:* covered by test.

### F-9 — LOW — Non-canonical proposal encodings — **FIXED**

Unused proposal fields left free would let several differently-encoded proposals describe the same
parameter change, complicating review and de-duplication. Separately, `uint8(id)` truncation could
have turned an id of `2**32 + 1` into a valid parameter id.

*Found by:* Codex.

*Fix:* unused fields must be canonically zero; the id is range-checked **as a uint40** before any
narrowing, so truncation cannot produce a valid id.

*Verification:* both covered by test, including the specific `2**32 + 1` case.

### F-10 — LOW — Duplicate option labels — **FIXED**

Duplicate or look-alike ballot labels split a vote and make a "winner" ambiguous to humans.

*Found by:* Codex.

*Fix:* options must be non-empty, ≤64 bytes, and `keccak256`-unique within a subject.

### F-11 — INFORMATIONAL — Parameter governance is serialised and jams on an expired proposal

All parameter proposals use `target == address(this)`, so only one can be pending at a time.
`GovernanceModule.createProposal:239` checks that slot **without testing expiry**, so an abandoned
proposal keeps blocking parameter governance until `cleanupExpiredProposals` is called.

*Status:* ACCEPTED, documented, and covered by a test that reproduces both the jam and its
recovery. A pseudo-target per parameter would allow parallel proposals but would put meaningless
addresses into proposal events and storage.

**Operational note: if parameter proposals begin reverting `ExistingActiveProposal`, run
`cleanupExpiredProposals`.**

---

## 3. Invariants

Asserted by the test suite; §5 records which are machine-checked continuously.

1. **Solvency** — `balanceOf(contract) >= totalLockedLiability + totalDepositLiability`, including
   with `platformFeeBps` anywhere in 1–500.
2. **Conservation** — every token received is exactly one of burned, currently owed, or already
   claimed; never assigned to two liabilities.
3. **Power integrity** — recorded basis equals the measured fresh-lock delta plus the once-weighted
   sum of distinct, caller-owned, qualifying stakes.
4. **No double vote** — after a wallet's first successful vote it can change no tally.
5. **Quorum purity** — only *basis* counts toward quorum; never quadratic or multiplied power. The
   multiplier boosts influence, never the capital test.
6. **Multiplier once** — a wallet can receive the multiplier at most once per subject.
7. **Finalize idempotence** — repeat calls cannot change the winner, tie flag, deposit entitlement
   or burn amount.
8. **Claim isolation** — one voter's failure (blacklist, revert) cannot block another's claim.
9. **No trapped funds** — after a full cycle, liabilities and the contract's balance both reach
   zero.

---

## 4. Accepted risks — stated plainly

### 4.1 Square-root voting is sybil-*positive*, not sybil-resistant

Splitting capital `C` across `n` wallets yields `n · sqrt(C/n) = sqrt(n) · sqrt(C)` — an
amplification of `sqrt(n)`, bounded above by plain linear voting. `minVoteBasis` sets the optimal
sybil chunk size and is the cheapest dial for tightening it.

The membership multiplier is the brake, and it is a *cost* brake, not a proof of personhood. If
`StoragePool.createPoolLockAmount` is zero on the live deployment, creating pools is free and a
motivated actor can self-approve sybil members; `minPoolJoinStake` and `minMembershipAge` then
carry the whole defence. **The deploy script reads this value and warns.**

This is whale *friction* and provider-weighting. Documentation and UI must not describe it as
whale resistance.

### 4.2 UUPS upgradeability is the real trust root

With `Recovery` blocked and no rescue function, the remaining admin power over locked funds is the
**upgrade itself** (two admins, 24h delay). Because locks can run up to 90 days, a 24-hour upgrade
notice is **not** a user exit window. Depositors should price this.

Recommended practice: announce any upgrade through a subject first, and dogfood the mechanism.

### 4.3 Inherited token-level risks

- Blacklisting the voting contract would freeze every lock and every burn.
- Blacklisting a voter freezes that voter's own claim; with `Recovery` blocked their funds wait
  until StorageToken governance unblacklists them. This is the accepted cost of removing the
  admin drain.
- Pausing FULA blocks `transfer` and therefore blocks claims — outside this contract's control.
- A non-zero `platformFeeBps` means a voter loses the fee on the way in *and* on the way out.
  Accounting stays correct; the round-trip loss is user-visible and must be surfaced in the UI.

### 4.4 Quorum proves capital, not participation

Quorum is `voterCount >= quorumVotersAt && totalBasis >= quorumBasisAt`. The **basis term is the
load-bearing one**; distinct addresses cost roughly a cent to manufacture, so the voter count is a
weak secondary floor. A creator can legitimately vote on their own subject. The deposit is best
understood as an anti-spam capital requirement, not a guarantee of organic turnout.

---

## 5. Test coverage

118 tests across five suites, all passing.

| Suite | Focus |
|---|---|
| `CommunityVotingLayout.test.ts` | Storage layout pinned slot-by-slot; Legacy-group placement at slot 11; trailing gap; `validateImplementation` |
| `CommunityVoting.test.ts` | Initialization, parameter bounds, the Recovery guard, every mirrored `createProposal` branch, proposal types 14/15 |
| `CommunityVotingSubjects.test.ts` | Ballot shape, fee burn, deposit capture, cooldown, slot accounting, fee-on-transfer, pause |
| `CommunityVotingVote.test.ts` | sqrt fuzzed against an off-chain reference over ~230 values from 1 wei to the full 2e27 supply; stake qualification; multiplier eligibility |
| `CommunityVotingClose.test.ts` | Finalization semantics, claims, deposit settlement, liveness under pause and blacklist |

Notable properties proven rather than argued:

- The Recovery drain is blocked **while the contract holds 1,000,000 FULA**.
- Finalization succeeds **while the token is paused**.
- Claims succeed **while the voting contract is paused**.
- A blacklisted voter's failure **does not block any other voter**.
- A creator's deposit is refundable **without anyone calling `finalize`**.
- A slot is freed **without anyone calling `finalize`**.
- `Math.sqrt` matches an independent integer square root exactly across the realistic range.

Solidity-coverage was deliberately deferred to this step rather than run mid-build, where most of
the contract did not yet exist and the numbers would have been misleading.

---

## 6. Deployment preconditions

1. `setRoleQuorum(ADMIN_ROLE, 2)` — the contract is **inert** until this is set; quorum defaults to
   0 and `_validateQuorum` rejects anything below 2. Both initial admins are timelocked for 24h
   after initialization, so it cannot run immediately.
2. `OWNER` and `ADMIN` must be **distinct** — `createProposal` auto-approves for its proposer, so a
   single address can never reach quorum 2. The deploy script enforces this.
3. Read live `StoragePool.createPoolLockAmount` and `StorageToken.platformFeeBps` before launch;
   both underpin assumptions above. The deploy script reads and warns on both.
4. Base Sepolia rehearsal before mainnet.
