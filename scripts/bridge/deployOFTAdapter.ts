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

  // REFUSE, do not merely warn. Two distinct disasters hide behind an owner with no code:
  //
  //   1. It is a genuine EOA — then a single leaked key drains the whole escrow, because the
  //      owner can `setPeer` a lane to an address it controls and release the balance.
  //   2. IT IS A SAFE THAT EXISTS ON THE OTHER CHAIN BUT NOT THIS ONE. A Safe address is only
  //      a contract where it has actually been deployed; the same address on a second chain is
  //      frequently empty. Deploying here would hand ownership to an address that can never
  //      act — and since `transferOwnership` is onlyOwner and `renounceOwnership` reverts,
  //      the adapter could never be wired, funded, or recovered. Permanently bricked.
  //
  // This used to be a console warning, which is invisible in practice: hardhat prints a
  // ~60-line contract-size table immediately beforehand.
  const code = await ethers.provider.getCode(owner);
  if (code === "0x") {
    const msg =
      `OWNER ${owner} has NO CONTRACT CODE on ${network.name}.\n\n` +
      `  If it is a multisig, IT IS NOT DEPLOYED ON THIS CHAIN. Deploying now would make the\n` +
      `  adapter permanently unusable: ownership could never be exercised or transferred, so it\n` +
      `  could never be wired, funded or recovered. Deploy the Safe on this chain first — a Safe\n` +
      `  address is only a contract where it has actually been created.\n\n` +
      `  If it really is an EOA, a single leaked key drains the entire escrow.\n\n` +
      `  Verify with:  cast code ${owner} --rpc-url <this chain>\n` +
      `  To proceed anyway (testnet only): set ALLOW_EOA_OWNER=1`;
    if (process.env.ALLOW_EOA_OWNER?.trim() !== "1") throw new Error(`REFUSING TO DEPLOY: ${msg}`);
    console.log(`\n  WARNING (ALLOW_EOA_OWNER=1 set): ${msg}\n`);
  } else {
    console.log(`owner has contract code on this chain (${(code.length - 2) / 2} bytes) — good`);
  }

  const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
  const pending = await Adapter.deploy(token, chain.endpoint, owner);
  const deployHash = pending.deploymentTransaction()?.hash;
  console.log(`\ndeploy tx: ${deployHash}`);

  // SURVIVE A HOSTILE RPC RESPONSE. Several public endpoints return `"to": ""` for a
  // contract-creation transaction where ethers v6 requires `null`, and ethers then throws
  // `invalid value for value.to` from inside waitForDeployment. The deployment itself is
  // FINE — the transaction is mined and the contract exists — but the script would abort
  // as though it had failed, inviting a pointless (and costly) redeploy.
  //
  // On that failure, fall back to the raw receipt, which bypasses the response formatter.
  let address: string;
  try {
    await pending.waitForDeployment();
    address = await pending.getAddress();
  } catch (e: any) {
    if (!deployHash) throw e;
    console.log(`\n  waitForDeployment failed (${e.shortMessage ?? e.message}).`);
    console.log(`  This is usually an RPC formatting quirk, not a failed deploy. Polling the receipt...`);
    let receipt: any = null;
    for (let i = 0; i < 60 && !receipt; i++) {
      receipt = await ethers.provider.send("eth_getTransactionReceipt", [deployHash]);
      if (!receipt) await new Promise((r) => setTimeout(r, 5000));
    }
    if (!receipt) throw new Error(`No receipt for ${deployHash} after 5 minutes. Check the explorer.`);
    if (receipt.status !== "0x1") throw new Error(`Deploy transaction REVERTED (${deployHash}).`);
    address = ethers.getAddress(receipt.contractAddress);
    console.log(`  recovered — the deploy succeeded.`);
  }
  const adapter = await ethers.getContractAt("FulaOFTAdapter", address);
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
