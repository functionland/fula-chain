// Adjust the adapter's rate limits — including the EMERGENCY KILL SWITCHES.
//
// Two independent buckets, either of which can be set to 0 to halt a direction immediately:
//
//   OUTBOUND (setRateLimits)        halts new departures. Fails source-side, so nothing is
//                                   locked and users simply retry later. Use this to stop the
//                                   bleeding when something looks wrong upstream.
//
//   INBOUND (setInboundRateLimits)  halts releases from THIS chain's escrow. Fails
//                                   destination-side: in-flight messages PARK retryably and
//                                   deliver once the limit is restored. This is the brake to
//                                   pull if you suspect a forged or wrongly-authorised message,
//                                   and it needs no token pause and no governance.
//
// Both take effect in the next block and neither destroys anything.
//
// USAGE:
//   ADAPTER=0x.. EID=40245 INBOUND=0 npx hardhat run scripts/bridge/setLimits.ts --network base-sepolia
//   ADAPTER=0x.. EID=40245 INBOUND=20000000 OUTBOUND=200000000 npx hardhat run ... --network base-sepolia
import { ethers, network } from "hardhat";

async function main() {
  const adapterAddr = process.env.ADAPTER?.trim();
  const eidRaw = process.env.EID?.trim();
  if (!adapterAddr) throw new Error("ADAPTER not set");
  if (!eidRaw) throw new Error("EID not set (the REMOTE endpoint id for this lane)");
  const eid = Number(eidRaw);

  const inbound = process.env.INBOUND?.trim();
  const outbound = process.env.OUTBOUND?.trim();
  if (inbound === undefined && outbound === undefined) {
    throw new Error("Set INBOUND and/or OUTBOUND (whole FULA; 0 is the kill switch)");
  }
  const window = Number(process.env.WINDOW?.trim() || 86400);

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const [signer] = await ethers.getSigners();

  console.log(`network  ${network.name}`);
  console.log(`adapter  ${adapterAddr}`);
  console.log(`lane eid ${eid}`);
  console.log(`signer   ${signer.address}\n`);

  const escrow = await adapter.availableLiquidity();
  console.log(`escrow held here: ${ethers.formatEther(escrow)} FULA`);

  const [, outBefore] = await adapter.getAmountCanBeSent(eid);
  const [, inBefore] = await adapter.getAmountCanBeReceived(eid);
  console.log(`before -> outbound available ${ethers.formatEther(outBefore)}, inbound available ${ethers.formatEther(inBefore)}`);

  // DRY_RUN prints calldata instead of sending. REQUIRED when the owner is a Safe/Timelock,
  // because this script signs with a plain EOA and the call would revert
  // OwnableUnauthorizedAccount. Paste `to` + `data` into the Safe transaction builder.
  const dryRun = process.env.DRY_RUN === "1";
  if (dryRun) console.log(`\nDRY RUN — printing calldata only, nothing will be sent.\n`);

  if (outbound !== undefined) {
    const limit = ethers.parseEther(outbound);
    const data = adapter.interface.encodeFunctionData("setRateLimits", [[{ dstEid: eid, limit, window }]]);
    if (dryRun) {
      console.log(`\nsetRateLimits(outbound) = ${outbound} / ${window}s`);
      console.log(`  to:   ${adapterAddr}\n  data: ${data}`);
    } else {
      console.log(`\nsetRateLimits(outbound) = ${outbound} / ${window}s ...`);
      const tx = await adapter.connect(signer).setRateLimits([{ dstEid: eid, limit, window }]);
      await tx.wait();
      console.log(`  ok (${tx.hash})${limit === 0n ? "   <-- OUTBOUND HALTED" : ""}`);
    }
  }

  if (inbound !== undefined) {
    const limit = ethers.parseEther(inbound);
    // A limit at or above escrow can never fire: `_credit` checks liquidity first, so anything
    // bigger than escrow reverts InsufficientLiquidity and anything smaller is under the limit.
    if (limit > 0n && escrow > 0n && limit >= escrow) {
      console.log(
        `\n  WARNING: inbound ${inbound} >= escrow ${ethers.formatEther(escrow)} — the inbound\n` +
          `  limiter would be INERT and bound nothing. Lower it, or seed more liquidity.`
      );
    }
    const data = adapter.interface.encodeFunctionData("setInboundRateLimits", [[{ dstEid: eid, limit, window }]]);
    if (dryRun) {
      console.log(`\nsetInboundRateLimits = ${inbound} / ${window}s`);
      console.log(`  to:   ${adapterAddr}\n  data: ${data}`);
    } else {
      console.log(`\nsetInboundRateLimits = ${inbound} / ${window}s ...`);
      const tx = await adapter.connect(signer).setInboundRateLimits([{ dstEid: eid, limit, window }]);
      await tx.wait();
      console.log(`  ok (${tx.hash})${limit === 0n ? "   <-- INBOUND RELEASES HALTED (messages park, nothing lost)" : ""}`);
    }
  }

  if (dryRun) return;

  const [, outAfter] = await adapter.getAmountCanBeSent(eid);
  const [, inAfter] = await adapter.getAmountCanBeReceived(eid);
  console.log(`\nafter  -> outbound available ${ethers.formatEther(outAfter)}, inbound available ${ethers.formatEther(inAfter)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
