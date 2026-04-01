import { ethers, upgrades } from "hardhat";
import { StakingEngineLinearWithMigration } from "../../typechain-types";

async function main() {
    console.log("Deploying StakingEngineLinearWithMigration...");

    // Get the contract factory
    const StakingEngineLinearWithMigrationFactory = await ethers.getContractFactory("StakingEngineLinearWithMigration");

    // Get deployment parameters from environment or use defaults
    const tokenAddress = process.env.TOKEN_ADDRESS || "0x0000000000000000000000000000000000000000";
    const stakePoolAddress = process.env.STAKE_POOL_ADDRESS || "0x0000000000000000000000000000000000000000";
    const rewardPoolAddress = process.env.REWARD_POOL_ADDRESS || "0x0000000000000000000000000000000000000000";

    if (tokenAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("TOKEN_ADDRESS environment variable must be set");
    }
    if (stakePoolAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("STAKE_POOL_ADDRESS environment variable must be set");
    }
    if (rewardPoolAddress === "0x0000000000000000000000000000000000000000") {
        throw new Error("REWARD_POOL_ADDRESS environment variable must be set");
    }

    console.log("Token Address:", tokenAddress);
    console.log("Stake Pool Address:", stakePoolAddress);
    console.log("Reward Pool Address:", rewardPoolAddress);

    // Deploy the upgradeable contract
    const stakingEngine = await upgrades.deployProxy(
        StakingEngineLinearWithMigrationFactory,
        [tokenAddress, stakePoolAddress, rewardPoolAddress],
        {
            initializer: "initialize",
            kind: "uups"
        }
    ) as StakingEngineLinearWithMigration;

    await stakingEngine.waitForDeployment();
    const stakingEngineAddress = await stakingEngine.getAddress();

    console.log("StakingEngineLinearWithMigration deployed to:", stakingEngineAddress);

    // Get the implementation address
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(stakingEngineAddress);
    console.log("Implementation address:", implementationAddress);

    // Verify deployment
    console.log("Verifying deployment...");
    const totalStaked = await stakingEngine.totalStaked();
    const migrationMode = await stakingEngine.migrationMode();
    const migrationModeEverEnabled = await stakingEngine.migrationModeEverEnabled();

    console.log("Total Staked:", totalStaked.toString());
    console.log("Migration Mode:", migrationMode);
    console.log("Migration Mode Ever Enabled:", migrationModeEverEnabled);

    console.log("Deployment completed successfully!");

    return {
        stakingEngine: stakingEngineAddress,
        implementation: implementationAddress,
        token: tokenAddress,
        stakePool: stakePoolAddress,
        rewardPool: rewardPoolAddress
    };
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
    .then((result) => {
        console.log("Deployment result:", result);
        process.exit(0);
    })
    .catch((error) => {
        console.error("Deployment failed:", error);
        process.exit(1);
    });

// Run with environment variables:
// set TOKEN_ADDRESS=0x92217cCaEDBdbc54C76c15feA18823db1558fDc9 && set INITIAL_OWNER=0x383a6A34C623C02dcf9BB7069FAE4482967fb713 && set INITIAL_ADMIN=0xFa8b02596a84F3b81B4144eA2F30482f8C33D446 && set APPROVAL_AMOUNT="100000000" && set DEPLOY_POOLS=true && set ETHERSCAN_API_KEY=JGD6ENM6P2G5XUS4VSCJJYGXR3RXCG2TEN && npx hardhat run scripts/StakingEngineLinear/deployStakingEngineLinearWithMigration.ts --network mainnet
// 
// Or for using existing pools:
// TOKEN_ADDRESS=0x... STAKE_POOL_ADDRESS=0x... REWARD_POOL_ADDRESS=0x... npx hardhat run scripts/StakingEngineLinear/deployStakingEngineLinearWithMigration.ts --network mainnet
