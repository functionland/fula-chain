// Wires a deployed FulaOFTAdapter to its peer: peer address, message libraries,
// DVN/executor security stack, enforced options and rate limits.
//
// Run ONCE PER CHAIN, after both adapters are deployed and both are authorized as
// bridge minters. Until setPeer is called on BOTH sides no message can move.
//
// IMPORTANT: the send-side ULN config on chain A must describe the SAME DVN set and
// threshold as the receive-side ULN config on chain B. A mismatch means messages are
// verified but never delivered (funds park, recoverable only by fixing the config).
//
// If the adapter owner is a Safe/Timelock (it should be), run with DRY_RUN=1 to print
// the calldata for each transaction instead of sending it.
//
// USAGE:
//   ADAPTER=0x.. REMOTE_ADAPTER=0x.. REMOTE=base RATE_LIMIT=1000000 \
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
  const lzReceiveGas = Number(process.env.LZ_RECEIVE_GAS?.trim() || 250000);
  const confirmations = BigInt(process.env.CONFIRMATIONS?.trim() || 15);
  const dryRun = process.env.DRY_RUN === "1";

  const requiredDvns = requiredDvnAddresses(local.network);
  console.log(`local:          ${local.network} (eid ${local.eid})`);
  console.log(`remote:         ${remote.network} (eid ${remote.eid})`);
  console.log(`adapter:        ${adapterAddr}`);
  console.log(`remote adapter: ${remoteAdapterAddr}`);
  console.log(`required DVNs:  ${requiredDvns.join(", ")}`);
  console.log(`confirmations:  ${confirmations}`);
  console.log(`rate limit:     ${rateLimitRaw} FULA / ${rateWindow}s`);
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
      "function setSendLibrary(address,uint32,address) external",
      "function setReceiveLibrary(address,uint32,address,uint256) external",
      "function setConfig(address,address,(uint32,uint32,bytes)[]) external",
      "function getConfig(address,address,uint32,uint32) external view returns (bytes)",
    ],
    local.endpoint
  );

  const peerBytes32 = ethers.zeroPadValue(remoteAdapterAddr, 32);
  const enforced = [{ eid: remote.eid, msgType: 1, options: lzReceiveOption(lzReceiveGas) }];

  const txs: Array<[string, { to: string; data: string }]> = [
    ["adapter.setPeer", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setPeer", [remote.eid, peerBytes32]) }],
    ["endpoint.setSendLibrary", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setSendLibrary", [adapterAddr, remote.eid, local.sendUln302]) }],
    ["endpoint.setReceiveLibrary", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setReceiveLibrary", [adapterAddr, remote.eid, local.receiveUln302, 0]) }],
    ["endpoint.setConfig(send)", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setConfig", [adapterAddr, local.sendUln302, [
      { eid: remote.eid, configType: CONFIG_TYPE_ULN, config: ulnConfig },
      { eid: remote.eid, configType: CONFIG_TYPE_EXECUTOR, config: executorConfig },
    ]]) }],
    ["endpoint.setConfig(receive)", { to: local.endpoint, data: endpoint.interface.encodeFunctionData("setConfig", [adapterAddr, local.receiveUln302, [
      { eid: remote.eid, configType: CONFIG_TYPE_ULN, config: ulnConfig },
    ]]) }],
    ["adapter.setEnforcedOptions", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setEnforcedOptions", [enforced]) }],
    ["adapter.setRateLimits", { to: adapterAddr, data: adapter.interface.encodeFunctionData("setRateLimits", [[{ dstEid: remote.eid, limit: rateLimit, window: rateWindow }]]) }],
  ];

  for (const [name, tx] of txs) {
    if (dryRun) {
      console.log(`\n${name}\n  to:   ${tx.to}\n  data: ${tx.data}`);
      continue;
    }
    console.log(`\n${name} ...`);
    const [signer] = await ethers.getSigners();
    const sent = await signer.sendTransaction(tx);
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
