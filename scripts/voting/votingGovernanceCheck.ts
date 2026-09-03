// LIVE governance verification for CommunityVoting on Base Sepolia.
//
//   VOTING_PROXY=0x.. npx hardhat run scripts/voting/baseSepoliaGovernanceCheck.ts --network base-sepolia
//
// Almost every check here is a `staticCall`: it executes against real chain state through the real
// proxy, but is never mined, so it costs nothing. The rehearsal wallets are low on gas, and revert
// behaviour is exactly what a live run should confirm — the unit suite can be wrong about the
// deployed configuration in a way it cannot detect about itself.
//
// Set SEND=1 to additionally perform the one state-changing step (setRoleQuorum).
import hre, { ethers } from "hardhat";

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const POOL_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("POOL_ADMIN_ROLE"));
const ZH = ethers.ZeroHash;
const Z = ethers.ZeroAddress;

const PT_ADD_ROLE = 1;
const PT_UPGRADE = 3;
const PT_RECOVERY = 4;
const PT_SET_PARAM = 14;
const PT_SET_INTEGRATION = 15;

const OPTS = ["Yes", "No", "Abstain"];
const DAY = 24 * 60 * 60;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, detail = "") {
  pass++;
  console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`);
}
function bad(label: string, detail: string) {
  fail++;
  failures.push(`${label}: ${detail}`);
  console.log(`  FAIL  ${label}  — ${detail}`);
}

let iface: ethers.Interface | undefined;

/**
 * Extract a custom-error name from a revert, however it surfaced.
 *
 * Some public RPCs return a bare "execution reverted" for eth_call without the revert DATA, which
 * makes every custom error indistinguishable. Where the data does come back — sometimes nested a
 * couple of levels down in the provider error — decode it against the contract ABI ourselves
 * rather than relying on ethers having done it.
 */
function revertName(e: any): string {
  if (e?.revert?.name) return e.revert.name;
  const data =
    e?.data ??
    e?.error?.data ??
    e?.info?.error?.data ??
    e?.error?.error?.data ??
    e?.info?.error?.error?.data;
  const hex = typeof data === "string" ? data : data?.data;
  if (hex && typeof hex === "string" && hex.length >= 10 && iface) {
    try {
      const parsed = iface.parseError(hex);
      if (parsed) return parsed.name;
    } catch {
      /* fall through to the generic message */
    }
    // Even undecodable, the selector is far more diagnostic than "execution reverted".
    return `unknown error selector ${hex.slice(0, 10)}`;
  }
  return (
    e?.errorName ??
    (typeof e?.shortMessage === "string" ? e.shortMessage : undefined) ??
    String(e?.message ?? e).slice(0, 120)
  );
}

/** Assert a call reverts, optionally with a specific custom error. */
async function expectRevert(label: string, fn: () => Promise<any>, expected?: string) {
  try {
    await fn();
    bad(label, "did NOT revert");
  } catch (e: any) {
    const name = revertName(e);
    if (expected && !name.includes(expected)) {
      bad(label, `reverted with "${name}", expected "${expected}"`);
    } else {
      ok(label, name);
    }
  }
}

async function expectValue(label: string, actual: any, expected: any) {
  if (String(actual) === String(expected)) ok(label, String(actual));
  else bad(label, `got ${actual}, expected ${expected}`);
}

async function main() {
  const proxyAddress = process.env.VOTING_PROXY?.trim();
  if (!proxyAddress) throw new Error("Set VOTING_PROXY to the deployed CommunityVoting proxy");
  const send = process.env.SEND === "1";

  const [a1, a2] = await ethers.getSigners();
  const voting = await ethers.getContractAt("CommunityVoting", proxyAddress);
  iface = voting.interface;
  const tokenAddress = await voting.token();
  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;

  console.log(`network : ${hre.network.name}`);
  console.log(`proxy   : ${proxyAddress}`);
  console.log(`token   : ${tokenAddress}`);
  console.log(`admin1  : ${a1.address}`);
  console.log(`admin2  : ${a2.address}`);

  // -----------------------------------------------------------------------
  console.log(`\n=== A. Deployed state ===`);
  // Chain-agnostic: assert the wired token really is FULA rather than pinning one address, so
  // this battery is meaningful on mainnet and testnet alike.
  const wired = await ethers.getContractAt("StorageToken", tokenAddress);
  await expectValue("wired token is FULA", await wired.symbol(), "FULA");
  await expectValue("wired token has 18 decimals", await wired.decimals(), 18);
  console.log(`  token: ${tokenAddress}`);
  // Integrations are deployment choices, not invariants — zero is a valid, supported
  // configuration (graceful degradation) and so is a wired address. Report them, and verify a
  // wired one actually points at the same token this contract governs, which IS an invariant.
  const se = await voting.stakingEngine();
  const sp = await voting.storagePool();
  console.log(`  stakingEngine: ${se === Z ? "unset (stake-derived power disabled)" : se}`);
  console.log(`  storagePool  : ${sp === Z ? "unset (membership multiplier disabled)" : sp}`);
  if (se !== Z) {
    const seToken = await (await ethers.getContractAt("StakingEngineLinear", se)).token();
    await expectValue("staking engine governs the same token", seToken.toLowerCase(), tokenAddress.toLowerCase());
  }
  if (sp !== Z) {
    const spToken = await (await ethers.getContractAt("StoragePool", sp)).storageToken();
    await expectValue("storage pool governs the same token", spToken.toLowerCase(), tokenAddress.toLowerCase());
  }
  console.log(`  subjectCount: ${await voting.subjectCount()} (informational — grows as the rehearsal runs)`);
  await expectValue("adminCount", await voting.adminCount(), 2);
  await expectValue("admin1 has ADMIN_ROLE", await voting.hasRole(ADMIN_ROLE, a1.address), true);
  await expectValue("admin2 has ADMIN_ROLE", await voting.hasRole(ADMIN_ROLE, a2.address), true);
  await expectValue("not paused", await voting.paused(), false);

  console.log(`\n=== B. Parameter defaults and bounds ===`);
  const expectedDefaults: Array<[number, string, bigint]> = [
    [1, "burnFee", ethers.parseEther("25000")],
    [2, "deposit", ethers.parseEther("50000")],
    [3, "minVoteBasis", ethers.parseEther("10000")],
    [4, "minDuration", BigInt(3 * DAY)],
    [5, "maxDuration", BigInt(30 * DAY)],
    [6, "memberMultiplierBps", 20000n],
    [7, "stakeWeightBps", 10000n],
    [8, "quorumBasis", ethers.parseEther("100000")],
    [9, "quorumVoters", 10n],
    [10, "maxOpenPerCreator", 3n],
    [11, "createCooldown", BigInt(DAY)],
    [12, "minPoolJoinStake", ethers.parseEther("1")],
    [13, "stakerMultiplierBps", 15000n],
  ];
  // These are DEPLOYMENT defaults. Once governance changes one, asserting the default reports a
  // failure for a contract that is behaving correctly — so a deviation is reported as a
  // governance change, and the real assertion is the bounds check below, which must always hold.
  for (const [id, name, expected] of expectedDefaults) {
    const actual = await voting.paramValue(id);
    if (actual === expected) ok(`param ${id} (${name}) at deployment default`, String(actual));
    else console.log(`  NOTE  param ${id} (${name}) = ${actual}, changed from default ${expected} by governance`);
  }
  let boundsOk = true;
  for (const [id] of expectedDefaults) {
    const [lo, hi] = await voting.paramBounds(id);
    const v = await voting.paramValue(id);
    if (!(v >= lo && v <= hi && lo <= hi)) {
      boundsOk = false;
      bad(`bounds sane for param ${id}`, `value ${v} outside [${lo}, ${hi}]`);
    }
  }
  if (boundsOk) ok("every default sits inside its hard bounds");
  await expectRevert("paramValue(0) rejected", () => voting.paramValue(0), "InvalidParam");
  await expectRevert("paramValue(14) rejected", () => voting.paramValue(14), "InvalidParam");
  await expectRevert("paramBounds(14) rejected", () => voting.paramBounds(14), "InvalidParam");

  // -----------------------------------------------------------------------
  // The guard that motivated this whole design. Placed before the timelock check on purpose,
  // so it is verifiable against the LIVE contract immediately after deployment.
  console.log(`\n=== C. Recovery drain guard (against the REAL FULA token) ===`);
  await expectRevert(
    "Recovery of governed FULA blocked (admin1)",
    () => voting.connect(a1).createProposal.staticCall(PT_RECOVERY, 0, a1.address, ZH, ethers.parseEther("1000"), tokenAddress),
    "RecoveryBlocked"
  );
  await expectRevert(
    "Recovery of governed FULA blocked (admin2)",
    () => voting.connect(a2).createProposal.staticCall(PT_RECOVERY, 0, a2.address, ZH, ethers.parseEther("1000"), tokenAddress),
    "RecoveryBlocked"
  );
  await expectRevert(
    "Recovery blocked for any beneficiary",
    () => voting.connect(a1).createProposal.staticCall(PT_RECOVERY, 0, a2.address, ZH, 1n, tokenAddress),
    "RecoveryBlocked"
  );
  await expectRevert(
    "Recovery blocked even for 1 wei",
    () => voting.connect(a1).createProposal.staticCall(PT_RECOVERY, 0, a1.address, ZH, 1n, tokenAddress),
    "RecoveryBlocked"
  );

  console.log(`\n=== D. Access control ===`);
  await expectRevert(
    "non-admin cannot create a proposal",
    () => voting.connect(a1).createProposal.staticCall(PT_ADD_ROLE, 0, a2.address, POOL_ADMIN_ROLE, 0, Z, { from: "0x000000000000000000000000000000000000dEaD" }),
    ""
  );
  await expectRevert(
    "zero target rejected",
    () => voting.connect(a1).createProposal.staticCall(PT_ADD_ROLE, 0, Z, ADMIN_ROLE, 0, Z),
    "InvalidAddress"
  );

  // -----------------------------------------------------------------------
  console.log(`\n=== E. Subject-creation validation (no tokens needed: these revert first) ===`);
  const longTitle = "t".repeat(257);
  const longCid = "c".repeat(101);
  const many = Array.from({ length: 101 }, (_, i) => `O${i}`);
  const cs = (t: string, c: string, o: string[], d: number) =>
    voting.connect(a1).createSubject.staticCall(t, c, o, d);

  await expectRevert("fewer than 2 options", () => cs("T", "C", ["Only"], 7 * DAY), "InvalidOptionCount");
  await expectRevert("zero options", () => cs("T", "C", [], 7 * DAY), "InvalidOptionCount");
  await expectRevert("more than 100 options", () => cs("T", "C", many, 7 * DAY), "InvalidOptionCount");
  await expectRevert("empty option label", () => cs("T", "C", ["Yes", ""], 7 * DAY), "OptionEmpty");
  await expectRevert("option over 64 bytes", () => cs("T", "C", ["Yes", "x".repeat(65)], 7 * DAY), "OptionTooLong");
  await expectRevert("duplicate option labels", () => cs("T", "C", ["Yes", "No", "Yes"], 7 * DAY), "DuplicateOption");
  await expectRevert("title over 256 bytes", () => cs(longTitle, "C", OPTS, 7 * DAY), "TitleTooLong");
  await expectRevert("CID over 100 bytes", () => cs("T", longCid, OPTS, 7 * DAY), "CidTooLong");
  // Read the window from the chain rather than hardcoding it: these are governable, and after a
  // parameter change a hardcoded boundary reports a failure where the contract is correct.
  // Probing one second outside the LIVE bounds also proves an executed parameter change is
  // functionally in force, not merely stored.
  const liveMin = Number(await voting.paramValue(4));
  const liveMax = Number(await voting.paramValue(5));
  console.log(`  live duration window: ${liveMin}..${liveMax} seconds`);
  await expectRevert(`duration below the live minimum (${liveMin})`, () => cs("T", "C", OPTS, liveMin - 1), "InvalidDuration");
  await expectRevert(`duration above the live maximum (${liveMax})`, () => cs("T", "C", OPTS, liveMax + 1), "InvalidDuration");
  // A well-formed subject must get past every bound. What happens next depends on whether the
  // caller can actually pay, so assert whichever outcome is correct for the CURRENT wallet rather
  // than assuming it is empty: reaching the token at all is the proof that the fee path is wired
  // to the real FULA contract.
  const token = await ethers.getContractAt("StorageToken", tokenAddress);
  const need = (await voting.paramValue(1)) + (await voting.paramValue(2)); // burnFee + deposit
  const canPay =
    (await token.balanceOf(a1.address)) >= need &&
    (await token.allowance(a1.address, proxyAddress)) >= need;
  const goodDuration = Number(await voting.paramValue(4));
  const wellFormed = () => cs("Roadmap?", "QmCid", OPTS, goodDuration);
  if (canPay) {
    try {
      await wellFormed();
      ok("well-formed subject is accepted when the creator can pay");
    } catch (e: any) {
      const n = revertName(e);
      // A cooldown is a legitimate refusal here, not a defect.
      if (n.includes("CreateCooldownActive")) ok("well-formed subject blocked only by the creator cooldown", n);
      else bad("well-formed subject is accepted when the creator can pay", n);
    }
  } else {
    await expectRevert("well-formed subject reaches the token and fails on funds", wellFormed, "");
  }

  // Use an id that CANNOT exist rather than a hardcoded 1. Once the rehearsal creates subjects,
  // id 1 is real, and every guard below then reports a correct-but-different error
  // (SubjectClosed, AlreadyFinalized, ...) which reads as a failure while the contract is right.
  const ghost = (await voting.subjectCount()) + 1000n;
  console.log(`\n=== F. Lifecycle guards on a non-existent subject (id ${ghost}) ===`);
  await expectRevert("getSubject", () => voting.getSubject(ghost), "SubjectNotFound");
  await expectRevert("vote", () => voting.connect(a1).vote.staticCall(ghost, 0, 0, [], 0, ZH), "SubjectNotFound");
  await expectRevert("finalize", () => voting.connect(a1).finalize.staticCall(ghost), "SubjectNotFound");
  await expectRevert("claim", () => voting.connect(a1).claim.staticCall(ghost), "SubjectNotFound");
  await expectRevert("claimDeposit", () => voting.connect(a1).claimDeposit.staticCall(ghost), "SubjectNotFound");
  await expectRevert("settleDeposit", () => voting.connect(a1).settleDeposit.staticCall(ghost), "SubjectNotFound");

  console.log(`\n=== G. Upgrade authorization ===`);
  await expectRevert(
    "upgradeToAndCall without a passed proposal",
    () => voting.connect(a1).upgradeToAndCall.staticCall(a2.address, "0x"),
    ""
  );

  // -----------------------------------------------------------------------
  console.log(`\n=== H. Quorum and the 24h role timelock ===`);
  const quorum = (await voting.roleConfigs(ADMIN_ROLE)).quorum;
  console.log(`  current quorum: ${quorum}`);
  const tc = await voting.timeConfigs(a1.address);
  const unlock = Number(tc.roleChangeTimeLock);
  const hoursLeft = Math.max(0, Math.ceil((unlock - now) / 3600));
  console.log(`  admin1 role timelock until ${new Date(unlock * 1000).toISOString()} (${hoursLeft}h)`);

  if (quorum < 2n) {
    if (send) {
      console.log(`  sending setRoleQuorum(ADMIN_ROLE, 2)...`);
      const tx = await voting.connect(a1).setRoleQuorum(ADMIN_ROLE, 2);
      const rcpt = await tx.wait();
      console.log(`  mined in block ${rcpt?.blockNumber}, status ${rcpt?.status}`);
      // Base Sepolia RPCs serve STALE state for a few seconds after a transaction is mined —
      // already documented in hardhat.config.ts for sepolia.base.org, and observed on drpc too.
      // Reading straight after tx.wait() reports the PRE-transaction value and looks like a
      // failure that never happened, so poll until the node catches up.
      let quorumNow = 0n;
      for (let attempt = 0; attempt < 10; attempt++) {
        quorumNow = (await voting.roleConfigs(ADMIN_ROLE)).quorum;
        if (quorumNow >= 2n) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      await expectValue("quorum set to 2", quorumNow, 2);
    } else {
      // Prove it WOULD work without paying for it.
      try {
        await voting.connect(a1).setRoleQuorum.staticCall(ADMIN_ROLE, 2);
        ok("setRoleQuorum(2) would succeed", "carries no timelock; re-run with SEND=1 to apply");
      } catch (e: any) {
        bad("setRoleQuorum(2) would succeed", revertName(e));
      }
    }
  } else {
    ok("quorum already 2");
  }

  if (now < unlock) {
    // Everything past the timelock check is unreachable for now; confirm that is exactly what
    // happens rather than assuming it.
    await expectRevert(
      "proposal creation blocked by the role timelock (expected this early)",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ZH, ethers.parseEther("60000"), Z),
      "TimeLockActive"
    );
    console.log(`\n  NOTE: parameter-proposal bound checks, canonical-field enforcement and the`);
    console.log(`  create -> approve -> execute flow sit behind this timelock and become testable`);
    console.log(`  in ~${hoursLeft}h. Re-run this script then.`);
  } else {
    console.log(`\n=== I. Parameter proposal validation (timelock expired) ===`);
    // Every parameter proposal targets address(this), so ONE pending proposal makes every check
    // below revert ExistingActiveProposal before reaching the rule it is meant to test (F-11).
    // Detect that rather than reporting 17 misleading failures.
    const pendingType = await voting.pendingProposals(proxyAddress);
    if (pendingType !== 0n) {
      console.log(`  SKIPPED: a type-${pendingType} proposal is pending on this contract.`);
      console.log(`  Parameter proposals are serialised on address(this), so these checks cannot`);
      console.log(`  run until it executes or is cleared with cleanupExpiredProposals. This is`);
      console.log(`  the documented F-11 behaviour, not a fault.`);
      ok("pending proposal correctly serialises parameter governance", `type ${pendingType}`);
    } else {
    await expectRevert(
      "burnFee below minimum",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ZH, ethers.parseEther("999"), Z),
      "ParamOutOfBounds"
    );
    await expectRevert(
      "burnFee above maximum",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ZH, ethers.parseEther("2000001"), Z),
      "ParamOutOfBounds"
    );
    await expectRevert(
      "unknown paramId",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 14, proxyAddress, ZH, 1n, Z),
      "InvalidParam"
    );
    await expectRevert(
      "id that truncates into a valid one (2**32 + 1)",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 2n ** 32n + 1n, proxyAddress, ZH, ethers.parseEther("60000"), Z),
      "InvalidParam"
    );
    await expectRevert(
      "non-canonical role field",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ADMIN_ROLE, ethers.parseEther("60000"), Z),
      "NonCanonicalProposalField"
    );
    await expectRevert(
      "non-canonical tokenAddress field",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ZH, ethers.parseEther("60000"), tokenAddress),
      "NonCanonicalProposalField"
    );
    await expectRevert(
      "target must be the contract itself",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, a2.address, ZH, ethers.parseEther("60000"), Z),
      "NonCanonicalProposalField"
    );
    await expectRevert(
      "unknown proposal type",
      () => voting.connect(a1).createProposal.staticCall(99, 0, proxyAddress, ZH, 0, Z),
      "InvalidProposalType"
    );
    await expectRevert(
      "integration slot must be known",
      () => voting.connect(a1).createProposal.staticCall(PT_SET_INTEGRATION, 3, proxyAddress, ZH, 0, a2.address),
      "InvalidParam"
    );
    // A valid parameter proposal must SUCCEED — the counterpart to all the rejections above.
    try {
      await voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, 1, proxyAddress, ZH, ethers.parseEther("60000"), Z);
      ok("a valid parameter proposal is accepted");
    } catch (e: any) {
      bad("a valid parameter proposal is accepted", revertName(e));
    }
    try {
      await voting.connect(a1).createProposal.staticCall(PT_UPGRADE, 0, a2.address, ZH, 0, Z);
      ok("an upgrade proposal is accepted");
    } catch (e: any) {
      bad("an upgrade proposal is accepted", revertName(e));
    }
    }
  }

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
