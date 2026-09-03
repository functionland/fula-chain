# Mainnet readiness — what is proven, what is not, and what it costs

An honest go/no-go for the FULA lock/release escrow bridge. Companion to
`docs/bridge-audit-escrow.md` (findings), `docs/bridge-verification.md` (evidence) and
`scripts/bridge/README.md` (the deployment runbook).

**Short version:** the contract is in good shape — 100% branch coverage, no permissionless path to
funds found by any reviewer, and a full two-way rehearsal completed on testnet with supply and
escrow conservation observed live. **Three things remain unproven, two of them structurally
impossible to prove on a testnet.** None is a defect; all are deployment risk you should price
consciously rather than discover.

---

## 1. Proven on a live network

| Property | Evidence |
|---|---|
| Transfers work both ways | Sepolia→Base 100 FULA in ~75s; Base→Sepolia 25 FULA in ~180s |
| **Supply is conserved** | Global supply delta **0**; escrow total exactly **400,000,000** across both chains after both legs — tokens moved between escrows, none created or destroyed |
| Failure parks, never loses | Inbound limit set to 0 → transfer locked on source, did **not** deliver for 3 min, escrow and recipient untouched |
| Retry is automatic | Limit restored → the **same** parked message delivered in ~15s with no manual step and no resend |
| Kill switch works both ways | `setInboundRateLimits(0)` halts releases next block; restoring resumes them |
| `lzReceive` gas | **143,659** measured against a fresh recipient (the expensive case — cold storage write). 1.5× = 215,488, under the configured 250,000, so no retune needed |
| Adapter holds no privilege | Verified on both chains: no admin role, no bridge-operator role, `approvalRequired() == true` |
| Config symmetry | Cross-chain ULN digest matches on all four sides |

Contract test coverage: **100% statements, branches, functions and lines**, 57 tests.

---

## 2. Structurally unprovable on testnet

These are not oversights. A testnet cannot exercise them, so they will execute for the first time on
mainnet no matter how long the rehearsal runs.

### 2.1 The multi-DVN configuration — **the most important one**

Testnet Sepolia and Base Sepolia have **only one LayerZero DVN each**, so every testnet message was
verified 1-of-1. Mainnet will require **two independent DVNs** (LayerZero + Nethermind).

What this means concretely: the mainnet ULN config path — two required verifiers, ascending-sorted
and deduplicated, send-side on A matching receive-side on B — has been exercised **mechanically**
(the encoding, the sort rule, the digest symmetry) but **never with two DVNs actually attesting**.

*Mitigation:* `addresses.ts` refuses to build a <2 DVN config on any non-testnet and
`verifyOAppConfig.ts` fails below two. Send a **small** first transfer on mainnet and confirm
delivery before seeding at scale. A DVN misconfiguration parks messages; it does not lose them.

### 2.2 The Timelock/multisig owner path

Every owner-only call in the rehearsal was made by an **EOA**. On mainnet the owner must be a
Timelock or multisig, which changes the mechanics of every privileged operation: `setPeer`,
`setConfig`, `setRateLimits`, `setInboundRateLimits`, `lockPeers` and `acceptOwnership` all become
proposals to batch, queue and execute.

`wireOApp.ts` has a `DRY_RUN=1` mode that prints calldata for exactly this, but **the Safe/Timelock
submission path itself has never been run.**

*Mitigation:* rehearse the batch on testnet by transferring adapter ownership to a Safe there first,
or accept that the first Safe execution happens on mainnet with a `DRY_RUN` calldata review.

### 2.3 `lockPeers()` has never executed anywhere

It is unit-tested (owner-only, blocks `setPeer`, traffic still flows afterwards) but has **never run
on any live chain**. It is irreversible, so the first real execution is inherently a one-way step.

*Recommendation:* run it on **testnet first**, then send one more transfer to confirm traffic still
flows. That converts an untested irreversible action into a rehearsed one, and the downside on
testnet is bounded by redeploying testnet adapters.

---

## 3. Residual risk, quantified

With the planned mainnet configuration — 2 independent DVNs, Timelock owner, 200M escrow per chain,
20M/24h inbound limit, peers locked:

| Adversary | Maximum single-incident loss | Notes |
|---|---|---|
| **Unprivileged attacker** | **None found** | No reviewer identified a permissionless path. Escrow cannot mint; every branch is covered by tests. |
| **Both DVNs compromised** | **20,000,000** per 24h window | Not the 200M escrow. This is precisely what the inbound limiter buys, and precisely the KelpDAO failure mode (~$292M lost to a 1-of-1 DVN with no such bound). |
| **Compromised owner / Timelock** | **20,000,000** per 24h window | `lockPeers` removes the one-transaction drain, but the owner is still the LZ delegate and can reconfigure the DVN set to forge a packet matching the frozen peer. The inbound limit — not the peer lock — is what bounds this. Timelock delay provides observability, not prevention. |
| **Token governance** | **Unbounded** | `StorageToken` is a UUPS proxy. A token upgrade can reach the escrowed balance directly. Token governance sits **above** the bridge in the trust stack; the bridge cannot constrain it. |

The honest ordering of risk for escrowed funds is:
**token governance > LayerZero DVN configuration > this contract's code.**

---

## 4. Methodological limits

- **No fuzzing, no property-based invariant testing, no formal verification.** The conservation
  sweep is 24 deterministic pseudo-random rounds — a smoke test, not a fuzz campaign.
- **Only one test was verified to fail without its fix** (the delegate rotation). The other 56 could
  in principle pass for the wrong reason.
- **The external audit of the newest code is thin.** The inbound limiter, `lockPeers`,
  `resetInboundRateLimits` and the zero-window guard received **one** substantive external review.
  Six of seven commissioned reviewers were unavailable (paid-plan gating, retired free model slugs,
  quota exhaustion, an MCP transport timeout, and a new account-binding requirement). One reviewer
  did return a "Critical" that was **refuted by live testnet evidence** — the bridge demonstrably
  works, and its claimed total-inbound-DoS would have made the rehearsal impossible.

---

## 5. Pre-flight checklist

Nothing here is optional.

- [ ] Owner is a Timelock or multisig on **both** chains — `verifyOAppConfig.ts` fails on an EOA
- [ ] **≥2 independent required DVNs** on every lane, both directions
- [ ] Cross-chain ULN digest matches on all four sides (compare the **operator-name-based** digest, never the address-based one)
- [ ] Both rate limiters configured — both are fail-closed and reject everything until set
- [ ] Inbound limit is **strictly below** escrow, targeting 10–25% — otherwise it is inert, not merely weak
- [ ] Escrow seeded on the side that will receive net flow (**Base is the constraint** — its token contract holds only ~4,239 FULA)
- [ ] A small transfer confirmed **in both directions** before seeding at full scale
- [ ] `reconcileSupply.ts` running on a schedule, watching the **current** adapter addresses
- [ ] `lockPeers()` called — after the above, and understanding it is irreversible

---

## 6. Verdict

**The contract is ready.** The residual risk is concentrated in configuration and operations, not in
code — which is the right place for it to be, and is what the two rate limiters plus the peer lock
were built to bound.

**Deploy in stages.** The staged rollout in `scripts/bridge/README.md` starts at a 10M seed with a
1M inbound limit. At that size the worst case from a total verification compromise is 1M, not 200M.
Advancing costs nothing but time, and the first mainnet transfer is the only way to prove the
multi-DVN path — so make it a small one.
