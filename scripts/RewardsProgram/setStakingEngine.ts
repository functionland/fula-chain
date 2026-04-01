import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

declare const hre: HardhatRuntimeEnvironment;

async function main() {
  const STAKING_POOL_ADDRESS = process.env.STAKING_POOL_ADDRESS?.trim();
  const REWARDS_PROGRAM_ADDRESS = process.env.REWARDS_PROGRAM_ADDRESS?.trim();

  if (!STAKING_POOL_ADDRESS) throw new Error("STAKING_POOL_ADDRESS required");
  if (!REWARDS_PROGRAM_ADDRESS) throw new Error("REWARDS_PROGRAM_ADDRESS required");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("StakingPool:", STAKING_POOL_ADDRESS);
  console.log("RewardsProgram:", REWARDS_PROGRAM_ADDRESS);

  const stakingPool = await ethers.getContractAt("StakingPool", STAKING_POOL_ADDRESS);

  console.log("\nCalling setStakingEngine...");
  const tx = await stakingPool.connect(deployer).setStakingEngine(REWARDS_PROGRAM_ADDRESS);
  console.log("Tx hash:", tx.hash);
  await tx.wait();
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed:", error);
    process.exit(1);
  });

// Run with:
// set STAKING_POOL_ADDRESS=0xc8be8BAFD52E46065190aA1b57CB126De83EfBb4
// set REWARDS_PROGRAM_ADDRESS=0x9b65D607aE107038831346359A5F97E5b2Ce6d8c
// npx hardhat run scripts/RewardsProgram/setStakingEngine.ts --network base
