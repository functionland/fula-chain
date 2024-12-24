import { multichain, web3 } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";

async function main(): Promise<void> {
    const [deployer] = await web3.eth.getAccounts();
    const tokenAddress = process.argv[2]?.split('=')[1];

    if (!tokenAddress) {
        throw new Error("Token address not provided. Use --tokenAddress=<address>");
    }

    const networkArguments: NetworkArguments = {
        sepolia: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [tokenAddress],
            },
        },
        amoy: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [tokenAddress],
            },
        }
    };

    const { transactionHash, domainIDs } = await multichain.deployMultichain(
        "StoragePool",
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

// yarn hardhat run scripts/deployPool.ts --network sepolia --tokenAddress=0x123... --show-stack-traces