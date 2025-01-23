import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

async function getCapIdLEngth(distributionEngine) {
    // Get the first few indices until you hit a revert
    let capIds = [];
    try {
        let i = 0;
        while (true) {
            const capId = await distributionEngine.capIds(i);
            capIds.push(capId);
            i++;
        }
    } catch (e) {
        // We've hit the end of the array
    }
    return capIds.length;
}
async function showContractDetails(storageToken, distributionEngine) {
    console.log("\n=== Contract Balances ===");
    const tokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
    const distributionBalance = await storageToken.balanceOf(await distributionEngine.getAddress());
    console.log(`StorageToken Contract Balance: ${ethers.formatEther(tokenBalance)} tokens`);
    console.log(`Distribution Contract Balance: ${ethers.formatEther(distributionBalance)} tokens`);

    console.log("\n=== Vesting Caps Details ===");
    let i = 0;
    while (true) {
        try {
            const capId = await distributionEngine.capIds(i);
            const cap = await distributionEngine.vestingCaps(capId);
            
            console.log(`\nCap ID: ${capId}`);
            console.log(`Name: ${ethers.decodeBytes32String(cap.name)}`);
            console.log(`Total Allocation: ${ethers.formatEther(cap.totalAllocation)} tokens`);
            console.log(`Cliff: ${Number(cap.cliff) / 86400} days`);
            console.log(`Vesting Term: ${Number(cap.vestingTerm) / (30 * 86400)} months`);
            console.log(`Vesting Plan: ${Number(cap.vestingPlan) / (30 * 86400)} months`);
            console.log(`Initial Release: ${cap.initialRelease}%`);
            console.log(`Start Date: ${new Date(Number(cap.startDate) * 1000).toLocaleString()}`);
            console.log(`Allocated to Wallets: ${ethers.formatEther(cap.allocatedToWallets)} tokens`);

            // Get wallets array from the cap struct
            const wallets = await distributionEngine.getWalletsInCap(capId);
            if (wallets && wallets.length > 0) {
                console.log("\nWallets in Cap:" +capId);
                for (const wallet of wallets) {
                    const walletInfo = await distributionEngine.vestingWallets(wallet, capId);
                    
                    console.log(`\nWallet Address: ${wallet}`);
                    console.log(`Entity Name: ${ethers.decodeBytes32String(walletInfo.name)}`);
                    console.log(`Allocated Amount: ${ethers.formatEther(walletInfo.amount)} tokens`);
                    console.log(`Claimed Amount: ${ethers.formatEther(walletInfo.claimed)} tokens`);
                }
            } else {
                console.log("\nNo wallets in this cap");
            }
            i++;
        } catch (e) {
            break;
        }
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

    // const initialOwner = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    // const initialAdmin = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2B tokens
    const initialMintedTokens = TOTAL_SUPPLY / BigInt(2);

    console.log("Deploying contracts with account:", adminWallet.address);

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

    // Deploy TokenDistributionEngine
    const TokenDistribution = await ethers.getContractFactory("TokenDistributionEngine");
    console.log("Deploying TokenDistributionEngine...");
    
    const distributionEngine = await upgrades.deployProxy(TokenDistribution, [
        tokenAddress,
        ownerWallet.address,
        adminWallet.address
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await distributionEngine.waitForDeployment();
    const distributionAddress = await distributionEngine.getAddress();
    console.log("TokenDistributionEngine deployed to:", distributionAddress);

    console.log("Waiting for timelock period...");
    await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second

    // Set quorum and transaction limit using admin wallet
    const storageTokenWithAdmin = storageToken.connect(adminWallet);
    const tx1 = await storageTokenWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await tx1.wait();
    console.log("quorum set");

    const tx2 = await storageTokenWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"), 
        ethers.parseEther("100000000")
    );
    await tx2.wait();
    console.log("transaction limit  set");

    // Create whitelist proposal for distribution contract
    // Create whitelist proposal
const whitelistProposalTx = await storageTokenWithAdmin.createProposal(
    5, // AddWhitelist is type 5
    0,
    distributionAddress,
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
console.log("proposalID: "+whitelistProposalId);

// Now approve using the extracted proposalId
const storageTokenWithSecondAdmin = storageToken.connect(ownerWallet);
await storageTokenWithSecondAdmin.approveProposal(whitelistProposalId);
console.log("proposal Approved: "+whitelistProposalId);
await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second
await storageTokenWithAdmin.executeProposal(whitelistProposalId);


// Wait for whitelist timelock (1 day)
await time.increase(24 * 60 * 60 + 1);

// Transfer tokens to distribution contract
await storageTokenWithAdmin.transferFromContract(distributionAddress, ethers.parseEther("100000000"));

// Set up distribution engine with admin wallet
const distributionWithAdmin = TokenDistribution.attach(distributionAddress).connect(adminWallet);
const txd1 = await distributionWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await txd1.wait();
    console.log("quorum set");

    const txd2 = await distributionWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"), 
        ethers.parseEther("100000000")
    );
    await txd2.wait();
console.log("quorum and transaction limit set for distribution contract");
const distributionWithSecondAdmin = TokenDistribution.attach(distributionAddress).connect(ownerWallet);
console.log("second admin created for distribution");
// Add vesting caps
await distributionWithAdmin.addVestingCap(
    1, // capId
    ethers.encodeBytes32String("Cap1"),
    ethers.parseEther("50000000"), // 50M allocation
    0, // cliff in days
    6, // vesting term in months
    1, // monthly vesting plan
    15 // 15% initial release
);

await distributionWithAdmin.addVestingCap(
    2, // capId
    ethers.encodeBytes32String("Cap2"),
    ethers.parseEther("50000000"), // 50M allocation
    120, // 4 months cliff in days
    15, // vesting term in months
    1, // monthly vesting plan
    10 // 10% initial release
);
console.log("2 vesting caps added");
const capIdsLength = await getCapIdLEngth(distributionEngine);
console.log("number of caps: "+capIdsLength);

// Add wallets to caps
const cap1Wallets = [
    "0x923E6C83A4b2DdE7F3a061F5497A0D554d67Ce3F",
    "0x71c30985750793A1b8cE4AE55b54b2b4cB3f25E0",
    "0xbE6157bC090536ee15763356Ac11be00b15951E3"
];

for (const wallet of cap1Wallets) {
    const proposalTx = await distributionWithAdmin.createProposal(
        7,
        1, // capId
        wallet,
        ethers.encodeBytes32String("Beneficiary"),
        ethers.parseEther("16666666"), // Equal distribution of 50M
        ethers.ZeroAddress
    );
    const receipt = await proposalTx.wait();
    const proposalCreatedLog = receipt.logs.find(
        log => {
            try {
                const parsed = distributionWithAdmin.interface.parseLog(log);
                return parsed?.name === "ProposalCreated";
            } catch {
                return false;
            }
        }
    );
    
    const proposalId = proposalCreatedLog ? 
        storageTokenWithAdmin.interface.parseLog(proposalCreatedLog)?.args[0] : 
        undefined;
    console.log("wallet proposalID: "+proposalId);
    
    await distributionWithSecondAdmin.approveProposal(proposalId);
    await time.increase(24 * 60 * 60 + 1);
    await distributionWithAdmin.executeProposal(proposalId);
}

// Add wallet to second cap
const cap2ProposalTx = await distributionWithAdmin.createProposal(
    7, // AddDistributionWallets is type 7
    2, // capId
    "0x1be910377306492D4763CE4ef35EFa6B18085538",
    ethers.encodeBytes32String("Beneficiary"),
    ethers.parseEther("50000000"),
    ethers.ZeroAddress
);
const cap2Receipt = await cap2ProposalTx.wait();
const proposalCreatedLog2 = cap2Receipt.logs.find(
    log => {
        try {
            const parsed = distributionWithAdmin.interface.parseLog(log);
            return parsed?.name === "ProposalCreated";
        } catch {
            return false;
        }
    }
);

const cap2ProposalId = proposalCreatedLog2 ? 
    storageTokenWithAdmin.interface.parseLog(proposalCreatedLog2)?.args[0] : 
    undefined;
console.log("wallet2 proposalID: "+cap2ProposalId);

await distributionWithSecondAdmin.approveProposal(cap2ProposalId);
await time.increase(24 * 60 * 60 + 1);
await distributionWithAdmin.executeProposal(cap2ProposalId);

// Initiate TGE
await distributionWithAdmin.initiateTGE();

console.log("Setup completed successfully!");

// Add this at the end of your deployment script
await showContractDetails(storageToken, distributionEngine);

}


main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });


// npx hardhat node --port 3000
// npx hardhat run scripts/deployLocal.ts --network localhost
