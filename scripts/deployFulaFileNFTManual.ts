import { ethers, run } from "hardhat";
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
    const [deployer] = await ethers.getSigners();
    console.log("Deploying FulaFileNFT (manual) with account:", deployer.address);

    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();
    const storageTokenAddr = process.env.STORAGE_TOKEN_ADDRESS?.trim();
    const baseUri = process.env.BASE_URI?.trim() || "https://ipfs.cloud.fx.land/gateway/";
    const existingImpl = process.env.IMPLEMENTATION_ADDRESS?.trim();

    if (!initialOwner) throw new Error("INITIAL_OWNER not set");
    if (!initialAdmin) throw new Error("INITIAL_ADMIN not set");
    if (!storageTokenAddr) throw new Error("STORAGE_TOKEN_ADDRESS not set");

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

    // Check for pending transactions
    const pendingNonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
    const confirmedNonce = await ethers.provider.getTransactionCount(deployer.address, "latest");
    if (pendingNonce > confirmedNonce) {
        console.log(`\nWARNING: ${pendingNonce - confirmedNonce} pending transaction(s) detected (confirmed: ${confirmedNonce}, pending: ${pendingNonce})`);
        console.log("Waiting 30s for pending transactions to clear...");
        await new Promise(r => setTimeout(r, 30000));

        const newPending = await ethers.provider.getTransactionCount(deployer.address, "pending");
        const newConfirmed = await ethers.provider.getTransactionCount(deployer.address, "latest");
        if (newPending > newConfirmed) {
            console.log(`Still ${newPending - newConfirmed} pending. Sending cancel tx to clear nonce ${newConfirmed}...`);
            // Send a zero-value tx to self to clear the stuck nonce
            const cancelTx = await deployer.sendTransaction({
                to: deployer.address,
                value: 0,
                nonce: newConfirmed,
            });
            await cancelTx.wait();
            console.log("Nonce cleared.");
        }
    }

    console.log("\nDeployment parameters:");
    console.log(`  Initial Owner:  ${initialOwner}`);
    console.log(`  Initial Admin:  ${initialAdmin}`);
    console.log(`  Storage Token:  ${storageTokenAddr}`);
    console.log(`  Base URI:       ${baseUri}`);
    if (existingImpl) {
        console.log(`  Existing Impl:  ${existingImpl} (skipping impl deploy)`);
    }

    await waitForUserConfirmation("\nPress Enter to deploy or Ctrl+C to abort...");

    const FulaFileNFT = await ethers.getContractFactory("FulaFileNFT");
    let implAddress: string;

    if (existingImpl) {
        // Reuse previously deployed implementation
        implAddress = existingImpl;
        console.log("\n[1/2] Using existing implementation:", implAddress);
    } else {
        // Deploy implementation
        console.log("\n[1/2] Deploying implementation...");
        const impl = await FulaFileNFT.deploy();
        await impl.waitForDeployment();
        implAddress = await impl.getAddress();
        console.log("Implementation deployed to:", implAddress);
    }

    // Step 2: Deploy ERC1967Proxy
    console.log("[2/2] Deploying proxy...");

    // Encode initialize() calldata
    const initData = FulaFileNFT.interface.encodeFunctionData("initialize", [
        initialOwner,
        initialAdmin,
        storageTokenAddr,
        baseUri,
    ]);

    const ERC1967Proxy = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
    );
    const proxy = await ERC1967Proxy.deploy(implAddress, initData);
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();
    console.log("Proxy deployed to:", proxyAddress);

    // Verify: read implementation slot
    const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
    const storedImpl = await ethers.provider.getStorage(proxyAddress, implSlot);
    const storedImplAddress = "0x" + storedImpl.slice(26);
    console.log("Stored implementation:", storedImplAddress);

    if (storedImplAddress.toLowerCase() !== implAddress.toLowerCase()) {
        console.error("WARNING: Implementation address mismatch!");
    }

    // Verify: call name() through proxy
    const proxyContract = FulaFileNFT.attach(proxyAddress);
    try {
        const name = await proxyContract.name();
        console.log(`Contract name: ${name}`);
    } catch (e) {
        console.warn("Could not read name():", e);
    }

    console.log("\n=== Deployment Complete ===");
    console.log(`Proxy:          ${proxyAddress}`);
    console.log(`Implementation: ${implAddress}`);
    console.log(`Owner:          ${initialOwner}`);
    console.log(`Admin:          ${initialAdmin}`);

    // Verify on explorer if API key available
    if (process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY) {
        console.log("\nWaiting for block confirmations before verification...");
        await proxy.deploymentTransaction()?.wait(6);

        try {
            await run("verify:verify", {
                address: implAddress,
                contract: "contracts/core/FulaFileNFT.sol:FulaFileNFT",
            });
            console.log("Implementation verified!");
        } catch (e: any) {
            console.warn("Verification failed:", e.message);
        }
    }

    console.log("\nExport for app:");
    console.log(`export NFT_CONTRACT_ADDRESS=${proxyAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to run (fresh deploy):
// INITIAL_OWNER=0x... INITIAL_ADMIN=0x... STORAGE_TOKEN_ADDRESS=0x... npx hardhat run scripts/deployFulaFileNFTManual.ts --network base
//
// Command to run (reuse existing implementation):
// IMPLEMENTATION_ADDRESS=0x... INITIAL_OWNER=0x... INITIAL_ADMIN=0x... STORAGE_TOKEN_ADDRESS=0x... npx hardhat run scripts/deployFulaFileNFTManual.ts --network base
