// Storage-layout pin for CommunityVoting.
//
// WHY THIS FILE EXISTS
// CommunityVoting is a GovernanceModule child, and `contracts/UPGRADING.md` documents how easy
// it is to corrupt such a child's layout: the parent's `__gap[40]` was added (2026-03-28) and
// later removed (2026-05-12), splitting live children into a "Legacy" group (first child slot 11)
// and a "Modern" group (first child slot 51, needing a leading absorber gap).
//
// CommunityVoting is a NEW deployment against the current gap-less GovernanceModule, so it
// belongs to the Legacy group: its first state variable must land at slot 11 and it must NOT
// declare a leading `__gap[40]`. This test pins that, and pins every subsequent slot, so any
// future edit that reorders, inserts, removes or resizes state fails loudly here rather than
// silently corrupting a live proxy.
//
// The expected values below were read from solc's emitted layout, not assumed.
import { expect } from "chai";
import hre, { ethers, upgrades } from "hardhat";

const SRC = "contracts/core/CommunityVoting.sol";

/** The COMPLETE expected layout, in slot order. */
const EXPECTED_LAYOUT: Array<[slot: string, label: string]> = [
  // --- GovernanceModule (parent) — shared by ~10 live contracts, must never move ---
  ["0", "adminCount"],
  ["1", "proposals"],
  ["2", "pendingProposals"],
  ["3", "timeConfigs"],
  ["4", "roleConfigs"],
  ["5", "upgradeProposals"],
  ["6", "proposalIndex"],
  ["7", "proposalCount"],
  ["8", "proposalRegistry"],
  ["9", "packedVars"],
  ["10", "_pendingOwnerRequest"],
  // --- CommunityVoting's own state. Slot 11 => Legacy group, no absorber gap. ---
  ["11", "token"],
  ["12", "stakingEngine"],
  ["13", "storagePool"],
  ["14", "_params"], // uint256[14] => slots 14..27
  ["28", "subjectCount"],
  ["29", "_subjects"],
  ["30", "_options"],
  ["31", "_optionSeen"],
  ["32", "tally"],
  ["33", "_receipts"],
  ["34", "_creatorOpen"],
  ["35", "lastCreateAt"],
  ["36", "totalLockedLiability"],
  ["37", "totalDepositLiability"],
  ["38", "__gap"], // uint256[50] => slots 38..87
];

type LayoutEntry = { label: string; slot: string; offset: number; type: string };

async function getStorageLayout(): Promise<{ storage: LayoutEntry[]; types: Record<string, any> }> {
  const buildInfo = await hre.artifacts.getBuildInfo(`${SRC}:CommunityVoting`);
  if (!buildInfo) throw new Error("No build info — run `npx hardhat compile` first");
  const layout = (buildInfo.output.contracts as any)[SRC]["CommunityVoting"].storageLayout;
  if (!layout) throw new Error("solc emitted no storageLayout");
  return layout;
}

describe("CommunityVoting — storage layout", () => {
  it("matches the pinned slot/label sequence exactly", async () => {
    const layout = await getStorageLayout();
    const actual = layout.storage.map((e) => [e.slot, e.label] as [string, string]);
    expect(actual).to.deep.equal(EXPECTED_LAYOUT);
  });

  it("places the first child variable at slot 11 (Legacy group, no leading absorber gap)", async () => {
    const layout = await getStorageLayout();
    // Everything from index 11 onward is CommunityVoting's own state.
    const firstChild = layout.storage[11];
    expect(firstChild.slot, "first child slot moved — see contracts/UPGRADING.md").to.equal("11");
    expect(firstChild.label).to.equal("token");
    // A leading `__gap` here would mean someone mistakenly applied the Modern-group rule.
    expect(firstChild.label).to.not.equal("__gap");
  });

  it("ends with a trailing __gap so future upgrades have room to append", async () => {
    const layout = await getStorageLayout();
    const last = layout.storage[layout.storage.length - 1];
    expect(last.label).to.equal("__gap");
    expect(layout.types[last.type].label).to.equal("uint256[50]");
  });

  it("reserves exactly 14 slots for the parameter vector", async () => {
    const layout = await getStorageLayout();
    const params = layout.storage.find((e) => e.label === "_params")!;
    const next = layout.storage.find((e) => e.label === "subjectCount")!;
    expect(Number(next.slot) - Number(params.slot)).to.equal(14);
  });

  it("is upgrade-safe as a UUPS implementation", async () => {
    const Factory = await ethers.getContractFactory("CommunityVoting");
    // `unsafeAllow: ['constructor']` matches the rest of the repo: GovernanceModule's constructor
    // calls _disableInitializers(), which the plugin otherwise flags on a UUPS implementation.
    await upgrades.validateImplementation(Factory, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
  });
});
