// PERMANENTLY freezes the adapter's peer set. ONE-WAY AND IRREVERSIBLE.
//
// WHY IT EXISTS. `setPeer` decides which remote address this adapter trusts, and
// `EndpointV2.send` is permissionless — it stamps a packet with `msg.sender`. So an owner who
// repoints a lane at an address they control can have that address emit a GENUINE source-chain
// packet (honest DVNs attest to it, because it really happened) that releases the entire escrow
// here, having locked nothing on the far side. No DVN compromise required. That is finding E-01,
// and it is proven by a deliberately passing attack test in the bridge suite.
//
// Locking closes it outright. Peers legitimately never change for a fixed two-chain bridge.
//
// THE COST, STATED PLAINLY: afterwards neither adapter can be replaced without redeploying BOTH
// and migrating liquidity. Only run this once a real transfer has been observed end to end.
//
// USAGE:
//   ADAPTER=0x.. REMOTE_EID=40245 EXPECTED_PEER=0x.. CONFIRM=LOCK \
//     npx hardhat run scripts/bridge/lockPeers.ts --network sepolia
import { ethers, network } from "hardhat";

async function main() {
  const adapterAddr = process.env.ADAPTER?.trim();
  const remoteEidRaw = process.env.REMOTE_EID?.trim();
  const expectedPeer = process.env.EXPECTED_PEER?.trim();
  if (!adapterAddr) throw new Error("ADAPTER not set");
  if (!remoteEidRaw) throw new Error("REMOTE_EID not set");
  if (!expectedPeer) throw new Error("EXPECTED_PEER not set (the peer adapter address on the remote chain)");
  const remoteEid = Number(remoteEidRaw);

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const [signer] = await ethers.getSigners();

  console.log(`network  ${network.name}`);
  console.log(`adapter  ${adapterAddr}`);
  console.log(`signer   ${signer.address}\n`);

  if (await adapter.peersLocked()) {
    console.log(`Peers are ALREADY locked on this adapter. Nothing to do.`);
    return;
  }

  // Verify the peer we are about to freeze is the one intended. After this call a wrong peer is
  // permanent, so a typo here is unrecoverable — check before, not after.
  const actual = await adapter.peers(remoteEid);
  const expectedBytes32 = ethers.zeroPadValue(ethers.getAddress(expectedPeer), 32);
  console.log(`peer for eid ${remoteEid}:`);
  console.log(`  on-chain  ${actual}`);
  console.log(`  expected  ${expectedBytes32}`);
  if (actual.toLowerCase() !== expectedBytes32.toLowerCase()) {
    throw new Error(`PEER MISMATCH — refusing to lock. Fix the peer first; locking would make this permanent.`);
  }
  if (actual === ethers.ZeroHash) {
    throw new Error(`Peer is unset — refusing to lock an adapter that can never receive.`);
  }

  const escrow = await adapter.availableLiquidity();
  console.log(`\nescrow held here: ${ethers.formatEther(escrow)} FULA`);
  if (escrow === 0n) {
    console.log(`  NOTE: escrow is empty. Locking is still safe, but confirm this adapter is the live one.`);
  }

  if (process.env.CONFIRM !== "LOCK") {
    console.log(
      `\nDRY RUN — nothing was changed.\n` +
        `This action is IRREVERSIBLE. Re-run with CONFIRM=LOCK once you are sure a real\n` +
        `cross-chain transfer has completed on this lane in BOTH directions.`
    );
    return;
  }

  console.log(`\nlockPeers() ...`);
  const tx = await adapter.connect(signer).lockPeers();
  await tx.wait();
  console.log(`  ok (${tx.hash})`);

  // Poll: public RPCs serve stale state right after a transaction, and a false "not locked"
  // reading here would be alarming for no reason.
  for (let i = 0; i < 10; i++) {
    if (await adapter.peersLocked()) {
      console.log(`\n  CONFIRMED: peersLocked = true. setPeer now reverts PeersAreLocked forever.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`\n  Transaction succeeded but peersLocked still reads false (stale RPC). Re-check shortly.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
