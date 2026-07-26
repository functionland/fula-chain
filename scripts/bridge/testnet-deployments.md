# Sepolia ↔ Base Sepolia bridge rehearsal — deployment record

Stage 0 of the rollout table in `docs/bridge-design.md`. **Testnet only.** Nothing here has any
authority on mainnet.

## Keys

Deliberately NOT the production keys. `PK`/`ADMIN_PK` are live mainnet `ADMIN_ROLE` holders and are
excluded from every testnet network entry in `hardhat.config.ts`.

| Role | hardhat var | Address |
|---|---|---|
| Deployer / owner / LZ delegate | `PK_TEST` | `0x694451c22627eff3Dd8C2D7002197e69FC687e7C` |
| Second admin (quorum) | `ADMIN_PK_TEST` | `0x68d36F6A4898C31292bdFE60B4219009C647a1bD` |

The second admin is structurally required: `ADMIN_ROLE` quorum is 2 and `createProposal`
auto-approves for its proposer, so one key can never execute a proposal.

## Deployed 2026-07-26

Addresses are **identical on both chains** — same fresh deployer, same nonce sequence, so `CREATE`
yields the same addresses. This is the same phenomenon that makes Ethereum's *implementation*
address equal Base's *proxy* address on mainnet. Do not read anything into it.

| Contract | Sepolia (eid 40161) | Base Sepolia (eid 40245) |
|---|---|---|
| StorageToken proxy | `0x32d6929c9F552068D54481FeAe75674fD29F337e` | `0x32d6929c9F552068D54481FeAe75674fD29F337e` |
| StorageToken impl | `0x9f49C2F490A90983f58651FDb857D934E473A3b9` | `0x9f49C2F490A90983f58651FDb857D934E473A3b9` |
| FulaOFTAdapter | `0xf3AC78cB0a98E72d6fC60Cf8865b31CcEF09d3f7` | `0xf3AC78cB0a98E72d6fC60Cf8865b31CcEF09d3f7` |
| LZ EndpointV2 | `0x6EDCE65403992e310A62460808c4b910D972f10f` | `0x6EDCE65403992e310A62460808c4b910D972f10f` |

Initial supply mirrors live mainnet so cap/headroom behaviour matches production:
Sepolia **1,470,000,000 FULA**, Base Sepolia **386,311,783 FULA**.

## Timeline — the delays are REAL SECONDS here

Local tests use `time.increase()`; a public testnet cannot. `ROLE_CHANGE_DELAY = 1 day`,
`MIN_PROPOSAL_EXECUTION_DELAY = 24 hours`, `WHITELIST_LOCK_DURATION = 1 day`, and
`__GovernanceModule_init` timelocks BOTH admins at deployment.

| Phase | Earliest | Actions |
|---|---|---|
| A — deploy + wire | done | token proxy, adapter, `setPeer`, libraries, ULN/Executor config, enforced options, `setRateLimits` (all `onlyOwner`, no timelock) |
| B — open governance | **2026-07-27 18:49 UTC** | `setRoleQuorum(ADMIN_ROLE,2)`, `setRoleTransactionLimit`, create `AddWhitelist` + `SetBridgeMinter`(12) proposals (different targets → run in parallel) |
| C — execute | B + 24h | second admin `approveProposal` on both |
| D — exercise | C + 24h (whitelist lock) | `transferFromContract` → cross-chain send → fail/retry drill → measure `lzReceive` gas |

## Phase A result — COMPLETE

Both chains fully wired: `setPeer`, send/receive libraries, ULN + Executor config, enforced
options, rate limits. Settings used: confirmations **2** (the on-chain default for these lanes),
rate limit **10,000,000 FULA / 86400s** (Stage 0 of the rollout table), enforced `lzReceive` gas
**250,000** (the design doc's conservative start; to be re-tuned to 1.5× measured in Phase D).

**R-07 cross-chain config check PASSES.** The operator-based ULN digest is identical on all four
sides (sepolia send/receive and base-sepolia send/receive):
`0x814df23ea8bb5af98dcea243dd847163efe435cefea2b039d968792284e157d7`

`verifyOAppConfig.ts` still reports 5 failures per chain. All are expected at this stage:

| Failure | Why it is expected |
|---|---|
| `owner is a CONTRACT (timelock/multisig), not an EOA` | testnet owner is an EOA; mainnet MUST use a timelock |
| `send: at least 2 independent verifiers required` | only 1 DVN exists on these testnets |
| `receive: at least 2 independent verifiers required` | same |
| `adapter is an authorized bridge minter` | Phase C — blocked by the 24h governance timelock |
| `cap is non-zero` | same |

The first three can never pass on testnet and must **all** pass before mainnet.

## Bugs found by the rehearsal (all fixed)

The rehearsal earned its keep before a single token moved:

1. **`wireOApp.ts` could not encode `setConfig` at all.** The endpoint ABI declared an anonymous
   tuple `(uint32,uint32,bytes)[]`, so ethers v6 rejected the `{eid, configType, config}` objects
   with "cannot encode object for signature with missing names". **This would have failed
   identically on mainnet** — the DVN/executor config could never have been set. Fixed by naming
   the tuple components.
2. **`wireOApp.ts` was not re-runnable.** The endpoint reverts when a message library is set to the
   value it already holds, so any partial failure (an RPC nonce race — which happened here) left
   the wiring stuck: re-running died on the first already-applied step and never reached the
   remaining ones. Each step now detects "already applied" and skips. This matters more on mainnet,
   where a half-wired bridge is an R-07 outage.
3. **`verifyOAppConfig.ts` told operators to compare a digest that can never match.** The digest
   hashed raw DVN *addresses*, but a DVN operator has a different address on every chain, so two
   correctly-matched configs always produced different digests. Following the instruction would
   suggest a correct bridge was misconfigured. Now emits a second, operator-name-based CROSS-CHAIN
   digest which is the value to compare, with the address-based one explicitly scoped to
   same-chain send-vs-receive.

## Gotchas hit during Phase A

- **`https://sepolia.base.org` serves stale state right after a deploy** — a just-created contract
  reads back as `0x` for seconds, so post-deploy assertions fail spuriously. Both Base Sepolia
  "failures" were this; the deploys had succeeded. Config now defaults to
  `https://base-sepolia-rpc.publicnode.com`.
- Alchemy: the project key works for **Base** (mainnet + sepolia) but returns **403 on Ethereum
  mainnet**.
- Etherscan V2 free tier covers chainid 1 but **not 8453**.
