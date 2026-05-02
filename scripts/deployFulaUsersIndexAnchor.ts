// Deploy the FulaUsersIndexAnchor contract.
//
// Required env vars:
//   INITIAL_OWNER  Multi-sig wallet that owns the contract (proposes
//                  upgrades, role grants, emergency pause).
//   INITIAL_ADMIN  Second admin signer required for the multi-sig
//                  quorum (default 2). Will be timelocked 24h before
//                  it can approve proposals.
//
// Optional env var:
//   OPERATOR_ADDRESS  Address that will hold CONTRACT_OPERATOR_ROLE
//                     to call publish() on behalf of master. NOT
//                     granted by this script — granting requires the
//                     governance AddRole proposal flow. We log the
//                     address + the next steps the operator must
//                     follow.
//
// Verification: set ETHERSCAN_API_KEY to verify the implementation
// after deployment.
//
// Usage:
//   INITIAL_OWNER=0x... INITIAL_ADMIN=0x... OPERATOR_ADDRESS=0x... \
//     npx hardhat run scripts/deployFulaUsersIndexAnchor.ts --network base
//
//   For SKALE deploys, swap --network skale.

import { ethers, upgrades } from "hardhat";
import * as readline from "readline";

const hre = require("hardhat");

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function waitForUserConfirmation(message: string): Promise<void> {
  const rl = createInterface();
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const initialOwner = process.env.INITIAL_OWNER?.trim();
  const initialAdmin = process.env.INITIAL_ADMIN?.trim();
  const operatorAddress = process.env.OPERATOR_ADDRESS?.trim();

  if (!initialOwner) {
    throw new Error("INITIAL_OWNER environment variable not set");
  }
  if (!initialAdmin) {
    throw new Error("INITIAL_ADMIN environment variable not set");
  }
  if (initialOwner.toLowerCase() === initialAdmin.toLowerCase()) {
    throw new Error(
      "INITIAL_OWNER and INITIAL_ADMIN must be different addresses (multi-sig requires distinct signers)",
    );
  }

  console.log("Parameters:");
  console.log("  Network:", hre.network.name);
  console.log("  Initial Owner:", initialOwner);
  console.log("  Initial Admin:", initialAdmin);
  console.log(
    "  Operator (advisory, not granted by this script):",
    operatorAddress ?? "(not set — set OPERATOR_ADDRESS to print follow-up steps)",
  );

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

  const Factory = await ethers.getContractFactory("FulaUsersIndexAnchor");

  // Estimate gas for the implementation.
  try {
    const implTx = Factory.getDeployTransaction();
    const implGas = await ethers.provider.estimateGas(implTx);
    const feeData = await ethers.provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("1", "gwei");
    // Proxy deployment is implementation + proxy + initialize ≈ 3x impl.
    const total = implGas * 3n;
    const cost = total * gasPrice;
    console.log(
      `Estimated total gas: ${total.toString()} (${ethers.formatEther(cost)} native)`,
    );
  } catch (e) {
    console.warn("Gas estimation failed; proceeding without estimate.");
  }

  await waitForUserConfirmation(
    "\nPress Enter to deploy or Ctrl+C to abort...",
  );

  const proxy = await upgrades.deployProxy(
    Factory,
    [initialOwner, initialAdmin],
    {
      kind: "uups",
      initializer: "initialize",
      unsafeAllow: ["constructor"],
    },
  );
  console.log(
    "Proxy deployment tx:",
    proxy.deploymentTransaction()?.hash ?? "(awaiting)",
  );
  await proxy.waitForDeployment();

  const proxyAddress = await proxy.getAddress();
  const implAddress = await upgrades.erc1967.getImplementationAddress(
    proxyAddress,
  );

  console.log("");
  console.log("✅ FulaUsersIndexAnchor deployed");
  console.log("   Proxy address:         ", proxyAddress);
  console.log("   Implementation address:", implAddress);
  console.log("");

  // Verify (optional — needs ETHERSCAN_API_KEY for the network).
  if (process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting 6 confirmations before verification...");
    await proxy.deploymentTransaction()?.wait(6);
    try {
      console.log("Verifying implementation...");
      await hre.run("verify:verify", {
        address: implAddress,
        constructorArguments: [],
      });
      console.log("Implementation verified.");
    } catch (e: any) {
      if (String(e?.message ?? "").includes("Already Verified")) {
        console.log("Implementation already verified.");
      } else {
        console.warn("Verification failed:", e?.message ?? e);
      }
    }
  }

  console.log("");
  console.log("Next steps (do these manually after deploy):");
  console.log(
    "  1. Add the proxy address to the chain cron in mainnet-reward-server:",
  );
  console.log(`       FULA_USERS_INDEX_ANCHOR_ADDRESS=${proxyAddress}`);
  console.log(
    "  2. Set the role quorum on ADMIN_ROLE so proposals can be approved:",
  );
  console.log(
    `       npx hardhat run scripts/setRoleQuorum.ts --network ${hre.network.name}`,
  );
  console.log(
    "     (Or call setRoleQuorum(ADMIN_ROLE, 2) directly via the multi-sig.)",
  );
  console.log("  3. Wait 24h (ROLE_CHANGE_DELAY).");
  console.log(
    `  4. Grant CONTRACT_OPERATOR_ROLE to the master operator wallet (${
      operatorAddress ?? "<set OPERATOR_ADDRESS env var>"
    }):`,
  );
  console.log(
    "       owner: createProposal(AddRole=1, 0, OPERATOR_ADDRESS, keccak256('CONTRACT_OPERATOR_ROLE'), 0, ZeroAddress)",
  );
  console.log("       wait 24h+1s, admin: approveProposal(<id>)");
  console.log(
    "  5. Configure mainnet-reward-server's 12h cron with the operator's private key + RPC URL.",
  );
  console.log("  6. Add to SDK config (fula-client):");
  console.log(`       users_index_anchor_address: ${proxyAddress}`);
  console.log(
    "       users_index_anchor_rpc_url:  <your RPC URL for this network>",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
