import { multichain } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";

async function main(): Promise<void> {
    const networkArguments: NetworkArguments = {
        sepolia: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [],
            },
        },
        "base-sepolia": {
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
        }
    };

    const { transactionHash, domainIDs } = await multichain.deployMultichain(
        "StorageToken",
        networkArguments
    );

    await multichain.getDeploymentInfo(transactionHash, domainIDs);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
