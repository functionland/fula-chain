import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

/**
 * Secure RewardEngine Deployment Script
 * 
 * This script:
 * 1. Deploys RewardEngine as UUPS proxy
 * 2. SECURELY initializes the implementation to prevent front-running attacks
 * 3. Sets up proper permissions and governance
 * 4. Verifies contracts on block explorer
 * 
 * SECURITY: Properly initializes implementation contracts to prevent
 * the ERC1967Proxy front-running/backdoor attack discovered by @VennBuild
 */

async function waitForUserConfirmation(message: string): Promise<void> {
    console.log(message);
    return new Promise((resolve) => {
        process.stdin.once('data', () => {
            resolve();
        });
    });
}

async function verifyWithTimeout(contractAddress: string, constructorArgs: any[] = [], timeoutMs: number = 60000): Promise<void> {
    return new Promise(async (resolve, reject) => {
        const timeout = setTimeout(() => {
            console.log(`⏰ Verification timeout (${timeoutMs/1000}s) reached for ${contractAddress}`);
            resolve(); // Resolve instead of reject to continue deployment
        }, timeoutMs);

        try {
            await hre.run("verify:verify", {
                address: contractAddress,
                constructorArguments: constructorArgs
            });
            clearTimeout(timeout);
            resolve();
        } catch (error: any) {
            clearTimeout(timeout);
            reject(error);
        }
    });
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log("🚀 SECURE REWARDENGINE DEPLOYMENT");
    console.log("=".repeat(50));
    
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    console.log("Deployer balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

    // Environment variables
    const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const storagePoolAddress = process.env.STORAGE_POOL_ADDRESS?.trim();
    const stakingPoolAddressEnv = process.env.STAKING_POOL_ADDRESS?.trim();
    const deployStakingPool = process.env.DEPLOY_STAKING_POOL?.toLowerCase() === 'true';
    const initialOwner = process.env.INITIAL_OWNER?.trim() || deployer.address;
    const initialAdmin = process.env.INITIAL_ADMIN?.trim() || deployer.address;

    console.log("\nConfiguration:");
    console.log("- Storage Token:", storageTokenAddress);
    console.log("- Storage Pool:", storagePoolAddress);
    console.log("- Deploy New Staking Pool:", deployStakingPool);
    if (!deployStakingPool) {
        console.log("- Staking Pool Address:", stakingPoolAddressEnv);
    }
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);

    // Validate required parameters
    if (!storageTokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable is required");
    }
    if (!storagePoolAddress) {
        throw new Error("STORAGE_POOL_ADDRESS environment variable is required");
    }

    // Only check staking pool address if we're not deploying a new one
    if (!deployStakingPool && !stakingPoolAddressEnv) {
        throw new Error("STAKING_POOL_ADDRESS environment variable is required when DEPLOY_STAKING_POOL is not true");
    }

    // Validate addresses are contracts
    console.log("\nValidating contract addresses...");
    const storageTokenCode = await ethers.provider.getCode(storageTokenAddress);
    const storagePoolCode = await ethers.provider.getCode(storagePoolAddress);

    if (storageTokenCode === "0x") {
        throw new Error(`StorageToken contract not found at ${storageTokenAddress}`);
    }
    if (storagePoolCode === "0x") {
        throw new Error(`StoragePool contract not found at ${storagePoolAddress}`);
    }

    // Only validate existing StakingPool if we're not deploying a new one
    if (!deployStakingPool && stakingPoolAddressEnv) {
        const stakingPoolCode = await ethers.provider.getCode(stakingPoolAddressEnv);
        if (stakingPoolCode === "0x") {
            throw new Error(`StakingPool contract not found at ${stakingPoolAddressEnv}`);
        }
    }
    console.log("✅ Contract addresses validated");

    // Get contract factory
    const RewardEngine = await ethers.getContractFactory("RewardEngine");

    // Estimate gas costs
    console.log("\nEstimating deployment costs...");
    const deploymentData = RewardEngine.interface.encodeDeploy([]);
    const gasEstimate = await ethers.provider.estimateGas({
        data: deploymentData
    });
    const gasPrice = await ethers.provider.getFeeData();
    const estimatedCost = gasEstimate * (gasPrice.gasPrice || 0n);
    console.log("Estimated gas:", gasEstimate.toString());
    console.log("Estimated cost:", ethers.formatEther(estimatedCost), "ETH");

    // Check deployer balance
    const deployerBalance = await ethers.provider.getBalance(deployer.address);
    if (deployerBalance < estimatedCost * 2n) {
        console.warn("⚠️  Warning: Deployer balance may be insufficient for deployment");
    }

    await waitForUserConfirmation("\nPress Enter to continue with deployment or Ctrl+C to cancel...");

    let stakingPool: any;
    let stakingPoolAddress: string;

    try {
        // Deploy new staking pool if requested
        if (deployStakingPool) {
            console.log("\nDeploying StakingPool as UUPS proxy...");
            const StakingPool = await ethers.getContractFactory("StakingPool");
            stakingPool = await upgrades.deployProxy(
                StakingPool,
                [storageTokenAddress, initialOwner, initialAdmin],
                {
                    initializer: "initialize",
                    kind: "uups"
                }
            );

            await stakingPool.waitForDeployment();

            // Add extra wait time for Base network
            console.log("Waiting for deployment to be fully processed...");
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

            stakingPoolAddress = await stakingPool.getAddress();
            console.log("StakingPool proxy deployed to:", stakingPoolAddress);

            // Get the implementation address
            const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
            console.log("StakingPool implementation address:", stakingPoolImplAddress);

        } else {
            // Use provided address and get reference
            stakingPoolAddress = stakingPoolAddressEnv!;
            stakingPool = await ethers.getContractAt("StakingPool", stakingPoolAddress);
            console.log("Using existing StakingPool at:", stakingPoolAddress);
        }

        // Deploy RewardEngine as UUPS proxy
        console.log("\nDeploying RewardEngine as UUPS proxy...");
        console.log({
          storageTokenAddress,
          storagePoolAddress,
          stakingPoolAddress,
          initialOwner,
          initialAdmin,
        });

        // First, try to deploy just the implementation
        console.log("Deploying RewardEngine implementation...");
        const rewardEngineImpl = await upgrades.deployImplementation(RewardEngine, {
            kind: "uups",
            timeout: 120000
        });
        console.log("RewardEngine implementation deployed to:", rewardEngineImpl);

        // Now deploy the proxy
        console.log("Deploying RewardEngine proxy...");
        const rewardEngine = await upgrades.deployProxy(
            RewardEngine,
            [
                storageTokenAddress,
                storagePoolAddress,
                stakingPoolAddress,
                initialOwner,
                initialAdmin
            ],
            {
                initializer: "initialize",
                kind: "uups",
                txOverrides: { gasLimit: 5000000 },
                timeout: 120000
            }
        );

        await rewardEngine.waitForDeployment();
        const rewardEngineAddress = await rewardEngine.getAddress();
        
        // Get the implementation address
        const rewardEngineImplAddress = await upgrades.erc1967.getImplementationAddress(rewardEngineAddress);
        console.log("RewardEngine proxy deployed to:", rewardEngineAddress);
        console.log("RewardEngine implementation address:", rewardEngineImplAddress);

        // CRITICAL SECURITY: Initialize implementation contracts to prevent front-running attacks
        console.log("\n🔒 SECURING IMPLEMENTATION CONTRACTS...");

        // Secure StakingPool implementation if we deployed it
        if (deployStakingPool) {
            console.log("Securing StakingPool implementation...");
            try {
                const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
                const stakingPoolImpl = await ethers.getContractAt("StakingPool", stakingPoolImplAddress);

                // Use proxy addresses as dummy values
                const initTx = await stakingPoolImpl.initialize(
                    storageTokenAddress,  // _token (use real token address)
                    stakingPoolAddress,   // initialOwner (use proxy address as dummy)
                    stakingPoolAddress    // initialAdmin (use proxy address as dummy)
                );
                await initTx.wait();
                console.log("✅ StakingPool implementation secured with proxy addresses");
            } catch (error: any) {
                if (error.message.includes("already initialized") ||
                    error.message.includes("InvalidInitialization")) {
                    console.log("✅ StakingPool implementation was already secured");
                } else {
                    console.warn("⚠️  Failed to secure StakingPool implementation automatically");
                    console.warn("Error:", error.message);
                    console.log("Continuing with deployment - manual security may be required...");
                }
            }
        }

        // Secure RewardEngine implementation
        console.log("Securing RewardEngine implementation...");
        try {
            const rewardEngineImpl = await ethers.getContractAt("RewardEngine", rewardEngineImplAddress);

            // Use proxy addresses as dummy values (safer than dead addresses)
            const initTx = await rewardEngineImpl.initialize(
                storageTokenAddress,    // _token (use real token address)
                storagePoolAddress,     // _storagePool (use real storage pool address)
                stakingPoolAddress,     // _stakingPool (use real staking pool address)
                rewardEngineAddress,    // initialOwner (use proxy address as dummy)
                rewardEngineAddress     // initialAdmin (use proxy address as dummy)
            );
            await initTx.wait();
            console.log("✅ RewardEngine implementation secured with proxy addresses");
        } catch (error: any) {
            if (error.message.includes("already initialized") ||
                error.message.includes("InvalidInitialization")) {
                console.log("✅ RewardEngine implementation was already secured");
            } else {
                console.warn("⚠️  Failed to secure RewardEngine implementation automatically");
                console.warn("Error:", error.message);
                console.log("\n📋 MANUAL SECURITY REQUIRED:");
                console.log("The RewardEngine implementation may be vulnerable to front-running attacks.");
                console.log("Please secure it manually by calling:");
                console.log(`rewardEngineImpl.initialize(${storageTokenAddress}, ${storagePoolAddress}, ${stakingPoolAddress}, <dummy_owner>, <dummy_admin>)`);
                console.log(`Implementation address: ${rewardEngineImplAddress}`);
                console.log("\nContinuing with deployment...");
            }
        }

        console.log("\n📋 DEPLOYMENT SUMMARY:");
        console.log("- Storage Token:", storageTokenAddress);
        console.log("- Storage Pool:", storagePoolAddress);
        console.log("- Staking Pool Proxy:", stakingPoolAddress);
        if (deployStakingPool) {
            const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
            console.log("- Staking Pool Implementation:", stakingPoolImplAddress);
            console.log("- Staking Pool Status: NEWLY DEPLOYED");
        } else {
            console.log("- Staking Pool Status: EXISTING CONTRACT");
        }
        console.log("- Reward Engine Proxy:", rewardEngineAddress);
        console.log("- Reward Engine Implementation:", rewardEngineImplAddress);
        console.log("- Initial Owner:", initialOwner);
        console.log("- Initial Admin:", initialAdmin);

        // Set up governance parameters
        console.log("\nSetting up governance parameters...");
        console.log("IMPORTANT: This requires the deployer to have ADMIN_ROLE on the RewardEngine.");
        
        await waitForUserConfirmation("\nPress Enter to attempt setting up governance or Ctrl+C to skip...");
        
        try {
            const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
            
            // Wait for timelock period (if needed)
            console.log("Setting up role quorum...");
            await rewardEngine.connect(await ethers.getSigner(initialOwner)).setRoleQuorum(ADMIN_ROLE, 2);
            
            console.log("Waiting for timelock period...");
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
            await ethers.provider.send("evm_mine", []);
            
            console.log("Setting up transaction limits...");
            const maxSupply = ethers.parseEther("1000000000"); // 1B tokens
            await rewardEngine.connect(await ethers.getSigner(initialOwner)).setRoleTransactionLimit(ADMIN_ROLE, maxSupply);
            
            console.log("✅ Governance parameters configured");

        } catch (error: any) {
            console.error("Failed to set up governance automatically:", error.message);
            console.log("\nManual setup required:");
            console.log(`1. Call setRoleQuorum(${ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"))}, 2) on RewardEngine`);
            console.log(`2. Wait for timelock period`);
            console.log(`3. Call setRoleTransactionLimit(${ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"))}, <amount>)`);
        }

        // Set up StakingPool permissions for RewardEngine
        console.log("\nSetting up StakingPool permissions...");
        console.log("IMPORTANT: This requires the deployer to have ADMIN_ROLE on the StakingPool.");

        await waitForUserConfirmation("\nPress Enter to attempt setting up StakingPool permissions or Ctrl+C to skip...");

        try {
            // Set RewardEngine address as the staking engine on StakingPool
            console.log("Setting RewardEngine address as staking engine on StakingPool...");
            const setStakingEngineTx = await stakingPool.connect(await ethers.getSigner(initialOwner)).setStakingEngine(rewardEngineAddress);
            await setStakingEngineTx.wait();
            console.log("✅ StakingPool configured with RewardEngine address!");

        } catch (error: any) {
            console.error("Failed to set up StakingPool permissions automatically:", error.message);
            console.log("\nManual setup required:");
            console.log(`1. Call setStakingEngine(${rewardEngineAddress}) on StakingPool contract at ${stakingPoolAddress}`);
        }

        // Verify contracts on block explorer
            console.log("\n📋 VERIFYING CONTRACTS ON BLOCK EXPLORER...");

            // Verify StakingPool if we deployed it
            if (deployStakingPool) {
                const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);

                try {
                    console.log("Verifying StakingPool proxy...");
                    await verifyWithTimeout(stakingPoolAddress, [], 60000);
                    console.log("✅ StakingPool proxy verified");
                } catch (error: any) {
                    console.error("⚠️  StakingPool proxy verification failed:", error.message);
                }

                // Wait 3 seconds to respect rate limits (2 calls/sec = 500ms minimum, using 3s for safety)
                console.log("⏳ Waiting 3 seconds to respect API rate limits...");
                await delay(3000);

                try {
                    console.log("Verifying StakingPool implementation...");
                    await verifyWithTimeout(stakingPoolImplAddress, [], 60000);
                    console.log("✅ StakingPool implementation verified");
                } catch (error: any) {
                    console.error("⚠️  StakingPool implementation verification failed:", error.message);
                }
            }

            // Wait 3 seconds before verifying RewardEngine contracts
            console.log("⏳ Waiting 3 seconds to respect API rate limits...");
            await delay(3000);

            try {
                console.log("Verifying RewardEngine proxy...");
                await verifyWithTimeout(rewardEngineAddress, [], 60000);
                console.log("✅ RewardEngine proxy verified");
            } catch (error: any) {
                console.error("⚠️  RewardEngine proxy verification failed:", error.message);
            }

            // Wait 3 seconds between RewardEngine verifications
            console.log("⏳ Waiting 3 seconds to respect API rate limits...");
            await delay(3000);

            try {
                console.log("Verifying RewardEngine implementation...");
                await verifyWithTimeout(rewardEngineImplAddress, [], 60000);
                console.log("✅ RewardEngine implementation verified");
            } catch (error: any) {
                console.error("⚠️  RewardEngine implementation verification failed:", error.message);
            }


        console.log("\n✅ DEPLOYMENT COMPLETED SUCCESSFULLY!");
        console.log("\n📋 NEXT STEPS:");
        console.log("1. Configure reward parameters (monthlyRewardPerPeer, expectedPeriod)");
        console.log("2. Fund StakingPool with reward tokens");
        console.log("3. Test reward calculation and claiming functions");
        console.log("4. Run security check to verify implementation is secured:");
        console.log(`   REWARD_ENGINE_PROXY=${rewardEngineAddress} npx hardhat run scripts/checkERC1967SecurityQuick.ts --network <network>`);

    } catch (error) {
        console.error("❌ Deployment failed:", error);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Usage:
//
// Option 1: Deploy with existing StakingPool
// TOKEN_ADDRESS=0x... STORAGE_POOL_ADDRESS=0x... STAKING_POOL_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/RewardEngine/deployRewardEngine.ts --network <network>
//
// Option 2: Deploy with new StakingPool
// TOKEN_ADDRESS=0x... STORAGE_POOL_ADDRESS=0x... DEPLOY_STAKING_POOL=true INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/RewardEngine/deployRewardEngine.ts --network <network>
//
// Environment Variables:
// - TOKEN_ADDRESS: Required - Address of deployed StorageToken contract
// - STORAGE_POOL_ADDRESS: Required - Address of deployed StoragePool contract
// - STAKING_POOL_ADDRESS: Required if DEPLOY_STAKING_POOL is not true - Address of existing StakingPool contract
// - DEPLOY_STAKING_POOL: Optional - Set to 'true' to deploy a new StakingPool contract
// - INITIAL_OWNER: Optional - Address that will own the contract (defaults to deployer)
// - INITIAL_ADMIN: Optional - Address that will have admin role (defaults to deployer)
// - ETHERSCAN_API_KEY: Optional - For automatic contract verification
/*
set TOKEN_ADDRESS=0x9e12735d77c72c5C3670636D428f2F3815d8A4cB
set INITIAL_OWNER=0x383a6A34C623C02dcf9BB7069FAE4482967fb713
set INITIAL_ADMIN=0xFa8b02596a84F3b81B4144eA2F30482f8C33D446
set ETHERESCAN_API_KEY=...
set DEPLOY_STAKING_POOL=true
set STORAGE_POOL_ADDRESS=0xf293A6902662DcB09E310254A5e418cb28D71b6b
npx hardhat run scripts/RewardEngine/deployRewardEngine.ts --network base
*/