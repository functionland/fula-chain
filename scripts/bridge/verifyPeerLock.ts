// Proves that {lockPeers} actually took effect — and that the lane still works afterwards.
//
// RUN THIS AFTER EXECUTING lockPeers(), on both chains. `peersLocked() == true` alone is not the
// property you care about; the property is "even the legitimate owner can no longer repoint this
// lane, and ordinary transfers are unaffected". Those are what this asserts.
//
// NO PRIVATE KEY IS NEEDED. The `setPeer` attempt is an `eth_call` with `from` set to the owner
// address read off the contract, so it proves the revert reason for the REAL owner — including a
// Safe or Timelock whose key we do not hold — without signing or sending anything.
//
// A note on why the revert SELECTOR is checked rather than the message: most public RPCs return a
// bare "execution reverted" string, so matching on text silently fails even when the contract
// behaved correctly. Comparing the 4-byte custom-error selector is exact and RPC-independent.
//
// USAGE:
//   ADAPTER=0x.. REMOTE_EID=30184 npx hardhat run scripts/bridge/verifyPeerLock.ts --network ethereum
//
// EXIT CODES:  0 = locked, correct error, lane operational · 1 = something is wrong
import { ethers, network } from "hardhat";

async function main() {
  const adapterAddr = process.env.ADAPTER?.trim();
  const remoteEidRaw = process.env.REMOTE_EID?.trim();
  if (!adapterAddr) throw new Error("ADAPTER not set");
  if (!remoteEidRaw) throw new Error("REMOTE_EID not set (the peer chain's LayerZero eid)");
  const remoteEid = Number(remoteEidRaw);

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const owner: string = await adapter.owner();

  console.log(`network  ${network.name}`);
  console.log(`adapter  ${adapterAddr}`);
  console.log(`owner    ${owner}`);

  const failures: string[] = [];

  // ---- 1. the flag ---------------------------------------------------------
  const locked: boolean = await adapter.peersLocked();
  console.log(`\npeersLocked        ${locked}`);
  if (!locked) failures.push("peersLocked is false — lockPeers() has not been executed on this chain.");

  const peerBefore: string = await adapter.peers(remoteEid);
  console.log(`peers(${remoteEid})      ${peerBefore}`);
  if (peerBefore === ethers.ZeroHash) failures.push(`peers(${remoteEid}) is unset.`);

  // ---- 2. the actual security property ------------------------------------
  // Impersonate the owner via `from`. If the lock works, this reverts PeersAreLocked; if the lock
  // were absent it would SUCCEED (the owner is authorised), which is precisely the drain path.
  const SELECTOR = ethers.id("PeersAreLocked()").slice(0, 10);
  const attacker = "0x000000000000000000000000000000000000dEaD";
  const calldata = adapter.interface.encodeFunctionData("setPeer", [
    remoteEid,
    ethers.zeroPadValue(attacker, 32),
  ]);

  let succeeded = false;
  let revertData = "";
  try {
    await ethers.provider.call({ to: adapterAddr, from: owner, data: calldata });
    succeeded = true;
  } catch (e: any) {
    const d = e.data ?? e.info?.error?.data ?? e.error?.data ?? "";
    revertData = typeof d === "string" ? d : (d?.data ?? "");
  }

  console.log(`\nowner attempts setPeer(${remoteEid}, 0x…dEaD)   [eth_call, from=owner]`);
  if (succeeded) {
    console.log(`  *** SUCCEEDED — the owner CAN still repoint this lane. THE DRAIN PATH IS OPEN. ***`);
    failures.push("setPeer did not revert for the owner — peers are NOT locked.");
  } else {
    console.log(`  reverted with:     ${revertData || "(no revert data returned by this RPC)"}`);
    console.log(`  expected selector: ${SELECTOR}  (PeersAreLocked)`);
    if (revertData && revertData.startsWith(SELECTOR)) {
      console.log(`  MATCH — the revert is PeersAreLocked, not an unrelated failure.`);
    } else if (!revertData) {
      // Do not treat an un-decodable revert as a pass: `OwnableUnauthorizedAccount` and a network
      // error also revert, and neither proves the lock.
      failures.push(
        "setPeer reverted but this RPC returned no revert data, so the reason is UNVERIFIED. " +
          "Re-run against an RPC that returns revert data before trusting this result."
      );
    } else {
      failures.push(`setPeer reverted with ${revertData.slice(0, 10)}, not PeersAreLocked (${SELECTOR}).`);
    }
  }

  const peerAfter: string = await adapter.peers(remoteEid);
  console.log(`\npeers(${remoteEid}) unchanged:  ${peerAfter === peerBefore}`);
  if (peerAfter !== peerBefore) failures.push("peer changed during verification.");

  // ---- 3. the lane must still work ----------------------------------------
  // A lock that also froze ordinary transfers would be catastrophic and irreversible.
  try {
    const quote = await adapter.quoteSend(
      {
        dstEid: remoteEid,
        to: ethers.zeroPadValue(owner, 32),
        amountLD: ethers.parseEther("1"),
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      },
      false
    );
    console.log(`quoteSend still works: ${ethers.formatEther(quote.nativeFee)} ETH for 1 FULA`);
    if (quote.nativeFee === 0n) failures.push("quoteSend returned a zero fee — the lane looks misconfigured.");
  } catch (e: any) {
    console.log(`  *** quoteSend FAILED: ${e.shortMessage ?? e.message} ***`);
    failures.push("quoteSend reverted — the lane may be broken.");
  }

  console.log(`\n${"=".repeat(68)}`);
  if (failures.length) {
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exit(1);
  }
  console.log(`PASS — peers permanently frozen, correct error, lane still operational.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
