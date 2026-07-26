# Upgrading contracts in fula-chain

## TL;DR — mandatory pre-deploy gate

Before deploying ANY contract upgrade (UUPS `upgradeProxy`, multisig upgrade transaction, governance-executed upgrade — any path):

```bash
npx hardhat run scripts/validateRewardEngineUpgrade.ts --network <network>
#   (copy and adapt the script for each contract: change PROXY_BY_NETWORK and
#    the factory name to match the contract being upgraded)
```

If the script reports `storage layout INCOMPATIBLE`, **STOP**. Do not deploy. On-chain data WILL be corrupted otherwise. The OZ error message is specific and actionable — read it carefully and fix the source before retrying.

The standalone `validateImplementation` check is not sufficient. It only verifies the new implementation is internally OZ-compliant; it does NOT compare against the deployed proxy's storage layout. Always run the layout check against the live network.

---

## Why this matters specifically for `GovernanceModule` children

### Background

`GovernanceModule.sol` is inherited by ~10 contracts in this repo (`RewardEngine`, `StoragePool`, `StorageToken`, `StakingPool`, `TokenBridge`, `TokenDistributionEngine`, `AirdropContract`, `FulaUsersIndexAnchor`, `TestnetMiningRewards`, and indirectly `RewardsProgram`/`RewardsExtension` via `RewardsStorageBase`).

The parent's storage layout has shifted across the codebase's history:

- **Originally**: no `__gap` at the end of `GovernanceModule`.
- **2026-03-28 (commit `97fae06`)**: `uint256[40] private __gap;` added at the end of `GovernanceModule` to reserve space for the new `RewardsProgram` family.
- **2026-05-12**: that `__gap` was REMOVED so that `RewardEngine` (deployed pre-`97fae06`) could be safely upgraded with the storage-rewards feature. Children's recorded layouts at that point split into two groups.

### The two groups

| Group | Deployed when | First child state slot | Action when next upgrading |
|---|---|---|---|
| **Legacy** | Source had no parent `__gap` | Slot **11** | None — current source already has no parent `__gap`. |
| **Modern** | Source had `__gap[40]` at GovernanceModule | Slot **51** | Add `uint256[40] private __gap;` as the FIRST state declaration in the child, before any other state. This "absorber" reclaims slots 11–50 so the child's other state vars stay at their on-chain slots. |

Both groups can coexist after this fix because gap slots are functionally zero regardless of which contract declares them.

### How to classify a contract before upgrading it

1. Find the live implementation address (OZ manifest `proxies` entry → impl, or read the proxy's implementation slot directly via `eth_getStorageAt 0xPROXY 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`).
2. Look up that impl's `layout.storage[]` in `.openzeppelin/<network>.json`.
3. Find the FIRST entry whose `contract` matches your child contract (i.e., the first state variable declared in the child, NOT in `GovernanceModule` or earlier inherited contracts).
4. Read its `slot` value:
   - **`slot: "11"`** → Legacy. No absorber needed.
   - **`slot: "51"`** → Modern. Absorber required.
   - Any other value → investigate. The contract may have a custom layout (e.g., extra inherited base classes); compare carefully against the source declaration order.

### Adding the absorber (Modern-group children only)

When upgrading a Modern-group child, before any other state changes, edit the child contract source:

```solidity
contract MyContract is GovernanceModule /*, …other bases */ {
    /// @dev Storage absorber for legacy `GovernanceModule.__gap[40]` (removed
    /// from parent in the 2026-05-12 RewardEngine upgrade). DO NOT REMOVE OR
    /// REORDER. Slots 11-50 of this contract's storage layout are reserved
    /// by this absorber to preserve compatibility with the live deployed impl.
    /// See `contracts/UPGRADING.md`.
    uint256[40] private __gap;

    // …rest of contract state, unchanged…
}
```

Solidity allows the child to declare a `__gap`-named variable even though the parent no longer does — the names don't collide because the parent's is gone. The OZ plugin has special handling for `__gap` and will accept the move (no `unsafeAllow` flag needed in most cases). If the plugin still flags it as a rename, add `unsafeAllowRenames: true` to the upgrade call with a code comment explaining why.

After adding the absorber, re-run `validateUpgrade` — it should now pass.

---

## Per-contract classification status

Update this table as you upgrade each contract. The status is determined empirically: run `validateUpgrade` against the live network before each upgrade and record the result.

| Contract | Inherits | Networks | Group | Notes |
|---|---|---|---|---|
| `RewardEngine` | `GovernanceModule` | Base, SKALE | **Legacy** | Verified 2026-05-12 (slot 11 layout in SKALE manifest). Upgraded with storage-rewards feature. |
| `StoragePool` | `GovernanceModule` | Base, SKALE | TODO | Classify before next upgrade. |
| `StorageToken` | `GovernanceModule` | **Ethereum**, Base, SKALE, IoTeX | TODO | Classify before next upgrade — **per network**. Expect Legacy (slot 11). Note this contract is ALSO live on Ethereum (`0x92217cCaEDBdbc54C76c15feA18823db1558fDc9`) and IoTeX, which earlier revisions of this table omitted. Validate with `scripts/validateStorageTokenUpgrade.ts`. |
| `StakingPool` | `GovernanceModule` | Base, SKALE | TODO | Classify before next upgrade. |
| `TokenBridge` | `GovernanceModule` | Base, SKALE | TODO | Classify before next upgrade. |
| `TokenDistributionEngine` | `ERC20Upgradeable, GovernanceModule` | Base, SKALE | TODO | Has extra base class — verify storage layout carefully. |
| `AirdropContract` | `ERC20Upgradeable, GovernanceModule` | Base, SKALE | TODO | Same as above. |
| `TestnetMiningRewards` | `GovernanceModule` | (testnet only) | TODO | Classify if/when upgraded. |
| `FulaUsersIndexAnchor` | `GovernanceModule` | (check) | Likely **Modern** | Manifest shows parent `__gap[40]` in its recorded layout (slot 11..50). |
| `RewardsProgram` | `RewardsStorageBase → GovernanceModule` | (check) | Likely **Modern** | Deployed post-`97fae06`. |
| `RewardsExtension` | `RewardsStorageBase → GovernanceModule` | (check) | Likely **Modern** | Same as RewardsProgram. |
| `FulaFileNFT` | `NftGovernanceModule` (different parent) | (check) | N/A | Different base class — separate layout considerations. |

---

## Hard rules

- **Never deploy a proxy upgrade without `validateUpgrade` passing on the target network.** No exceptions. If the OZ plugin doesn't have the proxy registered locally, run `upgrades.forceImport(proxy, OldFactory)` first using the OLD source (the version currently deployed). Commit the resulting `.openzeppelin/<network>.json` updates so the team has them.
- **Check storage compatibility on EVERY target network separately.** A contract can be Legacy on one chain and Modern on another if it was deployed at different times.
- **Never assume two children of `GovernanceModule` are in the same group.** Each was deployed independently; check each one.
- **Don't add new state to `GovernanceModule` without a coordinated upgrade plan.** Any new parent-level state would shift every child's layout. Use child-level state instead, or add only behind a child-side absorber.

## StorageToken bridge invariants (LayerZero OFT)

`StorageToken` exposes `mint(address,uint256)` / `burn(address,uint256)` for the LayerZero OFT
adapter. These carry invariants that MUST survive every future upgrade:

1. **A bridge minter can burn ANY holder's balance with no allowance.** This is required by
   `MintBurnOFTAdapter._debit`, which passes the message sender as `_from`. Therefore
   `bridgeMinters` may only ever contain **immutable, non-upgradeable, source-verified**
   contracts. `_createCustomProposal` enforces `target.code.length > 0` so an EOA can never be
   authorized — do not weaken that check.
2. **The platform fee must never apply to a mint or a burn.** `_update` bypasses the fee when
   `from == address(0) || to == address(0)`. Removing that bypass silently breaks global supply
   conservation: a burn would destroy less than requested while the destination chain credits the
   full amount, inflating supply by up to `MAX_BPS` (5%) per hop. `FulaOFTAdapter` asserts the
   exact supply delta and reverts (`SupplyInvariantViolated`) as a second line of defence, but the
   token-side fix is the primary one. See the `_update` regression tests in
   `test/governance/integration/FulaOFTBridge.test.ts`.
3. **`voluntarilyBurned` must keep being incremented by `burn(uint256)` / `burnFrom`.** The supply
   cap is computed as `totalSupply() + voluntarilyBurned`; without this, any holder could burn
   tokens to manufacture fresh mint headroom for the bridge.
4. **Bridge minter proposal types 12 and 13 are contract-local** (defined in `StorageToken.sol`,
   reserved by comment in `ProposalTypes.sol`). They are deliberately NOT in the
   `ProposalTypes.ProposalType` enum so the shared library and `GovernanceModule` — inherited by
   ~10 live contracts — do not have to change. Do not "tidy" them into the enum.
5. **`FulaOFTAdapter` is not upgradeable and must stay that way.** Deploy with a plain
   `ContractFactory`. Its owner is also the LayerZero delegate, which can permanently destroy
   in-flight messages (`endpoint.burn`/`nilify`) — i.e. destroy user funds already burned on the
   source chain. The owner MUST be a timelock or multisig, never an EOA.
6. **The rate limiter is fail-closed.** An adapter with no configured `RateLimitConfig` reverts
   every transfer with `RateLimitExceeded`. `setRateLimits` is a mandatory go-live step, not an
   optimization.

`StorageToken` sits close to the EIP-170 limit (23.9 KiB of 24.0). `hardhat.config.ts` pins it to
`runs: 100`; the measured size at each optimizer setting is recorded there. Optimizer runs do not
affect storage layout.

## Generalizing the validation script

`scripts/validateRewardEngineUpgrade.ts` is specific to RewardEngine. To validate any other contract:

1. Copy the file (e.g., `scripts/validateStoragePoolUpgrade.ts`).
2. Change `PROXY_BY_NETWORK` to that contract's proxy addresses.
3. Change `ethers.getContractFactory("RewardEngine")` → `getContractFactory("YourContract")`.
4. Run with `--network base` and `--network skale` (and any other live network).

A consolidated `scripts/validateAllUpgrades.ts` looping over a registry of contracts could be worth building if you upgrade frequently — but per-contract scripts are fine for occasional upgrades.
