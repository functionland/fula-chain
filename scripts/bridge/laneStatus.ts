// LANE STATUS — detects the ONE failure mode that can wedge a bridge lane permanently.
//
// WHY THIS EXISTS. LayerZero executes inbound messages in nonce order. `MessagingChannel._clearPayload`
// walks from `lazyInboundNonce + 1` up to the nonce being executed and reverts `LZ_InvalidNonce` if
// any intermediate nonce has NO COMMITTED PAYLOAD. So the two ways a message can fail are not
// remotely equivalent:
//
//   VERIFICATION failure (no required DVN ever attests) -> the nonce never commits -> EVERY later
//     message on that lane becomes unexecutable, permanently, including by manual execution. This
//     is a lane outage, and it is only clearable by `endpoint.skip()` from the owner.
//
//   EXECUTION failure (InsufficientLiquidity, InboundRateLimitExceeded, recipient blacklisted,
//     token paused) -> the payload IS committed, so later messages execute straight past it. The
//     message parks and stays retryable forever. This is NOT a lane outage.
//
// That distinction is invisible on LayerZero Scan, which shows both as a message that has not
// arrived. This script separates them, and names the exact nonce that is blocking if one is.
//
// IT HAPPENED. On 2026-07-31 a wrong DVN address (present, live, but not serving this lane) meant
// the first real mainnet transfer never verified. It wedged the next transfer behind it even though
// that one had been fully attested by both required DVNs in 40 seconds. Recovery was `skip()`.
//
// Read-only. Queries both chains directly — it does NOT take --network, because a lane has two ends
// and the whole point is to compare them.
//
// USAGE:
//   ETHEREUM_ADAPTER=0x.. BASE_ADAPTER=0x.. npx hardhat run scripts/bridge/laneStatus.ts
//
//   Optional env:
//     TESTNET=1        inspect the Sepolia <-> Base Sepolia rehearsal lanes instead
//     SCAN=50          how many recent nonces to classify per lane (default 25)
//     STALE_MINUTES=15 age past which an unverified nonce is reported as a WEDGE, not "in flight"
//     ETHEREUM_RPC / BASE_RPC / SEPOLIA_RPC / BASE_SEPOLIA_RPC   override endpoints
//
// EXIT CODES:  0 = lane healthy (parked messages may still be reported) · 1 = LANE WEDGED
import { ethers } from "ethers";

const ENDPOINT_ABI = [
  "function lazyInboundNonce(address,uint32,bytes32) view returns (uint64)",
  "function inboundNonce(address,uint32,bytes32) view returns (uint64)",
  "function outboundNonce(address,uint32,bytes32) view returns (uint64)",
  "function inboundPayloadHash(address,uint32,bytes32,uint64) view returns (bytes32)",
  // Destructive nonce operations. A skipped or burnt nonce leaves NO on-chain trace in the nonce
  // counters — afterwards it is indistinguishable from one that delivered normally. Only these
  // events record that it happened, which is why the scan reads them rather than inferring.
  "event InboundNonceSkipped(uint32 srcEid, bytes32 sender, address receiver, uint64 nonce)",
  "event PacketNilified(uint32 srcEid, bytes32 sender, address receiver, uint64 nonce, bytes32 payloadHash)",
  "event PacketBurnt(uint32 srcEid, bytes32 sender, address receiver, uint64 nonce, bytes32 payloadHash)",
];
const ADAPTER_ABI = [
  "function peers(uint32) view returns (bytes32)",
  "function token() view returns (address)",
  "function availableLiquidity() view returns (uint256)",
  "function getAmountCanBeReceived(uint32) view returns (uint256,uint256)",
];

interface End {
  name: string;
  rpc: string;
  eid: number;
  endpoint: string;
  adapter?: string;
}

const MAINNET: End[] = [
  {
    name: "Ethereum",
    rpc: process.env.ETHEREUM_RPC?.trim() || "https://ethereum-rpc.publicnode.com",
    eid: 30101,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    adapter: process.env.ETHEREUM_ADAPTER?.trim(),
  },
  {
    name: "Base",
    rpc: process.env.BASE_RPC?.trim() || "https://mainnet.base.org",
    eid: 30184,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    adapter: process.env.BASE_ADAPTER?.trim(),
  },
];

const TESTNET: End[] = [
  {
    name: "Sepolia",
    rpc: process.env.SEPOLIA_RPC?.trim() || "https://ethereum-sepolia.publicnode.com",
    eid: 40161,
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    adapter: process.env.SEPOLIA_ADAPTER?.trim() || "0x1a93D27cE441e86D3Fe0B2c3C7f76a9B6BA936f3",
  },
  {
    name: "BaseSep",
    rpc: process.env.BASE_SEPOLIA_RPC?.trim() || "https://base-sepolia-rpc.publicnode.com",
    eid: 40245,
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    adapter: process.env.BASE_SEPOLIA_ADAPTER?.trim() || "0x6bE953e030C23F4728446112aeD4AdB6ace19eD6",
  },
];

const ONE = 10n ** 18n;
function fmt(v: bigint): string {
  const whole = v / ONE;
  const frac = v % ONE;
  return whole.toLocaleString("en-US") + (frac ? ` + ${frac} wei` : "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public RPCs (mainnet.base.org in particular) rate-limit a tight `eth_call` loop, and ethers
 * surfaces that as `missing revert data` / CALL_EXCEPTION — indistinguishable at a glance from a
 * reverting contract. Retrying matters here beyond convenience: a monitor that ABORTS partway
 * through the nonce scan has not established that the lane is clear, and an operator who reads the
 * partial output as "fine" is exactly the failure this script exists to prevent.
 */
async function callWithRetry<T>(what: string, fn: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 400;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = `${e?.info?.error?.message ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`;
      const throttled = /rate limit|too many requests|429|missing revert data|timeout|SERVER_ERROR/i.test(msg);
      if (!throttled || i >= attempts) {
        throw new Error(`${what} failed after ${i} attempt(s): ${e?.shortMessage ?? e?.message ?? e}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
    }
  }
}

const wedges: string[] = [];
const parked: string[] = [];
const stranded: string[] = [];

/**
 * Find nonces destroyed by `skip` / `nilify` / `burn` on this lane.
 *
 * WHY THIS IS NOT OPTIONAL. `skip` advances `lazyInboundNonce` past a nonce without delivering it.
 * Every counter afterwards reads exactly as if the message had been delivered normally, so a naive
 * nonce comparison reports the lane HEALTHY while the tokens that message represented sit locked in
 * the SOURCE escrow forever with no claim against them. Each skip therefore widens a permanent
 * escrow imbalance that no counter reveals. Since `skip` is the standard recovery from a wedged
 * lane, that imbalance accumulates precisely when the bridge is under stress.
 */
async function findDestroyedNonces(
  ep: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  receiver: string,
  srcEid: number,
  sender: string,
  lookback: number
): Promise<{ nonce: bigint; how: string }[]> {
  const latest = await callWithRetry("getBlockNumber", () => provider.getBlockNumber());
  const from = Math.max(0, latest - lookback);
  const out: { nonce: bigint; how: string }[] = [];

  for (const name of ["InboundNonceSkipped", "PacketNilified", "PacketBurnt"]) {
    try {
      // Endpoint events are not indexed, so filter by signature and match the fields in JS.
      const logs = await callWithRetry(`${name} logs`, () =>
        provider.getLogs({
          address: ep.target as string,
          topics: [ep.interface.getEvent(name)!.topicHash],
          fromBlock: from,
          toBlock: latest,
        })
      );
      for (const l of logs) {
        const d = ep.interface.decodeEventLog(name, l.data, l.topics);
        if (
          Number(d.srcEid) === srcEid &&
          String(d.receiver).toLowerCase() === receiver.toLowerCase() &&
          String(d.sender).toLowerCase() === sender.toLowerCase()
        ) {
          out.push({ nonce: BigInt(d.nonce), how: name });
        }
      }
    } catch (e: any) {
      // Never let this degrade into a silent "no skips found" — that is the exact false all-clear
      // this function exists to prevent.
      console.log(`    (could not read ${name} events: ${e.message ?? e} — skip detection INCOMPLETE)`);
      stranded.push(
        `${name} event scan failed — destroyed nonces may exist but were NOT detected. Re-run with a working archive RPC.`
      );
    }
  }
  return out.sort((a, b) => (a.nonce > b.nonce ? 1 : -1));
}

/** Inspect the lane src -> dst: what src has sent, and what dst has verified and executed. */
async function inspectLane(src: End, dst: End, scan: number) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`LANE  ${src.name} (eid ${src.eid})  ->  ${dst.name} (eid ${dst.eid})`);
  console.log(`${"=".repeat(72)}`);

  if (!src.adapter || !dst.adapter) {
    console.log(`  SKIPPED — adapter address not configured for ${!src.adapter ? src.name : dst.name}.`);
    return;
  }

  const srcProvider = new ethers.JsonRpcProvider(src.rpc);
  const dstProvider = new ethers.JsonRpcProvider(dst.rpc);
  const srcEp = new ethers.Contract(src.endpoint, ENDPOINT_ABI, srcProvider);
  const dstEp = new ethers.Contract(dst.endpoint, ENDPOINT_ABI, dstProvider);
  const srcAdapter = new ethers.Contract(src.adapter, ADAPTER_ABI, srcProvider);
  const dstAdapter = new ethers.Contract(dst.adapter, ADAPTER_ABI, dstProvider);

  // The lane is keyed by the PEER as each side sees it, not by the local address.
  const srcPeer: string = await callWithRetry("peers(src)", () => srcAdapter.peers(dst.eid)); // dst adapter, as src knows it
  const dstPeer: string = await callWithRetry("peers(dst)", () => dstAdapter.peers(src.eid)); // src adapter, as dst knows it
  if (srcPeer === ethers.ZeroHash || dstPeer === ethers.ZeroHash) {
    console.log(`  NOT WIRED — peer is unset on ${srcPeer === ethers.ZeroHash ? src.name : dst.name}.`);
    return;
  }

  // A peer that does not resolve back to the adapter we are watching means we would be reading a
  // different lane's counters and calling it healthy.
  const expectDst = ethers.zeroPadValue(ethers.getAddress(dst.adapter), 32).toLowerCase();
  const expectSrc = ethers.zeroPadValue(ethers.getAddress(src.adapter), 32).toLowerCase();
  if (srcPeer.toLowerCase() !== expectDst || dstPeer.toLowerCase() !== expectSrc) {
    console.log(`  *** PEER MISMATCH — the configured peers do not point at these adapters. ***`);
    console.log(`      ${src.name}.peers(${dst.eid}) = ${srcPeer}`);
    console.log(`      expected                      ${expectDst}`);
    console.log(`      ${dst.name}.peers(${src.eid}) = ${dstPeer}`);
    console.log(`      expected                      ${expectSrc}`);
    wedges.push(`${src.name}->${dst.name}: peer mismatch — counters below are not this lane's.`);
    return;
  }

  const sent: bigint = await callWithRetry("outboundNonce", () =>
    srcEp.outboundNonce(src.adapter, dst.eid, srcPeer)
  );
  const verified: bigint = await callWithRetry("inboundNonce", () =>
    dstEp.inboundNonce(dst.adapter, src.eid, dstPeer)
  );
  const executed: bigint = await callWithRetry("lazyInboundNonce", () =>
    dstEp.lazyInboundNonce(dst.adapter, src.eid, dstPeer)
  );

  console.log(`  sent from ${src.name.padEnd(9)} (outboundNonce)     ${sent}`);
  console.log(`  verified on ${dst.name.padEnd(7)} (inboundNonce)       ${verified}`);
  console.log(`  executed on ${dst.name.padEnd(7)} (lazyInboundNonce)   ${executed}`);

  // Destination's ability to pay out. A lock/release bridge can only release what it custodies.
  const liq: bigint = await callWithRetry("availableLiquidity", () => dstAdapter.availableLiquidity());
  console.log(`  ${dst.name} escrow available                  ${fmt(liq)} FULA`);
  try {
    const [inFlight, canReceive] = await callWithRetry("getAmountCanBeReceived", () =>
      dstAdapter.getAmountCanBeReceived(src.eid)
    );
    console.log(`  ${dst.name} inbound allowance left            ${fmt(canReceive)} FULA (in flight ${fmt(inFlight)})`);
  } catch {
    /* adapter predates the inbound limiter */
  }

  if (sent === 0n) {
    console.log(`\n  no messages have ever been sent on this lane.`);
    return;
  }

  // Classify each recent nonce. This is the part that separates a WEDGE from a PARK.
  const from = sent > BigInt(scan) ? sent - BigInt(scan) + 1n : 1n;
  if (from > 1n) console.log(`\n  (classifying the most recent ${scan} nonces; SCAN= to widen)`);

  // Destroyed nonces must be resolved BEFORE classifying, because a skipped nonce leaves the
  // counters looking exactly like a delivered one.
  const lookback = Number(process.env.LOOKBACK_BLOCKS?.trim() || "300000");
  const destroyed = await findDestroyedNonces(dstEp, dstProvider, dst.adapter, src.eid, dstPeer, lookback);
  const destroyedBy = new Map(destroyed.map((d) => [d.nonce, d.how]));

  let firstUnverified: bigint | null = null;
  const parkedNonces: bigint[] = [];

  for (let n = from; n <= sent; n++) {
    const hash: string = await callWithRetry(`inboundPayloadHash(${n})`, () =>
      dstEp.inboundPayloadHash(dst.adapter, src.eid, dstPeer, n)
    );
    await sleep(120); // stay under public-RPC request ceilings during the scan
    if (destroyedBy.has(n)) {
      continue; // accounted for separately below
    }
    if (hash !== ethers.ZeroHash) {
      // Committed but the payload is still there => it has NOT been executed yet.
      parkedNonces.push(n);
    } else if (n > executed) {
      // No payload and never executed => it never verified.
      if (firstUnverified === null) firstUnverified = n;
    }
  }

  if (destroyed.length) {
    console.log(`\n  DESTROYED NONCES (delivered nothing — the counters above hide this):`);
    for (const d of destroyed) console.log(`    nonce ${d.nonce}  via ${d.how}`);
    console.log(
      `    Each of these represents FULA that was locked in the ${src.name} escrow and released to\n` +
        `    nobody on ${dst.name}. Those tokens are NOT lost or stolen — they became permanent\n` +
        `    bridge liquidity owned by whoever funded the escrow — but ${src.name} escrow is now\n` +
        `    permanently larger than the claims against it, and no nonce counter shows that.\n` +
        `    If the sender was a user rather than the project, they must be made whole off-chain.`
    );
    stranded.push(
      `${src.name}->${dst.name}: ${destroyed.length} destroyed nonce(s) (${destroyed
        .map((d) => d.nonce)
        .join(", ")}) — ${src.name} escrow permanently exceeds outstanding claims by their value.`
    );
  } else {
    console.log(`\n  no nonces destroyed by skip/nilify/burn in the last ${lookback} blocks.`);
  }

  if (parkedNonces.length) {
    console.log(`\n  COMMITTED BUT NOT EXECUTED (parked, retryable — these do NOT block the lane):`);
    for (const n of parkedNonces) console.log(`    nonce ${n}`);
    console.log(
      `    Cause is execution-side: escrow short of liquidity, inbound rate limit reached,\n` +
        `    recipient blacklisted, or the token paused. Clear the condition and re-execute from\n` +
        `    LayerZero Scan. The tokens are not lost and later messages still deliver.`
    );
    parked.push(`${src.name}->${dst.name}: ${parkedNonces.length} parked message(s) — retryable.`);
  }

  if (firstUnverified !== null) {
    const inFlightMsg =
      `\n  NOT VERIFIED: nonce ${firstUnverified} has no committed payload.\n` +
      `    Everything above it on this lane is UNEXECUTABLE until it commits or is skipped.`;
    console.log(inFlightMsg);
    console.log(
      `    If this nonce was sent within the last few minutes this is NORMAL — it is still in\n` +
        `    flight. If it has been longer than ~15 minutes, verification is failing: check that\n` +
        `    both required DVNs are attesting (scripts/bridge/verifyOAppConfig.ts), fix the DVN\n` +
        `    config if wrong, and only then clear it with scripts/bridge/skipStuckNonce.ts.`
    );
    wedges.push(
      `${src.name}->${dst.name}: nonce ${firstUnverified} unverified — blocks nonces ` +
        `${firstUnverified + 1n}..${sent} (${sent - firstUnverified} message(s)) if it does not commit.`
    );
  }

  if (!parkedNonces.length && firstUnverified === null) {
    console.log(
      destroyed.length
        ? `\n  FLOWING — nothing is blocked, but see the destroyed nonces above: this lane is NOT clean.`
        : `\n  HEALTHY — every message sent on this lane has been verified and executed.`
    );
  }
}

async function main() {
  const isTestnet = process.env.TESTNET?.trim() === "1";
  const ends = isTestnet ? TESTNET : MAINNET;
  const scan = Number(process.env.SCAN?.trim() || "25");

  console.log(`FULA bridge lane status${isTestnet ? "  [TESTNET]" : ""}`);
  console.log(`run at: ${new Date().toISOString()}`);
  for (const e of ends) console.log(`  ${e.name.padEnd(9)} adapter ${e.adapter ?? "NOT CONFIGURED"}`);

  await inspectLane(ends[0], ends[1], scan);
  await inspectLane(ends[1], ends[0], scan);

  console.log(`\n${"=".repeat(72)}`);
  for (const p of parked) console.log(`PARKED   ${p}`);
  for (const s of stranded) console.log(`STRANDED ${s}`);
  for (const w of wedges) console.log(`WEDGE    ${w}`);
  if (wedges.length) {
    console.log(`${"=".repeat(72)}`);
    console.log(`${wedges.length} lane(s) have an unverified nonce. If it is not simply in flight,`);
    console.log(`the lane is blocked — investigate the DVN configuration before skipping anything.`);
    process.exit(1);
  }
  console.log(
    `NO LANE IS BLOCKED` +
      `${parked.length ? ` · ${parked.length} parked message(s), retryable` : ""}` +
      `${stranded.length ? ` · ${stranded.length} lane(s) carry stranded escrow — see STRANDED above` : ""}`
  );
  console.log(`${"=".repeat(72)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ETHEREUM_ADAPTER=0x.. BASE_ADAPTER=0x.. npx hardhat run scripts/bridge/laneStatus.ts
