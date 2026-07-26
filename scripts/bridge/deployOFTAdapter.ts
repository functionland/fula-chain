// Deploys the immutable FulaOFTAdapter for the current network.
//
// The adapter is DELIBERATELY NOT UPGRADEABLE — it is deployed with a plain
// ContractFactory, never with the hardhat-upgrades plugin. It receives the power to
// burn any holder's balance, so that power must not sit behind a mutable pointer.
//
// USAGE:
//   OWNER=0xSafeOrTimelock npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base
//
// AFTER DEPLOY you must, in order:
//   1. Authorize the adapter as a bridge minter (governance proposal type 12)
//   2. setPeer on BOTH chains
//   3. setSendLibrary / setReceiveLibrary / setConfig (multi-DVN!)
//   4. setEnforcedOptions
//   5. setRateLimits  <-- MANDATORY: the rate limiter is fail-closed; without it every
//                        transfer reverts with RateLimitExceeded.
import { ethers, network } from "hardhat";
import { chainFor } from "./addresses";

declare const hre: any;

async function main() {
  const chain = chainFor(network.name);

  const owner = process.env.OWNER?.trim();
  if (!owner) throw new Error("OWNER environment variable not set");
  if (!ethers.isAddress(owner)) throw new Error(`OWNER is not a valid address: ${owner}`);

  const token = process.env.TOKEN_ADDRESS?.trim() || chain.token;
  if (!token) throw new Error("TOKEN_ADDRESS not set and no default for this network");

  const [deployer] = await ethers.getSigners();
  console.log(`network:  ${network.name} (eid ${chain.eid})`);
  console.log(`deployer: ${deployer.address}`);
  console.log(`token:    ${token}`);
  console.log(`endpoint: ${chain.endpoint}`);
  console.log(`owner:    ${owner}`);

  const code = await ethers.provider.getCode(owner);
  if (code === "0x") {
    console.log(
      `\n  WARNING: OWNER is an EOA, not a contract.\n` +
        `  The owner is also the LayerZero delegate, which can permanently DESTROY in-flight\n` +
        `  messages via endpoint.burn/nilify — i.e. destroy user funds already burned on the\n` +
        `  source chain. Use a TimelockController or multisig for mainnet.\n`
    );
  }

  const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
  const adapter = await Adapter.deploy(token, token, chain.endpoint, owner);
  await adapter.waitForDeployment();
  const address = await adapter.getAddress();
  console.log(`\nFulaOFTAdapter deployed: ${address}`);

  // Post-deploy assertions — fail loudly rather than leaving a misconfigured bridge.
  const checks: Array<[string, unknown, unknown]> = [
    ["token()", await adapter.token(), token],
    ["minterBurner()", await adapter.minterBurner(), token],
    ["owner()", await adapter.owner(), owner],
    ["sharedDecimals()", await adapter.sharedDecimals(), 6n],
    ["decimalConversionRate()", await adapter.decimalConversionRate(), 10n ** 12n],
    ["approvalRequired()", await adapter.approvalRequired(), false],
  ];
  let ok = true;
  for (const [name, actual, expected] of checks) {
    const a = typeof actual === "string" ? actual.toLowerCase() : actual;
    const e = typeof expected === "string" ? expected.toLowerCase() : expected;
    const pass = a === e;
    ok &&= pass;
    console.log(`  ${pass ? "OK  " : "FAIL"} ${name} = ${actual}${pass ? "" : ` (expected ${expected})`}`);
  }
  if (!ok) throw new Error("Post-deploy verification failed");

  if (process.env.ETHERSCAN_API_KEY) {
    await adapter.deploymentTransaction()?.wait(6);
    try {
      await hre.run("verify:verify", {
        address,
        constructorArguments: [token, token, chain.endpoint, owner],
      });
    } catch (error: any) {
      if (String(error.message).includes("Already Verified")) {
        console.log("Already verified.");
      } else {
        console.log(`Verification failed: ${error.message}`);
      }
    }
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Governance: createProposal(12, 0, ${address}, 0x0, <cap>, 0x0) then approve`);
  console.log(`  2. Deploy the peer adapter on the other chain`);
  console.log(`  3. npx hardhat run scripts/bridge/wireOApp.ts --network ${network.name}`);
  console.log(`  4. Set rate limits (MANDATORY — fail-closed)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// OWNER=0x... npx hardhat run scripts/bridge/deployOFTAdapter.ts --network ethereum
// OWNER=0x... npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base
