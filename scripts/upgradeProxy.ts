// SPDX-License-Identifier: MIT
import { ethers, config } from "hardhat";
import chalk from "chalk";
import readline from "readline";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Contract, Wallet } from "ethers";
import { HardhatConfig } from "hardhat/types";
import { HardhatEthersProvider } from "@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider";

// Environment variables
import * as dotenv from "dotenv";
dotenv.config();

// Contract addresses - these are used as defaults if not specified via environment variables
const PROXY_ADDRESS = process.env.PROXY_ADDRESS || "0x32A2b049b1E7A6c8C26284DE49e7F05A00466a5d";
const NEW_IMPLEMENTATION_ADDRESS = process.env.IMPLEMENTATION_ADDRESS || "0xC31db852C347322440f9027A5D65d8FD39B18C46";

// ABIs - We only need the function signatures for the upgrade process
const PROXY_ABI = [
  "function proposeUpgrade(address newImplementation) external",
  "function approveUpgrade(address newImplementation) external",
  "function pendingImplementation() external view returns (address)",
  "function upgradeProposalTime() external view returns (uint256)"
];

enum Action {
  PROPOSE = "propose",
  APPROVE = "approve"
}

// Get action from environment variable or command line arguments
const getAction = (): Action => {
  const action = process.env.UPGRADE_ACTION?.toLowerCase()?.trim();
  
  if (action === 'propose') return Action.PROPOSE;
  if (action === 'approve') return Action.APPROVE;
  
  // If not set or invalid, show usage and exit
  console.log(chalk.red(`ERROR: UPGRADE_ACTION environment variable must be set to 'propose' or 'approve' instead of '${action}'`));
  console.log(chalk.yellow("\nUsage:"));
  console.log(chalk.yellow("  UPGRADE_ACTION=propose yarn hardhat run scripts/upgradeProxy.ts --network ethereum"));
  console.log(chalk.yellow("  UPGRADE_ACTION=approve yarn hardhat run scripts/upgradeProxy.ts --network base"));
  console.log(chalk.yellow("\nOptional environment variables:"));
  console.log(chalk.yellow("  PROXY_ADDRESS=0x123... IMPLEMENTATION_ADDRESS=0x456... UPGRADE_ACTION=propose yarn hardhat run scripts/upgradeProxy.ts --network sepolia"));
  process.exit(1);
};

interface CommandArgs {
  action: "propose" | "approve";
  network?: string;
  proxyAddress?: string;
  implementationAddress?: string;
}

// Helper function to ensure private key is properly formatted
const formatPrivateKey = (privateKey: string): string => {
  console.log(chalk.yellow("Debug: Checking private key format..."));
  
  // Handle undefined or empty keys
  if (!privateKey) {
    throw new Error("Private key is empty or undefined");
  }
  
  // Remove any 0x prefix if it exists
  let cleanKey = privateKey.startsWith('0x') ? privateKey.substring(2) : privateKey;
  
  // Remove any whitespace or newlines
  cleanKey = cleanKey.trim().replace(/\s/g, '');
  
  // If key seems to include quotes, remove them
  if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
    cleanKey = cleanKey.substring(1, cleanKey.length - 1);
  }
  if (cleanKey.startsWith("'") && cleanKey.endsWith("'")) {
    cleanKey = cleanKey.substring(1, cleanKey.length - 1);
  }
  
  // Check if private key is valid hex
  if (!/^[0-9a-fA-F]+$/.test(cleanKey)) {
    // For debugging - show first few characters with problems
    const invalidChars = cleanKey.split('')
      .map((char, index) => ({ char, index }))
      .filter(item => !/[0-9a-fA-F]/.test(item.char))
      .slice(0, 3)
      .map(item => `'${item.char}' at position ${item.index}`);
      
    throw new Error(`Invalid private key format. Private key must contain only hexadecimal characters (0-9, a-f, A-F). Found invalid characters: ${invalidChars.join(', ')}`);
  }
  
  // Ensure it's the correct length (32 bytes = 64 hex chars)
  if (cleanKey.length <= 63) {
    throw new Error(`Invalid private key length. Expected 64 hex characters, got ${cleanKey.length}.`);
  }
  
  // Add 0x prefix back
  return '0x' + cleanKey;
};

async function main() {
  // Parse command line arguments using yargs
  const argv = yargs(hideBin(process.argv))
    .option("network", {
      alias: "n",
      describe: "Network to use (should match networks in hardhat.config.ts)",
      type: "string",
      default: "localhost"
    })
    .example("$0 --action propose --network ethereum", "Propose an upgrade on ethereum mainnet")
    .example("$0 --action approve --network base-sepolia", "Approve a pending upgrade on base-sepolia testnet")
    .example("$0 --action propose --proxyAddress 0x123... --implementationAddress 0x456...", "Propose with custom addresses")
    .wrap(120)
    .help()
    .argv;

  // Get action from environment variable
  const action = getAction();
  
  const commandArgs: CommandArgs = {
    action: action === Action.PROPOSE ? "propose" : "approve",
    network: argv.network as string,
    proxyAddress: argv.proxyAddress as string,
    implementationAddress: argv.implementationAddress as string
  };
  
  // Use the provided addresses if specified, otherwise use defaults
  const proxyAddress = commandArgs.proxyAddress || PROXY_ADDRESS;
  const implementationAddress = commandArgs.implementationAddress || NEW_IMPLEMENTATION_ADDRESS;
  
  // Setup provider and network information
  const provider = ethers.provider as HardhatEthersProvider;
  const { name: networkName, chainId } = await provider.getNetwork();
  
  console.log(chalk.cyan("========= Proxy Upgrade Script ========="));
  console.log(chalk.cyan(`Network: ${networkName} (Chain ID: ${chainId})`));
  console.log(chalk.cyan(`Action: ${commandArgs.action.toUpperCase()}`));
  console.log(chalk.cyan(`Using hardhat network: ${commandArgs.network}`));
  console.log(chalk.cyan("========================================"));
  
  // Debug the network configuration
  console.log(chalk.yellow(`Debug: Network name specified: ${commandArgs.network}`));
  
  // Override hardhat network if needed - this is key for Windows CMD
  const actualNetworkName = process.env.HARDHAT_NETWORK || commandArgs.network;
  console.log(chalk.yellow(`Debug: Actual network being used: ${actualNetworkName}`));
  
  try {
    const networkConfig = config.networks[actualNetworkName];
    
    // Check if the network configuration exists
    if (!networkConfig) {
      console.error(chalk.red(`No network configuration found for '${actualNetworkName}'`));
      console.log(chalk.yellow("Available networks:"), Object.keys(config.networks).join(", "));
      return;
    }
    
    // Check the accounts property
    console.log(chalk.yellow(`Debug: Accounts property exists: ${Boolean(networkConfig.accounts)}`));
    
    if (!networkConfig.accounts) {
      console.error(chalk.red("No accounts configured for this network"));
      return;
    }
  } catch (error) {
    console.error(chalk.red("Error inspecting network configuration:"), error);
    return;
  }
  
  // Get the appropriate private key based on action
  let signerPrivateKey: string;
  
  try {
    // First try directly from environment variables
    if (commandArgs.action === "propose") {
      // Check PK2 environment variable
      let pk2Var = process.env.PK2;
      if (pk2Var) {
        console.log(chalk.yellow("Using PK2 environment variable"));
        
        // Show stats about the key (length, etc.) without revealing it
        console.log(chalk.yellow(`Debug: PK2 length: ${pk2Var.length}`));
        console.log(chalk.yellow(`Debug: Has 0x prefix: ${pk2Var.startsWith('0x')}`));
        
        // Handle 0x prefix consistently
        if (pk2Var.startsWith('0x')) {
          pk2Var = pk2Var.substring(2);
          console.log(chalk.yellow(`Debug: Removed 0x prefix, new length: ${pk2Var.length}`));
        }
        
        // Ensure key is exactly 64 chars
        if (pk2Var.length < 64) {
          console.log(chalk.yellow(`Debug: Key is too short (${pk2Var.length}), padding with zeros`));
          pk2Var = pk2Var.padStart(64, '0');
        } else if (pk2Var.length > 64) {
          console.log(chalk.yellow(`Debug: Key is too long (${pk2Var.length}), truncating`));
          pk2Var = pk2Var.substring(0, 64);
        }
        
        // Re-add 0x prefix
        pk2Var = '0x' + pk2Var;
        
        try {
          // Assign it to the signer key
          signerPrivateKey = pk2Var;
        } catch (e) {
          console.error(chalk.red("Error validating private key:"), e.message);
          throw new Error("Invalid private key format. Please check instructions below.");
        }
      } else {
        throw new Error("PK2 environment variable not set");
      }
      console.log(chalk.yellow("Using ADMIN account for proposal"));
    } else {
      // Owner role - check PK environment variable
      let pkVar = process.env.PK;
      if (pkVar) {
        console.log(chalk.yellow("Using PK environment variable"));
        
        // Show stats about the key (length, etc.) without revealing it
        console.log(chalk.yellow(`Debug: PK length: ${pkVar.length}`));
        console.log(chalk.yellow(`Debug: Has 0x prefix: ${pkVar.startsWith('0x')}`));
        
        // Handle 0x prefix consistently
        if (pkVar.startsWith('0x')) {
          pkVar = pkVar.substring(2);
          console.log(chalk.yellow(`Debug: Removed 0x prefix, new length: ${pkVar.length}`));
        }
        
        // Ensure key is exactly 64 chars
        if (pkVar.length < 64) {
          console.log(chalk.yellow(`Debug: Key is too short (${pkVar.length}), padding with zeros`));
          pkVar = pkVar.padStart(64, '0');
        } else if (pkVar.length > 64) {
          console.log(chalk.yellow(`Debug: Key is too long (${pkVar.length}), truncating`));
          pkVar = pkVar.substring(0, 64);
        }
        
        // Re-add 0x prefix
        pkVar = '0x' + pkVar;
        
        try {
          // Basic validation that this is a valid hex string
          if (!/^0x[0-9a-fA-F]{64}$/.test(pkVar)) {
            throw new Error(`Key contains non-hexadecimal characters`);
          }
          
          // Assign it to the signer key
          signerPrivateKey = pkVar;
        } catch (e) {
          console.error(chalk.red("Error validating private key:"), e.message);
          throw new Error("Invalid private key format. Please check instructions below.");
        }
      } else {
        throw new Error("PK environment variable not set");
      }
      console.log(chalk.yellow("Using OWNER account for approval"));
    }
  } catch (error) {
    console.error(chalk.red("Error with private key:"), error.message);
    console.log(chalk.yellow("\nTo fix this, try:"));
    console.log(chalk.yellow("\n1. For Windows CMD:"));
    console.log(chalk.yellow("   set \"HARDHAT_NETWORK=base\""));
    console.log(chalk.yellow("   set \"PK2=your64characterprivatekeywithouthex\""));
    console.log(chalk.yellow("   set \"UPGRADE_ACTION=propose\""));
    console.log(chalk.yellow("   yarn hardhat run scripts/upgradeProxy.ts"));
    console.log(chalk.yellow("\n2. For PowerShell:"));
    console.log(chalk.yellow("   $env:HARDHAT_NETWORK = \"base\""));
    console.log(chalk.yellow("   $env:PK2 = \"your64characterprivatekeywithouthex\""));
    console.log(chalk.yellow("   $env:UPGRADE_ACTION = \"propose\""));
    console.log(chalk.yellow("   yarn hardhat run scripts/upgradeProxy.ts"));
    console.log(chalk.yellow("\nMake sure your private key:"));
    console.log(chalk.yellow("  - Is exactly 64 hexadecimal characters (0-9, a-f, A-F)"));
    console.log(chalk.yellow("  - Does not include quotes or spaces"));
    console.log(chalk.yellow("  - Does not include the '0x' prefix when setting the variable"));
    return;
  }

  // Create wallet and connect to provider
  // Trim any whitespace from the private key
  signerPrivateKey = signerPrivateKey.trim();
  const wallet = new Wallet(signerPrivateKey, provider);
  const signerAddress = wallet.address;
  
  console.log(chalk.green(`Signer address: ${signerAddress}`));

  // Create contract instance
  const proxyContract = new Contract(proxyAddress, PROXY_ABI, wallet);

  // Check current state
  let pendingImplementation: string;
  let upgradeProposalTime: bigint;
  
  try {
    pendingImplementation = await proxyContract.pendingImplementation();
    upgradeProposalTime = await proxyContract.upgradeProposalTime();
    
    console.log(chalk.blue(`Current pending implementation: ${pendingImplementation}`));
    
    if (pendingImplementation !== ethers.ZeroAddress) {
      const proposalDate = new Date(Number(upgradeProposalTime) * 1000);
      const now = new Date();
      const timeDiff = now.getTime() - proposalDate.getTime();
      const hoursDiff = timeDiff / (1000 * 60 * 60);
      
      console.log(chalk.blue(`Proposal timestamp: ${proposalDate.toISOString()}`));
      console.log(chalk.blue(`Time elapsed since proposal: ~${hoursDiff.toFixed(2)} hours`));
      
      // Check if 2-day timelock period has passed
      const TIMELOCK_HOURS = 48; // 2 days in hours
      if (commandArgs.action === "approve" && hoursDiff < TIMELOCK_HOURS) {
        console.log(chalk.red(`Timelock period not yet passed. Need to wait ~${(TIMELOCK_HOURS - hoursDiff).toFixed(2)} more hours`));
        return;
      }
    }
  } catch (error) {
    console.error(chalk.red("Error checking contract state:"), error);
    return;
  }

  // Prepare transaction data based on action
  let tx: { data: string };
  let txDescription: string;
  
  if (action === Action.PROPOSE) {
    txDescription = `Propose upgrade to implementation: ${implementationAddress}`;
    tx = await proxyContract.proposeUpgrade.populateTransaction(implementationAddress);
  } else { // approve
    if (pendingImplementation === ethers.ZeroAddress) {
      console.error(chalk.red("No pending implementation to approve. Run with UPGRADE_ACTION=propose first."));
      return;
    }
    
    if (pendingImplementation.toLowerCase() !== implementationAddress.toLowerCase()) {
      console.error(chalk.red(`Pending implementation (${pendingImplementation}) doesn't match expected (${implementationAddress})`));
      return;
    }
    
    txDescription = `Approve upgrade to implementation: ${implementationAddress}`;
    tx = await proxyContract.approveUpgrade.populateTransaction(implementationAddress);
  }

  // Estimate gas
  let gasEstimate: bigint;
  try {
    gasEstimate = await provider.estimateGas({
      to: proxyAddress,
      data: tx.data,
      from: signerAddress
    });
    
    const gasPrice = await provider.getFeeData();
    const gasCost = gasEstimate * (gasPrice.gasPrice || 0n);
    const ethCost = ethers.formatEther(gasCost);
    
    console.log(chalk.yellow(`Estimated gas: ${gasEstimate.toString()}`));
    console.log(chalk.yellow(`Estimated gas cost: ${ethCost} ETH`));
  } catch (error) {
    console.error(chalk.red("Error estimating gas:"), error);
    console.error(chalk.red("Transaction would likely fail"));
    return;
  }

  // Prompt for confirmation
  console.log("\n");
  console.log(chalk.cyan("=== Transaction Details ==="));
  console.log(chalk.green(`Action: ${txDescription}`));
  console.log(chalk.green(`From: ${signerAddress}`));
  console.log(chalk.green(`To: ${proxyAddress}`));
  console.log(chalk.green(`Network: ${networkName} (Chain ID: ${chainId})`));
  console.log(chalk.cyan("========================"));
  
  // Get user confirmation
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question(chalk.yellow("Press Enter to continue or Ctrl+C to abort..."), async () => {
    rl.close();
    
    console.log(chalk.cyan("Sending transaction..."));
    
    try {
      // Send transaction
      let txResponse;
      if (action === Action.PROPOSE) {
        txResponse = await proxyContract.proposeUpgrade(implementationAddress);
      } else {
        txResponse = await proxyContract.approveUpgrade(implementationAddress);
      }
      
      console.log(chalk.green(`Transaction sent! Hash: ${txResponse.hash}`));
      console.log(chalk.cyan("Waiting for confirmation..."));
      
      // Wait for confirmation
      const receipt = await txResponse.wait();
      
      console.log(chalk.green(`Transaction confirmed in block ${receipt?.blockNumber}`));
      console.log(chalk.green(`Gas used: ${receipt?.gasUsed.toString()}`));
      
      if (action === Action.PROPOSE) {
        console.log(chalk.cyan("\nUpgrade proposed successfully!"));
        console.log(chalk.yellow("You must wait 48 hours before approving the upgrade"));
        console.log(chalk.yellow(`Run with UPGRADE_ACTION=approve on the same network after the timelock period`));
      } else {
        console.log(chalk.cyan("\nUpgrade approved and executed successfully!"));
        console.log(chalk.green("Contract implementation has been updated"));
      }
    } catch (error) {
      console.error(chalk.red("Error executing transaction:"), error);
    }
  });
}

// Handle errors in the main function
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(chalk.red("Unhandled error:"), error);
    process.exit(1);
  });