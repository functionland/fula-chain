import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

declare const hre: HardhatRuntimeEnvironment;

async function main() {
  const REWARDS_PROGRAM_ADDRESS = process.env.REWARDS_PROGRAM_ADDRESS?.trim();
  const EXTENSION_ADDRESS = process.env.EXTENSION_ADDRESS?.trim();

  if (!REWARDS_PROGRAM_ADDRESS) throw new Error("REWARDS_PROGRAM_ADDRESS required");
  if (!EXTENSION_ADDRESS) throw new Error("EXTENSION_ADDRESS required");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("RewardsProgram:", REWARDS_PROGRAM_ADDRESS);
  console.log("Extension:", EXTENSION_ADDRESS);

  const rewardsProgram = await ethers.getContractAt("RewardsProgram", REWARDS_PROGRAM_ADDRESS);

  console.log("\nCurrent extension:", await rewardsProgram.extension());
  console.log("Calling setExtension...");

  const tx = await rewardsProgram.connect(deployer).setExtension(EXTENSION_ADDRESS);
  console.log("Tx hash:", tx.hash);
  await tx.wait();

  const stored = await rewardsProgram.extension();
  console.log("Extension set to:", stored);
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });

// Run with:
// set REWARDS_PROGRAM_ADDRESS=0x1FcF18c719F845051beB5ca4DBDa6aA23859BE3F
// set EXTENSION_ADDRESS=0xAB578B2734b05f96A613d45a20Aa30555Db7ca7b
// npx hardhat run scripts/RewardsProgram/setExtension.ts --network base
