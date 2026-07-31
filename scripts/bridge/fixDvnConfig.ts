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
import { chainFor, requiredDvnAddresses, DVNS, THRESHOLD_DVNS } from "./addresses";

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

  // THRESHOLD config: any `threshold` of these operators verifies a message. See THRESHOLD_DVNS.
  const policy = THRESHOLD_DVNS[local.network];
  if (!policy) throw new Error(`No THRESHOLD_DVNS policy for "${local.network}"`);
  const optional = requiredDvnAddresses(local.network, policy.operators);
  const threshold = policy.threshold;
  if (threshold < 2) throw new Error(`Threshold must be >= 2 (got ${threshold}) — 1-of-N is the Kelp configuration.`);
  if (optional.length < threshold) throw new Error(`Only ${optional.length} DVNs for threshold ${threshold}.`);

  console.log(`local:   ${local.network} (eid ${local.eid})  ->  ${remote.network} (eid ${remote.eid})`);
  console.log(`adapter: ${adapterAddr}`);
  console.log(`\npolicy:  ANY ${threshold} of ${optional.length} must attest (optional DVNs + threshold)`);
  for (const d of optional) console.log(`  ${d}  (${nameOf(local.network, d)})`);

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

    // ON-CHAIN PROVENANCE ONLY. A DVN must appear in this chain's own default config for the lane.
    // Off-chain evidence (a metadata API, a single observed attestation) is NOT accepted: that is
    // precisely the reasoning that put a non-serving DVN into the original mainnet config.
    const unproven = optional.filter((d) => !set.has(d.toLowerCase()));
    for (const d of optional) {
      console.log(`  ${d} -> ${set.has(d.toLowerCase()) ? "in live default set" : "*** NO ON-CHAIN PROVENANCE ***"}`);
    }
    if (unproven.length) {
      console.log(`\n  REFUSING: ${unproven.join(", ")} does not appear in this chain's live default`);
      console.log(`  ULN config for the lane. It may never attest, which hangs every message in`);
      console.log(`  status BLOCKED. Do not justify a DVN from documentation or an API.`);
      throw new Error("DVN without on-chain provenance — refusing to emit a config that may hang messages.");
    }
  }

  const abi = ethers.AbiCoder.defaultAbiCoder();
  const ulnConfig = abi.encode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    [[confirmations, 0, optional.length, threshold, [], optional]]
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
    `\nAfter BOTH chains are updated, a message already in flight becomes verifiable using the\n` +
      `attestations the correct DVNs ALREADY stored — verification is evaluated against the\n` +
      `CURRENT receive config, so no resend and no second fee is needed.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
