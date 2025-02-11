import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
const STORAGE_TOKEN_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"; // Address of deployed StorageToken contract from deployLocalDistribution.ts

async function showContractDetails(storageToken, rewardsContract) {
    console.log("\n=== Contract Balances ===");
    const tokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
    const rewardsBalance = await storageToken.balanceOf(await rewardsContract.getAddress());
    console.log(`StorageToken Contract Balance: ${ethers.formatEther(tokenBalance)} tokens`);
    console.log(`TestnetMiningRewards Contract Balance: ${ethers.formatEther(rewardsBalance)} tokens`);

    console.log("\n=== Vesting Caps Details ===");
    const capsCount = await rewardsContract.vestingCapsCount();
    for (let i = 1; i <= capsCount; i++) {
        try {
            const cap = await rewardsContract.vestingCaps(i);
            
            console.log(`\nCap ID: ${i}`);
            console.log(`Name: ${ethers.decodeBytes32String(cap.name)}`);
            console.log(`Total Allocation: ${ethers.formatEther(cap.totalAllocation)} tokens`);
            console.log(`Cliff: ${Number(cap.cliff) / 86400} days`);
            console.log(`Vesting Term: ${Number(cap.vestingTerm) / (30 * 86400)} months`);
            console.log(`Vesting Plan: ${Number(cap.vestingPlan) / (30 * 86400)} months`);
            console.log(`Initial Release: ${cap.initialRelease}%`);
            console.log(`Start Date: ${new Date(Number(cap.startDate) * 1000).toLocaleString()}`);
            console.log(`Allocated to Wallets: ${ethers.formatEther(cap.allocatedToWallets)} tokens`);
            console.log(`Ratio: ${cap.ratio}`);
            console.log(`Max Monthly Rewards: ${ethers.formatEther(cap.maxRewardsPerMonth)} tokens`);

            // Get wallets array from the cap struct
            const wallets = cap.wallets;
            if (wallets && wallets.length > 0) {
                console.log("\nWallets in Cap:" + i);
                for (const wallet of wallets) {
                    const walletInfo = await rewardsContract.vestingWallets(wallet, i);
                    console.log(`\nWallet: ${wallet}`);
                    console.log(`Allocation: ${ethers.formatEther(walletInfo.allocation)} tokens`);
                    console.log(`Claimed: ${ethers.formatEther(walletInfo.claimed)} tokens`);
                    console.log(`Last Claim Month: ${walletInfo.lastClaimMonth}`);
                    console.log(`Monthly Claimed Rewards: ${ethers.formatEther(walletInfo.monthlyClaimedRewards)} tokens`);
                }
            }
        } catch (e) {
            console.error(`Error getting cap ${i}:`, e);
        }
    }
}

async function verifyDeployment(storageToken, rewardsContract) {
    try {
        console.log("\nVerifying deployment...");

        // Check contract addresses
        const tokenAddress = await storageToken.getAddress();
        const rewardsAddress = await rewardsContract.getAddress();
        console.log("StorageToken address:", tokenAddress);
        console.log("TestnetMiningRewards address:", rewardsAddress);

        // Check roles
        const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
        const [deployer] = await ethers.getSigners();
        const hasAdminRole = await rewardsContract.hasRole(ADMIN_ROLE, deployer.address);
        console.log("Deployer has ADMIN_ROLE:", hasAdminRole);

        // Check token configuration
        const configuredToken = await rewardsContract.storageToken();
        console.log("Token contract configured:", configuredToken === tokenAddress);

        console.log("Deployment verification completed successfully");
    } catch (error) {
        console.error("TestnetMiningRewards verification failed:", error);
        throw new Error("TestnetMiningRewards deployment verification failed");
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

    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2B tokens
    const initialMintedTokens = TOTAL_SUPPLY / BigInt(2);

    console.log("Deploying contracts with account:", adminWallet.address);

    // Get existing StorageToken contract instance
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const storageToken = await ethers.getContractAt(
        "StorageToken", 
        STORAGE_TOKEN_ADDRESS // Address of deployed contract
    );
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);

    // Deploy TestnetMiningRewards
    const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
    console.log("Deploying TestnetMiningRewards...");
    
    const rewardsContract = await upgrades.deployProxy(TestnetMiningRewards, [
        tokenAddress,
        ownerWallet.address,
        adminWallet.address
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await rewardsContract.waitForDeployment();
    const rewardsAddress = await rewardsContract.getAddress();
    console.log("TestnetMiningRewards deployed to:", rewardsAddress);

    // Wait for role change timelock to expire
    await time.increase(24 * 60 * 60 + 1);

    // Set up roles and permissions
    const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    await storageToken.connect(ownerWallet).setRoleQuorum(ADMIN_ROLE, 2);
    await rewardsContract.connect(ownerWallet).setRoleQuorum(ADMIN_ROLE, 2);

    // Wait for execution delay
    await time.increase(24 * 60 * 60 + 1);
    await time.increase(24 * 60 * 60 + 1);

    // Set role transaction limit
    await storageToken.connect(ownerWallet).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

    // Whitelist TestnetMiningRewards contract in StorageToken
    const addWhitelistType = 5;
    const tx = await storageToken.connect(ownerWallet).createProposal(
        addWhitelistType,
        0,
        rewardsAddress,
        ethers.ZeroHash,
        0,
        ethers.ZeroAddress
    );
    
    const receipt = await tx.wait();
    const proposalId = receipt?.logs[0].topics[1];

    await time.increase(24 * 60 * 60 + 1);
    await storageToken.connect(adminWallet).approveProposal(proposalId);
    await time.increase(24 * 60 * 60 + 1);

    // Transfer tokens to rewards contract
    const REWARDS_AMOUNT = ethers.parseEther("1000000"); // 1M tokens
    await storageToken.connect(ownerWallet).transferFromContract(
        rewardsAddress,
        REWARDS_AMOUNT
    );

    // Create initial vesting cap
    await rewardsContract.connect(ownerWallet).addVestingCap(
        1, // capId
        ethers.encodeBytes32String("Mining Rewards"),
        REWARDS_AMOUNT,
        14, // 14 days cliff
        6, // 6 months vesting
        1, // vesting plan
        0, // initial release
        ethers.parseEther("1000"), // max monthly rewards
        10 // 10:1 ratio
    );

    // Set TGE
    await rewardsContract.connect(ownerWallet).initiateTGE();

    // Add wallet mapping
    const testWallet = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
    const substrateAddr = "5GWck2Qtq9MzsUhLpx2ksLrd3zZ3tBRAGDRanArR2AfYfAxH";
    await rewardsContract.connect(ownerWallet).batchAddAddresses(
        [testWallet],
        [ethers.toUtf8Bytes(substrateAddr)]
    );

    // Create proposal to add wallet to cap
    const walletAllocation = ethers.parseEther("100000"); // 100k tokens
    const addWalletProposal = await rewardsContract.connect(ownerWallet).createProposal(
        7, // AddDistributionWallets type
        1, // capId
        testWallet,
        ethers.ZeroHash,
        walletAllocation,
        ethers.ZeroAddress
    );

    const walletProposalReceipt = await addWalletProposal.wait();
    const walletProposalId = walletProposalReceipt?.logs[0].topics[1];

    // Wait for execution delay and approve
    await time.increase(24 * 60 * 60 + 1);
    await rewardsContract.connect(adminWallet).approveProposal(walletProposalId);
    await time.increase(24 * 60 * 60 + 1);

    // Set initial substrate rewards for the wallet
    await rewardsContract.connect(ownerWallet).updateSubstrateRewards(
        testWallet,
        ethers.parseEther("1000") // 1000 tokens as initial substrate rewards
    );

    await time.increase(45* 24 * 60 * 60 + 1);

    // Verify deployment
    await verifyDeployment(storageToken, rewardsContract);

    // Show contract details
    await showContractDetails(storageToken, rewardsContract);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// npx hardhat node
// then run the distribution deploy local and get the token address and put in the file
// npx hardhat run scripts/deployLocalTestnetMining.ts --network localhost