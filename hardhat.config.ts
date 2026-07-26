import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-web3-v4";
import '@openzeppelin/hardhat-upgrades';
import "@nomicfoundation/hardhat-verify";
import "hardhat-contract-sizer";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    ],
    overrides: {
      "contracts/rewards/RewardsProgram.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      "contracts/rewards/RewardsExtension.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
      "contracts/rewards/RewardsStorageBase.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
      "contracts/core/FulaFileNFT.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 25,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      // StorageToken: lower runs to keep deployed bytecode under the EIP-170 24KB cap after
      // adding the LayerZero OFT mint/burn path and bridge-minter governance. Deliberately NOT
      // runs:1 like the contracts below — `transfer` is a hot, user-facing path and low runs
      // would raise gas for every holder. Measured deployed sizes (limit 24.000 KiB):
      //   runs=200 -> 24.041 (OVER)   runs=150 -> 23.955   runs=100 -> 23.905
      //   runs=50  -> 23.784          runs=1   -> 23.743
      // runs=100 keeps optimization high while leaving ~95 bytes of headroom. If a future change
      // overflows again, step down to 50 before considering 1.
      // Optimizer runs do NOT affect storage layout, so this is upgrade-safe.
      "contracts/core/StorageToken.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
      // RewardEngine: lower runs to keep deployed bytecode under the EIP-170
      // 24KB cap after wiring per-peer storage rewards + per-month cap. Reward-
      // claim path is user-triggered (not high-frequency), so the runtime-gas
      // tradeoff is acceptable. Same pattern as RewardsProgram / RewardsExtension above.
      "contracts/core/RewardEngine.sol": {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "shanghai",
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    },
  },
  sourcify: {
    enabled: true,
  },
  networks: {
    // Mainnets
    ethereum: {
      url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY || ""}`,
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 1,
      gasPrice: "auto",
      // Uncomment if you need higher gas limits (adjust as needed)
      // gas: 2100000,
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
      // Base can sometimes need higher gas estimates
      // gas: 3000000,
    },
    "base-alt": {
      url: "https://base.blockpi.network/v1/rpc/public",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
    },
    "base-alt2": {
      url: "https://base.llamarpc.com",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 8453,
      gasPrice: "auto",
      timeout: 60000,
    },
    "iotex-mainnet": {
      url: "https://babel-api.mainnet.iotex.io",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 4689,
      gasPrice: "auto",
    },
    skale: {
      url: "https://mainnet.skalenodes.com/v1/elated-tan-skat",
      accounts: (() => {
        const accounts = [];
        if (vars.has("PK")) accounts.push(vars.get("PK"));
        if (vars.has("ADMIN_PK")) accounts.push(vars.get("ADMIN_PK"));
        return accounts;
      })(),
      chainId: 2046399126,
    },

    // Testnets
    sepolia: {
      url: "https://ethereum-sepolia.publicnode.com",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 11155111,
    },
    "base-sepolia": {
      url: "https://sepolia.base.org",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 84532,
    },
    amoy: {
      url: "https://polygon-amoy-bor-rpc.publicnode.com",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 80002,
    },
    "iotex-testnet": {
      url: "https://babel-api.testnet.iotex.io",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 4690,
    },
    "skale-testnet": {
      url: "https://testnet.skalenodes.com/v1/juicy-low-small-testnet",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 1444673419,
    },
    "sfi-testnet": {
      url: "https://rpc-testnet.singularityfinance.ai",
      accounts: vars.has("PK") ? [vars.get("PK")] : [],
      chainId: 751,
    },
    hardhat: {
      allowUnlimitedContractSize: true,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
     //Activate for skale and iotex verify  and deactivate for base and ethereum verification
    /*apiKey: {
      mainnet: vars.has("ETHERSCAN_API_KEY")
        ? vars.get("ETHERSCAN_API_KEY")
        : "",
      sepolia: vars.has("ETHERSCAN_API_KEY")
        ? vars.get("ETHERSCAN_API_KEY")
        : "",
      base: vars.has("BASESCAN_API_KEY") ? vars.get("BASESCAN_API_KEY") : "",
      "base-sepolia": vars.has("BASESCAN_API_KEY")
        ? vars.get("BASESCAN_API_KEY")
        : "",
      "iotex-mainnet": vars.has("IOTEXSCAN_API_KEY")
        ? vars.get("IOTEXSCAN_API_KEY")
        : "arbitrary",
      "skale": 'empty',
      "iotex-testnet": vars.has("IOTEXSCAN_API_KEY")
        ? vars.get("IOTEXSCAN_API_KEY")
        : "arbitrary",
      "skale-testnet": vars.has("SKALESCAN_API_KEY")
        ? vars.get("SKALESCAN_API_KEY")
        : "arbitrary",
    },*/
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "iotex-mainnet",
        chainId: 4689,
        urls: {
          apiURL: "https://iotexscout.io/api",
          browserURL: "https://iotexscan.io",
        },
      },
      {
        network: "skale",
        chainId: 2046399126,
        urls: {
          apiURL: "https://internal-hubs.explorer.mainnet.skalenodes.com:10021/api",
          browserURL: "https://internal-hubs.explorer.mainnet.skalenodes.com",
        },
      },
      {
        network: "skale-testnet",
        chainId: 1444673419,
        urls: {
          apiURL:
            "https://juicy-low-small-testnet.explorer.testnet.skalenodes.com/api",
          browserURL: "https://europa-explorer.testnet.skalenodes.com",
        },
      },
    ],
    
  },
  mocha: {
    timeout: 40000,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
    excludeContracts: ["contracts/mocks/"],
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
    strict: true,
  },
};

export default config;
