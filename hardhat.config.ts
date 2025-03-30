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
                runs: 300
            },
            viaIR: true,
            evmVersion: "shanghai"
        }
    },
    sourcify: {
        enabled: true
    },
    networks: {
        // Mainnets
        ethereum: {
            url: "https://eth-mainnet.g.alchemy.com/v2/_LnQrpSkygkgsX96sfS_fMl78FeAHnhw",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 1,
            gasPrice: "auto",
            // Uncomment if you need higher gas limits (adjust as needed)
            // gas: 2100000,
        },
        base: {
            url: "https://base-mainnet.g.alchemy.com/v2/_LnQrpSkygkgsX96sfS_fMl78FeAHnhw",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 8453,
            gasPrice: "auto",
            // Base can sometimes need higher gas estimates
            // gas: 3000000,
        },
        "iotex-mainnet": {
            url: "https://babel-api.mainnet.iotex.io",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 4689,
            gasPrice: "auto",
        },
        "skale": {
            url: "https://mainnet.skalenodes.com/v1/elated-tan-skat",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 2046399126
        },
        
        // Testnets
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
            url: "https://testnet.skalenodes.com/v1/juicy-low-small-testnet",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 1444673419
        },
        "sfi-testnet": {
            url: "https://rpc-testnet.singularityfinance.ai",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 751
        },
        localhost: {
            url: "http://127.0.0.1:8545",
            chainId: 31337
        }
    },
    etherscan: {
        apiKey: {
            mainnet: vars.has("ETHERSCAN_API_KEY") ? vars.get("ETHERSCAN_API_KEY") : "",
            sepolia: vars.has("ETHERSCAN_API_KEY") ? vars.get("ETHERSCAN_API_KEY") : "",
            base: vars.has("BASESCAN_API_KEY") ? vars.get("BASESCAN_API_KEY") : "",
            "base-sepolia": vars.has("BASESCAN_API_KEY") ? vars.get("BASESCAN_API_KEY") : "",
            "iotex-mainnet": vars.has("IOTEXSCAN_API_KEY") ? vars.get("IOTEXSCAN_API_KEY") : "arbitrary",
            "skale": vars.has("SKALESCAN_API_KEY") ? vars.get("SKALESCAN_API_KEY") : "arbitrary",
            "iotex-testnet": vars.has("IOTEXSCAN_API_KEY") ? vars.get("IOTEXSCAN_API_KEY") : "arbitrary",
            "skale-testnet": vars.has("SKALESCAN_API_KEY") ? vars.get("SKALESCAN_API_KEY") : "arbitrary",
        },
        customChains: [
            {
                network: "base",
                chainId: 8453,
                urls: {
                  apiURL: "https://api.basescan.org/api",
                  browserURL: "https://basescan.org"
                }
            },
            {
                network: "base-sepolia",
                chainId: 84532,
                urls: {
                  apiURL: "https://api-sepolia.basescan.org/api",
                  browserURL: "https://sepolia.basescan.org"
                }
            },
            {
              network: "iotex-mainnet",
              chainId: 4689,
              urls: {
                apiURL: "https://iotexscout.io/api",
                browserURL: "https://iotexscan.io"
              }
            },
            {
                network: "skale",
                chainId: 2046399126,
                urls: {
                    apiURL: "https://elated-tan-skat.explorer.mainnet.skalenodes.com/api",
                    browserURL: "https://elated-tan-skat.explorer.mainnet.skalenodes.com"
                }
            },
            {
                network: "skale-testnet",
                chainId: 1444673419,
                urls: {
                    apiURL: "https://juicy-low-small-testnet.explorer.testnet.skalenodes.com/api",
                    browserURL: "https://europa-explorer.testnet.skalenodes.com"
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
