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
                runs: 500
            },
            viaIR: true
        }
    },
    sourcify: {
        enabled: true
    },
    networks: {
        sepolia: {
            url: "https://ethereum-sepolia.publicnode.com",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 11155111
        },
        "base-sepolia": {
            url: "https://sepolia.base.org",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 84532
        },
        amoy: {
            url: "https://polygon-amoy-bor-rpc.publicnode.com",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 80002
        },
        "iotex-testnet": {
            url: "https://babel-api.testnet.iotex.io",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 4690
        },
        "skale-testnet": {
            url: "https://testnet.skalenodes.com/v1/giant-half-dual-testnet",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 974399131
        },
        "sfi-testnet": {
            url: "https://rpc-testnet.singularityfinance.ai",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 751
        },
        localhost: {
            url: "http://127.0.0.1:3000",
            chainId: 31337
        }
    },
    etherscan: {
        apiKey: vars.has("ETHERSCAN_API_KEY") ? vars.get("ETHERSCAN_API_KEY") : "",
        customChains: [
            {
              network: "iotex-mainnet",
              chainId: 4689,
              urls: {
                apiURL: "https://iotexscout.io/api",
                browserURL: "https://iotexscan.io"
              }
            },
            {
              network: "iotext-testnet",
              chainId: 4690,
              urls: {
                apiURL: "https://testnet.iotexscout.io/api",
                browserURL: "https://testnet.iotexscan.io"
              }
            }
        ]
    },
    mocha: {
        timeout: 40000
    },
    gasReporter: {
        enabled: process.env.REPORT_GAS !== undefined,
        currency: "USD",
        excludeContracts: ["contracts/mocks/"]
    },
    contractSizer: {
        alphaSort: true,
        runOnCompile: true,
        disambiguatePaths: false,
        strict: true
    }
};

export default config;
