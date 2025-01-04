import { ethers, upgrades } from "hardhat";

async function main() {
  const [deployer, rewardPoolAddress, stakingPoolAddress, rewardDistributionAddress] = await ethers.getSigners();

  // Get token address from environment variable
  const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
  if (!tokenAddress) {
    throw new Error("TOKEN_ADDRESS environment variable not set");
  }

  // Deploy StakingEngine
  const StakingEngine = await ethers.getContractFactory("StakingEngine");
  const stakingEngine = await upgrades.deployProxy(StakingEngine, [
    tokenAddress,
    rewardPoolAddress.address,
    stakingPoolAddress.address,
    rewardDistributionAddress.address,
    deployer.address,
  ]);
  await stakingEngine.waitForDeployment();
  const stakingEngineAddress = await stakingEngine.getAddress();
  console.log("StakingEngine deployed to:", stakingEngineAddress);

  // Get StorageToken instance
  const token = await ethers.getContractAt("StorageToken", tokenAddress);

  // Transfer tokens to reward pool and reward distribution addresses
  const initialRewardPool = ethers.parseEther("10000"); // Example: 10,000 tokens
  await token.transfer(rewardPoolAddress.address, initialRewardPool);
  await token.transfer(rewardDistributionAddress.address, ethers.parseEther("5000")); // Example: 5,000 tokens

  // Approve staking contract for reward pool address
  await token.connect(rewardPoolAddress).approve(stakingEngineAddress, ethers.MaxUint256);
  console.log("Reward pool address approved staking contract.");

  // Approve staking contract for reward distribution address
  await token.connect(rewardDistributionAddress).approve(stakingEngineAddress, ethers.MaxUint256);
  console.log("Reward distribution address approved staking contract.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
