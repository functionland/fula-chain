// Skips an inbound nonce that can never be verified, unblocking every LATER message on the lane.
//
// WHY THIS IS NEEDED. LayerZero executes inbound messages in nonce order. `_clearPayload` walks
// from `lazyInboundNonce + 1` up to the nonce being executed and REVERTS `LZ_InvalidNonce` if any
// intermediate nonce has no committed payload. So a single message that never verified does not
// merely lose itself — it makes every subsequent message on that lane unexecutable, permanently,
// including by manual execution.
//
// That is exactly what a misconfigured DVN set produces: the packet is emitted on the source and
// its tokens are locked, but no required DVN ever attests, so the nonce never commits and the lane
// wedges behind it.
//
// WHAT SKIPPING COSTS. The skipped message is abandoned forever. For a lock/release bridge the
// tokens it represented stay LOCKED IN THE SOURCE ESCROW — they are not burned and not stolen,
// they simply become permanent bridge liquidity owned by whoever funded the escrow. If the sender
// was the project itself that is a wash; if it was a user, they must be made whole off-chain.
//
// AUTHORISATION: `MessagingChannel.skip` calls `_assertAuthorized(_oapp)`, so the caller must be
// the OApp itself or its LayerZero delegate — for this deployment, the owner Safe.
//
// USAGE:
//   ADAPTER=0x.. REMOTE=ethereum NONCE=1 npx hardhat run scripts/bridge/skipStuckNonce.ts --network base
import { ethers, network } from "hardhat";
import { chainFor } from "./addresses";

async function main() {
  const local = chainFor(network.name);
  const remote = chainFor(process.env.REMOTE!.trim());
  const adapterAddr = process.env.ADAPTER?.trim();
  const peerAddr = process.env.PEER?.trim();
  const nonce = BigInt(process.env.NONCE?.trim() || "0");
  if (!adapterAddr) throw new Error("ADAPTER not set");
  if (nonce === 0n) throw new Error("NONCE not set");

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const peer32 = peerAddr ? ethers.zeroPadValue(ethers.getAddress(peerAddr), 32) : await adapter.peers(remote.eid);
  if (peer32 === ethers.ZeroHash) throw new Error(`No peer set for eid ${remote.eid}`);

  const ep = await ethers.getContractAt(
    [
      "function lazyInboundNonce(address,uint32,bytes32) view returns (uint64)",
      "function inboundNonce(address,uint32,bytes32) view returns (uint64)",
      "function inboundPayloadHash(address,uint32,bytes32,uint64) view returns (bytes32)",
      "function skip(address _oapp, uint32 _srcEid, bytes32 _sender, uint64 _nonce) external",
      "function delegates(address) view returns (address)",
    ],
    local.endpoint
  );

  console.log(`chain    ${network.name}  (inbound from ${remote.network}, eid ${remote.eid})`);
  console.log(`adapter  ${adapterAddr}`);
  console.log(`peer     ${peer32}`);
  console.log(`delegate ${await ep.delegates(adapterAddr)}   <- must be the caller\n`);

  const lazy = await ep.lazyInboundNonce(adapterAddr, remote.eid, peer32);
  const inbound = await ep.inboundNonce(adapterAddr, remote.eid, peer32);
  console.log(`lazyInboundNonce (executed)          ${lazy}`);
  console.log(`inboundNonce     (contiguous verified) ${inbound}`);

  // skip() requires exactly inboundNonce + 1.
  const expected = inbound + 1n;
  if (nonce !== expected) {
    throw new Error(`skip() only accepts inboundNonce + 1 = ${expected}, but NONCE=${nonce}.`);
  }

  // Refuse to skip a nonce that DID commit — that message is deliverable and must not be discarded.
  const h = await ep.inboundPayloadHash(adapterAddr, remote.eid, peer32, nonce);
  if (h !== ethers.ZeroHash) {
    throw new Error(
      `REFUSING: nonce ${nonce} HAS a committed payload (${h.slice(0, 20)}...). It is deliverable — ` +
        `execute it instead of skipping. Skipping would discard a live message and strand its tokens.`
    );
  }
  console.log(`nonce ${nonce} payload: none committed — genuinely stuck, safe to skip`);

  // Show what unblocks as a result.
  for (let n = nonce + 1n; n <= nonce + 3n; n++) {
    const ph = await ep.inboundPayloadHash(adapterAddr, remote.eid, peer32, n);
    if (ph !== ethers.ZeroHash) console.log(`  nonce ${n} is COMMITTED and will become executable`);
  }

  const data = ep.interface.encodeFunctionData("skip", [adapterAddr, remote.eid, peer32, nonce]);
  console.log(`\n=== SUBMIT VIA THE SAFE (value 0, custom data) ===`);
  console.log(`  to:   ${local.endpoint}`);
  console.log(`  data: ${data}`);
  console.log(
    `\nIRREVERSIBLE. Nonce ${nonce} can never be delivered afterwards. Its tokens remain locked in\n` +
      `the SOURCE escrow as permanent bridge liquidity.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
