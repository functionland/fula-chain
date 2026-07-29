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
