import { ethers, upgrades } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying TokenBridge with the account:", deployer.address);

    // Get the contract factory
    const TokenBridge = await ethers.getContractFactory("TokenBridge");
    console.log("Deploying TokenBridge...");

    // Validate environment variables
    const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
    const initialOwner = process.env.INITIAL_OWNER?.trim();
    const initialAdmin = process.env.INITIAL_ADMIN?.trim();
    const chainId = process.env.CHAIN_ID?.trim();
    const dailyLimit = process.env.DAILY_LIMIT?.trim();
    const bridgeOperatorsStr = process.env.BRIDGE_OPERATORS?.trim();

    // Validate required environment variables
    if (!storageTokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
    }
    if (!initialOwner) {
        throw new Error("INITIAL_OWNER environment variable not set");
    }
    if (!initialAdmin) {
        throw new Error("INITIAL_ADMIN environment variable not set");
    }
    if (!chainId) {
        throw new Error("CHAIN_ID environment variable not set");
    }
    if (!dailyLimit) {
        throw new Error("DAILY_LIMIT environment variable not set");
    }

    // Parse bridge operators (optional)
    const bridgeOperators = bridgeOperatorsStr ? bridgeOperatorsStr.split(',') : [];
    console.log("Bridge operators:", bridgeOperators.length > 0 ? bridgeOperators : "None specified");

    // Parse daily limit to wei
    const dailyLimitWei = ethers.parseEther(dailyLimit);

    // Deploy the proxy contract
    const tokenBridge = await upgrades.deployProxy(
        TokenBridge,
        [
            storageTokenAddress,
            chainId,
            dailyLimitWei,
            initialOwner,
            initialAdmin,
            bridgeOperators
        ],
        {
            initializer: "initialize",
            kind: "uups",
            unsafeAllow: ["constructor"]
        }
    );

    await tokenBridge.waitForDeployment();
    const contractAddress = await tokenBridge.getAddress();
    const implementationAddress = await upgrades.erc1967.getImplementationAddress(contractAddress);

    console.log("TokenBridge proxy deployed to:", contractAddress);
    console.log("Implementation address:", implementationAddress);
    console.log("Configuration:");
    console.log("- Storage token address:", storageTokenAddress);
    console.log("- Initial owner:", initialOwner);
    console.log("- Initial admin:", initialAdmin);
    console.log("- Chain ID:", chainId);
    console.log("- Daily limit:", dailyLimit, "tokens");
    console.log("- Initial bridge operators:", bridgeOperators.length);

    // Verify contract on Etherscan if API key is available
    if (process.env.ETHERSCAN_API_KEY) {
        console.log("Waiting for 6 block confirmations before verification...");
        await tokenBridge.deploymentTransaction()?.wait(6);

        try {
            console.log("Verifying implementation contract...");
            await hre.run("verify:verify", {
                address: implementationAddress,
                constructorArguments: []
            });
            console.log("Implementation contract verified successfully");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("Implementation contract already verified");
            } else {
                console.error("Error verifying implementation contract:", error);
            }
        }
    }

    console.log("\nNext steps:");
    console.log("1. Set up quorum for the bridge contract");
    console.log("2. Set transaction limits for bridge operators");
    console.log("3. Whitelist the bridge contract in the StorageToken contract");
    console.log("4. Transfer tokens to the bridge contract");
    console.log("5. Configure any additional bridge operators");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });

// Command to deploy:
// TOKEN_ADDRESS=<Token_Proxy_address> INITIAL_OWNER=<owner_address> INITIAL_ADMIN=<admin_address> CHAIN_ID=<chain_id> DAILY_LIMIT=<daily_limit_in_tokens> BRIDGE_OPERATORS=<op1,op2,op3> npx hardhat run scripts/deployTokenBridge.ts --network mainnet
// Note: Contract verification is handled automatically if ETHERSCAN_API_KEY environment variable is set
// Example:
// TOKEN_ADDRESS=0x123abc... INITIAL_OWNER=0xabc123... INITIAL_ADMIN=0xdef456... CHAIN_ID=1 DAILY_LIMIT=100000 BRIDGE_OPERATORS=0xfed987...,0xcba654... npx hardhat run scripts/deployTokenBridge.ts --network mainnet