// READ-ONLY. Has the inbound message been delivered on this chain yet?
import { ethers } from "hardhat";

const TOKEN = "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB";
const ADAPTER = "0x154b9654c58BCE82745A3D2f1EEb228cBa7E327a";
const RECIPIENT = "0x383a6A34C623C02dcf9BB7069FAE4482967fb713";
const ENDPOINT = "0x1a44076050125825900e736c501f859c50fE728c";
const SRC_EID = 30101;

async function main() {
  const t = await ethers.getContractAt("StorageToken", TOKEN);
  const a = await ethers.getContractAt("FulaOFTAdapter", ADAPTER);

  console.log(`\n=== BASE ===`);
  console.log(`  adapter escrow    ${ethers.formatEther(await a.availableLiquidity())} FULA   (1000 = not yet delivered, 950 = delivered)`);
  console.log(`  recipient balance ${ethers.formatEther(await t.balanceOf(RECIPIENT))} FULA`);
  console.log(`  token paused      ${await t.paused()}`);
  console.log(`  blacklisted?      ${await t.blacklisted(RECIPIENT)}`);

  const [, inboundAvail] = await a.getAmountCanBeReceived(SRC_EID);
  console.log(`  inbound available ${ethers.formatEther(inboundAvail)} FULA`);

  // The endpoint's inbound nonce for this lane: >0 means at least one message has been
  // delivered (or cleared) from that peer.
  const ep = await ethers.getContractAt(
    [
      "function inboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)",
      "function lazyInboundNonce(address _receiver, uint32 _srcEid, bytes32 _sender) view returns (uint64)",
      "function inboundPayloadHash(address _receiver, uint32 _srcEid, bytes32 _sender, uint64 _nonce) view returns (bytes32)",
    ],
    ENDPOINT
  );
  const peer = ethers.zeroPadValue("0x170c553e662d9dbc0d2abd8dcba36bd48b7c15e1", 32);
  try {
    const lazy = await ep.lazyInboundNonce(ADAPTER, SRC_EID, peer);
    console.log(`\n  lazyInboundNonce  ${lazy}   (0 = nothing executed yet)`);
    for (let n = 1n; n <= 3n; n++) {
      const h = await ep.inboundPayloadHash(ADAPTER, SRC_EID, peer, n);
      if (h !== ethers.ZeroHash) {
        console.log(`  nonce ${n}: payload COMMITTED and awaiting execution (hash ${h.slice(0, 18)}...)`);
      }
    }
  } catch (e: any) {
    console.log(`  endpoint query failed: ${e.shortMessage ?? e.message}`);
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
