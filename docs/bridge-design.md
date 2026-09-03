# FULA Ethereum → Base Bridge via LayerZero v2 OFT

> # ⚠️ SUPERSEDED DESIGN — READ THIS FIRST
>
> **This document describes a MINT/BURN bridge that was abandoned on 2026-07-28.**
> The implemented design is **LOCK/RELEASE ESCROW**, which requires **no change to the token
> contract at all**. Everything below about `MintBurnOFTAdapter`, `bridgeMinters`, `mint`/`burn`
> on the token, proposal types 12/13, `netMinted`, `cap`, and `voluntarilyBurned` **no longer
> exists in the codebase.** It is kept for the decision history — why LayerZero over
> CCIP/Wormhole/Hyperlane, the DVN policy, the ownership reasoning, and the risk register — all of
> which still apply.
>
> **What is actually built:** a LayerZero `OFTAdapter` (`contracts/bridge/FulaOFTAdapter.sol`) that
> locks tokens on the source chain and releases pre-funded tokens on the destination. Nothing is
> minted or burned, so supply conservation is structural rather than maintained by accounting.
> `contracts/core/StorageToken.sol` is byte-for-byte identical to the source verified on Etherscan
> for the live Ethereum and Base deployments.
>
> **Why the change.** Mint/burn required upgrading a live ~1.47B-token proxy, granting mint
> authority, and adding a `burn(address,uint256)` with **no allowance check** — a permanent power
> for an authorized contract to burn any holder's balance. Escrow removes all three. A compromised
> escrow adapter can reach only what is escrowed; it cannot create supply and cannot dilute holders
> who never used the bridge.
>
> **What escrow costs.** Each side must be pre-funded, and a persistent one-way flow drains the
> receiving side until it is replenished. That is an operational duty, not a risk to user funds —
> an under-funded transfer parks and stays retryable.
>
> **Current status:** `docs/bridging.md` (user guide) · `scripts/bridge/testnet-deployments.md`
> (live Stage-0 state) · `docs/bridge-audit.md` (audit, largely superseded — see its header).
>
> ---

> **Status: IMPLEMENTED.** This is the design record written before implementation, kept for the
> decision history — why LayerZero over CCIP/Wormhole/Hyperlane/the OP canonical bridge, why the
> `_update` fee bug is a blocker, why proposal types 12/13 instead of a governance role, the
> ownership reasoning, and the risk register.
>
> For *how to operate* the result, read `scripts/bridge/README.md` (runbook) and the
> "StorageToken bridge invariants" section of `contracts/UPGRADING.md` (what must not be broken).
>
> **What changed during implementation** — the plan below is otherwise accurate, but the following
> were discovered while building and are NOT reflected in the text that follows:
>
> 1. **OpenZeppelin is pinned to exactly `5.3.0`, not upgraded.** OZ 5.4+ removes
>    `ReentrancyGuardUpgradeable`, which `GovernanceModule` imports. Bumping would force source
>    changes to governance code shared by ~10 live contracts and change every inherited contract's
>    bytecode, inside an upgrade that grants mint authority. LayerZero packages are at latest.
> 2. **LayerZero's `RateLimiter` is FAIL-CLOSED.** An adapter with no configured limit rejects
>    every transfer with `RateLimitExceeded`. `setRateLimits` is a mandatory go-live step, not a
>    tuning knob. Caught by the test suite; there is now a test pinning the behaviour.
> 3. **The bridge-minter `cap` is bounded to `int96` max.** `cap` is a `uint96` but `netMinted` is
>    an `int96`, and an explicit `int256`→`int96` downcast truncates silently in Solidity. Bounded
>    at proposal-creation time so the invariant cannot be broken by a future supply-cap change.
> 4. **`StorageToken` sits at ~23.95 KiB of the 24 KiB EIP-170 limit**, so `hardhat.config.ts`
>    pins it to `runs: 100` (not `runs: 1` — `transfer` is a hot path). Measured sizes per
>    optimizer setting are recorded in the config. **Measured on this branch: 23.950 KiB, i.e.
>    ~51 bytes of headroom** — the config previously claimed ~95. Adding any code to this contract
>    will very likely overflow the build.
>
> **Added during the local test-completion pass (2026-07-26):**
>
> 5. **The rate limiter is NET, not gross.** Phase 2 below specifies only `_outflow` in `_debit`,
>    but the implementation also calls `_inflow(_srcEid, _amountLD)` in `_credit`. For a single
>    A↔B lane both use the SAME `rateLimits` key, so an inbound transfer refunds the outbound
>    counter and a round trip fully restores capacity within the window. The "rate limit / 24h"
>    column in the Rollout table therefore bounds **net export**, not total volume. The `limit = 0`
>    kill switch is unaffected. This was an unrecorded policy choice, not a bug — it is now pinned
>    by a test and documented in `UPGRADING.md`.
>    **DECISION (owner, 2026-07-26): keep NET.** The `_inflow` call stays. Read the rollout table's
>    "rate limit / 24h" column as a **net-drain** ceiling, not a gross-volume one, and size the
>    limits accordingly. If this is ever revisited, a gross ceiling is a one-line change (delete
>    `_inflow` from `FulaOFTAdapter._credit`) plus inverting the pinning test.
> 6. **`voluntarilyBurned` is headroom-NEUTRAL — and an earlier revision of this list said the
>    opposite, wrongly.** `mint` gates on `totalSupply() + voluntarilyBurned + amount <= TOTAL_SUPPLY`.
>    A voluntary burn of `X` moves BOTH terms in opposite directions by the same amount
>    (`voluntarilyBurned += X`, `totalSupply -= X`), so headroom is **unchanged**. Burning therefore
>    cannot manufacture mint capacity — which is the bug this term was added to fix — and cannot
>    destroy it either. Only a **bridge** burn returns headroom, correctly, since those tokens are
>    re-minted on another chain. Both directions are now pinned by dedicated tests. The claim that
>    voluntary burns permanently consume headroom (previously risk R-17) was an error and is
>    **retracted**; see `docs/bridge-audit.md` F-1 for the arithmetic and for how the mistake arose.
> 7. **⚠️ TWO constants named `PROPOSAL_TIMEOUT` exist, with different values.** The live one is
>    `GovernanceModule.sol:78` — `private constant PROPOSAL_TIMEOUT = 48 hours` — which
>    `_initializeProposal` (line 205) actually uses. `ProposalTypes.sol:33` also defines
>    `PROPOSAL_TIMEOUT = 3 days`, but it is **dead**: nothing in the codebase references
>    `ProposalTypes.PROPOSAL_TIMEOUT`. **The execution window is therefore `[T0+24h, T0+48h)` as
>    originally written.** An intermediate revision of this document and of
>    `scripts/bridge/live.ts` "corrected" the window to 72h based on the dead constant — that was a
>    regression (it would have had operators compute a deadline 24h after the proposal had already
>    expired) and has been reverted. Recommend deleting the unused `ProposalTypes` constant so the
>    trap cannot catch anyone else.
> 8. **The Verification section's check A now exists.** `contracts/legacy/StorageTokenPrev.sol`
>    (an exact copy of `StorageToken.sol` at `0384d94`, renamed only) is the manifest-free
>    reference factory, and `test/governance/integration/StorageTokenLayout.test.ts` runs
>    `validateUpgrade` plus absolute-slot assertions **offline**. This does NOT close Phase 0 —
>    live bytecode parity still needs network access.
>
> **Assumptions in the plan that were adopted as written:** Ethereum ↔ Base only (SKALE later),
> `bridgeOp` kept but deprecated, `TokenBridge.sol` deletion deferred to a separate commit, and
> the seven pre-existing issues in "Known pre-existing issues NOT fixed here" left out of scope.
>
> ## ✅ PHASE 0 IS NOW COMPLETE (verified 2026-07-26, read-only, no transactions)
>
> The Phase 0 gate below was previously unrun (RPC egress was blocked in the build environment).
> It has now been executed against live Ethereum and Base. Results:
>
> **1. Ethereum and Base run the SAME implementation source — assumption 4 CONFIRMED.**
> The raw stripped-bytecode keccaks differ:
> `eth 0xfea9e598…` vs `base 0xf5a54b29…`. That difference is **not** a code difference. Both are
> exactly **23144 bytes**, and they differ in only **38 bytes across 2 regions**, each region
> holding that chain's **own implementation address** — the `__self` immutable that
> `UUPSUpgradeable` declares (`address private immutable __self = address(this)`, OZ 5.3
> `UUPSUpgradeable.sol:22`), which is baked into deployed bytecode at construction.
> The decisive evidence is the **solc CBOR metadata trailer, which is byte-identical on both
> chains**: `a2646970667358221220 81e22f1c7328b9fb69d2dc3e28e91334899e4274bdc5a5fa20ba435f4c572e97 64736f6c6343000818 0033`.
> That trailer embeds a hash of the **source and the compiler settings**, so identical trailers ⇒
> identical source, identical settings, solc **0.8.24** on both.
> **Consequence: ONE reference source suffices.** The two-legacy-sources fallback described under
> Verification is NOT needed.
>
> ⚠️ **`verifyStorageTokenImplParity.ts` was fixed as part of this.** Comparing the RAW keccak
> across networks is *always* wrong for a UUPS implementation — the `__self` immutable guarantees
> a mismatch, which would have pushed an operator onto the unnecessary fallback path. The script
> now prints a **masked** hash (with `__self` occurrences zeroed) and the **metadata trailer**, and
> says explicitly which value to compare.
>
> **2. Live supply on all four chains (Phase 0 item 4 / risk R-11) — RESOLVED, no blocker.**
>
> | Chain | `totalSupply()` |
> |---|---|
> | Ethereum | 1,469,999,999.999999999999999999 |
> | Base | 386,311,783.000000000000000001 |
> | SKALE | 15,000,000 |
> | IoTeX | 15,000,000 |
> | **Total** | **1,886,311,783** |
>
> Under the 2,000,000,000 cap with **113,688,217 FULA of headroom**, so full consolidation onto a
> single chain remains possible. R-11 does not block launch.
>
> **3. Live state cross-check.** Ethereum: treasury `0x5cF6C9aF…`, adminCount 2, proposalCount 0,
> unpaused, ADMIN quorum 2. Base: treasury `0x0cF025835981E574218BA9931Ddf8B4f724ef93D`,
> adminCount 2, proposalCount 0, unpaused, ADMIN quorum 2. Both satisfy the rollout preconditions
> (quorum ≥ 2, adminCount ≥ 2, unpaused).
>
> **4. Deployed source identified (Phase 0 step 3).** Pulled the Etherscan-verified source for the
> Ethereum implementation and compared it to commit `0384d94` (the base of this branch):
>
> | File | verified-on-chain vs `0384d94` |
> |---|---|
> | `contracts/core/StorageToken.sol` | **IDENTICAL** |
> | `contracts/governance/Treasury.sol` | IDENTICAL |
> | `contracts/governance/interfaces/IStorageToken.sol` | IDENTICAL |
> | `contracts/governance/GovernanceModule.sol` | differs by a COMMENT block only (695 vs 713 lines) |
> | `contracts/governance/libraries/ProposalTypes.sol` | differs by 2 added `constant` declarations (`POOL_ADMIN_ROLE`, `OWNER_ROLE`) — compile-time only, **no storage** |
>
> **Confirmed by a REPRODUCIBLE BUILD.** The verified standard-JSON input was recompiled locally
> with the exact compiler Etherscan reports (`solc v0.8.24+commit.e11b9ed9`, `runs: 300`,
> `viaIR: true`, `evmVersion: shanghai`). The result reproduces the live implementation **exactly**:
> 23144 bytes on both, byte-identical CBOR metadata trailer, and masked keccak
> `0x6232acc3c704157735d5aecf022b55ff235be75f5ec2441606a76a6077a685a3` matching **both** the
> Ethereum and the Base deployment.
>
> So the full chain of evidence is closed:
> Ethereum ≡ Base (same code) → that code ≡ the Etherscan-verified source (reproducible build) →
> that source's `StorageToken.sol` ≡ commit `0384d94` ≡ `contracts/legacy/StorageTokenPrev.sol`
> (identical file hash).
> **`contracts/legacy/StorageTokenPrev.sol` IS the deployed StorageToken source**, so the layout
> baseline used by `StorageTokenLayout.test.ts` is validated against what actually runs on mainnet,
> not merely against repo history. **Phase 0's exit criterion is MET.**
>
> (This also makes a testnet redeploy of the *old* code unnecessary as a way to confirm parity —
> a deterministic local rebuild proves strictly more, with no keys and no transactions.)
>
> **5. ⚠️ The live implementation was compiled with `optimizer.runs = 300`** (Etherscan:
> solc `v0.8.24+commit.e11b9ed9`, `viaIR: true`, `evmVersion: shanghai`, `runs: 300`). The repo
> default is 200, and this branch pins `StorageToken.sol` to **100** because the bridge code pushes
> it to 23.950 KiB against the 24 KiB EIP-170 limit (200 already overflows).
> **Operational consequence, not previously recorded:** the upgrade lowers the optimization level
> from 300 to 100, so runtime gas on hot paths — notably `transfer` — will rise somewhat for every
> holder. This is unavoidable at the current contract size and does not affect storage layout or
> correctness, but it should be measured and communicated in the release note. Retiring `bridgeOp`
> and deleting `TokenBridge.sol` would free room to raise `runs` again in a follow-up.
>
> **6. Fork rehearsal — PASSED ON BOTH CHAINS (12/12 each).** `test/fork/StorageTokenUpgrade.fork.test.ts`
> was previously never executed. It now runs against real live state:
> `FORK_RPC_URL=<base rpc>     FORK_TARGET=base     npx hardhat test test/fork/StorageTokenUpgrade.fork.test.ts`
> `FORK_RPC_URL=<ethereum rpc> FORK_TARGET=ethereum npx hardhat test test/fork/StorageTokenUpgrade.fork.test.ts`
> Confirms on each chain: appended slots 16/17 and the whole 18..64 gap read ZERO on the live
> proxy; the real 2-of-2 governance proposal + 24h delay + `upgradeToAndCall` succeeds; **no
> pre-existing state changes**; bridge mint/burn move `totalSupply` exactly and take no treasury
> fee; the per-minter cap holds; existing holder balances are untouched; ordinary `transfer` still
> works after the upgrade.
> Two fixes were required to make this runnable at all: Hardhat needs an explicit
> `networks.hardhat.chains` hardfork history for non-builtin chains (Base 8453) or the fork aborts,
> and admin discovery had to stop relying on `AccessControlEnumerable` (StorageToken does not
> inherit it) — the real ADMIN_ROLE holders are now recorded in `scripts/bridge/live.ts` as
> `LIVE_ADMINS`, read from the `RoleGranted` logs emitted by `initialize`.
>
> **Still open (requires funded keys and outbound transactions, deliberately not done):** the
> Sepolia ↔ Base Sepolia testnet rehearsal against real DVNs/Executors, which is the only thing
> that exercises real fee quoting and real `lzReceive` gas measurement.

## Context

FULA (`StorageToken`) is live on Ethereum (~1.5B), Base (~400M), SKALE and IoTeX. Today there is **no working bridge**: `bridgeOp()` requires an admin to pre-arm a nonce per operation and mints only to the token contract, and `contracts/core/TokenBridge.sol` was an early effort that was never deployed. Both are operator-gated, so moving tokens needs a human in the loop.

**Goal:** any holder moves FULA from Ethereum to Base permissionlessly — no per-transfer admin, no project-run server/relayer/validator, audited contracts, and **global total supply must stay constant**.

**Chosen approach:** LayerZero v2 **`MintBurnOFTAdapter`** — burn on source, mint on destination, so global supply is conserved by construction. Selected over Chainlink CCIP (no SKALE path, can't self-deploy), Wormhole NTT (ETH+Base only), Hyperlane (would require running our own validators on SKALE/IoTeX), and the OP canonical bridge (would create a *second* FULA on Base and can't represent pre-existing native Base supply). LayerZero also already supports SKALE, leaving a future path.

**Constant-supply is satisfied by the framework** — `_debit` burns `amountSentLD` and the destination mints exactly `_toLD(_toSD(amountSentLD))`, bit-for-bit. Sub-1e-6 "dust" is never burned; it stays in the sender's wallet. **But only if the `_update` bug below is fixed first.**

### Blocking bug found during research

`StorageToken.sol:93-107` overrides `_update` and applies the treasury fee to *all* transfers. In OZ v5 `_mint` and `_burn` both route through `_update`, so when `platformFeeBps > 0`:
- `burn(100)` transfers 5 to treasury (supply unchanged) and burns only **95**
- `mint(100)` mints 5 to treasury and only **95** to the recipient

Across a bridge hop that inflates global supply by up to 5% per transfer, unbounded and round-trippable. Latent today only because `platformFeeBps == 0`, and there is **zero test coverage** of the fee path. Fixing this is a prerequisite, not an optional cleanup.

### Assumptions (change before implementation if wrong)

1. **Scope: Ethereum ↔ Base only.** Scripts written generically so SKALE is a later config addition. (SKALE needs separate work: its endpoint is an `EndpointV2Alt` variant with ERC-20 fees, and only one DVN exists there.)
2. **Adapter owner = OpenZeppelin `TimelockController`** (48–72h delay, no admin after setup). See "Ownership" below.
3. **Keep `bridgeOp`**, mark deprecated; delete the dead `TokenBridge.sol` in a separate cleanup commit.
4. **Ethereum and Base implementation *addresses* differ, but the code is probably identical** (both were deployed at the same time from the same source). Differing addresses are explained by deployer nonce ordering, not by a version difference — note `0x9e12735d…` is Ethereum's *implementation* and simultaneously the *proxy* on the other chains, i.e. the same deployer nonce produced different artifacts on different chains. **This is unverified either way** and is settled cheaply by the bytecode comparison in Phase 0. Plan for one shared implementation; if Phase 0 shows the bytecode differs, fall back to two legacy reference sources and two independent layout validations.

### Ownership: why not ownerless

Renouncing (`renounceOwnership`) is possible but is a footgun for a bridge. DVNs are off-chain companies; if a required DVN goes dark and config is frozen, tokens already burned on Ethereum **can never be minted on Base** — permanent loss. A compromised DVN could not be rotated out. And renouncing without setting config just inherits LayerZero's defaults, which LayerZero can change.

A `TimelockController` gets ~95% of the benefit: nothing changes silently, no unilateral action, users can exit during the delay — but a dead DVN can still be rotated instead of stranding funds. Path to further decentralization: timelock → optionally renounce later once the DVN set proves durable. The `bridgeMinters` cap (below) independently bounds damage at the token layer.

---

## Live deployments (verified via `scripts/checkProxyStorage.ts`)

| Chain | StorageToken proxy | Implementation |
|---|---|---|
| Ethereum (1) | `0x92217cCaEDBdbc54C76c15feA18823db1558fDc9` | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` |
| Base (8453) | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` | `0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb` |
| SKALE / IoTeX | `0x9e12735d77c72c5C3670636D428f2F3815d8A4cB` | `0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb` |

⚠️ `0x9e12735d…` is Ethereum's *implementation* **and** the *proxy* on the other chains (same deployer + nonce). Do not conflate. The implementation addresses differing across chains is **normal and expected** — it is a nonce artifact and says nothing about whether the code differs. Phase 0 resolves that by comparing bytecode.

**LayerZero:** EID Ethereum `30101`, Base `30184`. EndpointV2 `0x1a44076050125825900e736c501f859c50fE728c` (both). SendUln302 ETH `0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1` / Base `0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2`. ReceiveUln302 ETH `0xc02Ab410f0734EFa3F14628780e6e695156024C2` / Base `0xc70AB6f32772f59fBfc23889Caf4Ba3376C84bAf`. Testnet: Sepolia `40161`, Base Sepolia `40245`, endpoint `0x6EDCE65403992e310A62460808c4b910D972f10f`. All addresses go in `scripts/bridge/addresses.ts` as the single source of truth.

---

## Design decisions

**Do not touch `contracts/governance/GovernanceModule.sol`.** It is shared by ~10 live contracts. `GovernanceModule.sol:244` hardcodes the four grantable roles, so a new role constant would be rejected; `:247-248` (`AlreadyOwnsRole`) means an address can hold only one governance role. Reusing `BRIDGE_OPERATOR_ROLE` is rejected outright — it would hand arbitrary mint power to every existing operator EOA.

**Instead: token-local authorization via new custom proposal types.** `GovernanceModule.sol:281-284` routes any unrecognised `uint8` proposal type to `_createCustomProposal`, and `proposalType` is stored as `uint8`, so types **12 (SetBridgeMinter)** and **13 (RemoveBridgeMinter)** need no enum change, no struct change, and no parent edit — while inheriting the existing 2-approval + 24h-delay + 48h-expiry machinery. Reserve the numbers with a comment in `ProposalTypes.sol`; define the constants in `StorageToken.sol`.

**No shim contract.** A shim still requires the same token upgrade (something must be authorised to mint) while adding a third contract to the trust path. Implement `IMintableBurnable` directly on the token. The resulting `burn(address,uint256)` / inherited `burn(uint256)` overload is legal with distinct selectors and has **zero call sites** in this repo (`rg '\.burn\(' --type ts` hits only the unrelated ERC-1155 tests). TS callers use `token["burn(uint256)"](x)`.

**Both `mint` and `burn` MUST `returns (bool)`** — `IMintableBurnable` declares it, and Solidity's ABI decoder reverts on empty returndata, which would make every transfer fail. Revert on failure; never return `false`.

---

## Phase 0 — Verification gate (BLOCKING, no code)

`.openzeppelin/` is gitignored (`.gitignore:19-21`) and no mainnet manifests exist, so we cannot validate any upgrade until we know exactly what is deployed.

1. Run `npx hardhat run scripts/checkProxyStorage.ts --network ethereum|base` — confirm the ERC-1967 slot still matches the table above. If not, stop.
2. **New `scripts/verifyStorageTokenImplParity.ts`** (read-only): `eth_getCode` both impls, strip the CBOR metadata trailer (last 2 bytes = big-endian length; slice `len + 2`), compare `keccak256`. Also cross-check `name()`, `symbol()`, `maxSupply()`, `totalSupply()`, `adminCount()`, `treasury()`, `roleConfigs(ADMIN_ROLE).quorum` on both proxies, and diff each against locally compiled `deployedBytecode`.
3. Pull verified sources from Etherscan/Basescan and commit as `contracts/legacy/StorageTokenLiveEth.sol` and `StorageTokenLiveBase.sol` (rename contracts; renaming does not affect layout). These are the manifest-free validation baseline.
4. Record `totalSupply()` on **all four** chains. If the sum exceeds 2B, full consolidation onto one chain would be impossible — decide before launch.
5. **Un-ignore `.openzeppelin/`** — `contracts/UPGRADING.md:96` explicitly instructs committing these manifests; the ignore rule is what created this problem.

**Exit criterion:** we can state with bytecode evidence exactly which source runs on Ethereum and on Base.

---

## Phase 1 — StorageToken upgrade (the only proxy change)

**File: `contracts/core/StorageToken.sol`**

Storage is append-only. StorageToken is "Legacy group" (`contracts/UPGRADING.md:35`, first child slot 11) → **no absorber gap at the top**; confirm empirically in Phase 4. Append after `PackedVars private packedVars;` (line 35):

```solidity
struct BridgeMinter { bool enabled; uint96 cap; int96 netMinted; } // 1 slot
mapping(address => BridgeMinter) public bridgeMinters;  // slot 16
uint256 public voluntarilyBurned;                       // slot 17
uint256[47] private __gap;                              // slots 18..64
```

1. **Fix `_update` (lines 93-107)** — keep the blacklist checks unconditional, but bypass the fee when `from == address(0) || to == address(0)`.
2. **Add `mint(address,uint256) returns (bool)`** — `whenNotPaused nonReentrant`, requires `bridgeMinters[msg.sender].enabled`, rejects zero address/amount, enforces `totalSupply() + amount <= TOTAL_SUPPLY` **and** `netMinted + amount <= cap`, updates `netMinted`, `_mint`, emits `BridgeMint`.
3. **Add `burn(address,uint256) returns (bool)`** — same guards, decrements `netMinted`, `_burn`, emits `BridgeBurn`.
4. **Override inherited `burn(uint256)` / `burnFrom`** to increment `voluntarilyBurned`, then `super`. This closes the headroom-manufacturing hole: public burns currently create fresh `bridgeOp` mint capacity under a `totalSupply()`-based cap.
5. **Fix `bridgeOp` cap (line 188)** — `op == 1` becomes `totalSupply() + voluntarilyBurned + amount <= TOTAL_SUPPLY`. Mark the function `@custom:deprecated`.
6. **`_createCustomProposal` (lines 210-266)** — add types 12/13 to the dispatch and to the `if` at 242-247. Type 12 requires `target.code.length > 0` (contract only) and `amount > 0`, and sets `proposal.amount = amount`; re-issuing on an enabled minter is how the cap is raised. Type 13 requires the target be currently enabled. **Also fix `ChangeTreasuryFee`**: the branch at 248-263 never writes `proposal.amount`, so `_executeCustomProposal:299` always sets the fee to 0 — one line, in a function we are already editing.
7. **`_executeCustomProposal` (lines 279-304)** — type 12 sets `enabled = true, cap = proposal.amount`; type 13 sets `enabled = false` but **keeps `netMinted`** for accounting.
8. `_handleCustomProposalExpiry` needs no change.

**File: `contracts/governance/interfaces/IStorageToken.sol`** — append events `BridgeMint`, `BridgeBurn`, `BridgeMinterSet`, `BridgeMinterRemoved`; errors `NotBridgeMinter(address)`, `BridgeMintCapExceeded(uint256,uint96)`. Interface-only, no storage impact.

**Why `int96 netMinted` and not a monotonic `cumulativeMinted`:** bridge mints are not issuance — they are 1:1 backed by a remote burn. A monotonic counter would strangle the bridge after enough round trips. `netMinted` (mints − burns, may go negative) with a governance-set `cap` gives a real staged-rollout lever and bounds a DVN compromise at the token layer, independent of the adapter. `uint96` matches `createProposal`'s `amount` parameter exactly.

---

## Phase 2 — The adapter

**New file: `contracts/bridge/FulaOFTAdapter.sol`** — `MintBurnOFTAdapter` + `RateLimiter`, immutable (plain `ContractFactory`, **never** `hardhat-upgrades`).

```solidity
constructor(address _token, IMintableBurnable _minterBurner, address _lzEndpoint, address _owner)
    MintBurnOFTAdapter(_token, _minterBurner, _lzEndpoint, _owner)
    Ownable(_owner)   // required: OAppCore is Ownable but never calls Ownable(...) under OZ 5
{}
```

- `_token` and `_minterBurner` are both the StorageToken **proxy**.
- `_owner` is also the LayerZero delegate (`OAppCore`'s constructor calls `endpoint.setDelegate`). Must be the Timelock/Safe — see risk R-03.
- Add `setRateLimits` / `resetRateLimits` (`onlyOwner`).
- **Do not override `sharedDecimals()`** — the default 6 is what makes burn == mint exact.
- **Override `_debit`/`_credit` with supply-invariant assertions**: `_debit` asserts `totalSupply()` fell by exactly `amountSentLD`; `_credit` asserts the recipient's balance rose by exactly `_amountLD`; revert `SupplyInvariantViolated` otherwise. `MintBurnOFTAdapter._credit` returns `_amountLD` unconditionally, so without this a fee regression would inflate supply invisibly to LayerZero. ~6 lines, highest value in the change. Call `_outflow(_dstEid, amountSentLD)` in `_debit` for the rate limiter.

---

## Phase 3 — Dependencies

Add to `dependencies` only: `@layerzerolabs/oft-evm@^4.0.1`, `@layerzerolabs/oapp-evm@^0.4.1`, `@layerzerolabs/lz-evm-protocol-v2@^3.0.148`, `solidity-bytes-utils@^0.8.2`. All are `pragma ^0.8.20/^0.8.22` → fine under 0.8.24 + viaIR + shanghai.

**Do NOT install** `@layerzerolabs/toolbox-hardhat` / `devtools-evm-hardhat` (peer-dep ethers ^5 + hardhat-deploy; this repo is ethers 6.15.0), `lz-evm-messagelib-v2`, or `test-devtools-evm-hardhat`. The latter two pin `@openzeppelin/contracts@^4.8.1` as a **hard dependency**, and Hardhat's relative import resolution would pull OZ 4.x into the same compile graph as OZ 5.3. Encode `UlnConfig`/`ExecutorConfig` in TypeScript with `ethers.AbiCoder` instead of importing them.

**Gate:** after `yarn install`, `yarn why @openzeppelin/contracts` must return exactly one `5.3.x` entry.

`hardhat.config.ts`: exclude mocks from `contractSizer` (`strict: true` at lines 285-290 fails the build on overflow); add a `runs: 1` per-file override for `StorageToken.sol` **only if** the size check fails, mirroring the `RewardEngine` precedent at lines 87-102 (optimizer runs do not affect layout); add forking config for fork tests.

---

## Phase 4 — Tests

Follow the `StorageToken.test.ts` idiom: `upgrades.deployProxy(..., {kind:'uups', initializer:'initialize'})`, `SignerWithAddress`, `time` from `@nomicfoundation/hardhat-network-helpers`, `time.increase(24*60*60+1)` after deploy, `setRoleQuorum(ADMIN_ROLE, 2)`. Reuse the `getProposalIdFromLogs` helper from `test/governance/integration/TokenBridgeContract.test.ts:32-47`. Import typechain from `../../../typechain-types`.

**`contracts/test/MockLZEndpointV2.sol`** — hand-rolled ~150-line loopback endpoint (`setDelegate`, `quote`, `send`, `lzReceive`, `eid`, no-op `setConfig`/`setSendLibrary`) with `setDestLzEndpoint` pairing. Hand-rolled specifically to avoid the OZ 4.x contamination above.

**`test/governance/integration/FulaOFTBridge.test.ts`:**
- **The regression test for this whole project:** set `platformFeeBps = 500` via governance (needs the type-11 fix), then assert mint/burn move **zero** to treasury and `totalSupply()` moves by exactly the amount.
- `mint`/`burn` revert `NotBridgeMinter` for non-registered callers — including a `BRIDGE_OPERATOR_ROLE` holder and the `ADMIN_ROLE` owner.
- Full type-12 governance flow; approval before 24h does not execute; type 12 on an EOA reverts; `amount == 0` reverts; type 13 on unregistered reverts; second proposal on same target → `ExistingActiveProposal`.
- Cap: mint to `cap`, next wei reverts; burn then mint again succeeds.
- `voluntarilyBurned` increments on `burn(uint256)`/`burnFrom` but **not** on `burn(address,uint256)`.
- Paused / blacklisted `to` / blacklisted `from` all revert.
- `ChangeTreasuryFee` actually sets the fee (regression for the `proposal.amount` bug).
- **Supply conservation:** `supplyA + supplyB` identical before/after a round trip, with and without dust.
- Dust: send `1e18 + 999` → exactly `1e18` burned, `999` retained, `1e18` minted remotely.
- Destination mint reverting leaves source supply reduced and is replayable after the condition clears.
- Rate limiter exceed + decay; `setPeer(eid, bytes32(0))` halts both directions; `SupplyInvariantViolated` fires against a deliberately lossy mock token.

**`test/fork/StorageTokenUpgrade.fork.test.ts`** — highest fidelity. Fork Ethereum and Base, impersonate the live admins, run the real governance sequence, `upgradeToAndCall`, then deploy a real adapter against the **real** EndpointV2 and exercise `quoteSend`/`send`; simulate inbound by impersonating the endpoint. Assert every pre-existing balance, `totalSupply`, `adminCount`, `proposalCount`, `treasury` and role membership is byte-identical pre/post.

Add `test:bridge:oft` and `test:fork:token` to `package.json` matching the existing `test:*` shape.

---

## Phase 5 — Scripts

New `scripts/bridge/`: `addresses.ts` (EIDs/endpoints/ULNs/DVNs/executors), `deployStorageTokenImpl.ts`, `proposeUpgrade.ts`, `executeUpgrade.ts` (with window checks), `deployOFTAdapter.ts`, `proposeBridgeMinter.ts`, `approveProposal.ts`, `wireOApp.ts`, `verifyOAppConfig.ts`, `sendTest.ts`. Plus `scripts/verifyStorageTokenImplParity.ts` and `scripts/validateStorageTokenUpgrade.ts`.

Follow existing conventions: `process.env.X?.trim()` with throw-guards, `upgrades.deployImplementation(F, {kind:'uups', unsafeAllow:['constructor']})`, `upgrades.erc1967.getImplementationAddress`, conditional `hre.run("verify:verify")` behind `ETHERSCAN_API_KEY`, `main().then(exit 0).catch(exit 1)`, and a trailing comment with the exact CLI invocation. Template: `scripts/deployTokenBridge.ts`; validation template: `scripts/validateRewardEngineUpgrade.ts` (note it passes the **implementation** address, not the proxy, to `validateUpgrade` — line 71).

`wireOApp.ts` encodes with `ethers.AbiCoder`:
`UlnConfig = tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)` (configType 2), `ExecutorConfig = tuple(uint32 maxMessageSize, address executor)` (configType 1, send lib only). **`requiredDVNs` must be ascending-sorted and deduped** or `UlnBase` reverts `LZ_ULN_Unsorted`. Read current defaults via `endpoint.getConfig(ZeroAddress, SEND_ULN_302, remoteEid, 2)` and use at least the default `confirmations`.

---

## Verification

Three independent layout checks — **all must pass, per network**:

- **A (primary, no network needed): ✅ IMPLEMENTED AND PASSING.** `upgrades.validateUpgrade(LiveFactory, NewFactory, {kind:'uups', unsafeAllow:['constructor']})` using the `contracts/legacy/` reference source. `validateUpgrade` accepts a reference *factory*, so no manifest is required. Implemented as `test/governance/integration/StorageTokenLayout.test.ts` against `contracts/legacy/StorageTokenPrev.sol` (an exact copy of `StorageToken.sol` at `0384d94`, contract renamed only — renaming does not affect layout). Run with `yarn test:layout`. The suite also runs the same two factories in **reverse** to prove the check is not silently a no-op. If Phase 0 shows the Ethereum and Base bytecode is identical, one reference source suffices; if it differs, add a second reference and run this against **both**.
- **B:** `upgrades.forceImport(proxy, LiveFactory)` per `UPGRADING.md:96` — using the **legacy** factory, not repo HEAD; passing the wrong factory records a worthless baseline. Then `validateStorageTokenUpgrade.ts --network ethereum` and `--network base`. Commit the manifests.
- **C:** Inspect the manifest's first `StorageToken` `layout.storage[]` entry (`UPGRADING.md:42-48`). Expect `slot: "11"` → Legacy → no absorber. If `"51"`, stop and add `uint256[40] private __gap;` as the first state declaration. Record the answer in the `UPGRADING.md:81` table, per network.

Then, in order: **local mock tests** (logic, governance, caps, dust, conservation) → **mainnet fork tests** (will the upgrade brick the live proxy; does the real endpoint accept our config) → **public testnet Sepolia ↔ Base Sepolia** (the only thing exercising real DVNs, Executors, fee quoting and real `lzReceive` gas). The testnet run is **required** and must include a deliberate fail-then-retry drill: blacklist the recipient, send, observe the parked message on LayerZero Scan, un-blacklist, retry, confirm delivery. Measure actual `lzReceive` gas and set the enforced option to 1.5× (expect ~120-170k; start at 250k).

**Daily supply reconciliation** during rollout: sum `totalSupply()` across all live chains, compare to the previous day, alert on any delta not explained by a matched `OFTSent`/`OFTReceived` pair. This is the canary for the entire constant-supply property.

---

## Rollout

**Preconditions per chain (verify, don't assume):** `roleConfigs(ADMIN_ROLE).quorum >= 2`; both admins past `roleChangeTimeLock`; contract **unpaused** (`_authorizeUpgrade` is `whenNotPaused`); `adminCount >= 2`; keys funded.

**Upgrade (per chain):** deploy impl → validate → Admin1 `createProposal(3, 0, IMPL, ZeroHash, 0, ZeroAddress)` (record `T0`) → Admin2 `approveProposal` (safe any time; the `Upgrade` branch at `GovernanceModule.sol:528` deliberately does nothing and leaves the proposal valid for `_checkUpgrade`) → wait → `proxy.upgradeToAndCall(IMPL, "0x")` **inside `[T0+24h, T0+48h)`** → re-verify state. If the window is missed, deploy a *new* impl address and restart. (`MIN_PROPOSAL_EXECUTION_DELAY` is 24h and the effective `PROPOSAL_TIMEOUT` is **48h** — `GovernanceModule.sol:78`, which shadows the unused `ProposalTypes.PROPOSAL_TIMEOUT = 3 days`. An intermediate revision of this doc changed the window to 72h on the strength of the dead constant; that was wrong.)

**Adapter:** deploy with `_owner = Timelock` → assert `token()`, `minterBurner()`, `owner()`, `endpoint.delegates()`, `sharedDecimals() == 6`, `decimalConversionRate() == 1e12`, `approvalRequired() == false` → `createProposal(12, 0, ADAPTER, ZeroHash, CAP, ZeroAddress)` → approve/execute → confirm `bridgeMinters(ADAPTER)`. **Complete on both chains before any wiring.**

**Wiring (symmetric, from the Timelock):** `setPeer` → `setSendLibrary` → `setReceiveLibrary` → `setConfig`(ULN+Executor on send lib; ULN on receive lib) → `setEnforcedOptions` → `setRateLimits` → `verifyOAppConfig.ts`. **The send-side ULN config on A must equal the receive-side ULN config on B**, or messages verify but never deliver.

**DVN policy:** `requiredDVNs = sort([LayerZero Labs, Nethermind])`, count 2, no optional. Both operate on Ethereum and Base. Never the 1-of-1 default — that configuration caused the ~$292M Kelp loss. Optionally add Google Cloud as a third once volume justifies the fee.

| Stage | Where | `cap` | rate limit / 24h | Gate |
|---|---|---|---|---|
| 0 | Sepolia ↔ Base Sepolia | 100M | 10M | full runbook + fail/retry drill + gas measured |
| 1 | Mainnet, team only | 1M | 100k | 10 round trips, supply reconciled to the wei |
| 2 | Mainnet, soft launch | 25M | 1M | 7 days clean |
| 3 | Mainnet | 250M | 10M | 30 days clean |

Cap raises are governance proposals (24h delay built in); rate-limit raises are Timelock transactions.

**Kill switches, fastest first:** `setRateLimits(limit 0)` (~1 block, halts outbound) → `setPeer(eid, bytes32(0))` (~1 block, halts both; inbound parks retryably) → `emergencyAction(1)` (pauses token; 30-min cooldown before unpause) → type-13 `RemoveBridgeMinter` (24h, permanent).

---

## Risk register (top items)

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| R-01 | `burn(address,uint256)` lets a registered minter burn **any** holder's balance with no allowance | Critical | Inherent to `MintBurnOFTAdapter` (`_debit` passes `msg.sender`). Only ever register **immutable, non-upgradeable, source-verified** adapters; type-12 enforces `code.length > 0`; test that no adapter path reaches `burn` with a non-`msg.sender` `_from`; document as a permanent invariant in `UPGRADING.md` |
| R-02 | Malicious `setPeer` ⇒ unlimited mint on destination | Critical | `onlyOwner` = Timelock; `bridgeMinters.cap` bounds damage at the token layer; `totalSupply()` cap; `verifyOAppConfig.ts` in monitoring |
| R-03 | LZ **delegate** can `endpoint.burn/nilify` an in-flight message ⇒ funds burned at source, never minted | Critical | Delegate = Timelock/Safe, never an EOA; monitor `PacketBurnt`/`PacketNilified`; document as never-use |
| R-04 | Storage-layout corruption (no manifests, two different impls) | Critical | Phase 0 bytecode parity + three independent validations + fork test diffing all state |
| R-05 | `platformFeeBps > 0` inflates supply via `_update` | Critical | The `_update` fix + adapter `SupplyInvariantViolated` boundary checks + explicit fee-path tests (currently zero) |
| R-06 | `mint`/`burn` without `returns (bool)` ⇒ every transfer reverts | High | Caught by mock tests; asserted explicitly; called out in NatSpec |
| R-07 | Send/receive ULN config mismatch ⇒ messages park indefinitely | High | `verifyOAppConfig.ts` as a hard gate; rehearsed on testnet; recoverable (funds not lost) |
| R-08 | Inbound parks because recipient blacklisted or token paused | Medium | By design and recoverable — `lzReceive` failures are permissionlessly retryable forever (`_clearPayload` and the OApp call are in the same tx, so a revert restores the payload hash) |
| R-11 | ETH + Base + SKALE + IoTeX supply exceeds 2B ⇒ consolidation impossible | Medium | Measure all four in Phase 0 and decide before launch |
| R-12 | OZ 4.x pulled in beside 5.3 by LZ hard deps | Medium | Interfaces only; hand-rolled mock; gate on `yarn why` |
| R-09 | `bridgeMinters.cap` too low ⇒ legitimate inbound parks | Medium | Retryable, so an outage not a loss. Alert at 80% of `netMinted`/`cap`; cap raises take 24h, so plan ahead of demand |
| R-10 | Enforced `lzReceive` gas too low ⇒ inbound reverts OOG | Medium | Measure on testnet, set 1.5×. Retryable with more gas by any caller |
| R-13 | `contractSizer.strict` fails build | Medium | Per-file `runs: 1` override, mirroring `hardhat.config.ts:87-102` |
| R-14 | Upgrade proposal misses the `[T0+24h, T0+48h)` window | Low | Scripted window check in `executeUpgrade.ts`; recovery = deploy a new impl address and restart (the old target address stays blocked by `pendingProposals` until expiry) |
| R-15 | `burn` overload breaks a downstream TS integration | Low | Zero in-repo call sites; on-chain selectors unchanged. Release note: use `token["burn(uint256)"]` |
| R-16 | Fixing `ChangeTreasuryFee` makes a previously-inert governance action live | Low | Deliberate and in scope; dedicated test; release note. Fee stays 0 unless governance acts |
| ~~R-17~~ | ~~`voluntarilyBurned` permanently consumes a chain's inbound headroom~~ | ~~Medium~~ **RETRACTED** | ⚠️ **THIS RISK DOES NOT EXIST — entry retracted 2026-07-26.** A voluntary burn of `X` moves BOTH terms of `mint`'s gate in opposite directions by the same amount (`voluntarilyBurned += X` and `totalSupply -= X`), so headroom `TOTAL_SUPPLY − totalSupply() − voluntarilyBurned` is **unchanged**. Voluntary burns are headroom-NEUTRAL: they cannot manufacture capacity (the bug this term was added to fix) and cannot destroy it. Only a **bridge** burn returns headroom, correctly, since those tokens are re-minted elsewhere. Pinned by two tests in `FulaOFTBridge.test.ts` ("a voluntary burn is headroom-NEUTRAL…", "a BRIDGE burn does restore headroom…"). An intermediate revision of this row asserted the opposite; it was wrong. See `docs/bridge-audit.md` F-1 for the full analysis |
| R-18 | Rate limit is NET not gross (`_inflow` in `_credit`), so round-tripped capital can exceed the intended per-window ceiling | Medium | **ACCEPTED (owner decision, 2026-07-26): keep NET.** Documented and pinned by test. `limit = 0` kill switch is unaffected; `bridgeMinters.cap` bounds inbound independently. Operational consequence: size the per-window limits as a *net-drain* budget, and rely on `cap` + daily supply reconciliation — not the limiter — to bound gross churn |

---

## Known pre-existing issues NOT fixed here (deliberate scope boundary)

Surfaced during research. **Decision (confirmed with the owner): all of these stay out of scope.** Each was checked against the bridge path and is unrelated to it; fixing them would widen the blast radius of an already high-stakes upgrade to a live token. Recorded so they are decisions, not oversights.

- **Inherited `burn(uint256)` / `burnFrom` lack `whenNotPaused` and `nonReentrant`**, unlike every other state-changing function in the token. Impact is bounded — a caller can only burn their own balance or one they hold an allowance for. ⚠️ **Note the partial exception:** this plan *does* modify these two functions, but only to add `voluntarilyBurned` accounting (our mint path relies on the `totalSupply() + amount <= TOTAL_SUPPLY` backstop, which public burns would otherwise inflate headroom against). The missing guards are deliberately left as-is. Revisit in the `bridgeOp` retirement upgrade.
- **`transferFrom` and `approve` are not overridden**, so they bypass `whenNotPaused`/`nonReentrant` while `transfer` (line 134) has both. A pause therefore does **not** stop `transferFrom`. Unrelated to the bridge: the new `mint`/`burn` are `whenNotPaused`, so the bridge kill switch is unaffected.
- **`RemoveRole` silently un-whitelists.** `GovernanceModule.sol:584` does `delete timeConfigs[account]`, wiping `whitelistLockTime` alongside the role. A live footgun for operators, but not reachable by this design (the adapter holds no role and must never be whitelisted), and fixing it means editing `GovernanceModule`, shared by ~10 live contracts.
- **A blacklisted `treasury` would revert every fee-bearing transfer globally.** Only reachable if `platformFeeBps > 0`. The `_update` fix makes the bridge strictly *more* robust here, since mint/burn will no longer route through the treasury. Add to the operational checklist for any future fee change.
- **Fee rounding emits spurious zero-value `Transfer` events to treasury** for very small amounts. The `_update` fix removes these from the mint/burn path.
- **`_checkExpiredProposal` emits `ProposalExpired` with zeroed fields** because it deletes before emitting. ⚠️ This will also apply to the new type-12/13 proposals — an expired `SetBridgeMinter` appears blank in monitoring. Cosmetic, but know it before operating the rollout.
- **`contracts/core/TokenBridge.sol` and its test/scripts are dead code** (never deployed). Delete in a separate cleanup commit so this change's diff stays reviewable.

## Critical files

- `contracts/core/StorageToken.sol` — the only proxy-side change (`_update` 93-107, `bridgeOp` cap 188, `_createCustomProposal` 210-266, `_executeCustomProposal` 279-304, state appended after line 35)
- `contracts/governance/GovernanceModule.sol` — **read-only reference, do not edit** (custom dispatch 281-284, role whitelist 244, `AlreadyOwnsRole` 247-248, `Upgrade` no-op 528)
- `contracts/governance/interfaces/IStorageToken.sol` — new events/errors
- `contracts/bridge/FulaOFTAdapter.sol` — new
- `contracts/test/MockLZEndpointV2.sol` — new
- `contracts/legacy/StorageTokenLiveEth.sol`, `StorageTokenLiveBase.sol` — new, validation baselines
- `scripts/validateRewardEngineUpgrade.ts` — template to copy (passes impl address, not proxy, line 71)
- `scripts/checkProxyStorage.ts` — holds the live proxy/impl pairs
- `contracts/UPGRADING.md` — mandatory pre-deploy gate; update the StorageToken row (line 81) with per-network classification
- `hardhat.config.ts`, `package.json`
