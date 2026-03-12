import { ethers, upgrades } from "hardhat";
import * as readline from "readline";

function waitForUserConfirmation(message: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
    const signers = await ethers.getSigners();

    // Use ADMIN_PK (second signer) if available, otherwise fall back to PK (first signer)
    const admin = signers.length > 1 ? signers[1] : signers[0];
    console.log("Upgrading FulaFileNFT with account:", admin.address);
    if (signers.length > 1) {
        console.log("(Using ADMIN_PK — second configured account)");
    }

    const proxyAddress = process.env.NFT_CONTRACT_ADDRESS?.trim();
    if (!proxyAddress) {
        throw new Error("NFT_CONTRACT_ADDRESS environment variable not set (proxy address)");
    }

    // Verify current implementation
    const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log("Current implementation:", currentImpl);

    const balance = await ethers.provider.getBalance(admin.address);
    console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

    // Connect the contract factory to the admin signer (who has ADMIN_ROLE for _authorizeUpgrade)
    const FulaFileNFT = await ethers.getContractFactory("FulaFileNFT", admin);

    console.log("\nUpgrade parameters:");
    console.log(`  Proxy address: ${proxyAddress}`);
    console.log(`  Current impl:  ${currentImpl}`);
    console.log(`  Admin signer:  ${admin.address}`);

    await waitForUserConfirmation("\nPress Enter to upgrade or Ctrl+C to abort...");

    console.log("Deploying new implementation and upgrading proxy...");
    const upgraded = await upgrades.upgradeProxy(
        proxyAddress,
        FulaFileNFT,
        {
            kind: "uups",
            unsafeAllow: ["constructor"],
            redeployImplementation: "always",
        }
    );

    await upgraded.waitForDeployment();
    const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log("\nUpgrade complete!");
    console.log("Proxy address (unchanged):", proxyAddress);
    console.log("Old implementation:", currentImpl);
    console.log("New implementation:", newImpl);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run (make sure ADMIN_PK is set in hardhat vars):
// NFT_CONTRACT_ADDRESS=0x56F8268690B18f05Ba867FF47edf8A4f5D81423a npx hardhat run scripts/upgradeFulaFileNFT.ts --network skale
