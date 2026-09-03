// Verifies the read path that fulawebsite/js/governance.js uses, against the live
// chains, so the UI's contract wiring is proven independently of a browser.
//
//   node scripts/voting/verifyUiReadPath.js
//
// It deliberately uses the SAME hand-written ABI fragments and the SAME algorithms as
// the page — not the compiled artifact — because those fragments and algorithms are
// the thing under test. Two behaviours it exists to protect:
//
//   1. Ballot option TEXT is not stored on-chain, only keccak256 of each label. The
//      text lives in the SubjectOptions event, so the UI recovers labels from logs and
//      verifies them against optionHashes. This checks that recovery still works.
//
//   2. Public Base RPCs disagree wildly about eth_getLogs. publicnode answers 403 on
//      mainnet and serves a successful EMPTY array for pruned ranges on Sepolia, while
//      other endpoints return the very same log. So an empty result means "this
//      endpoint does not know", never "there are none" — every endpoint must agree
//      before nothing is reported. Both the page and this script follow that rule.
const { ethers } = require("ethers");

const ABI = [
  "function subjectCount() view returns (uint256)",
  "function getSubject(uint256) view returns (tuple(address creator,uint40 createdAt,uint40 closeTime,uint16 optionCount,uint96 deposit,uint32 voterCount,uint16 winningOption,uint8 status,bool tied,bool depositRefundable,bool depositSettled,uint128 totalPowerCast,uint128 totalBasis,uint96 quorumBasisAt,uint32 quorumVotersAt,uint32 memberMultiplierBpsAt,uint32 stakerMultiplierBpsAt,uint16 stakeWeightBpsAt,uint96 minVoteBasisAt,uint96 minPoolJoinStakeAt,string title,string descriptionCID))",
  "function optionHashes(uint256,uint256) view returns (bytes32)",
  "function tally(uint256,uint16) view returns (uint128)",
  "function getReceipt(uint256,address) view returns (tuple(uint128 lockedAmount,uint128 power,uint128 basis,uint16 option,bool voted,bool claimed,uint32 multiplierBps))",
  "function paramValue(uint8) view returns (uint256)",
  "function paramBounds(uint8) view returns (uint256 minValue,uint256 maxValue)",
  "function token() view returns (address)",
  "function stakingEngine() view returns (address)",
  "function storagePool() view returns (address)",
  "function paused() view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function roleConfigs(bytes32) view returns (uint16 quorum,uint240 transactionLimit)",
  "event SubjectOptions(uint256 indexed subjectId, string[] options)",
];
const ADMIN_ROLE = ethers.id("ADMIN_ROLE");
const OPTIONS_TOPIC = ethers.id("SubjectOptions(uint256,string[])");
const VOTECAST_TOPIC = ethers.id("VoteCast(uint256,address,uint16,uint128,uint128,uint32)");
const LOG_CHUNK = 9000;   // measured ceiling on public Base RPCs
const BLOCK_TIME = 2;     // Base produces a block every 2 seconds, exactly

// Mirrors computePower() in the page, which mirrors CommunityVoting.vote().
function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS " + m); } else { fail++; console.log("  FAIL " + m); } };

/** getLogs across a provider pool: an empty answer is "unknown", not "none". */
async function readLogs(pool, params) {
  for (const p of pool) {
    try {
      const logs = await p.getLogs(params);
      if (logs && logs.length) return logs;
    } catch (_) { /* refused, rate-limited, or range rejected */ }
  }
  return [];
}

/**
 * Locate a subject's SubjectOptions log by anchoring on time rather than scanning.
 * Base's fixed 2s block time makes the creating block predictable from createdAt to
 * within a handful of blocks, so this costs O(1) requests however old the subject is.
 * Walking back from head in 9k steps would instead cost one request per 9k blocks —
 * about 130 a month after deployment, growing without bound.
 */
async function findOptionsLog(pool, address, id, createdAt, headBlock, headTs, floor) {
  const idTopic = ethers.zeroPadValue(ethers.toBeHex(id), 32);
  const est = Math.max(floor, Math.min(headBlock, headBlock - Math.floor((headTs - Number(createdAt)) / BLOCK_TIME)));
  const scan = async (from, to) => {
    for (let lo = from; lo <= to; lo += LOG_CHUNK) {
      const logs = await readLogs(pool, { address, topics: [OPTIONS_TOPIC, idTopic], fromBlock: lo, toBlock: Math.min(to, lo + LOG_CHUNK - 1) });
      if (logs.length) return logs[logs.length - 1];
    }
    return null;
  };
  let doneLo = null, doneHi = null;
  for (const half of [4500, 15000, 50000, 150000]) {
    const from = Math.max(floor, est - half), to = Math.min(headBlock, est + half);
    const slices = doneLo === null ? [[from, to]] : [[from, doneLo - 1], [doneHi + 1, to]].filter(([a, b]) => a <= b);
    for (const [a, b] of slices) { const hit = await scan(a, b); if (hit) return { log: hit, est }; }
    doneLo = from; doneHi = to;
    if (from === floor && to === headBlock) break;
  }
  return { log: null, est };
}

async function run(label, rpcs, address, deployBlock, expect) {
  console.log("\n=== " + label + " " + address + " ===");
  const pool = [];
  for (const url of rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url, expect.chainId, { batchMaxCount: 1, staticNetwork: true });
      await p.getBlockNumber();
      pool.push(p);
    } catch (_) { /* endpoint down */ }
  }
  if (!pool.length) { console.log("  no reachable RPC"); fail++; return; }
  console.log(`reachable endpoints: ${pool.length}/${rpcs.length}`);
  const c = new ethers.Contract(address, ABI, pool[0]);

  const [token, engine, pool_, paused, count] = await Promise.all([
    c.token(), c.stakingEngine(), c.storagePool(), c.paused(), c.subjectCount(),
  ]);
  console.log(`token=${token} engine=${engine} storagePool=${pool_} paused=${paused} subjects=${count}`);
  if (expect.token) ok(token.toLowerCase() === expect.token.toLowerCase(), "token matches the recorded deployment");
  if (expect.engine) ok(engine.toLowerCase() === expect.engine.toLowerCase(), "stakingEngine matches the recorded deployment");

  let paramsOk = true; const bad = [];
  for (let id = 1; id <= 13; id++) {
    const v = await c.paramValue(id);
    const [lo, hi] = await c.paramBounds(id);
    if (v < lo || v > hi) { paramsOk = false; bad.push(`${id}:${v} not in [${lo},${hi}]`); }
  }
  ok(paramsOk, "all 13 parameters read and are within bounds" + (bad.length ? " — " + bad.join(", ") : ""));

  if (expect.admin) {
    ok(await c.hasRole(ADMIN_ROLE, expect.admin), `ADMIN_ROLE hash resolves — hasRole(${expect.admin.slice(0, 8)}…) is true`);
    ok(Number((await c.roleConfigs(ADMIN_ROLE)).quorum) === 2, "admin quorum is 2");
  }

  if (count === 0n) { console.log("  (no subjects yet — ballot and power checks need a populated deployment)"); return; }

  const head = await pool[0].getBlock("latest");
  const headBlock = head.number, headTs = Number(head.timestamp);
  const floor = deployBlock ?? 0;

  for (let id = 1n; id <= count; id++) {
    const s = await c.getSubject(id);
    console.log(`\n  subject ${id}: "${s.title}" options=${s.optionCount} voters=${s.voterCount} status=${s.status} tied=${s.tied} winner=${s.winningOption}`);

    const { log, est } = await findOptionsLog(pool, address, id, s.createdAt, headBlock, headTs, floor);
    ok(!!log, `    labels recovered from SubjectOptions logs (estimated block ${est}${log ? `, found at ${log.blockNumber}, off by ${est - log.blockNumber}` : ""})`);
    if (log) {
      const labels = ethers.AbiCoder.defaultAbiCoder().decode(["string[]"], log.data)[0];
      ok(labels.length === Number(s.optionCount), `    label count matches optionCount (${labels.length})`);
      let allMatch = true;
      for (let i = 0; i < labels.length; i++) {
        if ((await c.optionHashes(id, i)).toLowerCase() !== ethers.keccak256(ethers.toUtf8Bytes(labels[i])).toLowerCase()) {
          allMatch = false; console.log(`      mismatch @${i}: "${labels[i]}"`);
        }
      }
      ok(allMatch, `    every label hashes to its on-chain commitment  ${JSON.stringify(labels)}`);
    }

    let sum = 0n, best = -1n, bestI = 0, ties = 0;
    for (let i = 0; i < Number(s.optionCount); i++) {
      const t = await c.tally(id, i);
      sum += t;
      if (t > best) { best = t; bestI = i; ties = 1; } else if (t === best) ties++;
    }
    ok(sum === s.totalPowerCast, `    tallies sum to totalPowerCast (${sum})`);
    const quorumMet = s.voterCount >= s.quorumVotersAt && s.totalBasis >= s.quorumBasisAt;
    if (Number(s.status) === 1) {
      ok(Boolean(s.tied) === (ties > 1), "    tie flag agrees with the tallies");
      if (ties === 1) ok(Number(s.winningOption) === bestI, `    winningOption is the max tally (${bestI})`);
      ok(quorumMet === s.depositRefundable, "    quorum formula matches depositRefundable");
    }

    // Replay every recorded vote through the page's power formula. The receipt stores
    // the multiplier that was applied, so this checks the part the UI must get right:
    // floor(sqrt(basis)) first, THEN the multiplier — never folded inside the root.
    const voteTo = Math.min(headBlock, est + Math.ceil((Number(s.closeTime) - Number(s.createdAt)) / BLOCK_TIME) + 4500);
    const idTopic = ethers.zeroPadValue(ethers.toBeHex(id), 32);
    const votes = [];
    for (let lo = Math.max(floor, est - 4500); lo <= voteTo; lo += LOG_CHUNK) {
      votes.push(...await readLogs(pool, { address, topics: [VOTECAST_TOPIC, idTopic], fromBlock: lo, toBlock: Math.min(voteTo, lo + LOG_CHUNK - 1) }));
    }
    let checked = 0, mismatched = 0;
    for (const lg of votes) {
      const voter = ethers.getAddress("0x" + lg.topics[2].slice(26));
      const r = await c.getReceipt(id, voter);
      if (!r.voted) continue;
      checked++;
      const expected = (isqrt(BigInt(r.basis)) * BigInt(r.multiplierBps)) / 10000n;
      if (expected !== BigInt(r.power)) {
        mismatched++;
        console.log(`      power mismatch ${voter}: basis=${r.basis} mult=${r.multiplierBps} expected=${expected} chain=${r.power}`);
      }
    }
    ok(checked > 0, `    VoteCast logs recovered for this subject (${checked} of ${s.voterCount} voters)`);
    if (checked) ok(mismatched === 0, `    power formula reproduces every receipt exactly (${checked} checked)`);
  }
}

(async () => {
  await run(
    "Base mainnet",
    [
      "https://base-rpc.publicnode.com",
      "https://1rpc.io/base",
      "https://base-mainnet.public.blastapi.io",
      "https://base.drpc.org",
      "https://mainnet.base.org",
      "https://base.gateway.tenderly.co",
    ],
    "0xB8FCDb09C3828a4f8F5A0AEb2D7353719CECB013",
    50439299,
    {
      chainId: 8453,
      token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
      engine: "0xb2064743e3da40bB4C18e80620A02a38e87fB145",
      admin: "0x383a6A34C623C02dcf9BB7069FAE4482967fb713",
    }
  );

  // The rehearsal deployment has a finalized subject and 15 voters, so it is the only
  // place the ballot, tally and power paths can be exercised against real data.
  await run(
    "Base Sepolia rehearsal",
    [
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
      "https://sepolia.base.org",
      "https://base-sepolia.gateway.tenderly.co",
    ],
    "0x52db4Ab6A6123BB6dE3EBB874f99A0E4B6526139",
    null,
    { chainId: 84532 }
  );

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
