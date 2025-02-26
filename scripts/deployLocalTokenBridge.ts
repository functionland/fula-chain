import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

async function showBridgeDetails(tokenBridge, storageToken) {
    console.log("\n=== TokenBridge Details ===");
    const tokenAddress = await tokenBridge.token();
    const localChainId = await tokenBridge.LOCAL_CHAIN_ID();
    const dailyLimit = await tokenBridge.dailyLimit();
    const whitelistEnabled = await tokenBridge.whitelistEnabled();
    const operatorCount = await tokenBridge.operatorCount();
    const largeTransferThreshold = await tokenBridge.largeTransferThreshold();
    const largeTransferDelay = await tokenBridge.largeTransferDelay();
    
    console.log(`Token Address: ${tokenAddress}`);
    console.log(`Local Chain ID: ${localChainId}`);
    console.log(`Daily Limit: ${ethers.formatEther(dailyLimit)} tokens`);
    console.log(`Whitelist Enabled: ${whitelistEnabled}`);
    console.log(`Bridge Operator Count: ${operatorCount}`);
    console.log(`Large Transfer Threshold: ${ethers.formatEther(largeTransferThreshold)} tokens`);
    console.log(`Large Transfer Delay: ${Number(largeTransferDelay) / 3600} hours`);
    
    const bridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
    console.log(`Bridge Token Balance: ${ethers.formatEther(bridgeBalance)} tokens`);
}

async function verifyDeployment(tokenBridge, storageToken) {
    // Verify TokenBridge deployment
    const bridgeAddress = await tokenBridge.getAddress();
    console.log("\n=== Verifying TokenBridge Deployment ===");
    try {
        const tokenAddress = await tokenBridge.token();
        const storageTokenAddress = await storageToken.getAddress();
        
        if (tokenAddress.toLowerCase() !== storageTokenAddress.toLowerCase()) {
            throw new Error("StorageToken address mismatch in TokenBridge contract");
        }
        
        console.log(`Bridge Address: ${bridgeAddress}`);
        console.log(`Linked StorageToken: ${tokenAddress}`);
        console.log("TokenBridge deployment verified successfully");
    } catch (error) {
        console.error("TokenBridge verification failed:", error);
        throw new Error("TokenBridge deployment verification failed");
    }
}

async function main() {
    // Initial setup
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);

    const adminWallet = new ethers.Wallet(
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        ethers.provider
    );
    const ownerWallet = new ethers.Wallet(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        ethers.provider
    );

    // Set some operators (using hardhat default addresses for testing)
    const operators = [
        "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Account #3
        "0x90F79bf6EB2c4f870365E785982E1f101E93b906"  // Account #4
    ];

    // Chain ID for local Hardhat network
    const localChainId = 31337;
    
    // Daily limit (100,000 tokens)
    const dailyLimit = ethers.parseEther("100000");

    console.log("Deploying StorageToken first...");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2B tokens
    const initialMintedTokens = TOTAL_SUPPLY / BigInt(2);

    // Deploy StorageToken
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

    // Waiting for timelock to expire
    console.log("Waiting for timelock period...");
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second

    // Set quorum and transaction limit using admin wallet
    const storageTokenWithAdmin = storageToken.connect(adminWallet);
    const tx1 = await storageTokenWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await tx1.wait();
    console.log("Quorum set for StorageToken");

    const tx2 = await storageTokenWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"), 
        ethers.parseEther("100000000")
    );
    await tx2.wait();
    console.log("Transaction limit set for StorageToken");

    // Deploy TokenBridge
    const TokenBridge = await ethers.getContractFactory("TokenBridge");
    console.log("Deploying TokenBridge...");
    
    const tokenBridge = await upgrades.deployProxy(TokenBridge, [
        tokenAddress,
        localChainId,
        dailyLimit,
        ownerWallet.address,
        adminWallet.address,
        operators
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await tokenBridge.waitForDeployment();
    const bridgeAddress = await tokenBridge.getAddress();
    console.log("TokenBridge deployed to:", bridgeAddress);

    // Create whitelist proposal for bridge contract
    const whitelistProposalTx = await storageTokenWithAdmin.createProposal(
        5, // AddWhitelist is type 5
        0,
        bridgeAddress,
        ethers.ZeroHash,
        0,
        ethers.ZeroAddress
    );
    const whitelistReceipt = await whitelistProposalTx.wait();
    const proposalCreatedLog = whitelistReceipt.logs.find(
        log => {
            try {
                const parsed = storageTokenWithAdmin.interface.parseLog(log);
                return parsed?.name === "ProposalCreated";
            } catch {
                return false;
            }
        }
    );

    const whitelistProposalId = proposalCreatedLog ? 
        storageTokenWithAdmin.interface.parseLog(proposalCreatedLog)?.args[0] : 
        undefined;
    console.log("Whitelist proposal created, ID:", whitelistProposalId);

    // Approve the proposal with the second admin (owner)
    const storageTokenWithSecondAdmin = storageToken.connect(ownerWallet);
    await storageTokenWithSecondAdmin.approveProposal(whitelistProposalId);
    console.log("Whitelist proposal approved");
    
    // Wait for execution delay
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second
    
    // Execute the proposal
    await storageTokenWithAdmin.executeProposal(whitelistProposalId);
    console.log("Whitelist proposal executed");

    // Wait for whitelist timelock
    await time.increase(24 * 60 * 60 + 1);

    // Transfer tokens to bridge contract for testing
    await storageTokenWithAdmin.transferFromContract(bridgeAddress, ethers.parseEther("1000000"));
    console.log("Transferred 1,000,000 tokens to bridge contract");

    // Set up bridge with admin wallet
    const bridgeWithAdmin = TokenBridge.attach(bridgeAddress).connect(adminWallet);
    
    // Set quorum for the bridge
    const txBridge1 = await bridgeWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await txBridge1.wait();
    
    // Set transaction limit for the bridge
    const txBridge2 = await bridgeWithAdmin.setRoleTransactionLimit(
        ethers.id("BRIDGE_OPERATOR_ROLE"), 
        ethers.parseEther("10000") // 10k tokens per transaction limit for bridge operators
    );
    await txBridge2.wait();
    
    console.log("Bridge quorum and transaction limit set");

    // Configure bridge additional settings
    await bridgeWithAdmin.updateLargeTransferSettings(ethers.parseEther("50000"), 6 * 60 * 60); // 50k tokens, 6 hours delay
    console.log("Large transfer settings updated");

    // Create bridge operator proposal
    const additionalOperator = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // Account #5
    await bridgeWithAdmin.updateBridgeOperator(additionalOperator, true);
    console.log("Additional bridge operator added");

    // Display bridge details
    await showBridgeDetails(tokenBridge, storageToken);
    
    // Verify deployment
    await verifyDeployment(tokenBridge, storageToken);
    
    console.log("TokenBridge deployment and setup completed successfully!");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// npx hardhat node
// npx hardhat run scripts/deployLocalTokenBridge.ts --network localhost