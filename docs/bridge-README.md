# FULA bridge — document index

The bridge is a **LayerZero v2 lock/release escrow** between Ethereum and Base. It locks tokens on
the source chain and releases pre-funded tokens on the destination. Nothing is minted or burned, and
**`contracts/core/StorageToken.sol` is not modified in any way** — it is byte-for-byte identical to
the live Etherscan-verified source on both chains.

Start here and read in this order.

| Document | What it is for |
|---|---|
| **`bridging.md`** | For token holders. How to move FULA, what each error means, what to do when a transfer does not arrive. |
| **`bridge-audit-escrow.md`** | The security audit of the escrow design. Findings by category and severity, what was fixed, and the two decisions taken. **Read before any mainnet deployment.** |
| **`bridge-verification.md`** | What was actually tested and verified, live-chain readings, the operational bugs the testnet rehearsal caught, and how to reproduce every check. |
| **`bridge-mainnet-readiness.md`** | **Read this before deploying.** Go/no-go: what is proven on a live network, what is structurally unprovable on a testnet, and the maximum loss each class of adversary can still cause. |
| **`bridge-liquidity-runbook.md`** | How to seed and rebalance escrow liquidity, the three funding routes, and the burn-before-mint rule. |
| **`../scripts/bridge/README.md`** | The mainnet deployment runbook — exact command sequence, staged rollout, and kill switches. |
| **`../scripts/bridge/testnet-deployments.md`** | Current testnet addresses and configuration. The source of truth for what is deployed where. |

## Superseded — historical only

| Document | Status |
|---|---|
| `bridge-design.md` | Describes the **abandoned mint/burn design**. Carries a ⚠️ header mapping each part to what replaced it. |
| `bridge-audit.md` | Audit of that abandoned design. Superseded by `bridge-audit-escrow.md`. |

Anything referring to `MintBurnOFTAdapter`, `bridgeMinters`, `netMinted`, a minter `cap`, or proposal
types 12/13 belongs to the abandoned design and does not exist in the shipped code.

## The three things most likely to bite

1. **Both rate limiters are fail-closed.** A freshly deployed adapter rejects *every* transfer until
   `setRateLimits` **and** `setInboundRateLimits` are called. This is deliberate.
2. **A chain can only release what it already holds.** Seeding is not optional, and there is no
   withdraw function — see the runbook before committing capital.
3. **`lockPeers()` must be called, and is irreversible.** Until it is, whoever owns an adapter can
   repoint a lane at an address they control and drain the entire escrow — no DVN compromise
   required. This is proven by a deliberately passing attack test in the bridge suite.
