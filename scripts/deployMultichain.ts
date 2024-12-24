import { multichain, web3 } from "hardhat";
import { NetworkArguments } from "@chainsafe/hardhat-plugin-multichain-deploy";

async function main(): Promise<void> {
    const [deployer] = await web3.eth.getAccounts();

    // First deploy StorageToken
    const tokenNetworkArguments: NetworkArguments = {
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

    const tokenDeployment = await multichain.deployMultichain(
        "StorageToken",
        tokenNetworkArguments,
        {
            customNonPayableTxOptions: {
                from: deployer
            }
        }
    );

    // Then deploy StoragePool
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

    const poolDeployment = await multichain.deployMultichain(
        "StoragePool",
        poolNetworkArguments,
        {
            customNonPayableTxOptions: {
                from: deployer
            }
        }
    );

    // Finally deploy StorageProof with token address
    const proofNetworkArguments: NetworkArguments = {
        sepolia: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [tokenDeployment.addresses.sepolia],
            },
        },
        amoy: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [tokenDeployment.addresses.amoy],
            },
        },
        holesky: {
            args: [],
            initData: {
                initMethodName: "initialize",
                initMethodArgs: [tokenDeployment.addresses.holesky],
            },
        }
    };

    await multichain.deployMultichain(
        "StorageProof",
        proofNetworkArguments,
        {
            customNonPayableTxOptions: {
                from: deployer
            }
        }
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
