import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

declare const hre: HardhatRuntimeEnvironment;

async function waitForImplementation(proxyAddress: string, maxAttempts = 10): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const addr = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      return addr;
    } catch {
      console.log(`  Waiting for proxy storage to propagate... (${i + 1}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  throw new Error(`Failed to read implementation address for ${proxyAddress} after ${maxAttempts} attempts`);
}

async function main() {
  console.log("=== REWARDS PROGRAM DEPLOYMENT ===\n");

  // Read environment variables (trim to avoid trailing spaces from Windows `set` command)
  const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS?.trim();
  const INITIAL_OWNER = process.env.INITIAL_OWNER?.trim();
  const INITIAL_ADMIN = process.env.INITIAL_ADMIN?.trim();
  const DEPLOY_STAKING_POOL = process.env.DEPLOY_STAKING_POOL?.trim() !== "false"; // default: true
  const STAKING_POOL_ADDRESS = process.env.STAKING_POOL_ADDRESS?.trim();

  // Validate
  if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS environment variable required");
  if (!INITIAL_OWNER) throw new Error("INITIAL_OWNER environment variable required");
  if (!INITIAL_ADMIN) throw new Error("INITIAL_ADMIN environment variable required");
  if (!DEPLOY_STAKING_POOL && !STAKING_POOL_ADDRESS) {
    throw new Error("STAKING_POOL_ADDRESS required when DEPLOY_STAKING_POOL=false");
  }

  const [deployer] = await ethers.getSigners();

  console.log("Configuration:");
  console.log("- Deployer:", deployer.address);
  console.log("- Token Address:", TOKEN_ADDRESS);
  console.log("- Initial Owner:", INITIAL_OWNER);
  console.log("- Initial Admin:", INITIAL_ADMIN);
  console.log("- Deploy new StakingPool:", DEPLOY_STAKING_POOL);
  if (STAKING_POOL_ADDRESS) console.log("- Existing StakingPool:", STAKING_POOL_ADDRESS);
  console.log("- Network:", hre.network.name);

  // Confirmation prompt
  console.log("\n⚠️  Please verify the above configuration.");
  console.log("Proceeding with deployment in 5 seconds...\n");
  await new Promise(resolve => setTimeout(resolve, 5000));

  let stakingPoolAddress: string;

  // 1. Deploy or use existing StakingPool
  if (DEPLOY_STAKING_POOL) {
    console.log("Deploying StakingPool as UUPS proxy...");
    const StakingPool = await ethers.getContractFactory("StakingPool");
    const stakingPool = await upgrades.deployProxy(
      StakingPool,
      [TOKEN_ADDRESS, INITIAL_OWNER, INITIAL_ADMIN],
      { initializer: "initialize", kind: "uups" }
    );
    await stakingPool.waitForDeployment();
    stakingPoolAddress = await stakingPool.getAddress();
    console.log("✅ StakingPool deployed to:", stakingPoolAddress);

    // Secure implementation
    try {
      const implAddr = await waitForImplementation(stakingPoolAddress);
      const impl = await ethers.getContractAt("StakingPool", implAddr);
      await (await impl.initialize(TOKEN_ADDRESS, stakingPoolAddress, stakingPoolAddress)).wait();
      console.log("✅ StakingPool implementation secured");
    } catch (e: any) {
      if (e.message.includes("already initialized") || e.message.includes("InvalidInitialization")) {
        console.log("✅ StakingPool implementation was already secured");
      } else {
        console.warn("⚠️  Could not secure StakingPool implementation:", e.message);
      }
    }

    const implAddr = await waitForImplementation(stakingPoolAddress);
    console.log("StakingPool Implementation:", implAddr);
  } else {
    stakingPoolAddress = STAKING_POOL_ADDRESS!;
    console.log("Using existing StakingPool:", stakingPoolAddress);
  }

  // 2. Deploy RewardsProgram
  console.log("\nDeploying RewardsProgram as UUPS proxy...");
  const RewardsProgram = await ethers.getContractFactory("RewardsProgram");
  const rewardsProgram = await upgrades.deployProxy(
    RewardsProgram,
    [TOKEN_ADDRESS, stakingPoolAddress, INITIAL_OWNER, INITIAL_ADMIN],
    { initializer: "initialize", kind: "uups" }
  );
  await rewardsProgram.waitForDeployment();
  const rewardsProgramAddress = await rewardsProgram.getAddress();
  console.log("✅ RewardsProgram deployed to:", rewardsProgramAddress);

  // Secure implementation
  try {
    const implAddr = await waitForImplementation(rewardsProgramAddress);
    const impl = await ethers.getContractAt("RewardsProgram", implAddr);
    await (await impl.initialize(TOKEN_ADDRESS, stakingPoolAddress, rewardsProgramAddress, rewardsProgramAddress)).wait();
    console.log("✅ RewardsProgram implementation secured");
  } catch (e: any) {
    if (e.message.includes("already initialized") || e.message.includes("InvalidInitialization")) {
      console.log("✅ RewardsProgram implementation was already secured");
    } else {
      console.warn("⚠️  Could not secure RewardsProgram implementation:", e.message);
    }
  }

  const rpImplAddr = await waitForImplementation(rewardsProgramAddress);
  console.log("RewardsProgram Implementation:", rpImplAddr);

  // 3. Set RewardsProgram as stakingEngine (if new StakingPool was deployed)
  if (DEPLOY_STAKING_POOL) {
    console.log("\nSetting RewardsProgram as stakingEngine on StakingPool...");
    const stakingPool = await ethers.getContractAt("StakingPool", stakingPoolAddress);
    const tx = await stakingPool.connect(deployer).setStakingEngine(rewardsProgramAddress);
    await tx.wait();
    console.log("✅ StakingEngine set successfully");
  } else {
    console.log("\n⚠️  MANUAL STEP REQUIRED:");
    console.log(`Call setStakingEngine(${rewardsProgramAddress}) on StakingPool at ${stakingPoolAddress}`);
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log("\nProxy Addresses:");
  console.log("  StakingPool:    ", stakingPoolAddress);
  console.log("  RewardsProgram: ", rewardsProgramAddress);
  console.log("\nImplementation Addresses:");
  console.log("  StakingPool:    ", DEPLOY_STAKING_POOL ? await waitForImplementation(stakingPoolAddress) : "N/A (existing)");
  console.log("  RewardsProgram: ", rpImplAddr);

  console.log("\n📋 NEXT STEPS:");
  console.log("1. Whitelist StakingPool address in FULA token contract via governance proposal");
  console.log("2. Whitelist RewardsProgram address in FULA token contract via governance proposal");
  console.log("3. Set up governance parameters (quorum, transaction limits) on both contracts");
  console.log("4. Verify contracts on block explorer:");
  console.log(`   npx hardhat verify --network ${hre.network.name} ${stakingPoolAddress}`);
  console.log(`   npx hardhat verify --network ${hre.network.name} ${rewardsProgramAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });

// Run with:
// TOKEN_ADDRESS=0x9e12735d77c72c5C3670636D428f2F3815d8A4cB \
// INITIAL_OWNER=0x... \
// INITIAL_ADMIN=0x... \
// npx hardhat run scripts/RewardsProgram/deployRewardsProgram.ts --network base
