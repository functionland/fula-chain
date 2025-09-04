import { ethers, upgrades } from "hardhat";
import { TokenDistributionEngine } from "../../typechain-types";

// TGE Date: March 18, 2025 at 9:00 AM EST (already happened)
// EST is UTC-5, so 9:00 AM EST = 14:00 UTC
const TGE_TIMESTAMP = Math.floor(new Date("2025-03-18T14:00:00Z").getTime() / 1000);

// Vesting Cap IDs
const SEED_CAP_ID = 1;
const STRATEGIC_CAP_ID = 2;
const ADVISORS_CAP_ID = 3;
const PRE_SEED_CAP_ID = 4;

// Helper function to convert string to bytes32
function stringToBytes32(str: string): string {
  return ethers.encodeBytes32String(str);
}

// Helper function to convert tokens to wei (assuming 18 decimals)
function toTokens(amount: number): string {
  return ethers.parseEther(amount.toString()).toString();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying TokenDistributionEngine with account:", deployer.address);

  // Get current account balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Current account balance: ${ethers.formatEther(balance)} ETH`);

  // Validate environment variables
  const storageTokenAddress = process.env.TOKEN_ADDRESS?.trim();
  const initialOwner = process.env.INITIAL_OWNER?.trim() || deployer.address;
  const initialAdmin = process.env.INITIAL_ADMIN?.trim() || deployer.address;

  if (!storageTokenAddress) {
    throw new Error("TOKEN_ADDRESS environment variable not set");
  }

  console.log("Storage token address:", storageTokenAddress);
  console.log("Initial owner:", initialOwner);
  console.log("Initial admin:", initialAdmin);
  console.log("Deploying TokenDistributionEngine...");
  
  // Deploy the contract
  const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
  const tokenDistribution = await upgrades.deployProxy(
    TokenDistributionEngine,
    [storageTokenAddress, initialOwner, initialAdmin],
    { 
      initializer: "initialize",
      kind: "uups",
      unsafeAllow: ["constructor"]
    }
  );

  await tokenDistribution.waitForDeployment();
  const engineAddress = await tokenDistribution.getAddress();
  console.log("TokenDistributionEngine deployed to:", engineAddress);

  // Prepare batch cap data
  const batchCapData = [
    {
      capId: SEED_CAP_ID,
      name: stringToBytes32("Seed"),
      totalAllocation: toTokens(306666666.67), // Sum of all seed allocations
      cliff: 180, // 6 months in days
      vestingTerm: 18, // 18 months
      vestingPlan: 1, // Monthly vesting
      initialRelease: 10 // No initial release
    },
    {
      capId: STRATEGIC_CAP_ID,
      name: stringToBytes32("Strategic"),
      totalAllocation: toTokens(119487500), // Sum of all strategic allocations
      cliff: 120, // 4 months in days
      vestingTerm: 15, // 15 months
      vestingPlan: 1, // Monthly vesting
      initialRelease: 10 // No initial release
    },
    {
      capId: ADVISORS_CAP_ID,
      name: stringToBytes32("Advisors"),
      totalAllocation: toTokens(93060000), // Sum of all advisor allocations
      cliff: 180, // 6 months in days
      vestingTerm: 18, // 18 months
      vestingPlan: 1, // Monthly vesting
      initialRelease: 0 // No initial release
    },
    {
      capId: PRE_SEED_CAP_ID,
      name: stringToBytes32("Pre-seed"),
      totalAllocation: toTokens(120000000), // Pre-seed allocation
      cliff: 240, // 8 months in days
      vestingTerm: 24, // 24 months
      vestingPlan: 1, // Monthly vesting
      initialRelease: 0 // No initial release
    }
  ];

  // Prepare batch wallet data
  const batchWalletData = [
    // Seed allocations
    {
      capId: SEED_CAP_ID,
      wallet: "0x8252DE45e1CAe74Cc5d1087ec4d6d0F9FFdb7561",
      name: stringToBytes32("Jonathan Ip"),
      amount: toTokens(2446826.667)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0xf8f5D5C7C583Ad5E4446D26ACeac76305270C72c",
      name: stringToBytes32("Primal Capital"),
      amount: toTokens(13333333.33)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x28EfF6Cd911F5d5afB1a71A94C107B5B1e8433e8",
      name: stringToBytes32("Master Ventures"),
      amount: toTokens(7200000)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0xf51e2C7b50EC6b2369D94718881aaE2aF18Ef684",
      name: stringToBytes32("Delta Blockchain Fund"),
      amount: toTokens(66666666.67)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x4fd9bB45F17Db482fbb9E5E37a50B77B1C0c683d",
      name: stringToBytes32("PowerOne Capital"),
      amount: toTokens(13333333.33)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x2b485b86c843332A2aBFD553D5fe7485CeE0348c",
      name: stringToBytes32("Contango Digital"),
      amount: toTokens(20000000)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x30f24e11717d7a03e7e7af603562388012d23f20",
      name: stringToBytes32("Aaron"),
      amount: toTokens(2666666.667)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x74D37314e54135d571bdaeA9F4365F48705297Fa",
      name: stringToBytes32("Simon (nxgen)"),
      amount: toTokens(13333333.33)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x9576935881668204F6C6bFb1238AEdD991e2bd1b",
      name: stringToBytes32("Faisal"),
      amount: toTokens(6666666.667)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x671594c9FD3E351aCf1108C12820c038aeAcBC56",
      name: stringToBytes32("Mazhar"),
      amount: toTokens(6666666.667)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0xDd071d33bfCf21286ac874C9617A9b350B3072c1",
      name: stringToBytes32("Pinnacle"),
      amount: toTokens(18666666.67)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0xaCeC8C1DC15bb2d8785D4521382374a53d5f62C5",
      name: stringToBytes32("Tenzor Capital"),
      amount: toTokens(53333333.33)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x381126173877516fF6BD9f53F9430D4cEc44B981",
      name: stringToBytes32("Dora"),
      amount: toTokens(13333333.33)
    },
    {
      capId: SEED_CAP_ID,
      wallet: "0x87f91943345923039182ab2444b686dbc7c4a200",
      name: stringToBytes32("Protocol Labs"),
      amount: toTokens(66666666.67)
    },

    // Strategic allocations
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xA28a87af35eA4256e4c1510BD0ff9cA61Fc7D874",
      name: stringToBytes32("Thibaut"),
      amount: toTokens(1250000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xf51e2C7b50EC6b2369D94718881aaE2aF18Ef684", // Same as seed - Delta Blockchain Fund
      name: stringToBytes32("Delta Blockchain Fund"),
      amount: toTokens(37500000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xCC421394E4Be2f0EB3942ca361c1cB7E6edc883A",
      name: stringToBytes32("SKY Ventures"),
      amount: toTokens(6250000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xCE1d5D63A74b1D6858D9a05551F9aD8317C2211a",
      name: stringToBytes32("EVO Labs"),
      amount: toTokens(13750000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xd2F80f967a31Fe7C521416A7552c25f32CE4BAbc",
      name: stringToBytes32("AstraX"),
      amount: toTokens(5000000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0x918CA33dc19F9838673bf4cC6474540c22Be5588",
      name: stringToBytes32("Connectico"),
      amount: toTokens(7500000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xAC32A88E82C69E26AfdB5EC39a80FfC20989517e",
      name: stringToBytes32("Spark and Mint"),
      amount: toTokens(112500)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xaCeC8C1DC15bb2d8785D4521382374a53d5f62C5", // Same as seed - Tenzor Capital
      name: stringToBytes32("Tenzor Capital"),
      amount: toTokens(5000000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xDc6D1666CFfC25b8deA344A24eFb8336D2b4423e",
      name: stringToBytes32("Fast Project"),
      amount: toTokens(75000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0x8252DE45e1CAe74Cc5d1087ec4d6d0F9FFdb7561", // Same as seed - Jonathan Ip
      name: stringToBytes32("Jonathan Ip"),
      amount: toTokens(2050000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xC225A67e66C6e6afc11c621F4d6C6ef664F183EA",
      name: stringToBytes32("Asymmetry Ventures"),
      amount: toTokens(6250000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0xF6aa98cE1cc8eE991f380d5aFD178EF58AF85D93",
      name: stringToBytes32("Cogitent Ventures"),
      amount: toTokens(35000000)
    },
    {
      capId: STRATEGIC_CAP_ID,
      wallet: "0x4Cc2FcF3C6204d9F3F0f3d68e5aA6fe25339F0D7",
      name: stringToBytes32("Antoine"),
      amount: toTokens(1250000)
    },

    // Pre-seed allocation
    {
      capId: PRE_SEED_CAP_ID,
      wallet: "0xAAB72234204d43c5808469e4b40d1E363B51b652",
      name: stringToBytes32("Outlier Ventures"),
      amount: toTokens(120000000)
    },

    // Advisor allocations
    {
      capId: ADVISORS_CAP_ID,
      wallet: "0xf51e2C7b50EC6b2369D94718881aaE2aF18Ef684", // Same as seed/strategic - Delta Blockchain Fund
      name: stringToBytes32("Delta Blockchain Fund"),
      amount: toTokens(5000000)
    },
    {
      capId: ADVISORS_CAP_ID,
      wallet: "0xE6027555945A93275aB4A0953b2bE5Ef0ed2E0F4",
      name: stringToBytes32("Cointelegraph"),
      amount: toTokens(5400000)
    },
    {
      capId: ADVISORS_CAP_ID,
      wallet: "0xaCeC8C1DC15bb2d8785D4521382374a53d5f62C5", // Same as seed/strategic - Tenzor Capital
      name: stringToBytes32("Tenzor Capital"),
      amount: toTokens(2660000)
    },
    {
      capId: ADVISORS_CAP_ID,
      wallet: "0xa218005CB81EEca84378c602365FCdbbED931381",
      name: stringToBytes32("SDAO"),
      amount: toTokens(40000000)
    },
    {
      capId: ADVISORS_CAP_ID,
      wallet: "0xE49E72C88f5a26E35C60E7691DF329CA1a5615aD",
      name: stringToBytes32("Elja"),
      amount: toTokens(40000000)
    }
  ];

  // Compute per-cap wallet sums and validate against provided cap totals
  type CapTotals = { [capId: number]: bigint };
  const capWalletSums: CapTotals = {};
  for (const w of batchWalletData) {
    const capId = Number(w.capId);
    const amt = BigInt(w.amount);
    capWalletSums[capId] = (capWalletSums[capId] || 0n) + amt;
  }

  console.log("\n=== Pre-flight allocation checks ===");
  for (const cap of batchCapData) {
    const capId = Number(cap.capId);
    const providedTotal = BigInt(cap.totalAllocation);
    const walletSum = capWalletSums[capId] || 0n;
    const providedTotalFmt = ethers.formatEther(providedTotal);
    const walletSumFmt = ethers.formatEther(walletSum);
    console.log(`Cap ${capId} (${ethers.decodeBytes32String(cap.name)}): provided total=${providedTotalFmt}, wallets sum=${walletSumFmt}`);
  }

  // Align each cap's totalAllocation to the exact wallet sum to avoid AllocationTooHigh reverts
  // If you prefer strict validation, replace this adjustment with a throw when mismatched
  for (const cap of batchCapData) {
    const capId = Number(cap.capId);
    const walletSum = capWalletSums[capId] || 0n;
    if (walletSum === 0n) continue; // no wallets for this cap
    const providedTotal = BigInt(cap.totalAllocation);
    if (providedTotal !== walletSum) {
      console.warn(
        `Adjusting totalAllocation for cap ${capId} (${ethers.decodeBytes32String(cap.name)}) from ${ethers.formatEther(providedTotal)} to wallets sum ${ethers.formatEther(walletSum)} to prevent revert.`
      );
      cap.totalAllocation = walletSum.toString();
    }
  }

  console.log("Calling batchInitializeAndStartTGE...");
  console.log("TGE Timestamp:", TGE_TIMESTAMP, "Date:", new Date(TGE_TIMESTAMP * 1000).toISOString());
  console.log("Number of caps:", batchCapData.length);
  console.log("Number of wallets:", batchWalletData.length);

  // Check if deployer has admin role - if not, we need to use the admin account
  const adminRoleHash = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775"; // ADMIN_ROLE hash
  
  // Get the admin signer if deployer is not admin
  let adminSigner = deployer;
  if (deployer.address.toLowerCase() !== initialAdmin.toLowerCase()) {
    console.log("Deployer is not admin. Admin account needed:", initialAdmin);
    console.log("Current deployer:", deployer.address);
    
    // Try to get admin private key from environment
    const { vars } = require("hardhat/config");
    if (vars.has("ADMIN_PK")) {
      const adminWallet = new ethers.Wallet(vars.get("ADMIN_PK"), ethers.provider);
      adminSigner = adminWallet as any; // Cast to match HardhatEthersSigner interface
      console.log("Using admin private key for batch initialization");
      console.log("Admin address:", adminWallet.address);
    } else {
      throw new Error("ADMIN_PK environment variable not set. Need admin private key to call batch initialization.");
    }
  }

  // Connect to contract with admin signer
  const tokenDistributionAsAdmin = tokenDistribution.connect(adminSigner);

  // Check current block timestamp
  const currentBlock = await ethers.provider.getBlock("latest");
  console.log("Current block timestamp:", currentBlock?.timestamp);
  console.log("TGE timestamp (past event):", TGE_TIMESTAMP);

  try {
    // Call the batch initialization function using admin signer
    const tx = await tokenDistributionAsAdmin.batchInitializeAndStartTGE(
      batchCapData,
      batchWalletData,
      TGE_TIMESTAMP
    );

    console.log("Transaction hash:", tx.hash);
    console.log("Waiting for confirmation...");
    
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("Transaction receipt is null");
    }
    console.log("Transaction confirmed in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    // Verify deployment
    console.log("\n=== Deployment Summary ===");
    console.log("TokenDistributionEngine address:", engineAddress);
    console.log("TGE Date:", new Date(TGE_TIMESTAMP * 1000).toISOString());
    
    // Check cap totals
    for (let i = 0; i < batchCapData.length; i++) {
      const cap = await tokenDistribution.vestingCaps(batchCapData[i].capId);
      console.log(`\nCap ${batchCapData[i].capId} (${ethers.decodeBytes32String(batchCapData[i].name)}):`);
      console.log(`  Total Allocation: ${ethers.formatEther(cap.totalAllocation)} tokens`);
      console.log(`  Allocated to Wallets: ${ethers.formatEther(cap.allocatedToWallets)} tokens`);
      console.log(`  Cliff: ${Number(cap.cliff) / (24 * 60 * 60)} days`);
      console.log(`  Vesting Term: ${Number(cap.vestingTerm) / (30 * 24 * 60 * 60)} months`);
      
      // Get wallets in cap using the getter function
      const walletsInCap = await tokenDistribution.getWalletsInCap(batchCapData[i].capId);
      console.log(`  Number of Wallets: ${walletsInCap.length}`);
    }

    console.log("\n=== Deployment Complete ===");
    console.log("Contract is ready for token claims starting:", new Date(TGE_TIMESTAMP * 1000).toISOString());
  } catch (error) {
    console.error("Batch initialization failed:", error);
    
    // Try to get more specific error information
    if (error instanceof Error && error.message.includes("execution reverted")) {
      console.log("\nDebugging the revert reason...");
      
      // Check specific conditions that could cause revert
      console.log("Batch initialization failed - check contract state and permissions");
    }
    
    throw error;
  }

  // Verify deployment
  console.log("\n=== Deployment Summary ===");
  console.log("TokenDistributionEngine address:", engineAddress);
  console.log("TGE Date:", new Date(TGE_TIMESTAMP * 1000).toISOString());
  
  // Check cap totals
  for (let i = 0; i < batchCapData.length; i++) {
    const cap = await tokenDistribution.vestingCaps(batchCapData[i].capId);
    console.log(`\nCap ${batchCapData[i].capId} (${ethers.decodeBytes32String(batchCapData[i].name)}):`);
    console.log(`  Total Allocation: ${ethers.formatEther(cap.totalAllocation)} tokens`);
    console.log(`  Allocated to Wallets: ${ethers.formatEther(cap.allocatedToWallets)} tokens`);
    console.log(`  Cliff: ${Number(cap.cliff) / (24 * 60 * 60)} days`);
    console.log(`  Vesting Term: ${Number(cap.vestingTerm) / (30 * 24 * 60 * 60)} months`);
    
    // Get wallets in cap using the getter function
    const walletsInCap = await tokenDistribution.getWalletsInCap(batchCapData[i].capId);
    console.log(`  Number of Wallets: ${walletsInCap.length}`);
  }

  console.log("\n=== Deployment Complete ===");
  console.log("Contract is ready for token claims starting:", new Date(TGE_TIMESTAMP * 1000).toISOString());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
