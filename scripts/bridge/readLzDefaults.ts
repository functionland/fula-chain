// Read-only: what security stack does LayerZero apply to this lane BY DEFAULT?
//
// The design doc mandates an explicit multi-DVN config and warns never to inherit LayerZero's
// defaults on mainnet (a 1-of-1 DVN configuration caused the ~$292M Kelp loss). To set an explicit
// config you first have to know which DVNs actually exist on the chain — and on testnets the roster
// is much thinner than mainnet. Rather than hardcode addresses that cannot be verified, read the
// live default straight off the endpoint.
//
//   REMOTE=base-sepolia npx hardhat run scripts/bridge/readLzDefaults.ts --network sepolia
//   REMOTE=sepolia      npx hardhat run scripts/bridge/readLzDefaults.ts --network base-sepolia
import { ethers, network } from "hardhat";
import { chainFor } from "./addresses";

const ENDPOINT_ABI = [
  "function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes)",
  "function defaultSendLibrary(uint32 _eid) view returns (address)",
  "function defaultReceiveLibrary(uint32 _eid) view returns (address)",
];

const ULN_TYPE = 2;
const EXECUTOR_TYPE = 1;

const ULN_ABI = ["tuple(uint64,uint8,uint8,uint8,address[],address[])"];
const EXEC_ABI = ["tuple(uint32,address)"];

async function main() {
  const local = chainFor(network.name);
  const remoteName = process.env.REMOTE?.trim();
  if (!remoteName) throw new Error("Set REMOTE to the peer network name");
  const remote = chainFor(remoteName);

  const ep = new ethers.Contract(local.endpoint, ENDPOINT_ABI, ethers.provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  console.log(`local  : ${network.name} (eid ${local.eid})`);
  console.log(`remote : ${remoteName} (eid ${remote.eid})`);

  const defSend = await ep.defaultSendLibrary(remote.eid);
  const defRecv = await ep.defaultReceiveLibrary(remote.eid);
  console.log(`\ndefaultSendLibrary   : ${defSend}`);
  console.log(`  addresses.ts sendUln302   : ${local.sendUln302} ${defSend.toLowerCase() === local.sendUln302.toLowerCase() ? "(match)" : "*** MISMATCH ***"}`);
  console.log(`defaultReceiveLibrary: ${defRecv}`);
  console.log(`  addresses.ts receiveUln302: ${local.receiveUln302} ${defRecv.toLowerCase() === local.receiveUln302.toLowerCase() ? "(match)" : "*** MISMATCH ***"}`);

  for (const [label, lib] of [["SEND", defSend], ["RECEIVE", defRecv]] as Array<[string, string]>) {
    console.log(`\n--- ${label} lib ${lib} : default ULN config ---`);
    try {
      const raw = await ep.getConfig(ethers.ZeroAddress, lib, remote.eid, ULN_TYPE);
      const [cfg] = coder.decode(ULN_ABI, raw);
      const [confirmations, reqCount, optCount, optThreshold, reqDVNs, optDVNs] = cfg;
      console.log(`  confirmations       : ${confirmations}`);
      console.log(`  requiredDVNCount    : ${reqCount}`);
      console.log(`  optionalDVNCount    : ${optCount} (threshold ${optThreshold})`);
      console.log(`  requiredDVNs        : ${reqDVNs.length ? reqDVNs.join(", ") : "(none)"}`);
      console.log(`  optionalDVNs        : ${optDVNs.length ? optDVNs.join(", ") : "(none)"}`);
      if (Number(reqCount) + Number(optCount) < 2) {
        console.log(`  *** WARNING: fewer than 2 DVNs. Acceptable for a testnet rehearsal, NEVER for mainnet.`);
      }
    } catch (e: any) {
      console.log(`  <getConfig failed: ${e.shortMessage ?? e.message}>`);
    }
  }

  console.log(`\n--- SEND lib : default Executor config ---`);
  try {
    const raw = await ep.getConfig(ethers.ZeroAddress, defSend, remote.eid, EXECUTOR_TYPE);
    const [cfg] = coder.decode(EXEC_ABI, raw);
    console.log(`  maxMessageSize      : ${cfg[0]}`);
    console.log(`  executor            : ${cfg[1]}`);
    console.log(`  addresses.ts executor: ${local.executor} ${String(cfg[1]).toLowerCase() === local.executor.toLowerCase() ? "(match)" : "*** MISMATCH ***"}`);
  } catch (e: any) {
    console.log(`  <getConfig failed: ${e.shortMessage ?? e.message}>`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
