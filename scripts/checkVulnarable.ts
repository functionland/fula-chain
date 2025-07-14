import { ethers, upgrades } from "hardhat";

/**
 * Comprehensive UUPS Implementation Vulnerability Checker and Fixer
 *
 * This script checks for and fixes the vulnerability where UUPS implementation
 * contracts are left uninitialized, allowing attackers to gain control.
 *
 * Supports all UUPS contracts in the codebase:
 * - StorageToken
 * - StakingPool
 * - StoragePool
 * - StakingEngineLinear
 * - TokenBridge
 * - StorageProof
 */

interface ContractConfig {
    name: string;
    initFunction: string;
    dummyParams: any[];
}

// Configuration for each contract type with safe dummy parameters
const CONTRACT_CONFIGS: Record<string, ContractConfig> = {
    "StorageToken": {
        name: "StorageToken",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD", // initialAdmin
            ethers.parseEther("0") // initialMintedTokens (0 = safe)
        ]
    },
    "StakingPool": {
        name: "StakingPool",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _token
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    },
    "StoragePool": {
        name: "StoragePool",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _storageToken
            "0x000000000000000000000000000000000000dEaD", // _tokenPool
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    },
    "StakingEngineLinear": {
        name: "StakingEngineLinear",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _token
            "0x000000000000000000000000000000000000dEaD", // _stakePool
            "0x000000000000000000000000000000000000dEaD", // _rewardPool
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    },
    "TokenBridge": {
        name: "TokenBridge",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _token
            1, // _chainId
            ethers.parseEther("0"), // _dailyLimit (0 = safe)
            "0x000000000000000000000000000000000000dEaD", // _initialOwner
            "0x000000000000000000000000000000000000dEaD", // _initialAdmin
            [] // _initialOperators (empty array = safe)
        ]
    },
    "StorageProof": {
        name: "StorageProof",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _token
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // _rewardEngine
        ]
    },
    "TestnetMiningRewards": {
        name: "TestnetMiningRewards",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _storageToken
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    },
    "AirdropContract": {
        name: "AirdropContract",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _storageToken
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    },
    "TokenDistributionEngine": {
        name: "TokenDistributionEngine",
        initFunction: "initialize",
        dummyParams: [
            "0x000000000000000000000000000000000000dEaD", // _storageToken
            "0x000000000000000000000000000000000000dEaD", // initialOwner
            "0x000000000000000000000000000000000000dEaD"  // initialAdmin
        ]
    }
};

async function checkImplementationVulnerability(
    proxyAddress: string,
    contractType: string
): Promise<{ isVulnerable: boolean; implementationAddress: string }> {
    try {
        console.log(`\n🔍 Checking ${contractType} proxy at: ${proxyAddress}`);

        // Get implementation address
        const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
        console.log(`📍 Implementation address: ${implementationAddress}`);

        // Get contract instance
        const config = CONTRACT_CONFIGS[contractType];
        if (!config) {
            throw new Error(`Unsupported contract type: ${contractType}`);
        }

        const impl = await ethers.getContractAt(config.name, implementationAddress);

        // Strategy 1: Try to call initialize - if it succeeds, the implementation is vulnerable
        try {
            // Estimate gas first to see if the call would succeed
            await impl[config.initFunction].staticCall(...config.dummyParams);
            console.log(`⚠️  VULNERABLE: Implementation can still be initialized!`);
            return { isVulnerable: true, implementationAddress };
        } catch (error: any) {
            if (error.message.includes("Initializable: contract is already initialized") ||
                error.message.includes("InvalidInitialization") ||
                error.message.includes("already initialized")) {
                console.log(`✅ SAFE: Implementation is already initialized`);
                return { isVulnerable: false, implementationAddress };
            } else {
                console.log(`❓ Unknown error, checking adminCount: ${error.message.substring(0, 100)}...`);

                // Strategy 2: Check adminCount - if 0, likely uninitialized and vulnerable
                try {
                    const adminCount = await impl.adminCount();
                    if (Number(adminCount) === 0) {
                        console.log(`⚠️  VULNERABLE: adminCount is 0, implementation appears uninitialized!`);
                        return { isVulnerable: true, implementationAddress };
                    } else {
                        console.log(`✅ SAFE: adminCount is ${adminCount}, implementation appears initialized`);
                        return { isVulnerable: false, implementationAddress };
                    }
                } catch (adminError: any) {
                    console.log(`❌ Could not check adminCount: ${adminError.message.substring(0, 50)}...`);
                    console.log(`⚠️  ASSUMING VULNERABLE due to inability to verify safety`);
                    return { isVulnerable: true, implementationAddress };
                }
            }
        }
    } catch (error) {
        console.error(`❌ Error checking ${contractType}:`, error);
        throw error;
    }
}

async function fixImplementationVulnerability(
    implementationAddress: string,
    contractType: string
): Promise<boolean> {
    try {
        console.log(`\n🔧 Fixing ${contractType} implementation at: ${implementationAddress}`);

        const config = CONTRACT_CONFIGS[contractType];
        const impl = await ethers.getContractAt(config.name, implementationAddress);

        console.log(`📝 Calling ${config.initFunction} with dummy parameters...`);
        console.log(`   Parameters:`, config.dummyParams);

        // Call initialize with dummy parameters
        const tx = await impl[config.initFunction](...config.dummyParams);
        await tx.wait();

        console.log(`✅ Implementation successfully initialized with dummy values`);
        console.log(`   Transaction hash: ${tx.hash}`);
        return true;
    } catch (error: any) {
        if (error.message.includes("Initializable: contract is already initialized") ||
            error.message.includes("InvalidInitialization") ||
            error.message.includes("already initialized")) {
            console.log(`✅ Implementation was already initialized (safe)`);
            return true;
        } else {
            console.error(`❌ Failed to fix implementation:`, error.message);
            return false;
        }
    }
}

async function listContractAdmins(contractAddress: string, contractType: string): Promise<{count: number, admins: string[]}> {
    try {
        const config = CONTRACT_CONFIGS[contractType];
        if (!config) {
            console.log(`❌ Unsupported contract type: ${contractType}`);
            return {count: 0, admins: []};
        }

        // Get contract instance
        const contract = await ethers.getContractAt(config.name, contractAddress);

        // ADMIN_ROLE constant from ProposalTypes.sol
        const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

        // Get admin count from the contract (manually tracked in GovernanceModule)
        const adminCount = await contract.adminCount();
        console.log(`📊 ${contractType} has ${adminCount} admin(s)`);

        // Since AccessControlUpgradeable doesn't have enumeration, we can't list all admins
        // But we can check specific addresses if provided
        const knownAddresses = [
            "0x383a6A34C623C02dcf9BB7069FAE4482967fb713", // Initial owner from your deployments
            "0xFa8b02596a84F3b81B4144eA2F30482f8C33D446", // Initial admin from your deployments
            // Add more known addresses here if needed
        ];

        const confirmedAdmins: string[] = [];

        // Check known addresses
        for (const address of knownAddresses) {
            try {
                const hasRole = await contract.hasRole(ADMIN_ROLE, address);
                if (hasRole) {
                    confirmedAdmins.push(address);
                    console.log(`✅ Confirmed admin: ${address}`);
                }
            } catch (error) {
                // Skip if error checking this address
            }
        }

        return {
            count: Number(adminCount),
            admins: confirmedAdmins
        };
    } catch (error: any) {
        console.log(`❌ Error listing admins for ${contractType}:`, error.message);
        return {count: 0, admins: []};
    }
}

async function main() {
    console.log("🛡️  UUPS Implementation Vulnerability Checker & Fixer");
    console.log("=" .repeat(60));

    // Contract addresses to check - update these with your deployed addresses
    const contractsToCheck = [
      // Example addresses - replace with your actual deployed contract addresses
      {
        address: "0x2e757c35680756cdF8e6AE3f8a346D12b4e3773D",
        type: "StoragePool",
      },
      {
        address: "0xD8be67B0f4783aa85Ada89863449b9Bc5D79460b",
        type: "StakingPool",
      },
      { 
        address: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB", 
        type: "StorageToken" 
      },
      // { address: "0x...", type: "StakingEngineLinear" },
      // { address: "0x...", type: "TokenBridge" },
      // { address: "0x...", type: "StorageProof" },

      // New contracts - uncomment and use your actual addresses:
      { address: "0x1Def7229f6d6Ca5fbA4f9e28Cd1cf4e2688e545d", type: "TestnetMiningRewards" },
      { address: "0x0AF8Bf19C18a3c7352f831cf950CA8971202e4Be", type: "AirdropContract" },
      { address: "0x0C85A8E992E3Eb04A22027F7E0BC53392A331aC8", type: "TokenDistributionEngine" },
    ];

    // If no contracts specified, show usage
    if (contractsToCheck.length === 0) {
        console.log("📋 Usage: Update the contractsToCheck array with your deployed contract addresses");
        console.log("\nExample:");
        console.log('{ address: "0x2e757c35680756cdF8e6AE3f8a346D12b4e3773D", type: "StoragePool" },');
        console.log("\nSupported contract types:");
        Object.keys(CONTRACT_CONFIGS).forEach(type => {
            console.log(`  - ${type}`);
        });
        console.log("\nExample addresses from your deployments:");
        console.log("  - TestnetMiningRewards: 0x1Def7229f6d6Ca5fbA4f9e28Cd1cf4e2688e545d");
        console.log("  - AirdropContract: 0x0AF8Bf19C18a3c7352f831cf950CA8971202e4Be");
        console.log("  - TokenDistributionEngine: 0x0C85A8E992E3Eb04A22027F7E0BC53392A331aC8");
        return;
    }

    let vulnerableCount = 0;
    let fixedCount = 0;
    const results: Array<{
        address: string,
        type: string,
        vulnerable: boolean,
        fixed?: boolean,
        implementationAddress?: string,
        adminCount?: number,
        admins?: string[]
    }> = [];

    // Check each contract
    for (const contract of contractsToCheck) {
        try {
            const result = await checkImplementationVulnerability(contract.address, contract.type);

            // Get admin list for this contract
            const adminInfo = await listContractAdmins(contract.address, contract.type);

            const contractResult = {
                address: contract.address,
                type: contract.type,
                vulnerable: result.isVulnerable,
                fixed: false,
                implementationAddress: result.implementationAddress,
                adminCount: adminInfo.count,
                admins: adminInfo.admins
            };

            if (result.isVulnerable) {
                vulnerableCount++;

                // Ask user if they want to fix it
                console.log(`\n❓ Do you want to fix this vulnerability? (y/n)`);
                // For automated scripts, you might want to auto-fix:
                const shouldFix = true; // Change to false if you want manual confirmation

                if (shouldFix) {
                    const fixed = await fixImplementationVulnerability(
                        result.implementationAddress,
                        contract.type
                    );
                    contractResult.fixed = fixed;
                    if (fixed) fixedCount++;
                }
            }

            results.push(contractResult);

        } catch (error) {
            console.error(`❌ Failed to process ${contract.type} at ${contract.address}:`, error);
            results.push({
                address: contract.address,
                type: contract.type,
                vulnerable: false,
                fixed: false,
                adminCount: 0,
                admins: []
            });
        }
    }

    // Summary
    console.log("\n" + "=" .repeat(60));
    console.log("📊 SUMMARY");
    console.log("=" .repeat(60));
    console.log(`Total contracts checked: ${contractsToCheck.length}`);
    console.log(`Vulnerable implementations found: ${vulnerableCount}`);
    console.log(`Implementations fixed: ${fixedCount}`);

    if (vulnerableCount === 0) {
        console.log("\n🎉 All implementations are secure!");
    } else if (fixedCount === vulnerableCount) {
        console.log("\n✅ All vulnerabilities have been fixed!");
    } else {
        console.log(`\n⚠️  ${vulnerableCount - fixedCount} vulnerabilities remain unfixed`);
    }

    // Detailed results
    console.log("\n📋 DETAILED RESULTS:");
    results.forEach((result, index) => {
        const status = result.vulnerable
            ? (result.fixed ? "🔒 FIXED" : "⚠️  VULNERABLE")
            : "✅ SECURE";
        console.log(`${index + 1}. ${result.type} (${result.address}): ${status}`);
    });

    // Admin listing section
    console.log("\n" + "=".repeat(60));
    console.log("👥 CONTRACT ADMINS");
    console.log("=".repeat(60));

    results.forEach((result, index) => {
        console.log(`\n${index + 1}. ${result.type} (${result.address}):`);

        // Show admin count from contract
        if (result.adminCount !== undefined) {
            console.log(`   📊 Total Admin Count: ${result.adminCount}`);
        }

        // Show confirmed admins
        if (result.admins && result.admins.length > 0) {
            console.log(`   ✅ Confirmed Admins (${result.admins.length}):`);
            result.admins.forEach((admin, adminIndex) => {
                console.log(`   👤 Admin ${adminIndex + 1}: ${admin}`);
            });

            // Show if there are more admins than we could identify
            if (result.adminCount && result.admins.length < result.adminCount) {
                const unidentified = result.adminCount - result.admins.length;
                console.log(`   ❓ ${unidentified} additional admin(s) not identified (AccessControl doesn't support enumeration)`);
            }
        } else {
            console.log(`   ❌ No admins confirmed (check known addresses or use block explorer)`);
        }

        if (result.implementationAddress) {
            console.log(`   🔧 Implementation: ${result.implementationAddress}`);
        }
    });
}

// Example usage for specific contracts
async function checkSpecificContract() {
    // Example: Check a specific StoragePool contract
    const tokenProxyAddress = '0x2e757c35680756cdF8e6AE3f8a346D12b4e3773D';

    const result = await checkImplementationVulnerability(tokenProxyAddress, "StoragePool");

    if (result.isVulnerable) {
        await fixImplementationVulnerability(result.implementationAddress, "StoragePool");
    }
}

// Utility function to check all contracts from environment variables
async function checkFromEnvironment() {
    console.log("🌍 Checking contracts from environment variables...");

    const contractsToCheck = [];

    // Check for common environment variable patterns
    const envVars = [
        { env: "STORAGE_TOKEN_ADDRESS", type: "StorageToken" },
        { env: "STAKING_POOL_ADDRESS", type: "StakingPool" },
        { env: "STORAGE_POOL_ADDRESS", type: "StoragePool" },
        { env: "STAKING_ENGINE_ADDRESS", type: "StakingEngineLinear" },
        { env: "TOKEN_BRIDGE_ADDRESS", type: "TokenBridge" },
        { env: "STORAGE_PROOF_ADDRESS", type: "StorageProof" },
        { env: "TESTNET_MINING_ADDRESS", type: "TestnetMiningRewards" },
        { env: "AIRDROP_CONTRACT_ADDRESS", type: "AirdropContract" },
        { env: "DISTRIBUTION_ENGINE_ADDRESS", type: "TokenDistributionEngine" },
    ];

    for (const { env, type } of envVars) {
        const address = process.env[env]?.trim();
        if (address && address !== "") {
            contractsToCheck.push({ address, type });
            console.log(`📍 Found ${type}: ${address}`);
        }
    }

    if (contractsToCheck.length === 0) {
        console.log("❌ No contract addresses found in environment variables");
        console.log("Set environment variables like STORAGE_TOKEN_ADDRESS, STAKING_POOL_ADDRESS, etc.");
        return;
    }

    // Process the contracts
    for (const contract of contractsToCheck) {
        try {
            const result = await checkImplementationVulnerability(contract.address, contract.type);

            if (result.isVulnerable) {
                console.log(`\n🔧 Auto-fixing ${contract.type} implementation...`);
                await fixImplementationVulnerability(result.implementationAddress, contract.type);
            }
        } catch (error) {
            console.error(`❌ Error processing ${contract.type}:`, error);
        }
    }
}

// Export functions for use in other scripts
export {
    checkImplementationVulnerability,
    fixImplementationVulnerability,
    listContractAdmins,
    CONTRACT_CONFIGS
};

// Run the main function
if (require.main === module) {
    // Check if we should use environment variables
    const useEnv = process.argv.includes("--env");

    if (useEnv) {
        checkFromEnvironment()
            .then(() => process.exit(0))
            .catch((error) => {
                console.error(error);
                process.exit(1);
            });
    } else {
        main()
            .then(() => process.exit(0))
            .catch((error) => {
                console.error(error);
                process.exit(1);
            });
    }
}
