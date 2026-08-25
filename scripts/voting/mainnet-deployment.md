# CommunityVoting — Base mainnet deployment record

## CANONICAL DEPLOYMENT

> **PENDING REDEPLOY (2026-08-25).** `0xD2ae210b…` is being replaced because its quorum was seeded
> unreachably — see *Why the quorum was reseeded* below. Do not publish it. Fill this table in from
> the deploy output, then update `js/governance.js` in the website repo.

| | |
|---|---|
| Network | **Base mainnet**, chainId 8453 |
| **Proxy** | `(pending)` |
| Implementation | `(pending — must be NEW; the old 0xAb96F27f… carries the old seeds)` |
| **Deployment block** | `(pending)` — the UI must start its `eth_getLogs` scan here |
| Deployment tx | `(pending)` |
| Quorum | `(pending)` — inert until `setRoleQuorum(ADMIN_ROLE, 2)` |
| Deployed | `(pending)` |

### Configuration

| | |
|---|---|
| FULA token | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| stakingEngine | `0xb2064743e3da40bB4C18e80620A02a38e87fB145` — StakingEngineLinear, **6,464,022 FULA staked** |
| storagePool | `0x0` — membership multiplier deliberately disabled, see below |
| owner / admin1 | `0x383a6A34C623C02dcf9BB7069FAE4482967fb713` |
| admin2 | `0xFa8b02596a84F3b81B4144eA2F30482f8C33D446` |

### Seeded parameters

| Param | Value | Note |
|---|---|---|
| `burnFee` | **25,000 FULA** | burned unconditionally; the real anti-spam cost |
| `deposit` | **50,000 FULA** | refunded only if quorum is met |
| `minVoteBasis` | 10,000 FULA | per-voter floor |
| `quorumVoters` | **8** | |
| `quorumBasis` | **200,000 FULA** | 8 voters averaging 25,000 — 2.5x the minimum |
| everything else | unchanged | 3–30 day duration, 3 open per creator, 1 day cooldown, 1.5x staker, 2x member |

The deploy script now reads these back off the deployed proxy and aborts if any disagrees, and
separately rejects any pairing that demands more than 10x `minVoteBasis` per voter.

Admin role timelock: 24h from deployment. `setRoleQuorum` works immediately; creating *proposals*
waits out that delay.

## Why the quorum was reseeded

The first deployment paired `quorumVoters = 15` with `quorumBasis = 5,000,000 FULA`. Both sat
inside their own bounds, every test passed and the 50-assertion live check confirmed both — but
they were never checked **against each other**, and the two are ANDed:

| | |
|---|---|
| Basis 15 minimum-sized voters actually produce | 150,000 FULA |
| Basis required | 5,000,000 FULA |
| Shortfall | **97%** |
| Voters needed at the 10,000 minimum | **500** |
| Or, with 15 voters, each must average | **333,333 FULA** |
| 5,000,000 as a share of the wired staking pool (6,464,023) | **77.3%** |

So every proposal would have burned its 100,000 deposit, and proposing would have stopped after
the first attempt. The values were also tuned against a 2B supply figure, but only **386M** FULA
exists on Base (2B is the cap across all chains, and only Base-side FULA can be locked), making the
basis threshold ~5x more aggressive again than intended.

The fee and deposit were halved in the same pass, since a redeploy makes it free to change them.

## Public UI

Live at **https://fulanetwork.github.io/proposals/** (source in the `fulanetwork.github.io`
repo: `proposals/index.html`, `css/governance.css`, `js/governance.js`).

Re-verify the read path it depends on at any time — read-only, no keys, no gas:

```
node scripts/voting/verifyUiReadPath.js
```

It checks this deployment's wiring and, against the Sepolia rehearsal, the ballot recovery,
tally, quorum and voting-power maths. 23 assertions as of 2026-08-24.

### RPC facts the UI had to be built around

Measured, not assumed. Anyone building another client will hit these.

| Endpoint (Base mainnet) | `eth_getLogs` |
|---|---|
| `base-rpc.publicnode.com` | **403 Forbidden** — refuses log queries outright |
| `1rpc.io/base` | fails |
| `base-mainnet.public.blastapi.io` | 400 |
| `base.drpc.org` | works for sparse contracts; times out on busy ones |
| `mainnet.base.org` | **works**, ~10k block ceiling |
| `base.gateway.tenderly.co` | **works**, widest ranges accepted |

Three consequences:

1. **Log support is unrelated to general RPC quality.** publicnode is the fastest endpoint for
   ordinary calls and useless for logs. A pool picked on latency alone cannot render a ballot.
2. **An empty log result is "unknown", not "none".** On Sepolia, publicnode returns a
   *successful empty array* for pruned ranges while drpc, base.org and tenderly all return the
   very same log. Accepting the first empty answer silently drops a ballot's labels. Every
   endpoint must agree before reporting nothing.
3. **Never scan backwards from head.** Ranges above ~10k blocks are rejected, so a walk back to
   the deployment block costs one request per 10k blocks — about 130 a month after deployment,
   growing without bound. Base blocks are exactly 2s and `createdAt` is in the subject, so the
   creating block is *predicted* from its timestamp: `head - (headTs - createdAt) / 2`.
   Measured error was **0 blocks** on both rehearsal subjects.

Also worth knowing for any web3.js client: every ABI input needs a `name`, or the encoder throws
`Cannot read properties of undefined (reading 'replace')` on the first call. ethers does not care,
so an ethers-based test will not catch it.

## Three superseded proxies — pause all of them once their timelocks elapse

None holds FULA and none has subjects, but all are **fully functional**: anyone who finds the
address can create subjects and lock real tokens in a contract nobody is watching.

| Proxy | Why superseded | Pausable from |
|---|---|---|
| `0xbA687E16dcAb5f4C7798C092d4cCC250AA5169BE` | Deployed accidentally (see the DRY_RUN note) | **2026-08-25 23:52:23 UTC** |
| `0x9aF96A75A80d00Ea94ceBbcdDa8E1d578df89686` | Wired to the wrong staking engine | **2026-08-26 00:02:55 UTC** |
| `0xD2ae210b415B6b7077DCEcCA680fFc3FE621542A` | Quorum seeded unreachably (see above) | **2026-08-26 00:56:15 UTC** |

`0xD2ae210b…` matters most of the three: it was published on the live site, so it is the one a
user might actually find. Pause it as soon as its timelock elapses.

```
PROXY=0x... npx hardhat run scripts/voting/retireVotingProxy.ts --network base
```

`emergencyAction(1)` is gated by `ROLE_CHANGE_DELAY` as well as `ADMIN_ROLE`, so for the first 24
hours after a deployment even a rightful admin cannot pause it — the attempt reverts with no hint
of why. The script now pre-checks and reports the unlock time. Pausing blocks `createSubject`,
`vote` and `finalize`; claims are never pausable, so it can never trap funds, and it is reversible
with `emergencyAction(2)`.

## Why storagePool is zero

`StoragePool.createPoolLockAmount` on Base is **5,000,000 wei (0.000000000005 FULA)**, effectively
zero. That value caps `requiredTokens` in both `createPool` (`StoragePool.sol:157`) and
`setRequiredTokens` (`:420`), so no pool on Base can demand more than 5e-12 FULA from a joiner, and
`lockedTokens[peerId]` can never exceed it.

`minPoolJoinStake` has a hard floor of 1 FULA (raised deliberately per audit finding F-13 so the
check cannot be neutered), and `5e6 wei < 1e18 wei`, so `lockedTokens >= minPoolJoinStake` **could
never pass**. Wiring the pool would have shipped a multiplier that silently did nothing, forever.

To enable it later: raise `createPoolLockAmount` via `setCreatePoolLockAmount` on StoragePool
(ADMIN_ROLE, capped at 100M FULA), then wire the pool through **proposal type 15**. No upgrade to
CommunityVoting is needed.

## Two incidents worth keeping, because both are now prevented in code

### 1. An intended dry run deployed for real

The command used Windows `cmd` syntax: `set DRY_RUN=1 && set TOKEN_ADDRESS=... && npx hardhat run`.
`set VAR=1 && ...` stores **`"1 "` with a trailing space**, so the script's `DRY_RUN === "1"` test
was false and it deployed. The flag failed toward *doing* the dangerous thing.

*Fixed:* `DRY_RUN` is trimmed and case-folded, and **anything non-empty except `0`/`false`/`no`
counts as a dry run**. For a flag guarding a mainnet deployment, ambiguity must fail toward not
deploying.

Also fixed alongside it: the post-deploy implementation read threw *"Contract at 0x… doesn't look
like an ERC 1967 proxy"* — a **stale-RPC artifact after a successful deployment**, not a failure.
It now retries. **If you ever see that error: do not re-run the deploy.** Check whether the printed
proxy address already has code first; it almost certainly does, and re-running orphans it.

### 2. The wrong staking engine was wired

The first two deployments used `0x3EDD28f66C14d113A955ABFeC9f3D061A795c727`, copied from
`scripts/checkProxyStorage.ts`. It is a genuine FULA staking contract, so every check passed — but
it holds ~999k staked, while the contract users actually stake in (`0xb2064743…`, the one the VIP
staking page uses) holds ~6.46M. **About 87% of staked FULA would have been invisible to voting,
silently.**

*Fixed:* `scripts/deployCommunityVoting.ts` now carries a per-chain `KNOWN_GOOD` table, refuses to
deploy when an env value disagrees with it unless `CONFIRM_OVERRIDE=1`, checks that the staking
engine governs the same token being wired, and **prints its `totalStaked`** — the one number that
distinguishes several otherwise-identical contracts, and that would have made the mistake obvious
before deploying.

**A structural limitation to state in any UI:** the contract holds exactly one staking-engine
address, and three live FULA staking contracts exist on Base (`0xb2064743…` 6.46M, `0x3EDD28f6…`
999k, `0x4E875E0A…` 935k). Stakers in the two unwired contracts get no stake-derived voting power.
They can still vote by locking FULA fresh, and the UI should say so rather than showing them a
silent zero.
