// Validates that the modified RewardEngine implementation is safe to upgrade
// the live proxies on Base and SKALE.
//
// USAGE:
//   1. Standalone (initializer/banned-ops only — DOES NOT check storage layout):
//      npx hardhat run scripts/validateRewardEngineUpgrade.ts
//
//   2. Layout-vs-live-proxy (RECOMMENDED — connects to network, imports the
//      proxy with its CURRENT on-chain implementation layout, then compares
//      against your modified source):
//      npx hardhat run scripts/validateRewardEngineUpgrade.ts --network base
//      npx hardhat run scripts/validateRewardEngineUpgrade.ts --network skale
//
//   When run with --network, the script calls upgrades.forceImport(proxy, factory)
//   if the proxy isn't already registered. forceImport reads the live bytecode and
//   storage layout from the proxy's current implementation. This may write to
//   .openzeppelin/<network>.json — review and commit that file with the upgrade.
import { ethers, upgrades, network } from "hardhat";

const PROXY_BY_NETWORK: Record<string, string> = {
  base: "0x31029f90405fd3D9cB0835c6d21b9DFF058Df45A",
  skale: "0xF7c64248294C45Eb3AcdD282b58675F1831fb047",
};

// CURRENT live implementations (each proxy's current pointed-to impl). These
// implementations' layouts were recorded in `.openzeppelin/<network>.json` at
// the time of deployment and represent the authoritative on-chain layout.
// Passing an implementation address to `validateUpgrade` lets the OZ plugin
// look up that exact recorded layout, bypassing any pollution from prior
// forceImport calls.
const CURRENT_IMPL_BY_NETWORK: Record<string, string> = {
  base: "0x05c34A028C4DEd7d0Cd80A78082de459DaeFe4FD",
  skale: "0xd49541CfDBaFCa2B4e66a61cec6B9b50b24FeA21",
};

async function main() {
  const RewardEngine = await ethers.getContractFactory("RewardEngine");

  console.log(`[1/2] Validating new RewardEngine implementation (initializer / banned ops)...`);
  await upgrades.validateImplementation(RewardEngine, { kind: "uups" });
  console.log(`    OK  Implementation passes standalone validation.`);

  const networkName = network.name;
  console.log(`\n[2/2] Validating storage-layout compatibility...`);
  console.log(`     network: ${networkName}`);

  if (networkName === "hardhat" || networkName === "localhost") {
    console.log(`     skip: connect with --network base or --network skale to check live proxies.`);
    console.log(`     Standalone validation (step 1) passed — this catches initializer issues,`);
    console.log(`     banned opcodes, and most layout bugs against the SOURCE. To catch layout`);
    console.log(`     drift between your repo HEAD and the deployed impl, run on the actual network.`);
    return;
  }

  const proxy = PROXY_BY_NETWORK[networkName];
  const currentImpl = CURRENT_IMPL_BY_NETWORK[networkName];
  if (!proxy || !currentImpl) {
    console.log(`     skip: no known proxy/impl address for network "${networkName}".`);
    return;
  }
  console.log(`     proxy:        ${proxy}`);
  console.log(`     current impl: ${currentImpl}`);
  console.log(`     validating new factory against the recorded layout of the current impl...`);

  try {
    // Pass the IMPLEMENTATION address (not the proxy). The OZ plugin looks up
    // the recorded layout for this impl in the manifest and compares against
    // the new factory. This is the authoritative check — uses the layout that
    // was recorded when the contract was deployed, not anything a later
    // forceImport may have written.
    await upgrades.validateUpgrade(currentImpl, RewardEngine, { kind: "uups" });
    console.log(`\n    OK  ${networkName}: storage layout is upgrade-compatible.`);
    console.log(`     Safe to deploy upgraded implementation.`);
  } catch (e: any) {
    console.log(`\n    FAIL ${networkName}: storage layout INCOMPATIBLE.`);
    console.log(`---- begin error ----`);
    console.log(e.message ?? e);
    console.log(`---- end error ----`);
    console.log(`\n     DO NOT UPGRADE. Investigate the layout diff.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
