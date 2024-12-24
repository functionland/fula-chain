import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@chainsafe/hardhat-ts-artifact-plugin";
import "@nomicfoundation/hardhat-web3-v4";
import "@chainsafe/hardhat-plugin-multichain-deploy";
import { Environment } from "@buildwithsygma/sygma-sdk-core";

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.19",  // Updated from 0.8.20
        settings: {
            optimizer: {
                enabled: true,
                runs: 200
            }
        }
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
        iotex: {
            url: "https://babel-api.testnet.iotex.io",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 4690
        },
        skale: {
            url: "https://testnet.skalenodes.com/v1/giant-half-dual-testnet",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 974399131
        }
    },
    multichain: {
        environment: Environment.TESTNET
    }
};

export default config;
