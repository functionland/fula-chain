import { multichain, web3 } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";

async function main(): Promise<void> {
    const [deployer] = await web3.eth.getAccounts();

    const networkArguments: NetworkArguments = {
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
        }
    };

    const { transactionHash, domainIDs } = await multichain.deployMultichain(
        "StorageToken",
        networkArguments,
        {
            customNonPayableTxOptions: {
                from: deployer
            }
        }
    );

    await multichain.getDeploymentInfo(transactionHash, domainIDs);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// yarn hardhat run scripts/deployToken.ts --network sepolia --show-stack-traces