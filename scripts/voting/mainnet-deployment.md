# CommunityVoting — Base mainnet deployment record

## CANONICAL DEPLOYMENT

**Use `0xD2ae210b415B6b7077DCEcCA680fFc3FE621542A`.** This is the address to publish, index and
build against.

| | |
|---|---|
| Network | **Base mainnet**, chainId 8453 |
| **Proxy** | **`0xD2ae210b415B6b7077DCEcCA680fFc3FE621542A`** |
| Implementation | `0xAb96F27f666f29C5e6A274f9c610C069650A88c2` |
| **Deployment block** | **50415014** — the UI must start its `eth_getLogs` scan here |
| Deployment tx | `0x59756986109e84ebb4bb5145dd8ab41740e3c0dd158c9be14a408170ff970a86` |
| Quorum | **2**, set in block 50415165 |
| Deployed | 2026-08-25 |

### Configuration

| | |
|---|---|
| FULA token | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| stakingEngine | `0xb2064743e3da40bB4C18e80620A02a38e87fB145` — StakingEngineLinear, **6,464,022 FULA staked** |
| storagePool | `0x0` — membership multiplier deliberately disabled, see below |
| owner / admin1 | `0x383a6A34C623C02dcf9BB7069FAE4482967fb713` |
| admin2 | `0xFa8b02596a84F3b81B4144eA2F30482f8C33D446` |
| Parameters | all at deployment defaults |

Verification: **50 passed, 0 failed** via `scripts/voting/votingGovernanceCheck.ts`, including the
Recovery drain guard against the live FULA token, all 13 parameter defaults and bounds, every
subject-creation bound, and all lifecycle guards.

Admin role timelock elapses **2026-08-26 00:56:15 UTC**; proposals cannot be *created* before then.

## Two superseded proxies — pause both once their timelocks elapse

Neither holds FULA and neither has subjects, but both are **fully functional**: anyone who finds
the address can create subjects and lock real tokens in a contract nobody is watching.

| Proxy | Why superseded | Pausable from |
|---|---|---|
| `0xbA687E16dcAb5f4C7798C092d4cCC250AA5169BE` | Deployed accidentally (see the DRY_RUN note) | **2026-08-25 23:52:23 UTC** |
| `0x9aF96A75A80d00Ea94ceBbcdDa8E1d578df89686` | Wired to the wrong staking engine | **2026-08-26 00:02:55 UTC** |

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
