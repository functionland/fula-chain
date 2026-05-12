// Deploy the FulaUsersIndexAnchor contract.
//
// Required env vars:
//   INITIAL_OWNER     Multi-sig wallet that owns the contract (proposes
//                     upgrades, role grants, emergency pause).
//   INITIAL_ADMIN     Second admin signer required for the multi-sig
//                     quorum (default 2). Timelocked 24h before it can
//                     approve proposals.
//   OPERATOR_ADDRESS  Address that holds CONTRACT_OPERATOR_ROLE to
//                     call publish() on behalf of master. **Granted
//                     immediately by this script via the contract's
//                     `initialize(owner, admin, operator)` flow** —
//                     the master's chain-anchor cron is functional
//                     from the first block after deployment. This is
//                     the only operator change that bypasses the
//                     governance AddRole proposal flow; every
//                     subsequent grant or revoke MUST go through
//                     `createProposal(AddRole/RemoveRole, ...)`.
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
  if (!operatorAddress) {
    throw new Error(
      "OPERATOR_ADDRESS environment variable not set — required at deploy time. " +
        "This address receives CONTRACT_OPERATOR_ROLE during initialize() so the master's " +
        "chain-anchor cron is functional immediately. Subsequent operator changes MUST " +
        "go through governance (createProposal AddRole/RemoveRole).",
    );
  }
  if (initialOwner.toLowerCase() === initialAdmin.toLowerCase()) {
    throw new Error(
      "INITIAL_OWNER and INITIAL_ADMIN must be different addresses (multi-sig requires distinct signers)",
    );
  }
  if (
    operatorAddress.toLowerCase() === initialOwner.toLowerCase() ||
    operatorAddress.toLowerCase() === initialAdmin.toLowerCase()
  ) {
    // Production deployments should keep these three roles distinct so
    // a compromised hot key (the operator's chain-cron signer) can't
    // also approve governance proposals. We warn but don't block —
    // staging / dev deploys may legitimately run with a single EOA.
    console.warn(
      "\n⚠️  WARNING: OPERATOR_ADDRESS overlaps with INITIAL_OWNER or INITIAL_ADMIN.",
    );
    console.warn(
      "    Production should use distinct addresses to preserve the multi-sig invariant.",
    );
    console.warn(
      "    Continuing — set distinct addresses to suppress this warning.\n",
    );
  }

  console.log("Parameters:");
  console.log("  Network:", hre.network.name);
  console.log("  Initial Owner:", initialOwner);
  console.log("  Initial Admin:", initialAdmin);
  console.log(
    "  Operator (granted CONTRACT_OPERATOR_ROLE at deploy):",
    operatorAddress,
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
    [initialOwner, initialAdmin, operatorAddress],
    {
      kind: "uups",
      initializer: "initialize",
      // Note: no `unsafeAllow: ["constructor"]` — the contract uses
      // `initialize` (UUPS pattern), not a constructor. The flag was
      // present historically and could mask OZ's deployment-time
      // validation; removed so we get clearer diagnostics if a future
      // change accidentally introduces unsafe inheritance.
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
  console.log("✅ Operator already has CONTRACT_OPERATOR_ROLE — no AddRole");
  console.log("   proposal needed. The cron can call publish() immediately.");
  console.log("");
  console.log("Next steps (do these manually after deploy):");
  console.log(
    "  1. Configure mainnet-rewards-server's 12h cron with the operator's",
  );
  console.log("     private key + RPC URL + the deployed proxy address:");
  console.log(`       FULA_USERS_INDEX_ANCHOR_ADDRESS=${proxyAddress}`);
  console.log(
    `       FULA_USERS_INDEX_ANCHOR_${hre.network.name.toUpperCase()}=${proxyAddress}`,
  );
  console.log(
    "  2. Set the role quorum on ADMIN_ROLE so future governance proposals",
  );
  console.log("     (e.g., changing the operator) can be approved:");
  console.log(
    `       npx hardhat run scripts/setRoleQuorum.ts --network ${hre.network.name}`,
  );
  console.log(
    "     (Or call setRoleQuorum(ADMIN_ROLE, 2) directly via the multi-sig.)",
  );
  console.log("");
  console.log("  3. Add to SDK config (fula-client):");
  console.log(`       users_index_anchor_address: ${proxyAddress}`);
  console.log(
    "       users_index_anchor_rpc_url:  <your RPC URL for this network>",
  );
  console.log("");
  console.log(
    "Future operator changes (rotation / replacement / revocation) MUST go",
  );
  console.log(
    "through governance — see `createProposal(AddRole|RemoveRole, ..., CONTRACT_OPERATOR_ROLE, ...)`.",
  );
  console.log(
    "The deployment-time bypass is single-use and applies only to the address",
  );
  console.log("passed via OPERATOR_ADDRESS at this proxy's first initialize().");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
