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
// "CROSS-CHAIN" digest: A's SEND digest must equal B's RECEIVE digest.
//
// Use the CROSS-CHAIN digest, never the address-based one. A DVN operator has a DIFFERENT
// contract address on every chain, so the address-based digest cannot match across chains even
// when the configuration is perfectly correct. The cross-chain digest identifies DVNs by operator
// NAME (resolved through the DVNS table in addresses.ts), which is what R-07 actually cares about.
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
  check(Number(await adapter.sharedDecimals()) === 6, `sharedDecimals == 6 (dust granularity 1e12)`);
  check((await adapter.decimalConversionRate()) === 10n ** 12n, `decimalConversionRate == 1e12`);
  // TRUE is correct here and is the signature of a lock/release escrow adapter: it pulls tokens
  // with transferFrom, so holders must approve first. A mint/burn adapter would report false —
  // seeing false would mean the wrong adapter type is deployed.
  check((await adapter.approvalRequired()) === true, `approvalRequired() == true (escrow adapter)`);

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

    // ⚠️ THE CHECK ABOVE IS CIRCULAR ON ITS OWN — it only asks whether an address appears in OUR
    // table, so a wrong-but-recorded address passes. On 2026-07-31 it reported "all DVNs are
    // recognised operators" for a configuration whose DVNs do not serve this lane at all, and the
    // first real mainnet transfer hung in status BLOCKED because nothing ever attested.
    //
    // The authority is the CHAIN, not our table: compare against the live DEFAULT ULN config,
    // which is the set LayerZero itself runs for this pathway. A required DVN outside that set is
    // not automatically wrong — a deliberate non-default operator is legitimate — but it MUST be
    // confirmed to actually serve the lane, so this fails loudly rather than passing silently.
    try {
      // address(0) as the OApp returns the chain's DEFAULT config for this lane.
      const defRaw = await endpoint.getConfig(ethers.ZeroAddress, lib, remote.eid, CONFIG_TYPE_ULN);
      const [defCfg] = abi.decode([ULN_TUPLE], defRaw);
      const [, , , , defRequired, defOptional] = defCfg as [bigint, bigint, bigint, bigint, string[], string[]];
      const defaultSet = new Set([...defRequired, ...defOptional].map((d) => d.toLowerCase()));
      console.log(`     live DEFAULT required DVNs on this lane: ${defRequired.length}`);
      for (const d of defRequired) console.log(`       ${d}  (${dvnName(local.network, d)})`);

      const offDefault = requiredDvns.filter((d) => !defaultSet.has(d.toLowerCase()));
      check(
        offDefault.length === 0,
        `${label}: every required DVN is in the live DEFAULT set for this lane`,
        offDefault.length === 0
          ? ""
          : `NOT in the default set: ${offDefault.join(", ")} — these may never attest, which ` +
            `hangs every message in status BLOCKED. Verify each one actually serves this pathway ` +
            `before shipping, or switch to addresses from the default set above.`
      );
    } catch (e: any) {
      check(false, `${label}: could not read the live default ULN config`, e.shortMessage ?? e.message);
    }

    // LOCAL digest — includes raw DVN addresses. Valid ONLY for comparing send vs receive on
    // THIS chain. It is meaningless across chains: a DVN operator has a different address on
    // every chain, so two correctly-matched configs will always produce different local digests.
    const localDigest = ethers.keccak256(
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

    // CROSS-CHAIN digest — identifies DVNs by OPERATOR NAME rather than address, so it is
    // chain-independent and CAN legitimately match. This is the one that answers the question
    // R-07 actually asks: "does A's send side require the same verifier set that B's receive
    // side expects?". Sorted by name so ordering cannot affect the hash.
    const nameOf = (d: string) => dvnName(local.network, d);
    const crossDigest = ethers.keccak256(
      ethers.toUtf8Bytes(
        JSON.stringify({
          confirmations: confirmations.toString(),
          requiredCount: Number(requiredCount),
          optionalCount: Number(optionalCount),
          optionalThreshold: Number(optionalThreshold),
          required: [...requiredDvns].map(nameOf).sort(),
          optional: [...optionalDvns].map(nameOf).sort(),
        })
      )
    );

    console.log(`     ${label} ULN digest (local, address-based):  ${localDigest}`);
    console.log(`     ${label} ULN digest (CROSS-CHAIN, by operator): ${crossDigest}`);
    console.log(
      `     ^ THIS is the value to compare with the ${label === "send" ? "RECEIVE" : "SEND"} cross-chain digest on ${remote.network}.`
    );
    console.log(
      `       Do NOT compare the address-based digest across chains — DVN operators have`
    );
    console.log(`       different addresses per chain, so it can never match even when correct.`);
    return { digest: localDigest, crossDigest, requiredDvns };
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

  // The INBOUND bucket is the one that bounds a theft. Outbound only throttles how fast tokens
  // leave; inbound caps how much escrow a single forged or maliciously-authorised message can
  // remove. It is separately fail-closed, so an unset value silently parks every arrival.
  const irl = await adapter.inboundRateLimits(remote.eid);
  const [inFlightIn, , inboundLimit, inboundWindow] = irl as unknown as [bigint, bigint, bigint, bigint];
  console.log(`     INBOUND limit: ${ethers.formatEther(inboundLimit)} FULA per ${inboundWindow}s`);
  console.log(`     in flight:     ${ethers.formatEther(inFlightIn)} FULA`);
  check(
    inboundLimit > 0n,
    `inbound rate limit configured`,
    inboundLimit === 0n ? "FAIL-CLOSED: every inbound transfer will park with InboundRateLimitExceeded" : ""
  );

  // Sizing. `_credit` checks liquidity BEFORE the inbound limit, so a limit at or above the
  // escrow balance can NEVER fire: anything larger than escrow already reverted with
  // InsufficientLiquidity, and anything small enough to pass is by definition under the limit.
  // Such a limit is not merely weak — it is inert. That is a hard failure, not a note.
  const escrowedNow = await adapter.availableLiquidity();
  if (inboundLimit > 0n && escrowedNow > 0n) {
    const pct = (inboundLimit * 100n) / escrowedNow;
    console.log(
      `     inbound limit is ${pct}% of current escrow (${ethers.formatEther(escrowedNow)} FULA)`
    );
    check(
      inboundLimit < escrowedNow,
      `inbound limit is BELOW escrow (so it can actually fire)`,
      // Only explain on failure — `check` prints this line unconditionally.
      inboundLimit < escrowedNow
        ? ""
        : `limit ${ethers.formatEther(inboundLimit)} >= escrow ${ethers.formatEther(escrowedNow)}: ` +
          `InsufficientLiquidity always triggers first, so this limiter is INERT and bounds nothing`
    );
    if (inboundLimit < escrowedNow && pct > 25n) {
      console.log(
        `     NOTE: ${pct}% of escrow can be released in one window. The bucket starts full, so\n` +
          `           that is the instant first-tranche loss if a message is ever forged.\n` +
          `           Target 10-25%. Functional, but weaker than intended.`
      );
    }
  }

  // ---------------------------------------------------------------- peer lock
  console.log(`\n-- peer lock --`);
  const locked = await adapter.peersLocked();
  console.log(`     peersLocked: ${locked}`);
  check(
    locked,
    `peer set is FROZEN (lockPeers called)`,
    `while unlocked, the owner can repoint this lane at an address it controls and drain the ` +
      `entire escrow — no DVN compromise needed. Call lockPeers() once both lanes are proven.`
  );

  // ---------------------------------------------------------------- escrow liquidity
  //
  // This is a LOCK/RELEASE adapter: it holds no special power over the token and therefore needs
  // no governance authorization at all. What it does need is BALANCE — a chain can only release
  // tokens it already custodies. Liquidity replaces "is the minter authorized?" as the thing that
  // determines whether inbound transfers can succeed.
  console.log(`\n-- escrow liquidity --`);
  try {
    const tokenC = await ethers.getContractAt("StorageToken", token);
    const escrow: bigint = await tokenC.balanceOf(adapterAddr);
    const supply: bigint = await tokenC.totalSupply();
    console.log(`     escrowed here:  ${ethers.formatEther(escrow)} FULA`);
    console.log(`     local supply:   ${ethers.formatEther(supply)} FULA`);

    check(
      escrow > 0n,
      `adapter holds escrow liquidity`,
      escrow === 0n
        ? "every INBOUND transfer to this chain will revert InsufficientLiquidity and park"
        : ""
    );

    // A warning band rather than a hard threshold: what counts as "enough" is a function of
    // expected inbound flow, which this script cannot know. Surface it and let the operator judge.
    if (escrow > 0n) {
      const pctOfSupply = (escrow * 10000n) / supply;
      console.log(
        `     that is ${Number(pctOfSupply) / 100}% of this chain's supply — size it against expected INBOUND flow.`
      );
    }

    // The adapter must hold NO privileged position. Under mint/burn it needed one; under escrow a
    // privileged adapter would be a red flag, so assert the absence.
    const adminRole = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const bridgeOpRole = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));
    check(!(await tokenC.hasRole(adminRole, adapterAddr)), `adapter holds NO admin role`);
    check(
      !(await tokenC.hasRole(bridgeOpRole, adapterAddr)),
      `adapter holds NO bridge-operator role`
    );

    check(!(await tokenC.paused()), `token is not paused`);
  } catch (e: any) {
    check(false, `token state readable`, e.shortMessage ?? e.message);
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
