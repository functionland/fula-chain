import { HardhatUserConfig, vars } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-web3-v4";
import '@openzeppelin/hardhat-upgrades';

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.24",
        settings: {
            optimizer: {
                enabled: true,
                runs: 100
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
    }
};

export default config;
