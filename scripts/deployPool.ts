import { multichain, web3 } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";

async function main(): Promise<void> {
    const [deployer] = await web3.eth.getAccounts();
    const tokenAddress = process.env.TOKEN_ADDRESS?.trim();

    if (!tokenAddress) {
        throw new Error("TOKEN_ADDRESS environment variable not set");
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

// set TOKEN_ADDRESS=0x02b8492107b55941eccfd6d1e9c966210206b641 && yarn hardhat run scripts/deployPool.ts --network sepolia --show-stack-traces