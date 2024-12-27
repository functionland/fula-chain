import { ethers, upgrades } from "hardhat";

async function main() {
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }

    const StorageProof = await ethers.getContractFactory("StorageProof");
    console.log("Deploying StorageProof...");
    
    const storageProof = await upgrades.deployProxy(StorageProof, [tokenAddress], {
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


// set TOKEN_ADDRESS=0xFd3F71338f422B518e9eb6A76fF0D32093cD5fc8 && yarn hardhat run scripts/deployProof.ts --network sepolia