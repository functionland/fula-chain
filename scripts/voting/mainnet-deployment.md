# CommunityVoting — Base mainnet deployment record

## Deployed

| | |
|---|---|
| Network | **Base mainnet**, chainId 8453 |
| Proxy | `0xbA687E16dcAb5f4C7798C092d4cCC250AA5169BE` |
| Implementation | `0xab96f27f666f29c5e6a274f9c610c069650a88c2` |
| FULA token | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| stakingEngine | `0x3EDD28f66C14d113A955ABFeC9f3D061A795c727` (StakingEngineLinear) |
| storagePool | `0x0` — membership multiplier deliberately disabled, see below |
| owner / admin1 | `0x383a6A34C623C02dcf9BB7069FAE4482967fb713` |
| admin2 | `0xFa8b02596a84F3b81B4144eA2F30482f8C33D446` |
| Deployed | 2026-08-24 |

Verified on-chain after deployment: token wired to FULA, staking engine wired, storage pool zero,
`adminCount` 2 with both addresses holding `ADMIN_ROLE`, parameters seeded at their defaults
(`burnFee` 50,000 FULA), `subjectCount` 0.

## ⚠️ REQUIRED before the contract does anything

```
setRoleQuorum(ADMIN_ROLE, 2)
```

`roleConfigs[ADMIN_ROLE].quorum` is **0**, and `_validateQuorum` rejects anything below 2, so **no
proposal can be created until this is called**. It carries no timelock and can run immediately.

Note also that both initial admins are under a 24-hour `ROLE_CHANGE_DELAY` from deployment, so
while `setRoleQuorum` works straight away, *creating* a proposal does not until that lapses.

## Why storagePool is zero

`StoragePool.createPoolLockAmount` on Base is **5,000,000 wei (0.000000000005 FULA)**, effectively
zero. That value caps `requiredTokens` in both `createPool` (`StoragePool.sol:157`) and
`setRequiredTokens` (`:420`), so no pool on Base can demand more than 5e-12 FULA from a joiner,
and therefore `lockedTokens[peerId]` can never exceed it.

`minPoolJoinStake` has a hard floor of 1 FULA (raised deliberately per audit finding F-13 so the
check cannot be neutered), and `5e6 wei < 1e18 wei`, so the eligibility test
`lockedTokens >= minPoolJoinStake` **could never pass**. Wiring the pool would have shipped a
multiplier that silently did nothing for everyone, forever.

To enable it later: raise `createPoolLockAmount` via `setCreatePoolLockAmount` on StoragePool
(ADMIN_ROLE, capped at 100M FULA) so pools can require a real join stake, then wire the pool
address through **proposal type 15**. No upgrade to CommunityVoting is needed.

## How this deployment happened, and the lesson

It was intended as a dry run. The command used Windows `cmd` syntax:

```
set DRY_RUN=1 && set TOKEN_ADDRESS=... && npx hardhat run ...
```

`set VAR=1 && ...` stores **`"1 "` with a trailing space**, so the script's `DRY_RUN === "1"` test
was false and it deployed for real. The deployment itself is correct and matches what was
intended, so nothing was lost — but the flag failed toward *doing* the dangerous thing.

Both causes are now fixed in `scripts/deployCommunityVoting.ts`:

1. `DRY_RUN` is trimmed and case-folded, and **anything non-empty except `0`/`false`/`no` counts
   as a dry run**. For a flag guarding a mainnet deployment, ambiguity must fail toward not
   deploying.
2. The post-deploy implementation read now retries. It originally threw
   *"Contract at 0x… doesn't look like an ERC 1967 proxy with a logic contract address"* — a
   **stale-RPC artifact after a successful deployment**, not a failure. The proxy address printed
   before it is authoritative.

**If you ever see that ERC-1967 error again: do not re-run the deploy.** Check whether the printed
proxy address already has code first — it almost certainly does, and re-running would deploy a
second contract and orphan the first.
