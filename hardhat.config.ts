import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-web3-v4";
import '@openzeppelin/hardhat-upgrades';
import "@nomicfoundation/hardhat-verify";
import "hardhat-contract-sizer";

const config: HardhatUserConfig = {
  solidity: {
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
          "*": ["storageLayout"], // 👈 this line is key
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
      url: "https://eth-mainnet.g.alchemy.com/v2/_LnQrpSkygkgsX96sfS_fMl78FeAHnhw",
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
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
  etherscan: {
    apiKey: "JGD6ENM6P2G5XUS4VSCJJYGXR3RXCG2TEN",
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
