# FULA LayerZero OFT bridge — mainnet deployment runbook

**The bridge is a LOCK/RELEASE ESCROW. It does not modify the token.**

There is no implementation deploy, no governance upgrade, no minter authorization and no `cap`.
`contracts/core/StorageToken.sol` is byte-identical to the live Etherscan-verified source on both
chains and stays that way. The adapter is an ordinary token holder with no role and no privilege.

If you are reading an older revision of this file that tells you to run `deployStorageTokenImpl.ts`
or to execute a token upgrade through governance — that describes the **abandoned mint/burn design**.
Those scripts are deleted. Ignore it.

Read `docs/bridge-audit-escrow.md` before deploying, and `docs/bridge-liquidity-runbook.md` before
seeding.

---

## 0. Pre-flight

| Check | How |
|---|---|
| Tests green | `npx hardhat test test/governance/integration/FulaOFTBridge.test.ts` |
| Owner is a contract | A TimelockController or multisig on **both** chains. Not an EOA. |
| You control enough FULA on **Base** | See §3 — Base's token contract holds only ~4,239 FULA |
| Deployer funded | ETH on both chains for ~8 transactions each |

**The owner is the most consequential decision here.** It is simultaneously the OZ owner and the
LayerZero delegate, and it can drain the escrow — directly by repointing a lane before `lockPeers`,
and indirectly afterwards by reconfiguring the DVN set. `deployOFTAdapter.ts` only *warns* on an EOA;
`verifyOAppConfig.ts` *fails*. Do not ignore either.

---

## 1. Deploy both adapters

```bash
OWNER=<timelock or multisig> npx hardhat run scripts/bridge/deployOFTAdapter.ts --network ethereum
OWNER=<timelock or multisig> npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base
```

Deployed with a plain `ContractFactory`, never the upgrades plugin — this contract custodies user
funds and must not sit behind a mutable implementation pointer.

**No governance step follows.** The token grants the adapter nothing.

---

## 2. Wire both chains

```bash
ADAPTER=<eth adapter> REMOTE_ADAPTER=<base adapter> REMOTE=base \
  RATE_LIMIT=200000000 INBOUND_RATE_LIMIT=20000000 \
  npx hardhat run scripts/bridge/wireOApp.ts --network ethereum

# then the mirror image on base
ADAPTER=<base adapter> REMOTE_ADAPTER=<eth adapter> REMOTE=ethereum \
  RATE_LIMIT=200000000 INBOUND_RATE_LIMIT=20000000 \
  npx hardhat run scripts/bridge/wireOApp.ts --network base
```

Then verify on **both** chains and compare the digests:

```bash
ADAPTER=<adapter> REMOTE=<peer network> npx hardhat run scripts/bridge/verifyOAppConfig.ts --network <chain>
```

### Four things that will bite if skipped

1. **BOTH rate limiters are mandatory and fail-closed.** An unconfigured lane rejects *every*
   transfer. `wireOApp.ts` refuses to run without `RATE_LIMIT` **and** `INBOUND_RATE_LIMIT`.
2. **The send-side ULN config on chain A must match the receive-side config on chain B.** If they
   disagree, messages verify but never deliver and tokens park until the config is fixed.
   `verifyOAppConfig.ts` prints an operator-name-based cross-chain digest — compare *those*, never
   the address-based one, since DVN operators have different addresses per chain.
3. **Never ship a 1-of-1 DVN set.** `addresses.ts` refuses to build one on any non-testnet and
   `verifyOAppConfig.ts` fails below two. This is the configuration behind the ~$292M Kelp loss.
4. **The inbound limit must be strictly BELOW the escrow balance**, or it is inert rather than
   merely weak: `_credit` checks liquidity first, so anything above escrow reverts
   `InsufficientLiquidity` before the limiter is consulted. `verifyOAppConfig.ts` fails on this.

---

## 3. Seed escrow liquidity

A chain can only release what it already holds. Full detail in `docs/bridge-liquidity-runbook.md`.

```bash
ADAPTER=<adapter> AMOUNT=200000000 REMOTE_EID=<peer eid> \
  npx hardhat run scripts/bridge/seedLiquidity.ts --network <chain>
```

**Bridging A→B drains B's escrow**, so seed the side that will receive net flow.

⚠️ **Base is the constraint.** Its token contract holds only ~4,239 FULA, so Base liquidity cannot
come from the treasury. It must come from the ~386M circulating (a plain `transfer` needs no
whitelist), or from a one-time `bridgeOp` burn-on-Ethereum / mint-on-Base — **burn first, then mint**,
because the two halves have no on-chain link and mint-first risks unbacked supply.

`escrow_eth + escrow_base` is conserved by ordinary bridging, so the seed is a one-time allocation
sized to worst-case imbalance, not a recurring budget. **There is no withdraw function** — seeded
liquidity leaves only by being bridged to the other chain.

---

## 4. Prove it, then lock

```bash
ADAPTER=<adapter> REMOTE=<peer> AMOUNT=100 npx hardhat run scripts/bridge/sendTest.ts --network <chain>
```

Send in **both** directions and confirm delivery before going further.

```bash
ADAPTER=<adapter> REMOTE_EID=<peer eid> EXPECTED_PEER=<peer adapter> \
  npx hardhat run scripts/bridge/lockPeers.ts --network <chain>          # dry run
# then re-run with CONFIRM=LOCK
```

⚠️ **`lockPeers()` is irreversible.** It closes the cheap owner-drain path: `setPeer` decides who is
trusted and `EndpointV2.send` is permissionless, so before locking, an owner can repoint a lane at an
address it controls and drain the escrow in one transaction, having locked nothing on the far side.

It does **not** make a compromised owner harmless — the owner is still the delegate and can
reconfigure the receive library and DVN set to forge a packet matching the frozen peer. **The inbound
rate limit is what bounds that residual.** The two controls belong together.

After locking, neither adapter can be replaced without redeploying both and migrating liquidity.

---

## 5. Staged rollout

Under escrow there is no `cap`. The levers are **how much you seed** and **the inbound limit**, and
the maximum loss in any single incident is bounded by the inbound limit, not by total supply.

| Stage | Seed per chain | Inbound limit / 24h | Gate to advance |
|---|---|---|---|
| 0 | testnet | testnet | full runbook + fail/retry drill + `lzReceive` gas measured |
| 1 | 10M | 1M | 10 round trips, supply and escrow reconciled exactly |
| 2 | 50M | 5M | 7 days clean |
| 3 | 200M | 20M | 30 days clean |

Keep the inbound limit at **10–25% of the seeded escrow** at every stage — it is the instant
first-tranche loss if a message is ever wrongly authorised, because the bucket starts full. Both
limits are owner transactions and take effect the next block.

Run `reconcileSupply.ts` daily throughout. Under escrow the bridge cannot mint or burn, so **any**
global supply change is by definition not the bridge — which makes it an unusually sharp alarm.

---

## 6. Kill switches, fastest first

| Latency | Action | Effect |
|---|---|---|
| ~1 block | `ADAPTER=.. EID=.. INBOUND=0 setLimits.ts` | **Releases halted.** In-flight messages park retryably. The brake for a suspected forged message. |
| ~1 block | `ADAPTER=.. EID=.. OUTBOUND=0 setLimits.ts` | Departures halted. Fails source-side, nothing locked. |
| ~1 block | `emergencyAction(1)` on the token | Token paused → releases park. **Does NOT stop outbound locking** — `transferFrom` is not pause-gated. Pair it with `OUTBOUND=0`. 30-min cooldown before unpause. |
| ~1 block | `setPeer(eid, bytes32(0))` | Both directions halted — **unavailable once `lockPeers()` has been called.** |

⚠️ **After `lockPeers()`, `setPeer` reverts, so the inbound limit is your fastest kill switch.**
That is the main reason `setInboundRateLimits` exists as a separate owner lever, and why
`resetInboundRateLimits` exists to recover afterwards without permanently weakening the bound.

Nothing here destroys value: every one of these makes transfers *park*, and parked messages deliver
unchanged once the condition clears.
