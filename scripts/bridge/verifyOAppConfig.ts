// Reads back the full LayerZero security stack for a deployed FulaOFTAdapter and checks it
// against policy. Run on BOTH chains after wiring, and again before each rollout stage.
//
// The most important thing this catches: the send-side ULN config on chain A must describe the
// SAME DVN set and threshold as the receive-side ULN config on chain B. If they disagree,
// messages are verified but never delivered — transfers park indefinitely (recoverable only by
// fixing the config, but the funds are burned on the source in the meantime).
//
// USAGE:
//   ADAPTER=0x.. REMOTE=base npx hardhat run scripts/bridge/verifyOAppConfig.ts --network ethereum
//
// To cross-check both directions, run on each chain and compare the printed
// "send ULN digest" on A with the "receive ULN digest" on B.
import { ethers, network } from "hardhat";
import { chainFor, requiredDvnAddresses, DVNS } from "./addresses";

const CONFIG_TYPE_EXECUTOR = 1;
const CONFIG_TYPE_ULN = 2;

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

function dvnName(network: string, addr: string): string {
  const table = DVNS[network] ?? {};
  for (const [name, a] of Object.entries(table)) {
    if (a.toLowerCase() === addr.toLowerCase()) return name;
  }
  return "UNKNOWN";
}

async function main() {
  const local = chainFor(network.name);
  const remoteName = process.env.REMOTE?.trim();
  if (!remoteName) throw new Error("REMOTE environment variable not set (e.g. REMOTE=base)");
  const remote = chainFor(remoteName);

  const adapterAddr = process.env.ADAPTER?.trim();
  if (!adapterAddr) throw new Error("ADAPTER environment variable not set");

  console.log(`${"=".repeat(72)}`);
  console.log(`OApp config verification`);
  console.log(`local:   ${local.network} (eid ${local.eid})`);
  console.log(`remote:  ${remote.network} (eid ${remote.eid})`);
  console.log(`adapter: ${adapterAddr}`);
  console.log(`${"=".repeat(72)}`);

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const endpoint = await ethers.getContractAt(
    [
      "function getConfig(address,address,uint32,uint32) external view returns (bytes)",
      "function getSendLibrary(address,uint32) external view returns (address)",
      "function getReceiveLibrary(address,uint32) external view returns (address,bool)",
      "function delegates(address) external view returns (address)",
    ],
    local.endpoint
  );

  // ---------------------------------------------------------------- adapter wiring
  console.log(`\n-- adapter --`);
  const token = await adapter.token();
  check(
    !local.token || token.toLowerCase() === local.token.toLowerCase(),
    `token() is the expected FULA proxy`,
    token
  );
  check((await adapter.minterBurner()).toLowerCase() === token.toLowerCase(), `minterBurner() == token()`);
  check(Number(await adapter.sharedDecimals()) === 6, `sharedDecimals == 6 (dust granularity 1e12)`);
  check((await adapter.decimalConversionRate()) === 10n ** 12n, `decimalConversionRate == 1e12`);
  check((await adapter.approvalRequired()) === false, `approvalRequired() == false`);

  const owner = await adapter.owner();
  const ownerCode = await ethers.provider.getCode(owner);
  console.log(`     owner: ${owner}`);
  check(ownerCode !== "0x", `owner is a CONTRACT (timelock/multisig), not an EOA`);

  const delegate = await endpoint.delegates(adapterAddr);
  console.log(`     delegate: ${delegate}`);
  check(
    delegate.toLowerCase() === owner.toLowerCase(),
    `delegate == owner`,
    `delegate can burn/nilify in-flight messages — must not be an EOA`
  );

  // ---------------------------------------------------------------- peer
  console.log(`\n-- peer --`);
  const peer = await adapter.peers(remote.eid);
  const peerAddr = ethers.getAddress("0x" + peer.slice(-40));
  console.log(`     peers[${remote.eid}] = ${peer}`);
  check(BigInt(peer) !== 0n, `peer is set for eid ${remote.eid}`, peerAddr);
  const expectedPeer = process.env.REMOTE_ADAPTER?.trim();
  if (expectedPeer) {
    check(
      peerAddr.toLowerCase() === expectedPeer.toLowerCase(),
      `peer matches REMOTE_ADAPTER`,
      `${peerAddr}`
    );
  } else {
    console.log(`     (set REMOTE_ADAPTER to assert the exact peer address)`);
  }

  // ---------------------------------------------------------------- libraries
  console.log(`\n-- message libraries --`);
  const sendLib = await endpoint.getSendLibrary(adapterAddr, remote.eid);
  check(
    sendLib.toLowerCase() === local.sendUln302.toLowerCase(),
    `send library is SendUln302`,
    sendLib
  );
  const [recvLib] = await endpoint.getReceiveLibrary(adapterAddr, remote.eid);
  check(
    recvLib.toLowerCase() === local.receiveUln302.toLowerCase(),
    `receive library is ReceiveUln302`,
    recvLib
  );

  // ---------------------------------------------------------------- ULN configs
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const ULN_TUPLE = "tuple(uint64,uint8,uint8,uint8,address[],address[])";

  async function readUln(lib: string, label: string) {
    console.log(`\n-- ${label} ULN config --`);
    const raw = await endpoint.getConfig(adapterAddr, lib, remote.eid, CONFIG_TYPE_ULN);
    const [cfg] = abi.decode([ULN_TUPLE], raw);
    const [confirmations, requiredCount, optionalCount, optionalThreshold, requiredDvns, optionalDvns] =
      cfg as [bigint, bigint, bigint, bigint, string[], string[]];

    console.log(`     confirmations:      ${confirmations}`);
    console.log(`     requiredDVNCount:   ${requiredCount}`);
    console.log(`     optionalDVNCount:   ${optionalCount}  threshold ${optionalThreshold}`);
    for (const d of requiredDvns) console.log(`       required: ${d}  (${dvnName(local.network, d)})`);
    for (const d of optionalDvns) console.log(`       optional: ${d}  (${dvnName(local.network, d)})`);

    const effective = Number(requiredCount) + Number(optionalThreshold);
    check(
      effective >= 2,
      `${label}: at least 2 independent verifiers required`,
      `effective=${effective}`
    );
    if (effective < 2) {
      console.log(
        `\n     CRITICAL: a 1-of-1 DVN configuration is what enabled the ~$292M Kelp/rsETH\n` +
          `     loss in April 2026. Never ship this.\n`
      );
    }
    const unknown = [...requiredDvns, ...optionalDvns].filter(
      (d) => dvnName(local.network, d) === "UNKNOWN"
    );
    check(unknown.length === 0, `${label}: all DVNs are recognised operators`, unknown.join(", "));

    // digest to compare across chains
    const digest = ethers.keccak256(
      abi.encode(
        ["uint64", "uint8", "uint8", "uint8", "address[]", "address[]"],
        [
          confirmations,
          requiredCount,
          optionalCount,
          optionalThreshold,
          [...requiredDvns].map((d) => d.toLowerCase()).sort(),
          [...optionalDvns].map((d) => d.toLowerCase()).sort(),
        ]
      )
    );
    console.log(`     ${label} ULN digest: ${digest}`);
    console.log(
      `     ^ compare this with the ${label === "send" ? "RECEIVE" : "SEND"} digest on ${remote.network}`
    );
    return { digest, requiredDvns };
  }

  const send = await readUln(local.sendUln302, "send");
  const recv = await readUln(local.receiveUln302, "receive");
  check(
    send.digest === recv.digest,
    `local send and receive ULN configs agree`,
    `they should normally be symmetric`
  );

  // policy: our default required set
  try {
    const expected = requiredDvnAddresses(local.network);
    const actual = [...send.requiredDvns].map((d) => d.toLowerCase()).sort();
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `required DVNs match the configured policy`,
      `expected ${expected.map((d) => dvnName(local.network, d)).join("+")}`
    );
  } catch {
    console.log(`     (no DVN policy table for ${local.network}; skipping policy comparison)`);
  }

  // ---------------------------------------------------------------- executor
  console.log(`\n-- executor config --`);
  try {
    const raw = await endpoint.getConfig(
      adapterAddr,
      local.sendUln302,
      remote.eid,
      CONFIG_TYPE_EXECUTOR
    );
    const [cfg] = abi.decode(["tuple(uint32,address)"], raw);
    const [maxMessageSize, executor] = cfg as [bigint, string];
    console.log(`     maxMessageSize: ${maxMessageSize}`);
    console.log(`     executor:       ${executor}`);
    check(
      executor.toLowerCase() === local.executor.toLowerCase(),
      `executor is the expected LayerZero executor`
    );
  } catch (e: any) {
    check(false, `executor config readable`, e.shortMessage ?? e.message);
  }

  // ---------------------------------------------------------------- enforced options
  console.log(`\n-- enforced options --`);
  const enforced = await adapter.enforcedOptions(remote.eid, 1);
  console.log(`     msgType 1: ${enforced}`);
  check(enforced !== "0x", `enforced options set for SEND (msgType 1)`, `prevents users underpaying destination gas`);

  // ---------------------------------------------------------------- rate limits
  console.log(`\n-- rate limits --`);
  const rl = await adapter.rateLimits(remote.eid);
  const [amountInFlight, lastUpdated, limit, window] = rl as unknown as [bigint, bigint, bigint, bigint];
  console.log(`     limit:  ${ethers.formatEther(limit)} FULA per ${window}s`);
  console.log(`     in flight: ${ethers.formatEther(amountInFlight)} FULA (lastUpdated ${lastUpdated})`);
  check(
    limit > 0n,
    `rate limit configured`,
    limit === 0n ? "FAIL-CLOSED: every transfer will revert with RateLimitExceeded" : ""
  );
  check(window > 12n, `window exceeds block time`, `${window}s`);

  // ---------------------------------------------------------------- token side
  console.log(`\n-- token authorization --`);
  try {
    const tokenC = await ethers.getContractAt("StorageToken", token);
    const minter = await tokenC.bridgeMinters(adapterAddr);
    console.log(`     enabled:   ${minter.enabled}`);
    console.log(`     cap:       ${ethers.formatEther(minter.cap)} FULA`);
    console.log(`     netMinted: ${ethers.formatEther(minter.netMinted)} FULA`);
    check(minter.enabled, `adapter is an authorized bridge minter`);
    check(minter.cap > 0n, `cap is non-zero`);
    if (minter.cap > 0n) {
      const used = (minter.netMinted * 100n) / minter.cap;
      if (minter.netMinted > 0n && used >= 80n) {
        console.log(`     WARNING: ${used}% of cap consumed — raising it takes a 24h governance cycle.`);
      }
    }
    check(!(await tokenC.paused()), `token is not paused`);
  } catch (e: any) {
    check(false, `token bridgeMinters readable`, e.shortMessage ?? e.message);
  }

  console.log(`\n${"=".repeat(72)}`);
  if (failures > 0) {
    console.log(`${failures} CHECK(S) FAILED — do not proceed to the next rollout stage.`);
    console.log(`${"=".repeat(72)}`);
    process.exit(1);
  }
  console.log(`ALL CHECKS PASSED for ${local.network} -> ${remote.network}.`);
  console.log(`Now run the same on ${remote.network} and confirm the ULN digests cross-match.`);
  console.log(`${"=".repeat(72)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// ADAPTER=0x.. REMOTE_ADAPTER=0x.. REMOTE=base npx hardhat run scripts/bridge/verifyOAppConfig.ts --network ethereum
