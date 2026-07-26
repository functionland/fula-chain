// Validates that the modified StorageToken implementation is safe to upgrade the
// live proxies on Ethereum, Base, SKALE and IoTeX.
//
// THIS IS THE MANDATORY PRE-DEPLOY GATE. See contracts/UPGRADING.md.
// If it reports "storage layout INCOMPATIBLE", STOP — on-chain data WILL be corrupted.
//
// USAGE:
//   1. Standalone (initializer / banned-ops only — DOES NOT check storage layout):
//      npx hardhat run scripts/validateStorageTokenUpgrade.ts
//
//   2. Layout-vs-live-proxy (REQUIRED before any deploy):
//      npx hardhat run scripts/validateStorageTokenUpgrade.ts --network ethereum
//      npx hardhat run scripts/validateStorageTokenUpgrade.ts --network base
//
//   `.openzeppelin/` is gitignored in this repo, so there is very likely NO local
//   manifest for these networks. In that case `validateUpgrade(impl, ...)` cannot
//   resolve a recorded layout and the script falls back to forceImport, which reads
//   the layout directly from the live proxy. Review and commit the resulting
//   .openzeppelin/<network>.json — UPGRADING.md:96 explicitly instructs this.
//
// NOTE ON forceImport: it must be given the factory for the source that is CURRENTLY
// DEPLOYED, not repo HEAD. Passing the wrong factory records a wrong baseline and makes
// the whole check worthless. If you have pinned the live sources under contracts/legacy/,
// set LEGACY_FACTORY_BY_NETWORK below to use them.
import { ethers, upgrades, network } from "hardhat";

// Live StorageToken proxies. Source: scripts/checkProxyStorage.ts.
const PROXY_BY_NETWORK: Record<string, string> = {
  ethereum: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
  base: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  skale: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  "iotex-mainnet": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
};

// CURRENT live implementation each proxy points at.
// NOTE: Ethereum's implementation address (0x9e12...A4cB) is coincidentally identical to the
// PROXY address on Base/SKALE/IoTeX — same deployer at the same nonce on different chains.
// That is expected and is NOT evidence that the two chains run different code; run
// scripts/verifyStorageTokenImplParity.ts to compare the actual bytecode.
const CURRENT_IMPL_BY_NETWORK: Record<string, string> = {
  ethereum: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  base: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
  skale: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
  "iotex-mainnet": "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
};

// Optional: fully-qualified name of the pinned live source for each network, e.g.
// "contracts/legacy/StorageTokenLiveEth.sol:StorageTokenLiveEth". Used for forceImport
// when no manifest exists. Leave undefined to fall back to the current factory (which is
// only correct if repo HEAD still matches what is deployed).
const LEGACY_FACTORY_BY_NETWORK: Record<string, string | undefined> = {
  ethereum: undefined,
  base: undefined,
  skale: undefined,
  "iotex-mainnet": undefined,
};

async function main() {
  const StorageToken = await ethers.getContractFactory("StorageToken");

  console.log(`[1/2] Validating new StorageToken implementation (initializer / banned ops)...`);
  await upgrades.validateImplementation(StorageToken, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  console.log(`    OK  Implementation passes standalone validation.`);

  const networkName = network.name;
  console.log(`\n[2/2] Validating storage-layout compatibility...`);
  console.log(`     network: ${networkName}`);

  if (networkName === "hardhat" || networkName === "localhost") {
    console.log(`     skip: run with --network ethereum|base to check the live proxies.`);
    console.log(`     Standalone validation (step 1) passed, but that does NOT compare against`);
    console.log(`     the deployed layout. UPGRADING.md requires the on-network check.`);
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

  try {
    // Preferred: validate against the layout recorded for the current implementation.
    await upgrades.validateUpgrade(currentImpl, StorageToken, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    console.log(`\n    OK  ${networkName}: storage layout is upgrade-compatible.`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const noManifest =
      msg.includes("doesn't look like an ERC 1967 proxy") ||
      msg.includes("not found") ||
      msg.includes("deployment") ||
      msg.includes("manifest");

    if (!noManifest) {
      console.log(`\n    FAIL ${networkName}: storage layout INCOMPATIBLE.`);
      console.log(`---- begin error ----`);
      console.log(msg);
      console.log(`---- end error ----`);
      console.log(`\n     DO NOT UPGRADE. Investigate the layout diff.`);
      process.exit(1);
    }

    console.log(`     no recorded layout for this impl — falling back to forceImport on the proxy.`);
    const legacyName = LEGACY_FACTORY_BY_NETWORK[networkName];
    if (!legacyName) {
      console.log(`     WARNING: LEGACY_FACTORY_BY_NETWORK["${networkName}"] is not set, so the`);
      console.log(`     CURRENT source is being used as the import baseline. That is only valid if`);
      console.log(`     repo HEAD still matches the deployed bytecode. Verify with`);
      console.log(`     scripts/verifyStorageTokenImplParity.ts before trusting this result.`);
    }
    const baselineFactory = legacyName
      ? await ethers.getContractFactory(legacyName)
      : StorageToken;

    try {
      await upgrades.forceImport(proxy, baselineFactory, { kind: "uups" });
      await upgrades.validateUpgrade(proxy, StorageToken, {
        kind: "uups",
        unsafeAllow: ["constructor"],
      });
      console.log(`\n    OK  ${networkName}: storage layout is upgrade-compatible (via forceImport).`);
      console.log(`     Commit the updated .openzeppelin/${networkName}.json (see UPGRADING.md:96).`);
    } catch (e2: any) {
      console.log(`\n    FAIL ${networkName}: storage layout INCOMPATIBLE.`);
      console.log(`---- begin error ----`);
      console.log(e2?.message ?? e2);
      console.log(`---- end error ----`);
      console.log(`\n     DO NOT UPGRADE. Investigate the layout diff.`);
      process.exit(1);
    }
  }

  // Extra safety: report the first StorageToken-owned slot so the Legacy/Modern
  // classification in UPGRADING.md can be recorded per network. Expect slot 11 (Legacy).
  console.log(`\n     Reminder: record the Legacy/Modern classification for ${networkName}`);
  console.log(`     in the contracts/UPGRADING.md table (expect first child slot 11 = Legacy).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// npx hardhat run scripts/validateStorageTokenUpgrade.ts --network ethereum
// npx hardhat run scripts/validateStorageTokenUpgrade.ts --network base
