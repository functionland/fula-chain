// This script ensures that for all deployed proxy  contracts
// the admin address is 0x00
// the implementation is the expected implementation to detect front running

import { ethers, network } from "hardhat";

interface ContractInfo {
  name: string;
  proxy: string;
  expectedImplementation: string;
}

async function main() {
  // ERC1967 storage slots
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const adminSlot = "0xb53127684a568b3173ae13b9f8a6016e01a42b6a20e6f9e3c2ee9f35ab414d55";
  const zeroAddress = "0x0000000000000000000000000000000000000000";

  // Detect network and get appropriate contract addresses
  const networkName = network.name;
  console.log(`🌐 Detected network: ${networkName}\n`);

  let contracts: ContractInfo[];

  if (networkName === "base") {
    // BASE CHAIN CONTRACTS
    contracts = [
      {
        name: "StorageToken",
        proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
        expectedImplementation: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
      },
      {
        name: "TokenDistributionEngine",
        proxy: "0x0C85A8E992E3Eb04A22027F7E0BC53392A331aC8",
        expectedImplementation: "0x74d5409cB179998C8eF8c74e471CB8aE447d8CF0",
      },
      {
        name: "AirdropContract",
        proxy: "0x0AF8Bf19C18a3c7352f831cf950CA8971202e4Be",
        expectedImplementation: "0x0E870C8c51e9B457C40fFb3ad22AeD1f30fD0088",
      },
      {
        name: "TestnetMiningRewards",
        proxy: "0x1Def7229f6d6Ca5fbA4f9e28Cd1cf4e2688e545d",
        expectedImplementation: "0xdc1bB05397CAC751fA353bb39805A6B16cB08119",
      },
      {
        name: "StakingEngineLinear",
        proxy: "0x32A2b049b1E7A6c8C26284DE49e7F05A00466a5d",
        expectedImplementation: "0xC31db852C347322440f9027A5D65d8FD39B18C46",
      },
      {
        name: "StakePool (StakingLinear)",
        proxy: "0xfa9cb36656cf9A2D2BA3a6b0aD810fB9993F7A21",
        expectedImplementation: "0x860793bb966511d8Ddfb03a0598A1E5b3a83225f",
      },
      {
        name: "RewardPool (StakingLinear)",
        proxy: "0xDB2ab8De23eb8dd6cd12127673be9ae6Ae6edd9A",
        expectedImplementation: "0x860793bb966511d8Ddfb03a0598A1E5b3a83225f",
      },
      {
        name: "StakingPool (StoragePool)",
        proxy: "0x4d44aF4d59b276FD1228FE36552e940A03e78030",
        expectedImplementation: "0xa3FB8C0c90F54B167c463E9927E69a7D5b8eD4be",
      },
      {
        name: "StoragePool",
        proxy: "0xf293A6902662DcB09E310254A5e418cb28D71b6b",
        expectedImplementation: "0xf4355A5871762648a751546b163ee598A3381223",
      },
      {
        name: "StakingPool (RewardEngine)",
        proxy: "0x2374122915c4802a855c44468c01a5ff6eaE4Bc1",
        expectedImplementation: "0xa3FB8C0c90F54B167c463E9927E69a7D5b8eD4be",
      },
      {
        name: "RewardEngine",
        proxy: "0xB934cc71987a4369a046E9514FD47800C8c1A7d4",
        expectedImplementation: "0x5F3758869FAfE43A466bd66338EC3C132DC622eA",
      },
    ];
  } else if (networkName === "skale") {
    // SKALE CHAIN CONTRACTS
    contracts = [
      {
        name: "StorageToken",
        proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
        expectedImplementation: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
      },
      {
        name: "TestnetMiningRewards",
        proxy: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
        expectedImplementation: "0x74d5409cB179998C8eF8c74e471CB8aE447d8CF0",
      },
      {
        name: "StakingEngineLinear",
        proxy: "0xA002a09Fb3b9E8ac930B72C61De6F3979335bFa2",
        expectedImplementation: "0xf78670e48DCE9B133F2Bd2D43dbE577Abc18e9A1",
      },
      {
        name: "StakePool (StakingLinear)",
        proxy: "0x4337124896C11534E3De99da8ff0E4fE22465743",
        expectedImplementation: "0xb2A51311aAC9aDAe8F9785129c988539b1510c2d",
      },
      {
        name: "RewardPool (StakingLinear)",
        proxy: "0x9f0815CeDdd2f4E8Be37D09d95Fbfe0EFE57f0B9",
        expectedImplementation: "0xb2A51311aAC9aDAe8F9785129c988539b1510c2d",
      },
      {
        name: "StakingPool (StoragePool)",
        proxy: "0x4d44aF4d59b276FD1228FE36552e940A03e78030",
        expectedImplementation: "0xa3FB8C0c90F54B167c463E9927E69a7D5b8eD4be",
      },
      {
        name: "StoragePool",
        proxy: "0xf293A6902662DcB09E310254A5e418cb28D71b6b",
        expectedImplementation: "0xf4355A5871762648a751546b163ee598A3381223",
      },
      {
        name: "StakingPool (RewardEngine)",
        proxy: "0x2374122915c4802a855c44468c01a5ff6eaE4Bc1",
        expectedImplementation: "0xa3FB8C0c90F54B167c463E9927E69a7D5b8eD4be",
      },
      {
        name: "RewardEngine",
        proxy: "0xB934cc71987a4369a046E9514FD47800C8c1A7d4",
        expectedImplementation: "0x5F3758869FAfE43A466bd66338EC3C132DC622eA",
      },
    ];
  } else if (networkName === "iotex-mainnet") {
    // IOTEX MAINNET CONTRACTS
    contracts = [
      {
        name: "StorageToken",
        proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
        expectedImplementation: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb"
      },
      {
        name: "AirdropContract",
        proxy: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
        expectedImplementation: "0x2AB5988bAAbf0052333c1575C1Fef11F58AF640E"
      },
      {
        name: "StakingEngineLinear",
        proxy: "0xfe3574Fc1CC7c389fd916e891A497A4D986a8268",
        expectedImplementation: "0x9421bdf7529594A9Ad25A2b17EEE3B0a73F6c94c"
      },
      {
        name: "StakePool (StakingLinear)",
        proxy: "0xe6396c9A97D0abADF0EaaA59CAdB83F1f6DF686C",
        expectedImplementation: "0xE029433E329b32381CDeEDF3bB7F6435517519D1"
      },
      {
        name: "RewardPool (StakingLinear)",
        proxy: "0x506500211De270Fa181c26c50593110fc54e53D6",
        expectedImplementation: "0xE029433E329b32381CDeEDF3bB7F6435517519D1"
      }
    ];
  } else if (networkName === "ethereum") {
    // ETHEREUM MAINNET CONTRACTS
    contracts = [
      {
        name: "StorageToken",
        proxy: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
        expectedImplementation: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB"
      },
      {
        name: "TokenDistributionEngine",
        proxy: "0x1961d9869c8Cf8F724CC2DEA49BdAc60Bb7B6072",
        expectedImplementation: "0x26a1113772F8340A06158229FA0cd1db43fFeaa1"
      }
    ];
  } else {
    console.log(`❌ Unsupported network: ${networkName}`);
    console.log("Supported networks: base, skale, iotex-mainnet, ethereum");
    process.exit(1);
  }

  console.log("🔍 Checking proxy storage for all contracts...\n");

  let hasInconsistencies = false;

  for (const contract of contracts) {
    console.log(`📋 Checking ${contract.name}:`);
    console.log(`   Proxy: ${contract.proxy}`);

    try {
      // Get implementation address from storage
      const implRaw = await ethers.provider.send("eth_getStorageAt", [
        contract.proxy,
        implSlot,
        "latest",
      ]);

      // Get admin address from storage
      const adminRaw = await ethers.provider.send("eth_getStorageAt", [
        contract.proxy,
        adminSlot,
        "latest",
      ]);

      const actualImpl = ethers.getAddress("0x" + implRaw.slice(26));
      const actualAdmin = ethers.getAddress("0x" + adminRaw.slice(26));

      // Check implementation
      const implMatch = actualImpl.toLowerCase() === contract.expectedImplementation.toLowerCase();
      console.log(`   Implementation: ${actualImpl} ${implMatch ? "✅" : "❌"}`);
      if (!implMatch) {
        console.log(`   Expected: ${contract.expectedImplementation}`);
        hasInconsistencies = true;
      }

      // Check admin (should be zero address)
      const adminIsZero = actualAdmin.toLowerCase() === zeroAddress.toLowerCase();
      console.log(`   Admin: ${actualAdmin} ${adminIsZero ? "✅" : "❌"}`);
      if (!adminIsZero) {
        console.log(`   Expected: ${zeroAddress} (zero address)`);
        hasInconsistencies = true;
      }

    } catch (error) {
      console.log(`   ❌ Error checking contract: ${error}`);
      hasInconsistencies = true;
    }

    console.log(); // Empty line for readability
  }

  // Summary
  console.log("=" .repeat(60));
  if (hasInconsistencies) {
    console.log("❌ INCONSISTENCIES FOUND! Please review the issues above.");
    process.exit(1);
  } else {
    console.log("✅ ALL CONTRACTS VERIFIED SUCCESSFULLY!");
    console.log("   - All implementations match expected addresses");
    console.log("   - All admin addresses are set to zero address");
  }
}

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});

// npx hardhat run scripts/checkProxyStorage.ts --network base
// npx hardhat run scripts/checkProxyStorage.ts --network skale
// npx hardhat run scripts/checkProxyStorage.ts --network iotex-mainnet
// npx hardhat run scripts/checkProxyStorage.ts --network ethereum