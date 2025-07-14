import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

/**
 * Secure Local RewardEngine Deployment Script
 * 
 * This script deploys a complete RewardEngine setup for local testing:
 * 1. Deploys StorageToken, StakingPool, StoragePool (if not provided)
 * 2. Deploys RewardEngine as UUPS proxy
 * 3. SECURELY initializes all implementation contracts
 * 4. Sets up proper permissions and governance
 * 5. Funds contracts with test tokens
 * 6. Creates test scenarios
 * 
 * SECURITY: Properly initializes implementation contracts to prevent
 * the ERC1967Proxy front-running/backdoor attack
 */

async function main() {
    console.log("🚀 SECURE LOCAL REWARDENGINE DEPLOYMENT");
    console.log("=".repeat(50));
    
    const [deployer, admin, user1, user2] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);
    console.log("Admin account:", admin.address);
    console.log("Test user 1:", user1.address);
    console.log("Test user 2:", user2.address);

    // Configuration
    const initialOwner = deployer.address;
    const initialAdmin = admin.address;
    const tokenSupply = ethers.parseEther("1000000000"); // 1B tokens
    const poolInitialAmount = ethers.parseEther("100000000"); // 100M tokens for pools
    const userTestAmount = ethers.parseEther("1000000"); // 1M tokens for testing

    console.log("\nUsing configuration:");
    console.log("- Initial Owner:", initialOwner);
    console.log("- Initial Admin:", initialAdmin);
    console.log("- Token Supply:", ethers.formatEther(tokenSupply));
    console.log("- Pool Initial Amount:", ethers.formatEther(poolInitialAmount));
    console.log("- User Test Amount:", ethers.formatEther(userTestAmount));

    try {
        // 1. Deploy StorageToken
        console.log("\nDeploying StorageToken as UUPS proxy...");
        const StorageToken = await ethers.getContractFactory("StorageToken");
        const storageToken = await upgrades.deployProxy(
            StorageToken,
            [initialOwner, initialAdmin, tokenSupply],
            {
                initializer: "initialize",
                kind: "uups",
            }
        );
        await storageToken.waitForDeployment();
        const tokenAddress = await storageToken.getAddress();
        console.log("StorageToken deployed to:", tokenAddress);

        // 2. Deploy StakingPool as UUPS proxy
        console.log("\nDeploying StakingPool as UUPS proxy...");
        const StakingPool = await ethers.getContractFactory("StakingPool");
        const stakingPool = await upgrades.deployProxy(
            StakingPool,
            [tokenAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups",
            }
        );
        await stakingPool.waitForDeployment();
        const stakingPoolAddress = await stakingPool.getAddress();
        console.log("StakingPool deployed to:", stakingPoolAddress);

        // 3. Deploy StoragePool as UUPS proxy
        console.log("\nDeploying StoragePool as UUPS proxy...");
        const StoragePool = await ethers.getContractFactory("StoragePool");
        const storagePool = await upgrades.deployProxy(
            StoragePool,
            [tokenAddress, stakingPoolAddress, initialOwner, initialAdmin],
            {
                initializer: "initialize",
                kind: "uups",
            }
        );
        await storagePool.waitForDeployment();
        const storagePoolAddress = await storagePool.getAddress();
        console.log("StoragePool deployed to:", storagePoolAddress);

        // 4. Deploy RewardEngine as UUPS proxy
        console.log("\nDeploying RewardEngine as UUPS proxy...");
        const RewardEngine = await ethers.getContractFactory("RewardEngine");
        const rewardEngine = await upgrades.deployProxy(
            RewardEngine,
            [
                tokenAddress,
                storagePoolAddress,
                stakingPoolAddress,
                initialOwner,
                initialAdmin
            ],
            {
                initializer: "initialize",
                kind: "uups",
            }
        );
        await rewardEngine.waitForDeployment();
        const rewardEngineAddress = await rewardEngine.getAddress();
        console.log("RewardEngine deployed to:", rewardEngineAddress);

        // CRITICAL SECURITY: Initialize implementation contracts to prevent front-running attacks
        console.log("\n🔒 SECURING IMPLEMENTATION CONTRACTS...");

        // Secure StorageToken implementation
        console.log("Securing StorageToken implementation...");
        try {
            const tokenImplAddress = await upgrades.erc1967.getImplementationAddress(tokenAddress);
            const tokenImpl = await ethers.getContractAt("StorageToken", tokenImplAddress);

            // Use proxy address as dummy values and 0 for token amount
            const initTx = await tokenImpl.initialize(
                tokenAddress,  // initialOwner (use proxy address as dummy)
                tokenAddress,  // initialAdmin (use proxy address as dummy)
                0              // initialMintedTokens (0 = safe)
            );
            await initTx.wait();
            console.log("✅ StorageToken implementation secured with proxy addresses");
        } catch (error: any) {
            if (error.message.includes("already initialized") ||
                error.message.includes("InvalidInitialization")) {
                console.log("✅ StorageToken implementation was already secured");
            } else {
                console.warn("⚠️  Failed to secure StorageToken implementation automatically");
                console.warn("Error:", error.message);
                console.log("Continuing with deployment - manual security may be required...");
            }
        }

        // Secure StakingPool implementation
        console.log("Securing StakingPool implementation...");
        try {
            const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
            const stakingPoolImpl = await ethers.getContractAt("StakingPool", stakingPoolImplAddress);

            // Use proxy addresses as dummy values
            const initTx = await stakingPoolImpl.initialize(
                tokenAddress,       // _token (use real token address)
                stakingPoolAddress, // initialOwner (use proxy address as dummy)
                stakingPoolAddress  // initialAdmin (use proxy address as dummy)
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

        // Secure StoragePool implementation
        console.log("Securing StoragePool implementation...");
        try {
            const storagePoolImplAddress = await upgrades.erc1967.getImplementationAddress(storagePoolAddress);
            const storagePoolImpl = await ethers.getContractAt("StoragePool", storagePoolImplAddress);

            // Use proxy addresses as dummy values
            const initTx = await storagePoolImpl.initialize(
                tokenAddress,         // _storageToken (use real token address)
                stakingPoolAddress,   // _tokenPool (use real staking pool address)
                storagePoolAddress,   // initialOwner (use proxy address as dummy)
                storagePoolAddress    // initialAdmin (use proxy address as dummy)
            );
            await initTx.wait();
            console.log("✅ StoragePool implementation secured with proxy addresses");
        } catch (error: any) {
            if (error.message.includes("already initialized") ||
                error.message.includes("InvalidInitialization")) {
                console.log("✅ StoragePool implementation was already secured");
            } else {
                console.warn("⚠️  Failed to secure StoragePool implementation automatically");
                console.warn("Error:", error.message);
                console.log("Continuing with deployment - manual security may be required...");
            }
        }

        // Secure RewardEngine implementation
        console.log("Securing RewardEngine implementation...");
        try {
            const rewardEngineImplAddress = await upgrades.erc1967.getImplementationAddress(rewardEngineAddress);
            const rewardEngineImpl = await ethers.getContractAt("RewardEngine", rewardEngineImplAddress);

            // Use proxy addresses as dummy values
            const initTx = await rewardEngineImpl.initialize(
                tokenAddress,         // _token (use real token address)
                storagePoolAddress,   // _storagePool (use real storage pool address)
                stakingPoolAddress,   // _stakingPool (use real staking pool address)
                rewardEngineAddress,  // initialOwner (use proxy address as dummy)
                rewardEngineAddress   // initialAdmin (use proxy address as dummy)
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
                console.log("Continuing with deployment - manual security may be required...");
            }
        }

        // 5. Set up governance parameters
        console.log("\n⚙️  Setting up governance parameters...");
        const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

        // Increase time to bypass timelock for initial setup
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);

        // Set up governance for all contracts
        await storageToken.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        await stakingPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        await storagePool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
        await rewardEngine.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);

        // Wait for timelock again
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
        await ethers.provider.send("evm_mine", []);

        // Set transaction limits
        await storageToken.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        await stakingPool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        await storagePool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        await rewardEngine.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
        
        console.log("✅ Governance parameters set up for all contracts");

        // 6. Set up permissions
        console.log("\nSetting up permissions...");
        
        // Set RewardEngine address as the staking engine on StakingPool
        await stakingPool.connect(deployer).setStakingEngine(rewardEngineAddress);
        console.log("✅ StakingPool configured with RewardEngine address");

        // 7. Fund contracts and set up test environment
        console.log("\nSetting up test environment...");
        
        // Transfer tokens to StakingPool for rewards
        await storageToken.connect(admin).transferFromContract(stakingPoolAddress, poolInitialAmount);
        console.log("✅ Tokens transferred to StakingPool for rewards");

        // Transfer test tokens to users
        await storageToken.connect(admin).transferFromContract(user1.address, userTestAmount);
        await storageToken.connect(admin).transferFromContract(user2.address, userTestAmount);
        console.log("✅ Test tokens distributed to users");

        // Get implementation addresses for summary
        const tokenImplAddress = await upgrades.erc1967.getImplementationAddress(tokenAddress);
        const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
        const storagePoolImplAddress = await upgrades.erc1967.getImplementationAddress(storagePoolAddress);
        const rewardEngineImplAddress = await upgrades.erc1967.getImplementationAddress(rewardEngineAddress);

        console.log("\n📋 DEPLOYMENT SUMMARY:");
        console.log("=".repeat(30));
        console.log("StorageToken Proxy:", tokenAddress);
        console.log("StorageToken Implementation:", tokenImplAddress);
        console.log("StakingPool Proxy:", stakingPoolAddress);
        console.log("StakingPool Implementation:", stakingPoolImplAddress);
        console.log("StoragePool Proxy:", storagePoolAddress);
        console.log("StoragePool Implementation:", storagePoolImplAddress);
        console.log("RewardEngine Proxy:", rewardEngineAddress);
        console.log("RewardEngine Implementation:", rewardEngineImplAddress);
        console.log("Initial Owner:", initialOwner);
        console.log("Initial Admin:", initialAdmin);

        console.log("\n✅ LOCAL DEPLOYMENT COMPLETED SUCCESSFULLY!");

        console.log("\n📋 VERIFICATION COMMANDS (if needed):");
        console.log("For StorageToken:");
        console.log(`npx hardhat verify --network localhost ${tokenAddress}`);
        console.log(`npx hardhat verify --network localhost ${tokenImplAddress}`);
        console.log("For StakingPool:");
        console.log(`npx hardhat verify --network localhost ${stakingPoolAddress}`);
        console.log(`npx hardhat verify --network localhost ${stakingPoolImplAddress}`);
        console.log("For StoragePool:");
        console.log(`npx hardhat verify --network localhost ${storagePoolAddress}`);
        console.log(`npx hardhat verify --network localhost ${storagePoolImplAddress}`);
        console.log("For RewardEngine:");
        console.log(`npx hardhat verify --network localhost ${rewardEngineAddress}`);
        console.log(`npx hardhat verify --network localhost ${rewardEngineImplAddress}`);

        console.log("\n📋 NEXT STEPS:");
        console.log("1. Create storage pools using StoragePool contract");
        console.log("2. Add members to pools");
        console.log("3. Update online status for peer IDs");
        console.log("4. Test reward calculations and claiming");
        console.log("5. Run security verification:");
        console.log(`   REWARD_ENGINE_PROXY=${rewardEngineAddress} STORAGE_POOL_PROXY=${storagePoolAddress} STAKING_POOL_PROXY=${stakingPoolAddress} STORAGE_TOKEN_PROXY=${tokenAddress} npx hardhat run scripts/checkERC1967SecurityQuick.ts --network localhost`);

        console.log("\n🧪 TEST ACCOUNTS:");
        console.log("Deployer/Owner:", deployer.address);
        console.log("Admin:", admin.address);
        console.log("User 1:", user1.address);
        console.log("User 2:", user2.address);

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
// npx hardhat run scripts/RewardEngine/deployLocalRewardEngine.ts --network localhost
//
// This script deploys a complete local testing environment with:
// - StorageToken with 1B token supply
// - StakingPool for holding reward tokens
// - StoragePool for managing storage pools
// - RewardEngine for calculating and distributing rewards
// - All implementation contracts properly secured
// - Test accounts funded with tokens
// - Governance parameters configured
