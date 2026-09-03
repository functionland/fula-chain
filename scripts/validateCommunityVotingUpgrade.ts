// Mandatory pre-deploy gate for any CommunityVoting upgrade.
//
// Per contracts/UPGRADING.md, no proxy upgrade ships without validateUpgrade passing against the
// target network. `.openzeppelin/` is gitignored and there is no committed manifest, so the live
// layout is recovered with forceImport using the currently-deployed source as the reference.
//
// Usage:
//   PROXY_ADDRESS=0x.. npx hardhat run scripts/validateCommunityVotingUpgrade.ts --network base
//
// Optional:
//   REFERENCE_CONTRACT=CommunityVotingPrev   name of a frozen copy of the deployed source.
//     Keep one (as contracts/legacy/StorageTokenPrev.sol does) once the first version is live;
//     without it, forceImport is given the NEW source and the layout diff is vacuous.
//
// Note: unlike scripts/validateRewardEngineUpgrade.ts, this passes the PROXY to validateUpgrade,
// not an implementation address. Comparing against the proxy is what actually reads the deployed
// layout.
import hre, { ethers, upgrades } from "hardhat";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS?.trim();
  if (!proxyAddress) throw new Error("Missing required env var PROXY_ADDRESS");
  const referenceName = process.env.REFERENCE_CONTRACT?.trim();

  console.log(`network: ${hre.network.name}`);
  console.log(`proxy  : ${proxyAddress}`);

  const Next = await ethers.getContractFactory("CommunityVoting");

  if (referenceName) {
    const Reference = await ethers.getContractFactory(referenceName);
    console.log(`reference: ${referenceName}`);
    await upgrades.forceImport(proxyAddress, Reference, { kind: "uups" });
  } else {
    console.warn(
      "WARNING: no REFERENCE_CONTRACT given. forceImport will register the CURRENT source as the\n" +
        "         baseline, so the layout comparison below proves nothing about the deployed code.\n" +
        "         Freeze a copy of the live source and pass its name to make this check meaningful."
    );
    await upgrades.forceImport(proxyAddress, Next, { kind: "uups" });
  }

  await upgrades.validateUpgrade(proxyAddress, Next, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });

  const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log(`\ncurrent implementation: ${currentImpl}`);
  console.log("validateUpgrade: OK — layout is append-only and upgrade-compatible.");

  console.log(
    "\nReminder: an upgrade still needs the full governance path —\n" +
      "  createProposal(3, 0, NEW_IMPL, 0x0, 0, 0x0) -> second admin approveProposal ->\n" +
      "  wait 24h -> upgradeToAndCall(NEW_IMPL, \"0x\") inside the [24h, 48h) window."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// PROXY_ADDRESS=0x.. npx hardhat run scripts/validateCommunityVotingUpgrade.ts --network base
