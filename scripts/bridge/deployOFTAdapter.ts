// Deploys the immutable FulaOFTAdapter for the current network.
//
// The adapter is DELIBERATELY NOT UPGRADEABLE — it is deployed with a plain
// ContractFactory, never with the hardhat-upgrades plugin. It CUSTODIES escrowed user
// funds, so that custody must not sit behind a mutable implementation pointer.
//
// USAGE:
//   OWNER=0xSafeOrTimelock npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base
//
// AFTER DEPLOY you must, in order:
//   1. setPeer on BOTH chains  <-- and note that whoever can call this can DRAIN THE ESCROW
//                                  by pointing the lane at an attacker-controlled address.
//                                  The owner MUST be a timelock/multisig for this reason
//                                  alone, independent of the delegate powers below.
//   2. setSendLibrary / setReceiveLibrary / setConfig (multi-DVN!)
//   3. setEnforcedOptions
//   4. setRateLimits  <-- MANDATORY: the rate limiter is fail-closed; without it every
//                        transfer reverts with RateLimitExceeded.
//   5. SEED ESCROW LIQUIDITY — a chain can only release what it already holds.
//
// There is NO minter authorization step. This is a lock/release escrow: the token grants
// the adapter no role whatsoever.
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
        `  The owner can DRAIN THE ENTIRE ESCROW by calling setPeer to point a lane at an\n` +
        `  attacker-controlled address, which then sends a message releasing the balance.\n` +
        `  It is also the LayerZero delegate, so it can permanently DESTROY in-flight messages\n` +
        `  via endpoint.burn/nilify — stranding funds already locked on the source chain.\n` +
        `  Use a TimelockController or multisig for mainnet.\n`
    );
  }

  const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
  const adapter = await Adapter.deploy(token, chain.endpoint, owner);
  await adapter.waitForDeployment();
  const address = await adapter.getAddress();
  console.log(`\nFulaOFTAdapter deployed: ${address}`);

  // Public RPCs routinely serve STALE state for a few seconds after a deployment — a contract that
  // demonstrably exists reads back as `0x`, which made the post-deploy assertions below fail
  // spuriously and look like a failed deploy. Poll until the node admits the code exists.
  for (let i = 0; i < 30; i++) {
    if ((await ethers.provider.getCode(address)) !== "0x") break;
    if (i === 0) console.log(`  waiting for the RPC to observe the deployed code ...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(
      `RPC still reports no code at ${address} after 60s. The deployment transaction succeeded — ` +
        `verify manually before redeploying, or you will deploy a second adapter.`
    );
  }

  // Post-deploy assertions — fail loudly rather than leaving a misconfigured bridge.
  // NOTE `approvalRequired()` is TRUE: this is a lock/release escrow adapter, so holders must
  // `approve` before sending. A mint/burn adapter would report false.
  const checks: Array<[string, unknown, unknown]> = [
    ["token()", await adapter.token(), token],
    ["owner()", await adapter.owner(), owner],
    ["sharedDecimals()", await adapter.sharedDecimals(), 6n],
    ["decimalConversionRate()", await adapter.decimalConversionRate(), 10n ** 12n],
    ["approvalRequired()", await adapter.approvalRequired(), true],
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
        // THREE args, matching `constructor(address _token, address _lzEndpoint, address _owner)`.
        // This previously passed four (a leftover from the abandoned mint/burn adapter, which took
        // a separate minter-burner address) and would have failed every explorer verification.
        constructorArguments: [token, chain.endpoint, owner],
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
  console.log(`  1. Deploy the peer adapter on the other chain`);
  console.log(`  2. npx hardhat run scripts/bridge/wireOApp.ts --network ${network.name}`);
  console.log(`     (this also sets rate limits — MANDATORY, the limiter is fail-closed)`);
  console.log(`  3. SEED ESCROW LIQUIDITY on this chain — see below`);
  console.log(`\n  NO GOVERNANCE AUTHORIZATION IS REQUIRED.`);
  console.log(`  This is a lock/release escrow adapter: it never mints or burns, so the token`);
  console.log(`  grants it no role and no minter entry. It is an ordinary holder.`);
  console.log(`\n  LIQUIDITY: this chain can only RELEASE tokens it already holds. Send FULA to`);
  console.log(`  ${address} before anyone bridges INTO this chain, or inbound transfers will`);
  console.log(`  revert InsufficientLiquidity and park until it is funded.`);
  console.log(`  Check any time with:  adapter.availableLiquidity()`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// OWNER=0x... npx hardhat run scripts/bridge/deployOFTAdapter.ts --network ethereum
// OWNER=0x... npx hardhat run scripts/bridge/deployOFTAdapter.ts --network base
