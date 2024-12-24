import { multichain } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";
import tokenArtifact from "../artifacts/contracts/StorageToken.sol/StorageToken.json";
import poolArtifact from "../artifacts/contracts/StoragePool.sol/StoragePool.json";

async function main(): Promise<void> {
    // Deploy StorageToken
    const tokenNetworkArguments: NetworkArguments = {
        sepolia: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: ["Test Token", "TT"],
            },
        },
        amoy: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: ["Test Token", "TT"],
            },
        },
        holesky: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: ["Test Token", "TT"],
            },
        }
    };

    const tokenDeployment = await multichain.deployMultichainBytecode(
        tokenArtifact.bytecode,
        tokenArtifact.abi,
        tokenNetworkArguments
    );

    await multichain.getDeploymentInfo(tokenDeployment.transactionHash, tokenDeployment.domainIDs);

    // Deploy StoragePool
    const poolNetworkArguments: NetworkArguments = {
        sepolia: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [],
            },
        },
        amoy: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [],
            },
        },
        holesky: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [],
            },
        }
    };

    const poolDeployment = await multichain.deployMultichainBytecode(
        poolArtifact.bytecode,
        poolArtifact.abi,
        poolNetworkArguments
    );

    await multichain.getDeploymentInfo(poolDeployment.transactionHash, poolDeployment.domainIDs);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
