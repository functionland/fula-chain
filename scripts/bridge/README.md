# FULA LayerZero OFT bridge — deployment runbook

Two deployment paths, in order. **Do not skip the rehearsal.**

| | Script | Touches the proxy? |
|---|---|---|
| 1. Rehearsal | `rehearseUpgradeOnFork.ts` | Yes, but only on a local fork |
| 2. Mainnet | `deployStorageTokenImpl.ts` | **No** — deploys the implementation only |

The actual mainnet upgrade is executed by you, through the governance module. No script
ever calls `upgradeToAndCall` against a live proxy.

---

## 1. Rehearsal — mainnet state, locally

A real testnet cannot reproduce mainnet state (you cannot copy arbitrary holder balances into
an already-deployed proxy). A **fork** can: it gives you the real proxy, the real
implementation, real balances, the real admin set and real governance state at the latest
block. That is what this script uses.

```bash
# Terminal 1 — a local node forking live Base (or Ethereum)
FORK_RPC_URL=https://mainnet.base.org npx hardhat node

# Terminal 2 — rehearse against it
TARGET=base npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts --network localhost
```

Or in a single process:

```bash
FORK_RPC_URL=<rpc> TARGET=base npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts
```

What it does:

1. Snapshots live state — supply, balances, governance config, raw storage slots
2. Asserts the appended slots (16, 17) and the reserved gap (18–64) are **zero** on the live proxy
3. Deploys the new implementation
4. Runs the **real** governance flow: `createProposal(3)` → approve → +24h → `upgradeToAndCall`
5. Re-snapshots and diffs — every pre-existing value must be byte-identical, or it aborts
6. Deploys `FulaOFTAdapter` and authorizes it via proposal type 12
7. Exercises mint, burn, supply conservation, cap enforcement, and the fee-on-mint regression

If `ADMIN_ROLE` is not enumerable on the deployed implementation, pass a second admin:
`ADMIN2=0x... TARGET=base ...`

The same coverage runs as an automated test:

```bash
FORK_RPC_URL=<rpc> FORK_TARGET=base npx hardhat test test/fork/StorageTokenUpgrade.fork.test.ts
```

It skips automatically when `FORK_RPC_URL` is unset, so CI stays green without network access.

### A note on real testnets

If you also want something publicly pokeable, deploy a **fresh** StorageToken + adapter pair on
Sepolia and Base Sepolia and run the full wiring. That exercises real DVNs, real Executors, real
fee quoting and real `lzReceive` gas — which a fork cannot. It just won't have mainnet balances.
Both are worth doing: the fork proves the upgrade is safe against real state, the testnet proves
the LayerZero stack is configured correctly.

---

## 2. Mainnet — pre-flight and implementation deploy

```bash
# Run every check, deploy nothing
DRY_RUN=1 npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network base

# Then, once green
npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network base
```

Every check is a hard gate — nothing is deployed unless all pass:

- **A** Network and proxy identity (chainId, code present, responds as FULA)
- **B** Live implementation matches the recorded expectation (catches an out-of-band upgrade)
- **C** Deployed layout holds what we believe: slots 0/7/13/14 decode as `adminCount`,
  `proposalCount`, `treasury`, `platformFeeBps` — confirming the "Legacy" group, first child slot 11
- **D** **The corruption gate**: appended slots 16, 17 and the reserved gap 18–64 are all zero.
  If any is non-zero, the new state variables would silently inherit existing data
- **E** OpenZeppelin standalone implementation validation
- **F** OpenZeppelin storage-layout compatibility against the live deployment
  (falls back to `forceImport` when no local manifest exists — `.openzeppelin/` is gitignored)
- **G** Governance preconditions: unpaused, quorum ≥ 2, ≥ 2 admins — so the upgrade can actually execute
- **H** Bytecode sanity: the new implementation genuinely differs from the live one, and is under EIP-170

Then it deploys the implementation, verifies the on-chain bytecode matches the local artifact,
and prints the exact governance sequence.

### Executing the upgrade (you drive this)

```
1. admin1: createProposal(3, 0, <IMPL>, 0x0…0, 0, 0x0…0)
2. admin2: approveProposal(<proposalId>)
3. wait 24h from creation
4. either admin: upgradeToAndCall(<IMPL>, "0x")
```

The execution window is `[created + 24h, created + 48h)`. Miss it and the proposal expires —
you must deploy a **new** implementation address and start over, because `pendingProposals`
keeps the old target blocked until expiry.

Re-run the script afterwards: check **B** should now *fail*, because the live implementation
changed. That is your confirmation the upgrade landed.

---

## 3. After the upgrade — the bridge itself

```
1. Deploy adapters on both chains:
     OWNER=<timelock or multisig> npx hardhat run scripts/bridge/deployOFTAdapter.ts --network ethereum
     OWNER=<timelock or multisig> npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base

2. Authorize each adapter on its own chain (governance):
     createProposal(12, 0, <adapter>, 0x0…0, <cap>, 0x0…0) → approve → +24h

3. Wire both chains:
     ADAPTER=.. REMOTE_ADAPTER=.. REMOTE=base RATE_LIMIT=1000000 \
       npx hardhat run scripts/bridge/wireOApp.ts --network ethereum
     (then the mirror image on base)

4. Verify on BOTH chains, and cross-check the ULN digests:
     ADAPTER=.. REMOTE=base npx hardhat run scripts/bridge/verifyOAppConfig.ts --network ethereum
```

Two things that will bite if skipped:

- **`setRateLimits` is mandatory.** The rate limiter is fail-closed: an adapter with no
  configured limit rejects *every* transfer with `RateLimitExceeded`. `wireOApp.ts` refuses to
  run without `RATE_LIMIT` for exactly this reason.
- **The send-side ULN config on chain A must match the receive-side config on chain B.** If they
  disagree, messages verify but never deliver — tokens are burned on the source and park until
  the config is fixed. `verifyOAppConfig.ts` prints a digest on each side; they must match.

Never ship a 1-of-1 DVN configuration. `addresses.ts` refuses to build one, and
`verifyOAppConfig.ts` fails if fewer than two independent verifiers are required.

---

## Staged rollout

| Stage | `cap` | rate limit / 24h | Gate to advance |
|---|---|---|---|
| 0 | testnet | testnet | full runbook + a deliberate fail-then-retry drill + `lzReceive` gas measured |
| 1 | 1M | 100k | 10 round trips, supply reconciled to the wei |
| 2 | 25M | 1M | 7 days clean |
| 3 | 250M | 10M | 30 days clean |

Cap raises are governance proposals (24h delay built in). Rate-limit raises are owner
transactions and take effect next block.

Run a daily supply reconciliation during stages 1–3: sum `totalSupply()` across all live chains
and alert on any change not explained by a matched `OFTSent`/`OFTReceived` pair. That sum is the
canary for the entire constant-supply property.

## Kill switches, fastest first

| Latency | Action | Effect |
|---|---|---|
| ~1 block | `setRateLimits([{dstEid, limit: 0, window: 1}])` | Outbound halted |
| ~1 block | `setPeer(eid, bytes32(0))` | Both directions halted; inbound parks retryably |
| ~1 block | `emergencyAction(1)` on the token | Token paused; inbound parks retryably (30-min cooldown before unpause) |
| 24h | `createProposal(13, …)` | Bridge minter permanently revoked |
