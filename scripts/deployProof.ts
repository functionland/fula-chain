import { ethers, upgrades } from "hardhat";

async function main() {
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }

    // Specify the initial owner address
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }

    const StorageProof = await ethers.getContractFactory("StorageProof");
    console.log("Deploying StorageProof...");

    // Pass both tokenAddress and initialOwner to the initializer
    const storageProof = await upgrades.deployProxy(StorageProof, [tokenAddress, initialOwner], {
        initializer: "initialize",
        kind: "uups"
    });

    await storageProof.waitForDeployment();
    const proofAddress = await storageProof.getAddress();
    console.log("StorageProof deployed to:", proofAddress);

    // Get token contract instance and add proof as authorized contract
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const token = StorageToken.attach(tokenAddress);
    const addProofTx = await token.addProofContract(proofAddress);
    await addProofTx.wait();
    console.log("Proof contract authorized in token contract");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});


// set TOKEN_ADDRESS=0xed1211C59554c301FBaA2F4ebBD9DF91a21F7E47 && yarn hardhat run scripts/deployProof.ts --network sepolia
// yarn hardhat verify --network sepolia 0x...