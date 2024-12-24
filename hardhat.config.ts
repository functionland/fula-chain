import { HardhatUserConfig } from "hardhat/config";
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
            chainId: 11155111,
            gas: 199170,
            gasPrice: "auto"
        },
        "base-sepolia": {
            url: "https://sepolia.base.org",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 84532
        },
        amoy: {
            url: "https://amoy.infura.io/v3/YOUR-PROJECT-ID",
            accounts: vars.has("PK") ? [vars.get("PK")] : [],
            chainId: 80002
        }
    },
    multichain: {
        environment: Environment.TESTNET
    }
};

export default config;
