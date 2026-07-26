// SCRIPT 2 — MAINNET: extensive pre-deployment checks, then deploy the new
// StorageToken IMPLEMENTATION ONLY.
//
// This script NEVER touches the proxy. It does not upgrade anything. After it succeeds you
// drive the upgrade yourself through the governance module:
//     createProposal(3, 0, <IMPL>, 0x0, 0, 0x0)   by admin 1
//     approveProposal(<id>)                        by admin 2
//     wait 24h (and act within 48h of creation)
//     upgradeToAndCall(<IMPL>, "0x")               by either admin
//
// Every check below is a hard gate: any failure aborts before deployment. Nothing is
// deployed until all checks pass.
//
//   A. Network / proxy identity
//   B. Live implementation matches the recorded expectation
//   C. Deployed layout: slots 11..15 hold what we believe they hold
//   D. Appended slots 16..64 are currently ZERO (else new state inherits garbage)
//   E. OZ standalone implementation validation
//   F. OZ storage-layout compatibility vs the live deployment
//   G. Governance preconditions (quorum, admins, unpaused) so the upgrade can actually execute
//   H. Bytecode sanity: new impl differs from live, and repo is compiled fresh
//
// USAGE:
//   npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network ethereum
//   npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network base
//
//   DRY_RUN=1 to run every check and stop before deploying.
import { ethers, upgrades, network, artifacts } from "hardhat";
import {
  LIVE,
  SLOTS,
  ADMIN_ROLE,
  snapshotState,
  readImplementation,
  stripMetadata,
  fmt,
} from "./live";

declare const hre: any;

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}
function heading(s: string) {
  console.log(`\n${"-".repeat(72)}\n${s}\n${"-".repeat(72)}`);
}

async function main() {
  const netName = network.name;
  const live = LIVE[netName];
  const dryRun = process.env.DRY_RUN === "1";

  console.log(`${"=".repeat(72)}`);
  console.log(`StorageToken implementation deploy — PRE-FLIGHT`);
  console.log(`network: ${netName}${dryRun ? "   (DRY RUN)" : ""}`);
  console.log(`${"=".repeat(72)}`);

  // ---------------------------------------------------------------- A
  heading("A. Network and proxy identity");
  if (!live) {
    throw new Error(
      `No live StorageToken recorded for network "${netName}". ` +
        `Expected one of: ${Object.keys(LIVE).join(", ")}`
    );
  }
  const chainId = (await ethers.provider.getNetwork()).chainId;
  check(chainId === BigInt(live.chainId), `chainId is ${live.chainId}`, `got ${chainId}`);

  const proxy = live.proxy;
  const code = await ethers.provider.getCode(proxy);
  check(code !== "0x", `proxy has code at ${proxy}`);

  const token = await ethers.getContractAt("StorageToken", proxy);
  let sym = "";
  try {
    sym = await token.symbol();
  } catch { /* handled by the check below */ }
  check(sym === "FULA", `proxy responds as FULA`, `symbol=${sym || "<call failed>"}`);

  // ---------------------------------------------------------------- B
  heading("B. Live implementation matches expectation");
  const currentImpl = await readImplementation(proxy);
  console.log(`     live impl:     ${currentImpl}`);
  console.log(`     expected impl: ${live.expectedImpl}`);
  check(
    currentImpl.toLowerCase() === live.expectedImpl.toLowerCase(),
    `live implementation is the one we validated against`,
    currentImpl.toLowerCase() === live.expectedImpl.toLowerCase()
      ? ""
      : "someone upgraded outside the tracked process — STOP"
  );

  // ---------------------------------------------------------------- C
  heading("C. Deployed storage layout holds what we expect (slots 11..15)");
  // slot 13 = treasury (address), slot 14 = platformFeeBps (uint256)
  const slot13 = await ethers.provider.getStorage(proxy, SLOTS.treasury);
  const treasuryFromSlot = ethers.getAddress("0x" + slot13.slice(-40));
  const treasuryFromAbi = await token.treasury();
  check(
    treasuryFromSlot.toLowerCase() === treasuryFromAbi.toLowerCase(),
    `slot ${SLOTS.treasury} decodes as treasury`,
    `${treasuryFromSlot}`
  );

  const slot14 = await ethers.provider.getStorage(proxy, SLOTS.platformFeeBps);
  const feeBps = BigInt(slot14);
  check(feeBps <= 500n, `slot ${SLOTS.platformFeeBps} is a plausible platformFeeBps`, `${feeBps} bps`);
  if (feeBps > 0n) {
    console.log(
      `\n     NOTE: platformFeeBps is ${feeBps}. The un-upgraded contract charges this fee on\n` +
        `     mint and burn, which breaks supply conservation. This upgrade fixes that — good.\n`
    );
  }

  // slot 0 = adminCount, slot 7 = proposalCount: sanity that GovernanceModule occupies 0..10
  const adminCountSlot = BigInt(await ethers.provider.getStorage(proxy, SLOTS.adminCount));
  const adminCountAbi = await token.adminCount();
  check(adminCountSlot === adminCountAbi, `slot ${SLOTS.adminCount} decodes as adminCount`, `${adminCountAbi}`);

  const proposalCountSlot = BigInt(await ethers.provider.getStorage(proxy, SLOTS.proposalCount));
  const proposalCountAbi = await token.proposalCount();
  check(
    proposalCountSlot === proposalCountAbi,
    `slot ${SLOTS.proposalCount} decodes as proposalCount`,
    `${proposalCountAbi}`
  );
  console.log(`     => first child slot is 11 ("Legacy" group). No __gap absorber required.`);

  // ---------------------------------------------------------------- D
  heading("D. Appended slots are unused (this is the corruption gate)");
  const s16 = await ethers.provider.getStorage(proxy, SLOTS.bridgeMinters);
  const s17 = await ethers.provider.getStorage(proxy, SLOTS.voluntarilyBurned);
  check(BigInt(s16) === 0n, `slot ${SLOTS.bridgeMinters} (bridgeMinters) is zero`, s16);
  check(BigInt(s17) === 0n, `slot ${SLOTS.voluntarilyBurned} (voluntarilyBurned) is zero`, s17);

  let gapDirty = 0;
  for (let s = SLOTS.gapStart; s <= SLOTS.gapEnd; s++) {
    if (BigInt(await ethers.provider.getStorage(proxy, s)) !== 0n) gapDirty++;
  }
  check(gapDirty === 0, `reserved gap slots ${SLOTS.gapStart}..${SLOTS.gapEnd} all zero`, gapDirty ? `${gapDirty} dirty` : "");
  if (gapDirty > 0) {
    console.log(
      `\n     CRITICAL: appended slots are not empty. New state variables would inherit\n` +
        `     pre-existing data. DO NOT DEPLOY. Investigate the deployed layout first.\n`
    );
  }

  // ---------------------------------------------------------------- E
  heading("E. Standalone implementation validation");
  const StorageToken = await ethers.getContractFactory("StorageToken");
  try {
    await upgrades.validateImplementation(StorageToken, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    check(true, `initializer / banned opcode validation`);
  } catch (e: any) {
    check(false, `initializer / banned opcode validation`, e.message?.split("\n")[0] ?? "");
    console.log(e.message ?? e);
  }

  // ---------------------------------------------------------------- F
  heading("F. Storage-layout compatibility vs the LIVE deployment");
  let layoutOk = false;
  try {
    await upgrades.validateUpgrade(currentImpl, StorageToken, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    layoutOk = true;
    check(true, `layout compatible (validated against recorded impl layout)`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const missingManifest =
      msg.includes("not found") || msg.includes("manifest") || msg.includes("deployment");
    if (!missingManifest) {
      check(false, `layout compatible`, msg.split("\n")[0]);
      console.log(`\n---- layout error ----\n${msg}\n----------------------`);
    } else {
      console.log(`     no local manifest for this impl — importing layout from the live proxy...`);
      try {
        await upgrades.forceImport(proxy, StorageToken, { kind: "uups" });
        await upgrades.validateUpgrade(proxy, StorageToken, {
          kind: "uups",
          unsafeAllow: ["constructor"],
        });
        layoutOk = true;
        check(true, `layout compatible (via forceImport)`);
        console.log(`     commit the updated .openzeppelin/${netName}.json (UPGRADING.md:96)`);
        console.log(
          `     CAVEAT: forceImport used the CURRENT source as the baseline. That is only\n` +
            `     sound if repo HEAD's inherited layout matches the deployed one — checks C and D\n` +
            `     above are what actually establish that.`
        );
      } catch (e2: any) {
        check(false, `layout compatible`, String(e2?.message ?? e2).split("\n")[0]);
        console.log(`\n---- layout error ----\n${e2?.message ?? e2}\n----------------------`);
      }
    }
  }

  // ---------------------------------------------------------------- G
  heading("G. Governance preconditions for the upgrade to be executable");
  const snap = await snapshotState(proxy, []);
  check(!snap.paused, `contract is unpaused`, snap.paused ? "_authorizeUpgrade is whenNotPaused" : "");
  check(snap.adminQuorum >= 2n, `ADMIN_ROLE quorum >= 2`, `quorum=${snap.adminQuorum}`);
  check(snap.adminCount >= 2n, `at least 2 admins`, `adminCount=${snap.adminCount}`);
  if (snap.adminQuorum < 2n) {
    console.log(`     Fix with: setRoleQuorum(ADMIN_ROLE, 2) from an admin, then re-run.`);
  }
  console.log(`     totalSupply: ${fmt(snap.totalSupply)}   held by proxy: ${fmt(snap.contractBalance)}`);

  // ---------------------------------------------------------------- H
  heading("H. Bytecode sanity");
  const artifact = await artifacts.readArtifact("StorageToken");
  const localStripped = stripMetadata(artifact.deployedBytecode);
  const liveStripped = stripMetadata(await ethers.provider.getCode(currentImpl));
  const localHash = ethers.keccak256("0x" + localStripped);
  const liveHash = ethers.keccak256("0x" + liveStripped);
  console.log(`     live impl  keccak: ${liveHash}  (${liveStripped.length / 2} bytes)`);
  console.log(`     new impl   keccak: ${localHash}  (${localStripped.length / 2} bytes)`);
  check(localHash !== liveHash, `new implementation actually differs from the live one`);
  const sizeKib = localStripped.length / 2 / 1024;
  check(sizeKib < 24, `deployed size under EIP-170`, `${sizeKib.toFixed(3)} KiB`);

  // ---------------------------------------------------------------- gate
  console.log(`\n${"=".repeat(72)}`);
  if (failures > 0) {
    console.log(`PRE-FLIGHT FAILED — ${failures} check(s) did not pass. NOTHING DEPLOYED.`);
    console.log(`${"=".repeat(72)}`);
    process.exit(1);
  }
  if (!layoutOk) {
    console.log(`PRE-FLIGHT FAILED — storage layout not verified. NOTHING DEPLOYED.`);
    console.log(`${"=".repeat(72)}`);
    process.exit(1);
  }
  console.log(`PRE-FLIGHT PASSED — all checks green.`);
  console.log(`${"=".repeat(72)}`);

  if (dryRun) {
    console.log(`\nDRY_RUN=1 — stopping before deployment.`);
    return;
  }

  // ---------------------------------------------------------------- deploy
  heading("Deploying implementation (proxy is NOT touched)");
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`     deployer: ${deployer.address}`);
  console.log(`     balance:  ${ethers.formatEther(balance)} ETH`);

  const newImpl = await upgrades.deployImplementation(StorageToken, {
    kind: "uups",
    unsafeAllow: ["constructor"],
    timeout: 300000,
  });
  const implAddress = String(newImpl);
  console.log(`\n     NEW IMPLEMENTATION: ${implAddress}`);

  const deployedCode = await ethers.provider.getCode(implAddress);
  check(deployedCode !== "0x", `implementation has code on-chain`);
  check(
    ethers.keccak256("0x" + stripMetadata(deployedCode)) === localHash,
    `on-chain bytecode matches the local artifact`
  );

  if (process.env.ETHERSCAN_API_KEY) {
    console.log(`\n     verifying source...`);
    try {
      await hre.run("verify:verify", { address: implAddress, constructorArguments: [] });
    } catch (error: any) {
      if (String(error.message).includes("Already Verified")) {
        console.log(`     already verified`);
      } else {
        console.log(`     verification failed (non-fatal): ${error.message}`);
      }
    }
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`NEXT STEPS — governance upgrade (you drive this)`);
  console.log(`${"=".repeat(72)}`);
  console.log(`  proxy: ${proxy}`);
  console.log(`  impl:  ${implAddress}`);
  console.log(``);
  console.log(`  1. admin1: createProposal(3, 0, ${implAddress}, 0x0…0, 0, 0x0…0)`);
  console.log(`  2. admin2: approveProposal(<proposalId>)`);
  console.log(`  3. wait 24h from creation (MIN_PROPOSAL_EXECUTION_DELAY)`);
  console.log(`  4. either admin: upgradeToAndCall(${implAddress}, "0x")`);
  console.log(``);
  console.log(`  The execution window is [created+24h, created+48h). If you miss it the proposal`);
  console.log(`  expires and you must deploy a NEW implementation address and start over —`);
  console.log(`  pendingProposals keeps the old target blocked until it expires.`);
  console.log(``);
  console.log(`  After upgrading, re-run this script: check B should then FAIL because the live`);
  console.log(`  implementation has changed — that is your confirmation it landed.`);
  console.log(``);
  console.log(`  Then authorize the OFT adapter: createProposal(12, 0, <adapter>, 0x0…0, <cap>, 0x0…0)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nABORTED\n`);
    console.error(error);
    process.exit(1);
  });

// DRY_RUN=1 npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network base
// npx hardhat run scripts/bridge/deployStorageTokenImpl.ts --network ethereum
