import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

async function showContractDetails(storageToken, storagePool) {
    console.log("\n=== Contract Details ===");
    const tokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
    const poolBalance = await storageToken.balanceOf(await storagePool.getAddress());
    console.log(`StorageToken Contract Balance: ${ethers.formatEther(tokenBalance)} tokens`);
    console.log(`StoragePool Contract Balance: ${ethers.formatEther(poolBalance)} tokens`);

    console.log("\n=== StoragePool Configuration ===");
    const poolCreationTokens = await storagePool.dataPoolCreationTokens();
    const poolCounter = await storagePool.poolCounter();
    const tokenAddress = await storagePool.token();
    
    console.log(`Pool Creation Requirement: ${ethers.formatEther(poolCreationTokens)} tokens`);
    console.log(`Current Pool Counter: ${poolCounter}`);
    console.log(`Linked Token Address: ${tokenAddress}`);

    // Show all pools if any exist
    if (poolCounter > 0) {
        console.log("\n=== Existing Pools ===");
        try {
            const allPools = await storagePool.getAllPools();
            const [poolIds, names, regions, creators, requiredTokens] = allPools;

            for (let i = 0; i < poolIds.length; i++) {
                console.log(`\nPool ID: ${poolIds[i]}`);
                console.log(`Name: ${names[i]}`);
                console.log(`Region: ${regions[i]}`);
                console.log(`Creator: ${creators[i]}`);
                console.log(`Required Tokens: ${ethers.formatEther(requiredTokens[i])} tokens`);

                // Get member count for this pool
                try {
                    const memberCount = await storagePool.getPoolMemberCount(poolIds[i]);
                    console.log(`Member Count: ${memberCount}`);
                } catch (error) {
                    console.log(`Member Count: Error retrieving count`);
                }
            }
        } catch (error) {
            console.log("Error retrieving pool information:", error.message);
        }
    }
}

async function verifyDeployment(storageToken, storagePool, ownerWallet, adminWallet) {
    // Verify StorageToken deployment
    const tokenAddress = await storageToken.getAddress();
    console.log("\n=== Verifying StorageToken Deployment ===");
    try {
        const totalSupply = await storageToken.maxSupply();
        const contractBalance = await storageToken.balanceOf(tokenAddress);
        console.log(`Token Address: ${tokenAddress}`);
        console.log(`Max Supply: ${ethers.formatEther(totalSupply)} tokens`);
        console.log(`Contract Balance: ${ethers.formatEther(contractBalance)} tokens`);
    } catch (error) {
        console.error("StorageToken verification failed:", error);
        throw new Error("StorageToken deployment verification failed");
    }

    // Verify StoragePool deployment
    const poolAddress = await storagePool.getAddress();
    console.log("\n=== Verifying StoragePool Deployment ===");
    try {
        const linkedTokenAddress = await storagePool.token();
        if (linkedTokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
            throw new Error("StorageToken address mismatch in StoragePool contract");
        }
        console.log(`StoragePool Address: ${poolAddress}`);
        console.log(`Linked StorageToken: ${linkedTokenAddress}`);
        
        // Verify roles using the actual wallet addresses
        const DEFAULT_ADMIN_ROLE = await storagePool.DEFAULT_ADMIN_ROLE();
        const POOL_CREATOR_ROLE = await storagePool.POOL_CREATOR_ROLE();

        const ownerHasAdminRole = await storagePool.hasRole(DEFAULT_ADMIN_ROLE, ownerWallet.address);
        const adminHasAdminRole = await storagePool.hasRole(DEFAULT_ADMIN_ROLE, adminWallet.address);
        const ownerHasPoolCreatorRole = await storagePool.hasRole(POOL_CREATOR_ROLE, ownerWallet.address);

        console.log(`Owner (${ownerWallet.address}) has admin role: ${ownerHasAdminRole}`);
        console.log(`Admin (${adminWallet.address}) has admin role: ${adminHasAdminRole}`);
        console.log(`Owner has pool creator role: ${ownerHasPoolCreatorRole}`);
    } catch (error) {
        console.error("StoragePool verification failed:", error);
        throw new Error("StoragePool deployment verification failed");
    }
}

async function createSamplePool(storagePool, storageToken, creator, creatorPeerId) {
    console.log("\n=== Creating Sample Pool ===");

    try {
        // First, approve the StoragePool contract to transfer tokens
        const poolCreationTokens = await storagePool.dataPoolCreationTokens();
        console.log(`Approving StoragePool to transfer ${ethers.formatEther(poolCreationTokens)} tokens...`);

        const approveTx = await storageToken.connect(creator).approve(
            await storagePool.getAddress(),
            poolCreationTokens
        );
        await approveTx.wait();
        console.log("Approval successful");

        // Advance time to bypass any potential timelock issues
        await time.increase(8 * 60 * 60 + 1); // 8 hours + 1 second

        const tx = await storagePool.connect(creator).createDataPool(
            "Sample Pool",
            "North America",
            ethers.parseEther("100000"), // 100K tokens required to join
            100, // 100ms min ping time
            7 * 24 * 60 * 60, // 7 days max challenge response
            creatorPeerId
        );
        
        const receipt = await tx.wait();
        console.log(`Sample pool created successfully!`);
        console.log(`Transaction hash: ${receipt.hash}`);
        
        // Get the pool ID from events
        const poolCreatedEvent = receipt.logs.find(log => {
            try {
                const parsed = storagePool.interface.parseLog(log);
                return parsed?.name === "PoolCreated";
            } catch {
                return false;
            }
        });
        
        if (poolCreatedEvent) {
            const parsedEvent = storagePool.interface.parseLog(poolCreatedEvent);
            const poolId = parsedEvent?.args[0];
            console.log(`Created Pool ID: ${poolId}`);
            return poolId;
        }
    } catch (error) {
        console.error("Failed to create sample pool:", error);
        throw error;
    }
}

async function deployStorageToken(ownerWallet, adminWallet) {
    console.log("\n=== Deploying StorageToken ===");

    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2B tokens
    const initialMintedTokens = TOTAL_SUPPLY / BigInt(2); // 1B tokens initially minted

    const StorageToken = await ethers.getContractFactory("StorageToken");
    console.log("Deploying StorageToken...");

    const storageToken = await upgrades.deployProxy(StorageToken, [
        ownerWallet.address,
        adminWallet.address,
        initialMintedTokens
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);

    // Wait for timelock period
    console.log("Waiting for initial timelock period...");
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second

    // Set up governance parameters
    const storageTokenWithAdmin = storageToken.connect(adminWallet);
    const tx1 = await storageTokenWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await tx1.wait();
    console.log("StorageToken quorum set");

    const tx2 = await storageTokenWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"),
        ethers.parseEther("100000000")
    );
    await tx2.wait();
    console.log("StorageToken transaction limit set");

    return storageToken;
}

async function getExistingStorageToken(tokenAddress) {
    console.log("\n=== Connecting to Existing StorageToken ===");

    try {
        const storageToken = await ethers.getContractAt("StorageToken", tokenAddress);

        // Verify it's a valid StorageToken by calling a view function
        const name = await storageToken.name();
        const symbol = await storageToken.symbol();
        const maxSupply = await storageToken.maxSupply();

        console.log(`Connected to StorageToken: ${name} (${symbol})`);
        console.log(`Max Supply: ${ethers.formatEther(maxSupply)} tokens`);
        console.log(`Token Address: ${tokenAddress}`);

        return storageToken;
    } catch (error) {
        console.error("Failed to connect to StorageToken:", error);
        throw new Error(`Invalid token address: ${tokenAddress}`);
    }
}

async function fundInitialAccounts(storageToken: any, adminWallet: any, ownerWallet: any) {
    const storageTokenWithAdmin = storageToken.connect(adminWallet);

    // Fund amounts
    const ownerFundAmount = ethers.parseEther("10000000"); // 10M tokens for owner
    const adminFundAmount = ethers.parseEther("5000000");  // 5M tokens for admin

    // Create whitelist proposals for owner and admin
    console.log("Creating whitelist proposals for initial accounts...");

    // Whitelist owner
    const ownerWhitelistTx = await storageTokenWithAdmin.createProposal(
        5, // AddWhitelist is type 5
        0,
        ownerWallet.address,
        ethers.ZeroHash,
        0,
        ethers.ZeroAddress
    );
    const ownerWhitelistReceipt = await ownerWhitelistTx.wait();
    const ownerProposalId = extractProposalId(ownerWhitelistReceipt, storageTokenWithAdmin);
    console.log("Owner whitelist proposal ID:", ownerProposalId);

    // Whitelist admin
    const adminWhitelistTx = await storageTokenWithAdmin.createProposal(
        5, // AddWhitelist is type 5
        0,
        adminWallet.address,
        ethers.ZeroHash,
        0,
        ethers.ZeroAddress
    );
    const adminWhitelistReceipt = await adminWhitelistTx.wait();
    const adminProposalId = extractProposalId(adminWhitelistReceipt, storageTokenWithAdmin);
    console.log("Admin whitelist proposal ID:", adminProposalId);

    // Approve whitelist proposals using owner wallet (second admin)
    console.log("Approving whitelist proposals...");
    const storageTokenWithOwner = storageToken.connect(ownerWallet);
    await storageTokenWithOwner.approveProposal(ownerProposalId);
    console.log("Owner whitelist proposal approved:", ownerProposalId);
    await storageTokenWithOwner.approveProposal(adminProposalId);
    console.log("Admin whitelist proposal approved:", adminProposalId);

    // Wait for execution delay (24 hours)
    console.log("Waiting for proposal execution delay...");
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second

    // Execute whitelist proposals
    console.log("Executing whitelist proposals...");
    await storageTokenWithAdmin.executeProposal(ownerProposalId);
    await storageTokenWithAdmin.executeProposal(adminProposalId);
    console.log("Whitelist proposals executed");

    // Wait for whitelist lock time (24 hours)
    console.log("Waiting for whitelist lock time...");
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second

    // Transfer tokens to owner and admin
    console.log("Transferring tokens to initial accounts...");
    const ownerTransferTx = await storageTokenWithAdmin.transferFromContract(
        ownerWallet.address,
        ownerFundAmount
    );
    await ownerTransferTx.wait();
    console.log(`Transferred ${ethers.formatEther(ownerFundAmount)} tokens to owner`);

    const adminTransferTx = await storageTokenWithAdmin.transferFromContract(
        adminWallet.address,
        adminFundAmount
    );
    await adminTransferTx.wait();
    console.log(`Transferred ${ethers.formatEther(adminFundAmount)} tokens to admin`);
}

function extractProposalId(receipt: any, contract: any) {
    const proposalCreatedLog = receipt.logs.find(log => {
        try {
            const parsed = contract.interface.parseLog(log);
            return parsed?.name === "ProposalCreated";
        } catch {
            return false;
        }
    });

    return proposalCreatedLog ?
        contract.interface.parseLog(proposalCreatedLog)?.args[0] :
        undefined;
}

async function main() {
    // Initial setup
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);

    // Get environment variables (optional for local deployment)
    const providedTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();

    // Use provided addresses or default to hardhat accounts for local development
    let adminWallet, ownerWallet;

    if (initialAdmin && initialOwner) {
        // Use provided addresses
        console.log("Using provided owner and admin addresses");
        ownerWallet = await ethers.getSigner(initialOwner);
        adminWallet = await ethers.getSigner(initialAdmin);
    } else {
        // Use hardhat default accounts for local development
        console.log("Using default hardhat accounts for local development");
        const signers = await ethers.getSigners();
        ownerWallet = signers[0];  // Account #0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
        adminWallet = signers[1];  // Account #1: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
    }

    console.log("Admin wallet:", adminWallet.address);
    console.log("Owner wallet:", ownerWallet.address);

    // Deploy or connect to StorageToken
    let storageToken;
    if (providedTokenAddress) {
        console.log(`Using provided StorageToken address: ${providedTokenAddress}`);
        storageToken = await getExistingStorageToken(providedTokenAddress);
    } else {
        console.log("No token address provided, deploying new StorageToken...");
        storageToken = await deployStorageToken(ownerWallet, adminWallet);
    }

    const tokenAddress = await storageToken.getAddress();
    console.log("Using StorageToken at:", tokenAddress);

    // Deploy StoragePoolLib library first
    console.log("Deploying StoragePoolLib library...");
    const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
    const storagePoolLib = await StoragePoolLib.deploy();
    await storagePoolLib.waitForDeployment();
    const libAddress = await storagePoolLib.getAddress();
    console.log("StoragePoolLib deployed to:", libAddress);

    // Deploy StoragePool with library linking
    const StoragePool = await ethers.getContractFactory("StoragePool", {
        libraries: {
            StoragePoolLib: libAddress
        }
    });
    console.log("Deploying StoragePool...");

    const storagePool = await upgrades.deployProxy(StoragePool, [
        tokenAddress,
        ownerWallet.address,
        adminWallet.address
    ], {
        initializer: "initialize",
        kind: "uups",
        unsafeAllow: ["external-library-linking"]
    });

    await storagePool.waitForDeployment();
    const poolAddress = await storagePool.getAddress();
    console.log("StoragePool deployed to:", poolAddress);

    // Only wait for timelock if we just deployed a new token
    if (!providedTokenAddress) {
        console.log("Waiting for timelock period...");
        await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second
    }

    // Set up token governance if needed (skip if using existing token with governance already set)
    const storageTokenWithAdmin = storageToken.connect(adminWallet);
    try {
        // Only set up governance if we deployed a new token
        if (!providedTokenAddress) {
            console.log("Setting up token contract governance...");
            const tx1 = await storageTokenWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
            await tx1.wait();
            console.log("Token contract quorum set");

            const tx2 = await storageTokenWithAdmin.setRoleTransactionLimit(
                ethers.id("ADMIN_ROLE"),
                ethers.parseEther("100000000")
            );
            await tx2.wait();
            console.log("Token contract transaction limit set");
        } else {
            console.log("Using existing token - skipping governance setup");
        }
    } catch (error) {
        console.log("Note: Could not configure token governance (may already be set or insufficient permissions)");
    }

    // Note: StoragePool authorization in StorageToken may need to be done manually
    // if the StorageToken contract has pool authorization mechanisms
    console.log("Note: If StorageToken has pool authorization, manually authorize this pool:", poolAddress);

    // Set up StoragePool governance with admin wallet
    const storagePoolWithAdmin = storagePool.connect(adminWallet);
    const txp1 = await storagePoolWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await txp1.wait();
    console.log("Pool contract quorum set");

    const txp2 = await storagePoolWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"),
        ethers.parseEther("100000000")
    );
    await txp2.wait();
    console.log("Pool contract transaction limit set");

    // Fund initial owner and admin with tokens through proper whitelisting mechanism
    if (!providedTokenAddress) {
        console.log("\n=== Funding Initial Accounts ===");
        await fundInitialAccounts(storageToken, adminWallet, ownerWallet);
    } else {
        console.log("Using existing token - skipping initial account funding");
    }

    console.log("Setup completed successfully!");

    // Create a sample pool for demonstration
    const creatorPeerId = "QmSampleCreatorPeerId123";
    await createSamplePool(storagePool, storageToken, ownerWallet, creatorPeerId);

    // Show contract details
    await showContractDetails(storageToken, storagePool);

    // Verify deployment
    await verifyDeployment(storageToken, storagePool, ownerWallet, adminWallet);
    
    console.log("Deployment successful and verified!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Usage:
// 1. Start local hardhat node: npx hardhat node
//
// 2a. Deploy with new StorageToken (full deployment):
//     npx hardhat run scripts/deployLocalStoragePool.ts --network localhost
//
// 2b. Deploy with existing StorageToken:
//     TOKEN_ADDRESS=0x... npx hardhat run scripts/deployLocalStoragePool.ts --network localhost
//
// 2c. Deploy with custom owner/admin addresses:
//     TOKEN_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... npx hardhat run scripts/deployLocalStoragePool.ts --network localhost
//
// Environment Variables (all optional for local deployment):
// - TOKEN_ADDRESS: Address of existing StorageToken (if not provided, deploys new one)
// - INITIAL_OWNER: Custom owner address (if not provided, uses hardhat account)
// - INITIAL_ADMIN: Custom admin address (if not provided, uses hardhat account)
//
// Features:
// - Deploys StoragePoolLib library and links it to StoragePool
// - Sets up governance with proper quorum and transaction limits
// - Funds initial owner (10M tokens) and admin (5M tokens) through proper whitelisting
// - Creates sample pool for testing
// - Includes proper proposal approval and execution delays
