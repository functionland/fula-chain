// Seeds escrow liquidity into the FulaOFTAdapter on the current network.
//
// A lock/release adapter can only RELEASE what it already holds, so this is the step that
// makes inbound transfers possible at all. Two hops:
//   1. transferFromContract(deployer, amount)  -- ADMIN_ROLE, recipient must be whitelisted
//   2. plain ERC20 transfer(adapter, amount)   -- no whitelist needed, adapter stays unprivileged
//
// Routing through the deployer rather than whitelisting the adapter keeps the adapter's
// standing in the token at exactly zero, which is the property verifyOAppConfig asserts.
//
// USAGE:
//   ADAPTER=0x.. AMOUNT=200000000 npx hardhat run scripts/bridge/seedLiquidity.ts --network base-sepolia
import { ethers, network } from "hardhat";

const TESTNET_TOKENS: Record<string, string> = {
  sepolia: "0x32d6929c9F552068D54481FeAe75674fD29F337e",
  "base-sepolia": "0x32d6929c9F552068D54481FeAe75674fD29F337e",
};

function hms(s: number) {
  return `${Math.floor(Math.abs(s) / 3600)}h ${Math.floor((Math.abs(s) % 3600) / 60)}m`;
}

async function main() {
  const tokenAddr = process.env.TOKEN_ADDRESS?.trim() || TESTNET_TOKENS[network.name];
  const adapterAddr = process.env.ADAPTER?.trim();
  const amountRaw = process.env.AMOUNT?.trim();
  if (!tokenAddr) throw new Error(`No token for "${network.name}"; set TOKEN_ADDRESS`);
  if (!adapterAddr) throw new Error("ADAPTER not set");
  if (!amountRaw) throw new Error("AMOUNT not set (in whole FULA, e.g. 200000000)");
  const amount = ethers.parseEther(amountRaw);

  const [deployer] = await ethers.getSigners();
  const token = await ethers.getContractAt("StorageToken", tokenAddr);
  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;

  console.log(`network   ${network.name}`);
  console.log(`token     ${tokenAddr}`);
  console.log(`adapter   ${adapterAddr}`);
  console.log(`funder    ${deployer.address}`);
  console.log(`amount    ${amountRaw} FULA\n`);

  // --- preconditions, each failing with something actionable -------------
  if ((await adapter.token()).toLowerCase() !== tokenAddr.toLowerCase()) {
    throw new Error(`Adapter escrows a DIFFERENT token (${await adapter.token()}). Wrong adapter?`);
  }

  const cfg = await token.timeConfigs(deployer.address);
  const lock = Number(cfg.whitelistLockTime);
  if (lock === 0) throw new Error(`${deployer.address} is NOT whitelisted — needs an AddWhitelist proposal.`);
  if (lock > now) throw new Error(`Whitelist still locked for ${hms(lock - now)} (until ${new Date(lock * 1000).toISOString()}).`);

  const adminLimit = (await token.roleConfigs(ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE")))).transactionLimit;
  if (amount > adminLimit) {
    throw new Error(
      `AMOUNT exceeds ADMIN_ROLE transactionLimit (${ethers.formatEther(adminLimit)} FULA). Split into multiple runs.`
    );
  }

  // Only the SHORTFALL has to come out of the token contract. Checking the full amount here
  // made the script un-resumable: after hop 1 succeeded and hop 2 failed, a re-run aborted
  // because the contract no longer held the whole amount — even though the funder now did.
  const escrowBefore = await adapter.availableLiquidity();
  console.log(`escrow before: ${ethers.formatEther(escrowBefore)} FULA`);

  const held = await token.balanceOf(deployer.address);
  const need = amount > held ? amount - held : 0n;

  const contractBal = await token.balanceOf(tokenAddr);
  if (contractBal < need) {
    throw new Error(
      `Token contract holds ${ethers.formatEther(contractBal)} FULA but ${ethers.formatEther(need)} more ` +
        `is needed (funder already has ${ethers.formatEther(held)}).`
    );
  }

  // --- hop 1: contract -> deployer --------------------------------------
  if (need > 0n) {
    console.log(`transferFromContract(${deployer.address}, ${ethers.formatEther(need)}) ...`);
    const tx1 = await token.connect(deployer).transferFromContract(deployer.address, need);
    await tx1.wait();
    console.log(`  ok (${tx1.hash})`);
  } else {
    console.log(`funder already holds ${ethers.formatEther(held)} FULA — skipping transferFromContract`);
  }

  // --- hop 2: deployer -> adapter ---------------------------------------
  console.log(`transfer(${adapterAddr}, ${amountRaw}) ...`);
  const tx2 = await token.connect(deployer).transfer(adapterAddr, amount);
  await tx2.wait();
  console.log(`  ok (${tx2.hash})`);

  // --- verify ------------------------------------------------------------
  //
  // POLL, don't read once. Public RPCs serve stale state for seconds after a transaction is
  // mined: the transfer above returned a successful receipt while `balanceOf` still reported
  // the pre-transfer value. Reading once turned a completed seeding into a false alarm that
  // claimed a transfer fee was active. Give the node a few seconds to catch up before
  // concluding anything.
  let escrowAfter = escrowBefore;
  for (let i = 0; i < 15; i++) {
    escrowAfter = await adapter.availableLiquidity();
    if (escrowAfter - escrowBefore === amount) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\nescrow after:  ${ethers.formatEther(escrowAfter)} FULA`);
  if (escrowAfter - escrowBefore !== amount) {
    throw new Error(
      `Escrow moved ${ethers.formatEther(escrowAfter - escrowBefore)}, expected ${amountRaw}, after 30s of polling. ` +
        `If the transfer receipt succeeded, re-read the balance manually before assuming failure — ` +
        `otherwise a transfer fee may be active, which would break the escrow invariant.`
    );
  }

  // The inbound limiter is INERT unless it sits strictly below escrow: _credit checks
  // liquidity first, so a limit >= escrow can never be the binding constraint.
  const remoteEid = process.env.REMOTE_EID?.trim();
  if (remoteEid) {
    const rl = await adapter.inboundRateLimits(Number(remoteEid));
    const limit = rl[2] as bigint;
    if (limit >= escrowAfter) {
      console.log(
        `\n  WARNING: inbound limit ${ethers.formatEther(limit)} >= escrow ${ethers.formatEther(escrowAfter)}.\n` +
          `  The inbound limiter cannot fire and bounds nothing. Lower it, or seed more.`
      );
    } else {
      console.log(
        `  inbound limit ${ethers.formatEther(limit)} = ${(limit * 100n) / escrowAfter}% of escrow — active.`
      );
    }
  }

  console.log(`\nNext: run verifyOAppConfig.ts, then sendTest.ts for the first cross-chain transfer.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
