// Wires a deployed FulaOFTAdapter to its peer: peer address, message libraries,
// DVN/executor security stack, enforced options and rate limits.
//
// Run ONCE PER CHAIN, after both adapters are deployed and both are authorized as
// escrow adapters. Until setPeer is called on BOTH sides no message can move.
//
// IMPORTANT: the send-side ULN config on chain A must describe the SAME DVN set and
// threshold as the receive-side ULN config on chain B. A mismatch means messages are
// verified but never delivered (funds park, recoverable only by fixing the config).
//
// If the adapter owner is a Safe/Timelock (it should be), run with DRY_RUN=1 to print
// the calldata for each transaction instead of sending it.
//
// USAGE:
//   ADAPTER=0x.. REMOTE_ADAPTER=0x.. REMOTE=base RATE_LIMIT=200000000 INBOUND_RATE_LIMIT=20000000 \
//     npx hardhat run scripts/bridge/wireOApp.ts --network ethereum
import { ethers, network } from "hardhat";
import { chainFor, requiredDvnAddresses } from "./addresses";

const CONFIG_TYPE_EXECUTOR = 1;
const CONFIG_TYPE_ULN = 2;

/** Type-3 executor option: lzReceive(gas, value). */
function lzReceiveOption(gas: number, value = 0): string {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  // worker id 1 (executor), option type 1 (lzReceive)
  const optionData =
    value === 0
      ? ethers.solidityPacked(["uint128"], [gas])
      : ethers.solidityPacked(["uint128", "uint128"], [gas, value]);
  const option = ethers.solidityPacked(
    ["uint8", "uint16", "uint8", "bytes"],
    [1, ethers.dataLength(optionData) + 1, 1, optionData]
  );
  void abi;
  return ethers.concat(["0x0003", option]);
}

async function main() {
  const local = chainFor(network.name);
  const remoteName = process.env.REMOTE?.trim();
  if (!remoteName) throw new Error("REMOTE environment variable not set (e.g. REMOTE=base)");
  const remote = chainFor(remoteName);

  const adapterAddr = process.env.ADAPTER?.trim();
  const remoteAdapterAddr = process.env.REMOTE_ADAPTER?.trim();
  if (!adapterAddr) throw new Error("ADAPTER environment variable not set");
  if (!remoteAdapterAddr) throw new Error("REMOTE_ADAPTER environment variable not set");

  const rateLimitRaw = process.env.RATE_LIMIT?.trim();
  if (!rateLimitRaw) {
    throw new Error(
      "RATE_LIMIT environment variable not set (in whole FULA). The rate limiter is " +
        "FAIL-CLOSED: without a limit every transfer reverts with RateLimitExceeded."
    );
  }
  const rateLimit = ethers.parseEther(rateLimitRaw);
  const rateWindow = Number(process.env.RATE_WINDOW?.trim() || 86400);

  // INBOUND limit — also fail-closed, and the one that actually bounds a theft. Outbound
  // throttles how fast tokens leave; inbound bounds how much escrow ONE compromised or forged
  // message can remove. Size it against the ESCROW BALANCE on this chain (aim for 10-25%), not
  // against supply: the bucket starts full, so this number IS the instant first-tranche loss.
  const inboundLimitRaw = process.env.INBOUND_RATE_LIMIT?.trim();
  if (!inboundLimitRaw) {
    throw new Error(
      "INBOUND_RATE_LIMIT environment variable not set (in whole FULA). The inbound limiter is " +
        "FAIL-CLOSED: without it every inbound transfer parks with InboundRateLimitExceeded."
    );
  }
  const inboundLimit = ethers.parseEther(inboundLimitRaw);
  const inboundWindow = Number(process.env.INBOUND_RATE_WINDOW?.trim() || 86400);
  const lzReceiveGas = Number(process.env.LZ_RECEIVE_GAS?.trim() || 250000);
  const confirmations = BigInt(process.env.CONFIRMATIONS?.trim() || 15);
  // TRIM. On Windows `set DRY_RUN=1 && npx hardhat ...` assigns "1 " WITH A TRAILING SPACE,
  // because cmd takes everything after `=` literally. An untrimmed `=== "1"` is then false and
  // this script sends REAL transactions while the operator believes it is dry-running. That is
  // a fail-OPEN bug on the one flag whose entire purpose is to prevent sending.
  const dryRun = process.env.DRY_RUN?.trim() === "1";

  const requiredDvns = requiredDvnAddresses(local.network);
  console.log(`local:          ${local.network} (eid ${local.eid})`);
  console.log(`remote:         ${remote.network} (eid ${remote.eid})`);
  console.log(`adapter:        ${adapterAddr}`);
  console.log(`remote adapter: ${remoteAdapterAddr}`);
  console.log(`required DVNs:  ${requiredDvns.join(", ")}`);
  console.log(`confirmations:  ${confirmations}`);
  console.log(`rate limit:     ${rateLimitRaw} FULA / ${rateWindow}s  (outbound, throttles flow)`);
  console.log(`inbound limit:  ${inboundLimitRaw} FULA / ${inboundWindow}s  (bounds a single compromise)`);
  console.log(`lzReceive gas:  ${lzReceiveGas}`);
  if (dryRun) console.log(`\nDRY RUN — printing calldata only.\n`);

  const abi = ethers.AbiCoder.defaultAbiCoder();
  const ulnConfig = abi.encode(
    ["tuple(uint64,uint8,uint8,uint8,address[],address[])"],
    [[confirmations, requiredDvns.length, 0, 0, requiredDvns, []]]
  );
  const executorConfig = abi.encode(
    ["tuple(uint32,address)"],
    [[10000, local.executor]]
  );

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const endpoint = await ethers.getContractAt(
    [
      "function setSendLibrary(address _oapp, uint32 _eid, address _newLib) external",
      "function setReceiveLibrary(address _oapp, uint32 _eid, address _newLib, uint256 _gracePeriod) external",
      // NOTE: the tuple components MUST be named. With an anonymous tuple
      // `(uint32,uint32,bytes)[]` ethers v6 only accepts POSITIONAL arrays and throws
      // "cannot encode object for signature with missing names" on the `{eid, configType, config}`
      // objects built below. Caught by the Sepolia rehearsal; it would have failed identically on
      // mainnet.
      "function setConfig(address _oapp, address _lib, (uint32 eid, uint32 configType, bytes config)[] _params) external",
      "function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) external view returns (bytes)",
      "function getSendLibrary(address _sender, uint32 _dstEid) external view returns (address)",
      "function isDefaultSendLibrary(address _sender, uint32 _dstEid) external view returns (bool)",
      "function getReceiveLibrary(address _receiver, uint32 _srcEid) external view returns (address lib, bool isDefault)",
    ],
    local.endpoint
  );

  // --- idempotence helpers -------------------------------------------------
  // The endpoint REVERTS when a library is set to the value it already holds, so a naive re-run
  // after a partial failure (an RPC nonce race, a dropped tx, a funding hiccup) dies on the first
  // already-applied step and never reaches the ones that still need doing. That is exactly the
  // situation a runbook has to survive on mainnet, so each step declares how to detect that it is
  // already done and is skipped rather than attempted.
  async function sendLibAlreadySet(): Promise<boolean> {
    try {
      // `getSendLibrary` LAZILY FALLS BACK to LayerZero's default when the OApp has not set one
      // (MessageLibManager.sol:83-89), so comparing it alone reports "already set" for a brand-new
      // adapter that has actually pinned nothing. That would leave the OApp riding LayerZero's
      // MUTABLE default — precisely what the design record says not to inherit. `isDefaultSendLibrary`
      // is what distinguishes "explicitly pinned" from "merely defaulting".
      if (await endpoint.isDefaultSendLibrary(adapterAddr, remote.eid)) return false;
      const cur = await endpoint.getSendLibrary(adapterAddr, remote.eid);
      return String(cur).toLowerCase() === local.sendUln302.toLowerCase();
    } catch {
      return false;
    }
  }
  async function receiveLibAlreadySet(): Promise<boolean> {
    try {
      const [lib, isDefault] = await endpoint.getReceiveLibrary(adapterAddr, remote.eid);
      return !isDefault && String(lib).toLowerCase() === local.receiveUln302.toLowerCase();
    } catch {
      return false;
    }
  }
  async function peerAlreadySet(): Promise<boolean> {
    try {
      return (await adapter.peers(remote.eid)).toLowerCase() === peerBytes32.toLowerCase();
    } catch {
      return false;
    }
  }

  const peerBytes32 = ethers.zeroPadValue(remoteAdapterAddr, 32);
  const enforced = [{ eid: remote.eid, msgType: 1, options: lzReceiveOption(lzReceiveGas) }];

  const txs: Array<[string, { to: string; data: string }, (() => Promise<boolean>)?]> = [
    ["adapter.setPeer", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setPeer", [remote.eid, peerBytes32]) }, peerAlreadySet],
    ["endpoint.setSendLibrary", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setSendLibrary", [adapterAddr, remote.eid, local.sendUln302]) }, sendLibAlreadySet],
    ["endpoint.setReceiveLibrary", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setReceiveLibrary", [adapterAddr, remote.eid, local.receiveUln302, 0]) }, receiveLibAlreadySet],
    ["endpoint.setConfig(send)", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setConfig", [adapterAddr, local.sendUln302, [
      { eid: remote.eid, configType: CONFIG_TYPE_ULN, config: ulnConfig },
      { eid: remote.eid, configType: CONFIG_TYPE_EXECUTOR, config: executorConfig },
    ]]) }],
    ["endpoint.setConfig(receive)", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setConfig", [adapterAddr, local.receiveUln302, [
      { eid: remote.eid, configType: CONFIG_TYPE_ULN, config: ulnConfig },
    ]]) }],
    ["adapter.setEnforcedOptions", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setEnforcedOptions", [enforced]) }],
    ["adapter.setRateLimits", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setRateLimits", [[{ dstEid: remote.eid, limit: rateLimit, window: rateWindow }]]) }],
    ["adapter.setInboundRateLimits", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setInboundRateLimits", [[{ dstEid: remote.eid, limit: inboundLimit, window: inboundWindow }]]) }],
  ];

  const [signer] = await ethers.getSigners();
  // Fetch the nonce ONCE and advance it ourselves. Public RPCs frequently serve a stale
  // transaction count immediately after a send, which produced repeated "nonce too low" aborts
  // mid-wiring when each transaction re-queried it.
  let nonce = await ethers.provider.getTransactionCount(signer.address, "pending");

  for (const [name, tx, alreadyDone] of txs) {
    if (dryRun) {
      console.log(`\n${name}\n  to:   ${tx.to}\n  data: ${tx.data}`);
      continue;
    }
    if (alreadyDone && (await alreadyDone())) {
      console.log(`\n${name} ... SKIP (already set)`);
      continue;
    }
    console.log(`\n${name} ...`);
    const sent = await signer.sendTransaction({ ...tx, nonce });
    nonce++;
    await sent.wait();
    console.log(`  ok (${sent.hash})`);
  }

  console.log(`\nDone. Now run the SAME script on ${remote.network} with the addresses swapped,`);
  console.log(`then verify both sides with scripts/bridge/verifyOAppConfig.ts.`);
  console.log(`The send-side ULN config here MUST equal the receive-side ULN config there.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// ADAPTER=0x.. REMOTE_ADAPTER=0x.. REMOTE=base RATE_LIMIT=1000000 npx hardhat run scripts/bridge/wireOApp.ts --network ethereum
// ADAPTER=0x.. REMOTE_ADAPTER=0x.. REMOTE=ethereum RATE_LIMIT=1000000 npx hardhat run scripts/bridge/wireOApp.ts --network base
