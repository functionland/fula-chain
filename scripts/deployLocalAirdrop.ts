import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
const STORAGE_TOKEN_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"; // Address of deployed StorageToken contract from deployLocalDistribution.ts

async function getCapIdLEngth(airdropContract) {
    // Get the first few indices until you hit a revert
    let capIds = [];
    try {
        let i = 0;
        while (true) {
            const capId = await airdropContract.capIds(i);
            capIds.push(capId);
            i++;
        }
    } catch (e) {
        // We've hit the end of the array
    }
    return capIds.length;
}
async function showContractDetails(storageToken, airdropContract) {
    console.log("\n=== Contract Balances ===");
    const tokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
    const airdropBalance = await storageToken.balanceOf(await airdropContract.getAddress());
    console.log(`StorageToken Contract Balance: ${ethers.formatEther(tokenBalance)} tokens`);
    console.log(`Airdrop Contract Balance: ${ethers.formatEther(airdropBalance)} tokens`);

    console.log("\n=== Vesting Caps Details ===");
    let i = 0;
    while (true) {
        try {
            const capId = await airdropContract.capIds(i);
            const cap = await airdropContract.vestingCaps(capId);
            
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
            const wallets = await airdropContract.getWalletsInCap(capId);
            if (wallets && wallets.length > 0) {
                console.log("\nWallets in Cap:" +capId);
                for (const wallet of wallets) {
                    const walletInfo = await airdropContract.vestingWallets(wallet, capId);
                    
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

async function verifyDeployment(storageToken, airdropContract) {
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

    // Verify Airdrop deployment
    const airdropAddress = await airdropContract.getAddress();
    console.log("\n=== Verifying Airdrop Deployment ===");
    try {
        const storageTokenAddress = await airdropContract.storageToken();
        if (storageTokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
            throw new Error("StorageToken address mismatch in Airdrop contract");
        }
        console.log(`Airdrop Address: ${airdropAddress}`);
        console.log(`Linked StorageToken: ${storageTokenAddress}`);
    } catch (error) {
        console.error("Airdrop verification failed:", error);
        throw new Error("Airdrop deployment verification failed");
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

    // Get existing StorageToken contract instance
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const storageToken = await ethers.getContractAt(
        "StorageToken", 
        STORAGE_TOKEN_ADDRESS // Address of deployed contract
    );
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);

    // Deploy AirdropContract
    const AirdropContract = await ethers.getContractFactory("AirdropContract");
    console.log("Deploying AirdropContract...");
    
    const airdropContract = await upgrades.deployProxy(AirdropContract, [
        tokenAddress,
        ownerWallet.address,
        adminWallet.address
    ], {
        initializer: "initialize",
        kind: "uups"
    });

    await airdropContract.waitForDeployment();
    const airdropAddress = await airdropContract.getAddress();
    console.log("AirdropContract deployed to:", airdropAddress);

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

    // Create whitelist proposal for airdrop contract
    // Create whitelist proposal
const whitelistProposalTx = await storageTokenWithAdmin.createProposal(
    5, // AddWhitelist is type 5
    0,
    airdropAddress,
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

// Transfer tokens to airdrop contract
await storageTokenWithAdmin.transferFromContract(airdropAddress, ethers.parseEther("100000000"));

// Set up airdrop engine with admin wallet
const airdropWithAdmin = AirdropContract.attach(airdropAddress).connect(adminWallet);
const txd1 = await airdropWithAdmin.setRoleQuorum(ethers.id("ADMIN_ROLE"), 2);
    await txd1.wait();
    console.log("quorum set");

    const txd2 = await airdropWithAdmin.setRoleTransactionLimit(
        ethers.id("ADMIN_ROLE"), 
        ethers.parseEther("100000000")
    );
    await txd2.wait();
console.log("quorum and transaction limit set for airdrop contract");
const airdropWithSecondAdmin = AirdropContract.attach(airdropAddress).connect(ownerWallet);
console.log("second admin created for airdrop");
// Add vesting caps
await airdropWithAdmin.addVestingCap(
    1, // capId
    ethers.encodeBytes32String("Airdrop"),
    ethers.parseEther("60000000"), // 50M allocation
    14, // cliff in days
    6, // vesting term in months
    1, // monthly vesting plan
    0 // 0% initial release
);

const capIdsLength = await getCapIdLEngth(airdropContract);
console.log("number of caps: "+capIdsLength);

// Add wallets to caps -these are hardhat default wallets
const cap1Wallets = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
];

for (const wallet of cap1Wallets) {
    const proposalTx = await airdropWithAdmin.createProposal(
        7,
        1, // capId
        wallet,
        ethers.encodeBytes32String("Beneficiary"),
        ethers.parseEther("16666666"), // Equal airdrop of 50M
        ethers.ZeroAddress
    );
    const receipt = await proposalTx.wait();
    const proposalCreatedLog = receipt.logs.find(
        log => {
            try {
                const parsed = airdropWithAdmin.interface.parseLog(log);
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
    
    await airdropWithSecondAdmin.approveProposal(proposalId);
    await time.increase(24 * 60 * 60 + 1);
    await airdropWithAdmin.executeProposal(proposalId);
}

// Initiate TGE
await airdropWithAdmin.initiateTGE();

console.log("Setup completed successfully!");

// Add this at the end of your deployment script
await showContractDetails(storageToken, airdropContract);

await verifyDeployment(storageToken, airdropContract);
    
    console.log("Deployment successful and verified!");

}


main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });


// npx hardhat node
// then run the distribution deploy local and get the token address and put in the file
// npx hardhat run scripts/deployLocalAirdrop.ts --network localhost
