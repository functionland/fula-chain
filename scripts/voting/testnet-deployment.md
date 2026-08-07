# CommunityVoting — Base Sepolia rehearsal record

Follows the format of `scripts/bridge/testnet-deployments.md`.

## Deployment

| | |
|---|---|
| Network | Base Sepolia, chainId 84532 |
| Proxy | `0x52db4Ab6A6123BB6dE3EBB874f99A0E4B6526139` |
| Implementation | `0x46B5fFBDa0f42151b4442A85142D556966c1311B` |
| FULA token | `0x32d6929c9F552068D54481FeAe75674fD29F337e` (real testnet token, reused) |
| stakingEngine | `0x0` — not deployed on this chain; stake-derived power disabled |
| storagePool | `0x0` — not deployed on this chain; membership multiplier disabled |
| owner / admin1 | `0x694451c22627eff3Dd8C2D7002197e69FC687e7C` (`PK_TEST`) |
| admin2 | `0x68d36F6A4898C31292bdFE60B4219009C647a1bD` (`ADMIN_PK_TEST`) |
| Deployed | 2026-07-29 ~13:45 UTC |
| `setRoleQuorum(ADMIN_ROLE, 2)` | done — confirmed `2` on two independent RPCs |

Gas was never the binding constraint. Deployment plus `setRoleQuorum` cost **0.0000368 ETH** in
total at 0.011 gwei, leaving admin1 with 0.000836 ETH — several hundred more transactions' worth.
admin2 has not spent anything yet (0.000599 ETH); its first spend will be the second approval on
whichever proposal is run first.

The check script is built around this: nearly everything is a `staticCall`, so re-running the full
51-assertion battery as often as needed costs nothing at all.

Both integrations are zero. That is not a limitation of the rehearsal — it exercises the
graceful-degradation path, and either can be wired later through proposal type 15 without an
upgrade.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/voting/baseSepoliaPreflight.ts` | Read-only. Balances, token state, admin roles, FULA availability, deploy-cost estimate. Costs nothing; run it first. |
| `scripts/voting/baseSepoliaGovernanceCheck.ts` | The live battery. Almost every assertion is a `staticCall`, so it executes against real chain state through the real proxy without being mined — free to re-run. `SEND=1` additionally performs `setRoleQuorum`. |

```
npx hardhat run scripts/voting/baseSepoliaPreflight.ts --network base-sepolia
VOTING_PROXY=0x52db4Ab6A6123BB6dE3EBB874f99A0E4B6526139 \
  npx hardhat run scripts/voting/baseSepoliaGovernanceCheck.ts --network base-sepolia
```

## Result: 51 / 51 passed

Verified against the live contract and the real FULA token:

- **The `Recovery` drain guard.** Blocked for the governed token from either admin, to any
  beneficiary, for any amount down to 1 wei. This is the finding the whole design rests on, now
  confirmed on-chain rather than only against a unit-test mock.
- All 13 parameter defaults, and every one inside its own hard bounds; unknown ids rejected.
- Every subject-creation bound: option count 0/1/101, empty label, 65-byte label, duplicate
  labels, 257-byte title, 101-byte CID, and duration on both sides of the window.
- A **well-formed** subject passes every validation and dies at `burnFrom` on the real token with
  `ERC20InsufficientAllowance` (`0xfb8f41b2`). That is the positive result: it proves the fee path
  is wired to the live FULA contract, not merely that bad input reverts.
- Lifecycle guards on a non-existent subject: `getSubject`, `vote`, `finalize`, `claim`,
  `claimDeposit`, `settleDeposit` all `SubjectNotFound`.
- Upgrade authorization refuses without a passed proposal; zero target refused; non-admin refused.
- The 24h role timelock refuses proposal creation with `TimeLockActive`, exactly as expected this
  soon after deployment.

## Two operational findings from the live run

Neither is a contract defect; both would have wasted someone's time later.

1. **Some Base Sepolia RPCs strip revert data.** `base-sepolia-rpc.publicnode.com` returned a bare
   `execution reverted` for `eth_call`, making every custom error indistinguishable — the first run
   reported 25 spurious failures that were all correct reverts. `base-sepolia.drpc.org` returns the
   data. The check script now decodes revert data itself against the ABI and falls back to printing
   the raw selector, so a stripping RPC degrades to "unknown selector 0x…" instead of silence.
2. **State reads immediately after `tx.wait()` can be stale.** `setRoleQuorum` was mined
   successfully, but the read on the next line returned the pre-transaction value, which looks
   exactly like a failed write. `hardhat.config.ts` already documents this for `sepolia.base.org`;
   it also affects drpc. The script now polls until the node catches up.

## Round 2 — 2026-07-31, both time gates open

Re-ran the governance battery with the role timelock expired: **61 / 61 passed**, section I now
included — parameter bounds rejected at creation on both sides, unknown ids, the `2**32+1`
truncation guard, all three canonical-field rules, unknown proposal type, unknown integration
slot, and the positive cases (a valid parameter proposal and a valid upgrade proposal are both
accepted).

Then the token-dependent flow, with `scripts/voting/baseSepoliaVotingFlow.ts`:

| Step | Result |
|---|---|
| `fund` | 10,000,000 FULA pulled via `transferFromContract`; 2,000,000 forwarded to admin2 by plain transfer (no whitelist needed for that leg) |
| `param` | Proposal `0x8d65107ae2fceb0a32660c5ff3767ae3100264c0dec18bd20b40180960305615` — set `minDuration` to 1 day. Executable from **2026-08-01 ~01:26 UTC** |
| `create` | Subject **1** created, 541,272 gas. Closes **2026-08-03 01:27:56 UTC** |
| `vote` | admin1 → option 0 with 1,000,000 FULA; admin2 → option 1 with 250,000 FULA |
| `verify` | **29 / 29 passed** |

What the live votes confirm, against real chain state rather than a local EVM:

- **The quadratic curve.** 1,000,000 FULA gives power of exactly `1e12`; 250,000 gives exactly
  `5e11`. Four times the capital buys twice the say — the whole point of the mechanism, now
  demonstrated on-chain.
- The stored `title` and `descriptionCID` read back intact, and all three option hashes equal
  `keccak256` of the submitted labels, so the ballot commitment works as intended.
- **Conservation is exact**: contract balance equals locked plus deposit liabilities
  (1,350,000 FULA = 1,250,000 locked + 100,000 deposit).
- Every guard that should still refuse does: double vote, claim/finalize/settle before close, and
  the creator cooldown.

Deliberately, this subject will **miss quorum** (2 voters and 1.25M basis against thresholds of 15
and 5M), so the `close` step will exercise the deposit-burn path rather than the refund path.

### The stale-read trap, hit a second time

Verifying immediately after the vote transactions, the RPC served a **pre-vote** view of the
subject while already returning fresh receipts and tallies. That reads as `voterCount 0` next to
perfectly correct per-voter data — indistinguishable at a glance from a real accounting bug. A
fresh read moments later gave 29/29. The script now waits for the subject aggregate to agree with
the receipts before asserting on it.

Worth internalising: on this chain, *any* assertion made right after a transaction needs to poll,
and a partial-staleness view is more misleading than a wholly stale one.

## Round 3 — 2026-08-02: the proposal expired, which turned into a better test

**The first parameter proposal was allowed to expire unexecuted.** Its window was
`[2026-08-01 01:27:40, 2026-08-02 01:27:40)` and it was approached at 16:33 on 08-02, about 15
hours late. `minDuration` was never changed.

The cause was a reporting error, not a contract problem: the window was written down as
"executable from 08-01 01:26" and treated as a deadline to beat. It is a **24-hour window**,
`[created + 24h, created + 48h)`, and it closes. `MIN_PROPOSAL_EXECUTION_DELAY` is 24h and
`PROPOSAL_TIMEOUT` is 48h, so **an approval is only valid during the second of those two days**.
The `param` step now prints both bounds, labelled, so the closing time cannot be dropped again.

Missing it did produce something worth having: a live end-to-end demonstration of **F-11**, the
operational footgun this design records but had only ever exercised in a unit test.

| Check | Result |
|---|---|
| An expired proposal cannot be approved | `ProposalErr` |
| It **still blocks** all new parameter governance | `ExistingActiveProposal` |
| `cleanupExpiredProposals` clears the pending slot | pending → `0` |
| Parameter governance works again afterwards | valid proposal accepted |

That is the whole failure-and-recovery cycle confirmed on-chain: because every parameter proposal
targets `address(this)` and GovernanceModule's `pendingProposals` check does not test expiry, one
abandoned proposal freezes parameter governance until someone runs cleanup. **If parameter
proposals start reverting `ExistingActiveProposal`, run `cleanupExpiredProposals`.**

A replacement proposal is staged:
`0x5276169bf040218c5fc42a9dda07f89207649cc4141e5e18dde0f259ef3e0a61` — `minDuration` → 1 day,
window **2026-08-03 16:36:54 → 2026-08-04 16:36:54 UTC**.

Subject 1 was also re-verified after two days on-chain: **29 / 29**, with every stored value,
tally, receipt and the conservation identity unchanged.

Two script corrections from this round, both mine rather than the contract's:

- The **stale read struck a third time**, now on reading a proposal immediately after creating it,
  which printed the execution window as epoch zero. Three distinct places so far
  (`setRoleQuorum`, subject aggregates, proposal fetch) — on this chain, treat *any* read that
  follows a write in the same script as unreliable until polled.
- The cooldown assertion was written for "immediately after creation" and became wrong once a day
  had passed, reporting a failure where the contract was correct. It now checks
  `lastCreateAt + createCooldown` and asserts whichever behaviour is correct at the time. A
  time-dependent assertion has to compute what it expects, not assume when it runs.

## Round 4 — 2026-08-06: the full lifecycle closed out, 11 / 11

Subject 1 reached its close time and the whole settlement sequence ran against the live chain:

| Check | Result |
|---|---|
| `finalize` (permissionless) | winning option **0**, not tied |
| Quorum missed (2 voters / 1.25M basis vs 15 / 5M) | deposit **not** refundable |
| admin1 refund | exactly 1,000,000 FULA, to the wei |
| admin2 refund | exactly 250,000 FULA, to the wei |
| Creator attempts the deposit | refused, `QuorumNotMet` |
| `settleDeposit` (permissionless) | 100,000 FULA **burned**, `totalSupply` fell by exactly that |
| `totalLockedLiability` | 0 |
| `totalDepositLiability` | 0 |
| Contract FULA balance | **0** |

That completes the design's core claim end-to-end on a real network: create → vote → close →
finalize → claim → burn, ending with **nothing owed and nothing stranded**. The deposit-burn path
is the one exercised here; the refund path is still only covered by unit tests, since it needs 15
distinct voters or a governance change to `quorumVoters`.

### The parameter proposal expired a second time — and the fix is structural, not "try harder"

The replacement proposal also lapsed unexecuted (window `[2026-08-03 16:36, 2026-08-04 16:36)`).
Two misses is a pattern, not bad luck: hitting a fixed 24-hour window requires someone to act
inside it, and sessions do not reliably land there.

The mitigation is to shrink what must happen inside the window. `approveProposal` does **not**
need to land in it — GovernanceModule records the approval whenever it is called and auto-executes
only if the delay has *also* elapsed. So the second approval can be given immediately at creation,
leaving a single `executeProposal` call for the window instead of two coordinated actions.

Currently staged that way:

- Proposal `0xf483a761e52fc5b0d140baffea294c00b8434bdf114db045a4300658e300ac95` — `minDuration` → 1 day
- **Already at 2 / 2 approvals**
- Execute window: **2026-08-07 04:22:56 → 2026-08-08 04:22:56 UTC**

Run inside that range:

```
VOTING_PROXY=0x52db4Ab6A6123BB6dE3EBB874f99A0E4B6526139 \
BASE_SEPOLIA_RPC=https://base-sepolia-rpc.publicnode.com \
STEP=approve npx hardhat run scripts/voting/baseSepoliaVotingFlow.ts --network base-sepolia
```

Cleanup was exercised a second time first, and passed 3 / 3 including the pending-slot assertion
that an earlier script bug had obscured.

### RPC notes, revised

drpc began failing `eth_getTransactionCount` with `Temporary internal error` on every send, which
blocks transactions while leaving reads fine. publicnode handled the whole settlement sequence.

This also revises an earlier note: publicnode returned decodable custom errors here
(`ExistingActiveProposal`, `QuorumNotMet`), so its revert-data stripping is **not** universal as
first recorded — it varies by call shape or over time. Keep both endpoints to hand and switch on
symptom: drpc when revert names are needed and sends are failing, publicnode when they are not.

## Round 5 — 2026-08-07: the parameter change executed

`executeProposal` landed inside the window and **`minDuration` went from 259200 to 86400** on
chain. That completes the last untested governance path: create → approve → execute, end to end
on a live network.

The "approve early" change is what made it hittable. Because `approveProposal` records the second
approval whenever it is called and auto-executes only if the delay has *also* passed, the
proposal sat at 2/2 with a single `executeProposal` call left — one action inside the window
instead of two. After two consecutive misses with the old shape, the first attempt with the new
one succeeded.

Also proven functionally, not just in storage: probing one second either side of the **live**
duration bounds now rejects `86399` and accepts `86400`, so the executed change is genuinely in
force rather than merely recorded.

Next, for the deposit-**refund** path — the last remaining gap — `quorumVoters` must come down
from 15, since only `quorumBasis` (5M) is reachable with the FULA on hand. Staged the same way:

- Proposal `0xa055c86bae4f957e940fc2757aa70810012c7821ba81c78206936299ea8ff791` — `quorumVoters` → 3
- **Already at 2 / 2 approvals**
- Execute window: **2026-08-08 14:55:20 → 2026-08-09 14:55:20 UTC**

### The check scripts had to stop assuming a pristine deployment

As the live deployment accumulated state, one assertion after another began reporting failures
against a contract that was behaving correctly. All four were the same mistake in different
clothes:

| Symptom | Cause | Fix |
|---|---|---|
| 17 × `ExistingActiveProposal` | A pending proposal serialises all parameter governance (F-11) | Detect it and skip section I with an explanation |
| "well-formed subject did NOT revert" | The creator now *has* FULA, so it legitimately succeeds | Assert on whether the wallet can pay |
| 6 × wrong error on subject id 1 | Subject 1 exists and is settled, so guards return `SubjectClosed` / `AlreadyFinalized` / … | Use `subjectCount + 1000`, an id that cannot exist |
| `minDuration` "wrong" | Governance changed it — the very thing being tested | Report deviation from default as a NOTE; assert bounds, which must always hold |

The general rule, learned the hard way over several rounds: **a live check must derive its
expectations from current chain state.** Anything hardcoded to a fresh deployment — a balance, an
id, a parameter value, an empty proposal slot — becomes a false alarm the moment the environment
moves, and false alarms are worse than no check because they train you to ignore the output.

Current battery: **49 / 49**, with section I correctly skipped while a proposal is pending.

## Still outstanding, and why

Both are time gates, not defects.

| Gate | Unlocks | Blocks |
|---|---|---|
| Contract's own `ROLE_CHANGE_DELAY` | **2026-07-30 13:45:16 UTC** | Creating any proposal, so: parameter-bound rejection at create, canonical-field enforcement, the `2**32+1` id-truncation guard, and the whole create → approve → 24h → execute flow |
| admin1's token whitelist lock | **2026-07-30 00:34:06 UTC** | `transferFromContract`, so no wallet holds FULA, so: create subject → vote → finalize → claim → deposit settlement |

Deploying on 07-29 started the first clock as early as possible. Sequence once both open:

1. After 00:34 UTC — `transferFromContract(admin1, N)`, then plain ERC-20 transfers to test wallets
   (no whitelist needed for those). Needs ≥150,000 FULA per subject at default parameters, plus
   whatever voters lock.
2. After 13:45 UTC — re-run `baseSepoliaGovernanceCheck.ts`; section I runs automatically once the
   timelock has expired, covering the parameter battery.
3. Then the voting flow. Note the shortest legal subject is **3 days** (`minDuration`), so a full
   create → vote → close → finalize → claim cycle takes 3 days unless `minDuration` is first
   lowered to its 1-day floor by governance — which itself needs a 24h proposal. Lowering it is
   worth doing first.
