import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

declare const hre: HardhatRuntimeEnvironment;

async function main() {
  console.log("=== DEPLOY REWARDS EXTENSION ===\n");

  const REWARDS_PROGRAM_ADDRESS = process.env.REWARDS_PROGRAM_ADDRESS?.trim();

  if (!REWARDS_PROGRAM_ADDRESS) {
    throw new Error("REWARDS_PROGRAM_ADDRESS environment variable required");
  }

  const [deployer] = await ethers.getSigners();

  console.log("Configuration:");
  console.log("- Deployer:", deployer.address);
  console.log("- RewardsProgram proxy:", REWARDS_PROGRAM_ADDRESS);
  console.log("- Network:", hre.network.name);
  console.log();

  // 1. Deploy RewardsExtension (plain contract, not a proxy — called via delegatecall)
  console.log("Deploying RewardsExtension...");
  const RewardsExtension = await ethers.getContractFactory("RewardsExtension");
  const extension = await RewardsExtension.deploy();
  await extension.waitForDeployment();
  const extensionAddress = await extension.getAddress();
  console.log("RewardsExtension deployed to:", extensionAddress);

  // 2. Call setExtension on the RewardsProgram proxy
  console.log("\nSetting extension on RewardsProgram proxy...");
  const rewardsProgram = await ethers.getContractAt("RewardsProgram", REWARDS_PROGRAM_ADDRESS);
  const tx = await rewardsProgram.connect(deployer).setExtension(extensionAddress);
  await tx.wait();
  console.log("setExtension tx confirmed");

  // 3. Verify
  const stored = await rewardsProgram.extension();
  console.log("Stored extension address:", stored);

  if (stored.toLowerCase() === extensionAddress.toLowerCase()) {
    console.log("\nDone. Extension is set correctly.");
  } else {
    console.error("\nWARNING: Stored address does not match deployed address!");
  }

  console.log("\nTo verify on block explorer:");
  console.log(`  npx hardhat verify --network ${hre.network.name} ${extensionAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });

// Run with:
// REWARDS_PROGRAM_ADDRESS=0x1FcF18c719F845051beB5ca4DBDa6aA23859BE3F \
// npx hardhat run scripts/RewardsProgram/deployExtension.ts --network base
