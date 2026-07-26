// Storage-layout validation for the LayerZero OFT bridge upgrade to the LIVE StorageToken proxy.
//
// This is check "A" (primary) and check "C" from the Verification section of
// docs/bridge-design.md, both of which run entirely OFFLINE — no RPC, no .openzeppelin manifest.
//
// WHY THIS FILE EXISTS
// `.openzeppelin/` is gitignored and there is no committed mainnet manifest, so
// `upgrades.upgradeProxy` has no recorded baseline to diff the new implementation against.
// `validateUpgrade` accepts a reference *factory* instead of a manifest, and
// `contracts/legacy/StorageTokenPrev.sol` supplies that baseline: an exact copy of
// StorageToken.sol at commit 0384d94 (the last commit before this branch), renamed only.
//
// WHAT THIS PROVES: the branch's diff to StorageToken is append-only and upgrade-compatible —
// no reordered, removed, resized or retyped variable.
// WHAT IT DOES NOT PROVE: that the live Ethereum/Base proxies actually run that reference code.
// That is Phase 0 bytecode parity, needs network access, and is still open.
import { expect } from "chai";
import hre, { ethers, upgrades } from "hardhat";

/**
 * The COMPLETE expected storage layout of the upgraded StorageToken, in slot order.
 *
 * Asserted as an ordered list rather than looked up by name, for two reasons:
 *  1. `packedVars` is declared TWICE — by GovernanceModule (slot 9) and by StorageToken (slot 15).
 *     solc's `contract` field on a layout entry names the COMPILATION TARGET, not the declaring
 *     contract, so every entry reads `...:StorageToken` and a name lookup cannot tell them apart.
 *     Position can.
 *  2. An exact list also catches INSERTIONS and DELETIONS anywhere in the layout, which a set of
 *     per-name spot checks would miss.
 *
 * Slots 0..10 belong to GovernanceModule (shared by ~10 live contracts, out of scope for this
 * change). Slots 11..15 are the currently-deployed StorageToken state and are FROZEN. Slots 16+
 * are what this upgrade appends.
 */
const EXPECTED_LAYOUT: Array<[slot: string, label: string]> = [
  // --- GovernanceModule (parent) — must not move -------------------------
  ["0", "adminCount"],
  ["1", "proposals"],
  ["2", "pendingProposals"],
  ["3", "timeConfigs"],
  ["4", "roleConfigs"],
  ["5", "upgradeProposals"],
  ["6", "proposalIndex"],
  ["7", "proposalCount"],
  ["8", "proposalRegistry"],
  ["9", "packedVars"], // GovernanceModule's
  ["10", "_pendingOwnerRequest"],
  // --- StorageToken, as currently DEPLOYED — frozen ----------------------
  ["11", "_usedNonces"], // slot 11 => "Legacy" group, no absorber gap
  ["12", "blacklisted"],
  ["13", "treasury"],
  ["14", "platformFeeBps"],
  ["15", "packedVars"], // StorageToken's own
  // --- Appended by this upgrade ------------------------------------------
  ["16", "bridgeMinters"],
  ["17", "voluntarilyBurned"],
  ["18", "__gap"], // uint256[47] => slots 18..64
];

/** The layout of the pre-branch reference: identical, minus everything from slot 16 on. */
const EXPECTED_LAYOUT_PREV = EXPECTED_LAYOUT.filter(([slot]) => Number(slot) <= 15);

type LayoutEntry = {
  label: string;
  slot: string;
  offset: number;
  type: string;
  contract: string;
};

/** Reduce a layout to the comparable (slot, label) sequence. */
function shape(layout: { storage: LayoutEntry[] }): Array<[string, string]> {
  return layout.storage.map((e) => [e.slot, e.label] as [string, string]);
}

/** Pull solc's emitted storageLayout for a contract out of the Hardhat build info. */
async function getStorageLayout(
  sourceName: string,
  contractName: string
): Promise<{ storage: LayoutEntry[]; types: Record<string, any> }> {
  const fqn = `${sourceName}:${contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fqn);
  if (!buildInfo) throw new Error(`No build info for ${fqn} — run \`npx hardhat compile\` first`);
  const layout = (buildInfo.output.contracts as any)[sourceName][contractName].storageLayout;
  if (!layout) throw new Error(`solc emitted no storageLayout for ${fqn}`);
  return layout;
}

describe("StorageToken bridge upgrade — storage layout", () => {
  describe("check A: validateUpgrade against the last-deployed source", () => {
    it("the new implementation is layout-compatible with the pre-branch reference", async () => {
      const Prev = await ethers.getContractFactory("StorageTokenPrev");
      const Next = await ethers.getContractFactory("StorageToken");

      // Throws with a detailed report on any incompatibility (reorder / delete / resize / retype).
      // `unsafeAllow: ['constructor']` is required because GovernanceModule's constructor calls
      // `_disableInitializers()`, which the plugin otherwise flags on a UUPS implementation.
      await upgrades.validateUpgrade(Prev, Next, {
        kind: "uups",
        unsafeAllow: ["constructor"],
      });
    });

    it("rejects an incompatible layout (proves the check is not a no-op)", async () => {
      // Guard against a false-green. If validateUpgrade were effectively inert — wrong options, a
      // plugin behaviour change, a factory that silently resolved to the same artifact — the test
      // above would pass no matter what the diff did.
      //
      // Running the SAME two factories in reverse is a real incompatibility: new -> prev deletes
      // `bridgeMinters` and `voluntarilyBurned`, which the plugin must reject. Using the existing
      // factories deliberately avoids adding a second ~24 KiB contract to the build, which would
      // risk tripping the EIP-170 sizer gate (`contractSizer.strict`).
      const Prev = await ethers.getContractFactory("StorageTokenPrev");
      const Next = await ethers.getContractFactory("StorageToken");

      let message = "";
      try {
        await upgrades.validateUpgrade(Next, Prev, {
          kind: "uups",
          unsafeAllow: ["constructor"],
        });
      } catch (e: any) {
        message = String(e?.message ?? e);
      }
      expect(message, "validateUpgrade accepted a layout deletion — the check is not working")
        .to.not.equal("");
      expect(message.toLowerCase()).to.match(/delet|incompatible|storage layout/);
    });
  });

  describe("check C: absolute slot assignments", () => {
    let layout: { storage: LayoutEntry[]; types: Record<string, any> };

    before(async () => {
      layout = await getStorageLayout("contracts/core/StorageToken.sol", "StorageToken");
    });

    it("the full slot layout matches expectation exactly", async () => {
      // One assertion covering: parent slots unmoved, the five deployed StorageToken variables
      // still on 11..15, the three new variables appended at 16..18, correct ORDER, and no
      // insertion or deletion anywhere. Any of those going wrong corrupts the live proxy.
      expect(shape(layout)).to.deep.equal(EXPECTED_LAYOUT);

      // Everything must start at a slot boundary — no accidental packing of a pre-existing
      // variable into a neighbour's slot.
      for (const e of layout.storage) {
        expect(e.offset, `${e.label} is packed at a non-zero offset`).to.equal(0);
      }
    });

    it("StorageToken is in the Legacy group — its first own variable is at slot 11", async () => {
      // contracts/UPGRADING.md classifies contracts by where their first CHILD variable lands.
      // Slot 11 => "Legacy" (GovernanceModule occupies 0..10, no absorber gap). Slot 51 would mean
      // a parent __gap absorber exists, and this upgrade would need `uint256[40] __gap` declared
      // as the FIRST state variable instead of appending at the end. Getting this wrong corrupts
      // the live proxy, so it is asserted rather than assumed.
      //
      // `_usedNonces` is the first variable StorageToken itself declares; GovernanceModule's last
      // is `_pendingOwnerRequest` at slot 10.
      const idx = layout.storage.findIndex((e) => e.label === "_usedNonces");
      expect(idx, "_usedNonces not found in layout").to.be.gte(0);
      expect(
        layout.storage[idx].slot,
        "StorageToken is NOT in the Legacy group — re-read UPGRADING.md before upgrading"
      ).to.equal("11");
      expect(layout.storage[idx - 1].label).to.equal("_pendingOwnerRequest");
      expect(layout.storage[idx - 1].slot).to.equal("10");
    });

    it("BridgeMinter packs into exactly one slot", async () => {
      // bool(1) + uint96(12) + int96(12) = 25 bytes <= 32. If a future edit widened a field, the
      // struct would silently spill into a second slot and every mapping entry would shift.
      const entry = layout.storage.find((e) => e.label === "bridgeMinters");
      const valueType = layout.types[entry!.type].value;
      expect(layout.types[valueType].numberOfBytes, "BridgeMinter no longer fits in one slot")
        .to.equal("32");

      const members: LayoutEntry[] = layout.types[valueType].members;
      expect(members.map((m) => m.label)).to.deep.equal(["enabled", "cap", "netMinted"]);
      // All three must share slot 0 of the struct.
      for (const m of members) expect(m.slot, `${m.label} spilled to another slot`).to.equal("0");
      expect(members.find((m) => m.label === "cap")!.type).to.equal("t_uint96");
      expect(members.find((m) => m.label === "netMinted")!.type).to.equal("t_int96");
    });

    it("the reserved gap ends at slot 64, leaving room for future appends", async () => {
      const gap = layout.storage.find((e) => e.label === "__gap");
      expect(gap!.type).to.equal("t_array(t_uint256)47_storage"); // slots 18..64 inclusive
      expect(Number(gap!.slot) + 47 - 1).to.equal(64);
    });

    it("the legacy reference really is the pre-branch layout (no bridge state)", async () => {
      // Also guards against a STALE build-info: several build-info files contain a StorageToken
      // layout (the per-file `runs: 100` override compiles it in its own job). If the reference
      // baseline were ever read from a stale artifact, this exact-shape check fails loudly rather
      // than silently validating against the wrong layout.
      const prev = await getStorageLayout(
        "contracts/legacy/StorageTokenPrev.sol",
        "StorageTokenPrev"
      );
      expect(shape(prev)).to.deep.equal(EXPECTED_LAYOUT_PREV);
      // The reference must end exactly where the new state begins.
      expect(Number(prev.storage[prev.storage.length - 1].slot)).to.equal(15);
    });
  });
});
