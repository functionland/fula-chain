# Sepolia ↔ Base Sepolia bridge rehearsal — deployment record

Stage 0 of the rollout in `docs/bridge-design.md`. **Testnet only.** Nothing here has any authority
on mainnet.

## Design: LOCK / RELEASE ESCROW — the token is NOT modified

The bridge is a LayerZero `OFTAdapter`: it locks tokens on the source chain and releases
pre-funded tokens on the destination. **Nothing is minted or burned anywhere.**

`contracts/core/StorageToken.sol` is byte-for-byte identical to the source verified on Etherscan for
the live Ethereum and Base deployments. There is no token upgrade, no mint authority, no governance
proposal granting anything, and no storage change to a live proxy. The adapter is an ordinary
holder — `verifyOAppConfig.ts` asserts it holds no admin and no bridge-operator role.

The earlier mint/burn design (`MintBurnOFTAdapter` + `bridgeMinters` inside the token) was
**abandoned** for this reason. It required upgrading a live ~1.47B-token contract and introducing a
`burn(address,uint256)` with no allowance check.

## Keys

Deliberately NOT the production keys. `PK`/`ADMIN_PK` are live mainnet `ADMIN_ROLE` holders and are
excluded from every testnet network entry in `hardhat.config.ts`.

| Role | hardhat var | Address |
|---|---|---|
| Deployer / adapter owner / LZ delegate | `PK_TEST` | `0x694451c22627eff3Dd8C2D7002197e69FC687e7C` |
| Second admin (token governance quorum) | `ADMIN_PK_TEST` | `0x68d36F6A4898C31292bdFE60B4219009C647a1bD` |

## Current addresses (escrow adapters, redeployed 2026-07-28 with the post-audit controls)

| Contract | Sepolia (eid 40161) | Base Sepolia (eid 40245) |
|---|---|---|
| StorageToken proxy | `0x32d6929c9F552068D54481FeAe75674fD29F337e` | `0x32d6929c9F552068D54481FeAe75674fD29F337e` |
| **FulaOFTAdapter (escrow)** | **`0x1a93D27cE441e86D3Fe0B2c3C7f76a9B6BA936f3`** | **`0x6bE953e030C23F4728446112aeD4AdB6ace19eD6`** |
| LZ EndpointV2 | `0x6EDCE65403992e310A62460808c4b910D972f10f` | `0x6EDCE65403992e310A62460808c4b910D972f10f` |

These carry the two controls added after the escrow audit: a **separate gross inbound rate limiter**
and the one-way **`lockPeers()`** latch. The previous escrow pair predates both and was replaced
before any liquidity was seeded into it, so nothing had to be recovered.

⚠️ **SUPERSEDED — never authorize or use.** Three earlier generations exist on both chains:
the mint/burn adapters `0xf3AC78cB0a98E72d6fC60Cf8865b31CcEF09d3f7`,
`0x1491E7d10778582346F97ad320CEEBcAA98cE8A6` (Sepolia) /
`0x967d80629a03f136478e7A55916767223FAEec82` (Base Sepolia) — none ever authorized as bridge
minters, so all inert — plus the **first escrow pair**,
`0x1E90000F0Ef8aaFe9a9FeC9E61dBAbABa5330Ac4` (Sepolia) /
`0xd07B62b5BF5030Adbfa722E7ABd1152D4c6396c0` (Base Sepolia), which lack the inbound limiter and the
peer latch. All are empty. Do not send tokens to any of them.

⚠️ **The testnet token proxies predate the revert** and therefore still contain the abandoned
mint/burn surface (`mint`, `burn(address,uint256)`, `bridgeMinters`). Nothing is authorized, so it
is dead code, and the escrow adapter never touches it — it uses only `transferFrom`/`transfer`/
`balanceOf`. The escrow rehearsal is faithful; the testnet token simply carries extra unused
functions that mainnet does not. Redeploying the token to remove them would restart a 24h governance
timelock for no behavioural gain.

### Live configuration

**Two independent buckets, both fail-closed.**

*Outbound* **200,000,000 FULA / 86400s** — throttles how fast tokens leave, **shared by all users**
(not per-user), a leaky bucket rather than a daily quota: 200M immediately, then ~2,315 FULA/s
refill. Failure is source-side, so nothing is locked.

*Inbound* **20,000,000 FULA / 86400s** — bounds how much escrow a single forged or maliciously
authorised message can remove. This one is **gross**, not netted, because an attacker draining the
escrow never sends anything back to offset. The bucket starts full, so 20M *is* the instant
first-tranche loss; size it at 10–25% of that chain's escrow and revisit as escrow grows. Failure is
destination-side and **parks retryably** — delay, never loss.

**DECIDED (owner, 2026-07-29): the inbound limit is a FLAT 20,000,000 / 24h on testnet AND mainnet,
against a 200,000,000 escrow seeded manually on each chain.** That is 10% — the intended ratio — so
no per-chain re-sizing is needed and the testnet configuration mirrors mainnet exactly.

⚠️ **The one rule that must not be broken: the inbound limit must stay STRICTLY BELOW the escrow
balance.** `_credit` checks liquidity *before* the inbound limit, so if the limit is at or above
escrow it can never fire — anything larger than escrow already reverted `InsufficientLiquidity`, and
anything small enough to pass is by definition under the limit. Such a limit is not weak, it is
**inert**. `verifyOAppConfig.ts` now FAILS on that condition rather than merely noting it.

Practical consequence: **seed at least 200M before relying on the 20M limit.** Seeding materially
less without lowering the limit silently disables the control. Both testnet token contracts hold
enough (Sepolia 1.47B, Base Sepolia 386.3M) and the testnet `ADMIN_ROLE` transaction limit is 2B, so
200M is a **single** `transferFromContract` call on each chain.

Enforced `lzReceive` gas **250,000** (placeholder — replace with 1.5× measured). Confirmations **2**.
R-07 cross-chain ULN digest matches on all four sides:
`0x814df23ea8bb5af98dcea243dd847163efe435cefea2b039d968792284e157d7`

`verifyOAppConfig.ts` currently reports **5 failures per chain**, all expected:

| Failure | Why |
|---|---|
| owner is an EOA, not a timelock | testnet only; **must** be a timelock on mainnet |
| ≥2 verifiers required (send) | only one DVN exists on these testnets |
| ≥2 verifiers required (receive) | same |
| peer set is FROZEN (`lockPeers` called) | **intentionally not yet locked** — lock only after a real transfer is proven end to end, since it is irreversible |
| adapter holds escrow liquidity | **not yet funded — this is the remaining step** |

The first three can never pass on testnet. The last two are the escrow-specific gates that replaced
"adapter is an authorized bridge minter" and "cap is non-zero".

### Rehearsal results — the bridge is PROVEN end to end (2026-07-30)

| Step | State |
|---|---|
| `AddWhitelist` for the deployer `0x694451c2…`, both chains | EXECUTED 2026-07-29 00:33 UTC |
| 24h whitelist lock | expired 2026-07-30 00:34 UTC |
| Escrow seeded, **200,000,000 FULA on each chain** | **DONE** |
| First cross-chain send Sepolia → Base Sepolia (100 FULA) | **DELIVERED in ~75s** |
| Return leg Base Sepolia → Sepolia (25 FULA) | **DELIVERED in ~180s** |
| Fail/retry drill via the inbound kill switch | **PASSED** — see below |
| `lzReceive` gas measured | **143,659** (1.5× = 215,488) |
| `lockPeers()` on both adapters | **NOT YET CALLED** — irreversible, awaiting go-ahead |

**Supply conservation, observed live.** After both legs, `reconcileSupply.ts` reports global supply
delta **0** and total escrow delta **0**: Sepolia holds 200,000,125 and Base Sepolia 199,999,875,
summing to exactly the 400,000,000 seeded. Tokens moved between escrows; none were created or
destroyed. This is the headline property demonstrated on a real network rather than in a mock.

**Fail/retry drill.** Rather than a blacklist (which needs a 24h governance proposal), the drill used
the inbound rate limiter as an immediate kill switch — which also exercises the new control live:

1. `setInboundRateLimits(eid, 0)` on Base Sepolia — takes effect next block, no governance.
2. Sent 50 FULA from Sepolia. It locked on the source and **did not deliver for 3 minutes**;
   destination escrow and recipient balance both untouched.
3. Restored the limit to 20M. The **same parked message delivered automatically within ~15s** —
   the executor retried on its own; no manual intervention and no resend.

That is the non-destructive-failure property end to end: refusing a release delays it, never loses
it, and the kill switch works in both directions without pausing the token.

**Enforced `lzReceive` gas needs no change.** Measured 143,659 for the whole delivery transaction
against a *fresh* recipient — the expensive case, since crediting a zero balance is a cold storage
write. 1.5× is 215,488, comfortably under the configured 250,000. The design note calling 250,000 a
placeholder to be re-tuned is therefore resolved: it is adequately sized as-is.

Executing a proposal that reached quorum *before* its window opened needs `executeProposal`, not
`approveProposal` — the latter only auto-executes when the final approval arrives at or after the
execution time, and any further approval reverts `ProposalErr(4)`. `approveProposal.ts` now detects
that state and calls `executeProposal` instead.

The old `SetBridgeMinter` proposals were deliberately left at 1/2 and **never approved**, so they
cannot execute. They expire 2026-07-30 00:26 UTC. Approving one would grant mint authority to a
superseded mint/burn adapter.

⚠️ **`lockPeers()` is irreversible.** Until it is called, whoever owns the adapter can repoint a lane
at an address they control and drain the entire escrow — no DVN compromise required, and proven by
the regression test *"E-01: the OWNER can drain the whole escrow by rotating setPeer, locking
nothing"*. Lock it once, after the bridge is proven; after that neither adapter can be replaced
without redeploying both and migrating liquidity.

## Remaining: seed liquidity, then transfer

A chain can only release what it holds, so **both adapters must be funded before any transfer will
complete.** Nothing else is outstanding — the bridge is fully wired.

Funding requires moving tokens out of the token contract, which needs the recipient whitelisted:

1. **2026-07-29 ~00:26 UTC** — approve the pending `AddWhitelist` proposal for the deployer
   (`0x694451c2…`), already filed on both chains:
   `npx hardhat run scripts/bridge/approveProposal.ts --network <net>`
2. **+24h (whitelist lock)** — `transferFromContract(deployer, amount)`, then a plain ERC-20
   `transfer` from the deployer to the adapter. A normal transfer needs no whitelist, so the
   adapter itself never has to be whitelisted.
3. Then run the first real cross-chain send, the fail/retry drill, and measure `lzReceive` gas.

The `SetBridgeMinter` proposals filed under the old design are now meaningless — **let them expire**
(2026-07-30). Approving them would grant mint authority to a superseded adapter.

### Mainnet liquidity note

Ethereum's token contract holds **1,308,990,141 FULA**, so that side is trivially fundable. Base's
holds only **4,239 FULA** — its 386M supply is circulating. Seeding the Base adapter therefore needs
either team-held Base tokens, or a one-time `bridgeOp` move (burn from Ethereum's contract balance
with `op=2`, mint into Base's with `op=1`), which uses only existing audited functionality and
leaves global supply unchanged.

## Bugs found by this rehearsal (all fixed)

The rehearsal has now caught six defects that would have hit mainnet identically:

1. **`wireOApp.ts` could not encode `setConfig` at all** — the endpoint ABI used an anonymous tuple,
   so ethers v6 rejected the object arguments. The DVN/executor security stack could never have been
   configured.
2. **`wireOApp.ts` was not re-runnable** — the endpoint reverts when a library is set to its current
   value, so any partial failure left wiring stuck. Each step now detects "already applied".
3. **`verifyOAppConfig.ts` told operators to compare a digest that can never match** — it hashed raw
   DVN *addresses*, which differ per chain. Now emits an operator-name-based cross-chain digest.
4. **`wireOApp.ts` skipped `setSendLibrary` on a brand-new adapter** — `getSendLibrary` lazily falls
   back to LayerZero's default, so it read "already set" while nothing was pinned, leaving the
   adapter on LayerZero's **mutable** default. Now uses `isDefaultSendLibrary`.
5. **Nonce races aborted wiring mid-run** — pending nonce re-queried per transaction reads stale
   from public RPCs. Now fetched once and advanced locally.
6. **`deployOFTAdapter.ts` failed its own post-deploy assertions** — public RPCs serve stale state
   for seconds after a deployment, so a contract that exists reads back as `0x`. Now polls for the
   code before asserting.

Plus one contract-level find, from the escrow test suite: **sub-dust sends silently succeeded as
no-ops** (`_removeDust` → 0, and an ERC-20 transfer of 0 succeeds), letting a user pay a LayerZero
fee for an empty message and slip past a zero rate limit. Fixed with `ZeroAmountAfterDust`.

## Ops gotchas

- `https://sepolia.base.org` and `https://ethereum-sepolia.publicnode.com` both serve **stale state
  right after a deploy**. `deployOFTAdapter.ts` now polls; the config default for base-sepolia is
  `base-sepolia-rpc.publicnode.com`.
- Alchemy's key works for Base mainnet + sepolia but **403s on Ethereum mainnet**.
- Etherscan V2 free tier covers chainid 1 but **not** 8453.
- Testnet DVNs (read live, not from docs): sepolia `0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193`,
  base-sepolia `0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6`.
- **Two constants named `PROPOSAL_TIMEOUT` disagree**: `GovernanceModule.sol:78` = **48h** (live,
  used by `_initializeProposal`) and `ProposalTypes.sol:33` = 3 days (**dead**). Computing a
  deadline from the dead one lands 24h past expiry.
