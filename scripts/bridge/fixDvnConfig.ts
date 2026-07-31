// Emits ONLY the two `setConfig` transactions needed to correct a wrong DVN set.
//
// WHY A SEPARATE SCRIPT: re-running wireOApp.ts to fix DVNs would emit all 8 transactions, and
// `setSendLibrary`/`setReceiveLibrary` REVERT with LZ_SameValue when the library is already what
// you are setting it to — so the whole Safe batch would fail. Only the ULN config needs changing.
//
// It also prints, for each configured DVN, whether it appears in the chain's LIVE DEFAULT set —
// the check whose absence let a non-serving DVN reach mainnet and hang the first real transfer.
//
// USAGE:
//   ADAPTER=0x.. REMOTE=base npx hardhat run scripts/bridge/fixDvnConfig.ts --network ethereum
import { ethers, network } from "hardhat";
import { chainFor, requiredDvnAddresses, DVNS } from "./addresses";

const CONFIG_TYPE_ULN = 2;

function nameOf(net: string, addr: string): string {
  for (const [n, a] of Object.entries(DVNS[net] ?? {})) {
    if (a.toLowerCase() === addr.toLowerCase()) return n;
  }
  return "UNKNOWN";
}

async function main() {
  const local = chainFor(network.name);
  const remoteName = process.env.REMOTE?.trim();
  if (!remoteName) throw new Error("REMOTE not set");
  const remote = chainFor(remoteName);
  const adapterAddr = process.env.ADAPTER?.trim();
  if (!adapterAddr) throw new Error("ADAPTER not set");

  const confirmations = BigInt(process.env.CONFIRMATIONS?.trim() || 15);

  // BOTH named operators must attest. See the note above THRESHOLD_DVNS in addresses.ts for why
  // a 2-of-N threshold was rejected: it bounds security by the two WEAKEST operators, and a DVN
  // outage only parks messages whereas a DVN compromise steals.
  const required = requiredDvnAddresses(local.network);
  if (required.length < 2) throw new Error(`Need >= 2 required DVNs, got ${required.length}.`);

  console.log(`local:   ${local.network} (eid ${local.eid})  ->  ${remote.network} (eid ${remote.eid})`);
  console.log(`adapter: ${adapterAddr}`);
  console.log(`\npolicy:  ALL ${required.length} of these must attest (requiredDVNs)`);
  for (const d of required) console.log(`  ${d}  (${nameOf(local.network, d)})`);

  // Cross-check against the live default set on BOTH libraries before emitting anything.
  const ulnAbi = [
    "function getUlnConfig(address _oapp, uint32 _remoteEid) view returns (tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs))",
  ];
  for (const [label, lib] of [["send", local.sendUln302], ["receive", local.receiveUln302]] as const) {
    const uln = await ethers.getContractAt(ulnAbi, lib);
    const def = await uln.getUlnConfig(ethers.ZeroAddress, remote.eid);
    const set = new Set(def.requiredDVNs.map((d: string) => d.toLowerCase()));
    console.log(`\n${label} library live DEFAULT required DVNs:`);
    for (const d of def.requiredDVNs) console.log(`  ${d}  (${nameOf(local.network, d)})`);

    // THE ONLY ACCEPTABLE CREDENTIAL: membership of LayerZero's OWN on-chain default ULN config
    // for this lane, which LayerZero sets in its own contract for all default traffic.
    //
    // A DVN having attested one of our packets is explicitly NOT accepted as evidence. A hostile
    // operator would attest a small test correctly for exactly that reason, establishing a track
    // record before falsely attesting a large transfer. Correct behaviour on one packet proves
    // liveness, never honesty. Documentation and metadata APIs are likewise rejected: both are
    // off-chain and mutable.
    const unproven = required.filter((d) => !set.has(d.toLowerCase()));
    for (const d of required) {
      console.log(`  ${d} -> ${set.has(d.toLowerCase()) ? "in LayerZero's on-chain default set" : "*** NOT LAYERZERO-TRUSTED ***"}`);
    }
    if (unproven.length) {
      console.log(`\n  REFUSING: ${unproven.join(", ")} is not in LayerZero's own on-chain default`);
      console.log(`  ULN config for this lane. Do NOT justify a DVN from documentation, a metadata`);
      console.log(`  API, or the fact that it attested a test packet — a malicious node attests`);
      console.log(`  small transfers correctly precisely to earn trust before a large one.`);
      throw new Error("DVN not in LayerZero's on-chain default set — refusing to emit this config.");
    }
  }

  const abi = ethers.AbiCoder.defaultAbiCoder();
  const ulnConfig = abi.encode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    [[confirmations, required.length, 0, 0, required, []]]
  );

  const endpoint = await ethers.getContractAt(
    ["function setConfig(address _oapp, address _lib, (uint32 eid, uint32 configType, bytes config)[] _params) external"],
    local.endpoint
  );

  console.log(`\n=== SUBMIT THESE TWO THROUGH THE SAFE (value 0, custom data) ===`);
  for (const [label, lib] of [["send", local.sendUln302], ["receive", local.receiveUln302]] as const) {
    const data = endpoint.interface.encodeFunctionData("setConfig", [
      adapterAddr,
      lib,
      [{ eid: remote.eid, configType: CONFIG_TYPE_ULN, config: ulnConfig }],
    ]);
    console.log(`\nendpoint.setConfig(${label})`);
    console.log(`  to:   ${local.endpoint}`);
    console.log(`  data: ${data}`);
  }

  console.log(
    `\nMESSAGES ALREADY IN FLIGHT verify only if the DVNs named above have ALREADY attested that\n` +
      `packet. A packet sent under a broken config was attested by whichever DVNs the OLD send\n` +
      `config named, so it will NOT necessarily verify under the corrected set. Check first with\n` +
      `ReceiveUln302.verifiable(config, headerHash, payloadHash).\n\n` +
      `NEVER weaken the DVN set to rescue a stuck packet. That is exactly how a hostile verifier\n` +
      `gets adopted: it behaves correctly on a small transfer so that it looks like the only way\n` +
      `to recover those funds, and is then trusted with a large one.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
