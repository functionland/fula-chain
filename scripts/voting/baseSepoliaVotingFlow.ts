// LIVE end-to-end voting flow for CommunityVoting on Base Sepolia.
//
//   VOTING_PROXY=0x.. STEP=<step> npx hardhat run scripts/voting/baseSepoliaVotingFlow.ts --network base-sepolia
//
// Steps, in order. Each is separately runnable so the run survives the two real time delays
// (a 24h proposal execution delay, and a subject that cannot close for 3 days):
//
//   fund    - pull FULA out of the token contract and distribute it to both admins
//   param   - stage a parameter change, to be approved 24h later (proves the execute path)
//   create  - create a real subject
//   vote    - cast votes from both admins
//   verify  - read back and check every derived value, plus the guards that must still refuse
//   approve - approve whatever proposal is pending (run 24h after `param`)
//   close   - finalize, claim, settle (run once the subject's closeTime has passed)
import hre, { ethers } from "hardhat";

const ZH = ethers.ZeroHash;
const Z = ethers.ZeroAddress;
const PT_SET_PARAM = 14;
const DAY = 24 * 60 * 60;

const P_MIN_DURATION = 4;

// Chosen so the expected powers are exact integers and a wrong result is obvious by eye:
// sqrt(1_000_000e18) = 1e12 and sqrt(250_000e18) = 5e11.
const VOTE_A = ethers.parseEther("1000000");
const VOTE_B = ethers.parseEther("250000");
const PULL = ethers.parseEther("10000000");
const TO_ADMIN2 = ethers.parseEther("2000000");

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(l: string, d = "") { pass++; console.log(`  PASS  ${l}${d ? "  — " + d : ""}`); }
function bad(l: string, d: string) { fail++; failures.push(`${l}: ${d}`); console.log(`  FAIL  ${l}  — ${d}`); }
function check(l: string, actual: any, expected: any) {
  if (String(actual) === String(expected)) ok(l, String(actual));
  else bad(l, `got ${actual}, expected ${expected}`);
}

let iface: ethers.Interface | undefined;
function revertName(e: any): string {
  if (e?.revert?.name) return e.revert.name;
  const d = e?.data ?? e?.error?.data ?? e?.info?.error?.data ?? e?.error?.error?.data;
  const hex = typeof d === "string" ? d : d?.data;
  if (hex && typeof hex === "string" && hex.length >= 10 && iface) {
    try { const p = iface.parseError(hex); if (p) return p.name; } catch { /* selector below */ }
    return `selector ${hex.slice(0, 10)}`;
  }
  return e?.shortMessage ?? String(e?.message ?? e).slice(0, 100);
}
async function expectRevert(l: string, fn: () => Promise<any>, expected?: string) {
  try { await fn(); bad(l, "did NOT revert"); }
  catch (e: any) {
    const n = revertName(e);
    if (expected && !n.includes(expected)) bad(l, `reverted "${n}", expected "${expected}"`);
    else ok(l, n);
  }
}

/** Base Sepolia RPCs serve stale state right after a tx is mined; poll until it catches up. */
async function settle(label: string, read: () => Promise<bigint>, want: bigint) {
  for (let i = 0; i < 15; i++) {
    if ((await read()) >= want) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  (warning: ${label} did not reach ${want} within the poll window)`);
}

async function main() {
  const proxyAddress = process.env.VOTING_PROXY?.trim();
  if (!proxyAddress) throw new Error("Set VOTING_PROXY");
  const step = (process.env.STEP ?? "verify").trim();

  const [a1, a2] = await ethers.getSigners();
  const voting = await ethers.getContractAt("CommunityVoting", proxyAddress);
  iface = voting.interface;
  const token = await ethers.getContractAt("StorageToken", await voting.token());
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;

  console.log(`network: ${hre.network.name}   step: ${step}`);
  console.log(`voting : ${proxyAddress}`);
  console.log(`admin1 : ${a1.address}  ${ethers.formatEther(await token.balanceOf(a1.address))} FULA`);
  console.log(`admin2 : ${a2.address}  ${ethers.formatEther(await token.balanceOf(a2.address))} FULA`);
  const subjectCount = await voting.subjectCount();
  console.log(`subjects: ${subjectCount}\n`);

  // ---------------------------------------------------------------- fund
  if (step === "fund") {
    console.log(`Pulling ${ethers.formatEther(PULL)} FULA to admin1...`);
    const t1 = await token.connect(a1).transferFromContract(a1.address, PULL);
    await t1.wait();
    await settle("admin1 FULA", () => token.balanceOf(a1.address), PULL);
    // admin2 is NOT whitelisted, but a plain ERC-20 transfer needs no whitelist — only
    // transferFromContract does. This is the cheap way to fund extra test wallets.
    const t2 = await token.connect(a1).transfer(a2.address, TO_ADMIN2);
    await t2.wait();
    await settle("admin2 FULA", () => token.balanceOf(a2.address), TO_ADMIN2);
    check("admin1 funded", (await token.balanceOf(a1.address)) >= PULL - TO_ADMIN2, true);
    check("admin2 funded", (await token.balanceOf(a2.address)) >= TO_ADMIN2, true);

    console.log(`\nApproving the voting contract for both admins...`);
    for (const [l, s] of [["admin1", a1], ["admin2", a2]] as const) {
      const tx = await token.connect(s).approve(proxyAddress, ethers.MaxUint256);
      await tx.wait();
      ok(`${l} approved the voting contract`);
    }
  }

  // --------------------------------------------------------------- param
  if (step === "param") {
    // Proves the create -> approve -> execute path on-chain. Lowering minDuration to its 1-day
    // floor also makes future rehearsal cycles three times faster.
    console.log(`Staging: minDuration -> 1 day`);
    const tx = await voting.connect(a1).createProposal(PT_SET_PARAM, P_MIN_DURATION, proxyAddress, ZH, BigInt(DAY), Z);
    const rc = await tx.wait();
    const id = rc!.logs[0].topics[1];
    const pr = await voting.proposals(id);
    console.log(`  proposalId ${id}`);
    // Report BOTH bounds. This is a 24-hour WINDOW, not a deadline: executable from
    // created+24h and dead at created+48h. Reporting only the opening time is how the
    // first attempt at this proposal was allowed to expire unexecuted.
    console.log(`  EXECUTION WINDOW (approve with admin2 inside this range, STEP=approve):`);
    console.log(`    opens  ${new Date(Number(pr.config.executionTime) * 1000).toISOString()}`);
    console.log(`    EXPIRES ${new Date(Number(pr.config.expiryTime) * 1000).toISOString()}`);
    ok("parameter proposal created");
  }

  // ------------------------------------------------------------- approve
  if (step === "approve") {
    const count = await voting.proposalCount();
    console.log(`proposalCount: ${count}`);
    let found = false;
    for (let i = 0n; i < count; i++) {
      const pid = await voting.proposalRegistry(i);
      if (pid === ZH) continue;
      const p = await voting.proposals(pid);
      if (p.config.status !== 0n || p.target === Z) continue;
      console.log(`  pending ${pid}  type ${p.proposalType}  approvals ${p.config.approvals}`);
      found = true;

      // Approve EARLY on purpose. The second approval only has to be recorded; it does not have
      // to land inside the execution window. GovernanceModule auto-executes here only when the
      // delay has also elapsed, so approving now leaves a single executeProposal call to make
      // inside [executionTime, expiryTime) — which is far easier to hit than two calls.
      if (!(await voting.hasProposalApproval(pid, a2.address))) {
        const tx = await voting.connect(a2).approveProposal(pid);
        await tx.wait();
        ok("second approval recorded", BigInt(now) >= p.config.executionTime ? "and executed" : "execution still pending");
      } else {
        console.log(`  already approved by admin2`);
      }

      if (BigInt(now) >= p.config.executionTime) {
        const after = await voting.proposals(pid);
        if (after.config.status === 0n && after.target !== Z) {
          const tx2 = await voting.connect(a1).executeProposal(pid);
          await tx2.wait();
          ok("proposal executed");
        }
      } else {
        console.log(`  EXECUTE WINDOW: ${new Date(Number(p.config.executionTime) * 1000).toISOString()}`);
        console.log(`              to: ${new Date(Number(p.config.expiryTime) * 1000).toISOString()}`);
        console.log(`  run STEP=approve again inside that range to execute`);
      }
    }
    if (!found) console.log(`  nothing executable right now`);
    console.log(`  minDuration is now ${await voting.paramValue(P_MIN_DURATION)}`);
  }

  // ------------------------------------------------------------- cleanup
  // Exercises the expiry + cleanup path documented as F-11: every parameter proposal targets
  // `address(this)`, and GovernanceModule's pendingProposals check does NOT test for expiry, so
  // one abandoned proposal freezes ALL parameter governance until cleanup is run.
  if (step === "cleanup") {
    const staleId = process.env.STALE_PROPOSAL?.trim();
    if (staleId) {
      const pr = await voting.proposals(staleId);
      console.log(`stale proposal expired ${new Date(Number(pr.config.expiryTime) * 1000).toISOString()}`);
      await expectRevert(
        "an expired proposal cannot be approved",
        () => voting.connect(a2).approveProposal.staticCall(staleId),
        ""
      );
    }

    const pendingBefore = await voting.pendingProposals(proxyAddress);
    console.log(`pendingProposals[this] = ${pendingBefore}`);
    if (pendingBefore !== 0n) {
      await expectRevert(
        "the expired proposal still blocks new parameter governance",
        () => voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, P_MIN_DURATION, proxyAddress, ZH, BigInt(DAY), Z),
        "ExistingActiveProposal"
      );

      console.log(`Running cleanupExpiredProposals...`);
      const tx = await voting.connect(a1).cleanupExpiredProposals(10);
      await tx.wait();
      for (let i = 0; i < 15; i++) {
        if (await voting.pendingProposals(proxyAddress) === 0n) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      check("cleanup cleared the pending slot", await voting.pendingProposals(proxyAddress), 0);
    }

    try {
      await voting.connect(a1).createProposal.staticCall(PT_SET_PARAM, P_MIN_DURATION, proxyAddress, ZH, BigInt(DAY), Z);
      ok("parameter governance works again after cleanup");
    } catch (e: any) {
      bad("parameter governance works again after cleanup", revertName(e));
    }
  }

  // -------------------------------------------------------------- create
  if (step === "create") {
    const minDur = Number(await voting.paramValue(P_MIN_DURATION));
    console.log(`Creating a subject with the shortest legal duration (${minDur / DAY} days)...`);
    const tx = await voting
      .connect(a1)
      .createSubject(
        "Live rehearsal: which roadmap item first?",
        "QmRehearsalCidPlaceholder",
        ["Mobile app", "Storage incentives", "Governance UI"],
        minDur
      );
    const rc = await tx.wait();
    console.log(`  gas used: ${rc?.gasUsed}`);
    await settle("subjectCount", async () => await voting.subjectCount(), subjectCount + 1n);
    ok("subject created", `id ${await voting.subjectCount()}`);
  }

  // ---------------------------------------------------------------- vote
  if (step === "vote") {
    const id = subjectCount;
    console.log(`Voting on subject ${id}...`);
    const t1 = await voting.connect(a1).vote(id, 0, VOTE_A, [], 0, ZH);
    const r1 = await t1.wait();
    console.log(`  admin1 voted option 0, gas ${r1?.gasUsed}`);
    const t2 = await voting.connect(a2).vote(id, 1, VOTE_B, [], 0, ZH);
    const r2 = await t2.wait();
    console.log(`  admin2 voted option 1, gas ${r2?.gasUsed}`);
    ok("both votes cast");
  }

  // -------------------------------------------------------------- verify
  if (step === "verify" || step === "vote") {
    const id = step === "vote" ? subjectCount : subjectCount;
    console.log(`\n=== Verifying subject ${id} against the live chain ===`);
    // Read the receipts FIRST, then wait for the subject aggregate to agree with them. Running
    // straight after the vote transactions, this RPC will happily serve a pre-vote view of the
    // subject while already reporting fresh receipts and tallies — which reads as voterCount 0
    // against correct per-voter data, i.e. exactly like a contract bug that isn't there.
    const expectedVoters =
      ((await voting.getReceipt(id, a1.address)).voted ? 1 : 0) +
      ((await voting.getReceipt(id, a2.address)).voted ? 1 : 0);
    await settle("subject aggregate", async () => (await voting.getSubject(id)).voterCount, BigInt(expectedVoters));
    const s = await voting.getSubject(id);
    console.log(`  creator ${s.creator}  close ${new Date(Number(s.closeTime) * 1000).toISOString()}`);
    check("title stored on-chain", s.title, "Live rehearsal: which roadmap item first?");
    check("CID stored on-chain", s.descriptionCID, "QmRehearsalCidPlaceholder");
    check("optionCount", s.optionCount, 3);
    check("deposit held", s.deposit, ethers.parseEther("100000"));
    check("status open", s.status, 0);

    // The ballot commitment must match the labels that were submitted.
    const labels = ["Mobile app", "Storage incentives", "Governance UI"];
    for (let i = 0; i < labels.length; i++) {
      check(`option hash ${i}`, await voting.optionHashes(id, i), ethers.keccak256(ethers.toUtf8Bytes(labels[i])));
    }

    const rA = await voting.getReceipt(id, a1.address);
    const rB = await voting.getReceipt(id, a2.address);
    if (rA.voted) {
      // sqrt(1_000_000e18) is exactly 1e12; no multiplier applies (integrations are unset).
      check("admin1 basis", rA.basis, VOTE_A);
      check("admin1 power = sqrt(basis)", rA.power, 10n ** 12n);
      check("admin1 multiplier 1x", rA.multiplierBps, 10000);
      check("admin1 option", rA.option, 0);
    }
    if (rB.voted) {
      check("admin2 basis", rB.basis, VOTE_B);
      check("admin2 power = sqrt(basis)", rB.power, 5n * 10n ** 11n);
      check("admin2 option", rB.option, 1);
    }
    if (rA.voted && rB.voted) {
      check("tally option 0", await voting.tally(id, 0), 10n ** 12n);
      check("tally option 1", await voting.tally(id, 1), 5n * 10n ** 11n);
      check("tally option 2 empty", await voting.tally(id, 2), 0);
      check("voterCount", s.voterCount, 2);
      check("totalBasis", s.totalBasis, VOTE_A + VOTE_B);
      check("totalPowerCast = sum of tallies", s.totalPowerCast, 10n ** 12n + 5n * 10n ** 11n);
      // The whole point of the curve: 4x the capital buys only 2x the say.
      check("4x capital -> 2x power", (await voting.tally(id, 0)) / (await voting.tally(id, 1)), 2);
    }

    console.log(`\n  --- conservation ---`);
    const held = await token.balanceOf(proxyAddress);
    const owed = (await voting.totalLockedLiability()) + (await voting.totalDepositLiability());
    check("held == locked + deposit liabilities", held, owed);

    console.log(`\n  --- guards that must still refuse ---`);
    await expectRevert("double vote", () => voting.connect(a1).vote.staticCall(id, 2, VOTE_B, [], 0, ZH), "AlreadyVoted");
    await expectRevert("claim before close", () => voting.connect(a1).claim.staticCall(id), "SubjectStillOpen");
    await expectRevert("finalize before close", () => voting.connect(a1).finalize.staticCall(id), "SubjectStillOpen");
    await expectRevert("settle before close", () => voting.connect(a1).settleDeposit.staticCall(id), "SubjectStillOpen");
    await expectRevert("stake indices with no engine", () => voting.connect(a1).vote.staticCall(id, 0, 0, [0], 0, ZH), "");
    // The cooldown is time-dependent, so assert whichever behaviour is correct RIGHT NOW rather
    // than assuming the run happens moments after creation.
    const minDurNow = Number(await voting.paramValue(P_MIN_DURATION));
    const cooldownEnds = Number(await voting.lastCreateAt(a1.address)) + Number(await voting.paramValue(11));
    const attempt = () => voting.connect(a1).createSubject.staticCall("x", "y", ["a", "b"], minDurNow);
    if (now < cooldownEnds) {
      await expectRevert("second subject blocked while the cooldown is active", attempt, "CreateCooldownActive");
    } else {
      // Past the cooldown a second subject is legitimate; it should now fail only for funds,
      // which is what proves the cooldown was the earlier blocker and nothing else.
      try {
        await attempt();
        ok("cooldown expired, so a second subject is allowed");
      } catch (e: any) {
        const n = revertName(e);
        if (n.includes("CreateCooldownActive")) bad("cooldown expired but still blocking", n);
        else ok("cooldown expired; second subject blocked only by funds/approval", n);
      }
    }
  }

  // --------------------------------------------------------------- close
  if (step === "close") {
    const id = subjectCount;
    const s = await voting.getSubject(id);
    if (BigInt(now) < s.closeTime) {
      console.log(`Subject ${id} closes ${new Date(Number(s.closeTime) * 1000).toISOString()} — not yet.`);
      return;
    }
    console.log(`Finalizing subject ${id}...`);
    if (s.status === 0n) {
      const tx = await voting.connect(a1).finalize(id);
      await tx.wait();
      ok("finalized");
    }
    const f = await voting.getSubject(id);
    check("winning option", f.winningOption, 0);
    check("not tied", f.tied, false);
    // Two voters and 1.25M basis against thresholds of 15 voters / 5M basis: quorum missed,
    // so the deposit must be burnable and NOT refundable.
    check("quorum missed => not refundable", f.depositRefundable, false);

    for (const [l, s2] of [["admin1", a1], ["admin2", a2]] as const) {
      const r = await voting.getReceipt(id, s2.address);
      if (r.voted && !r.claimed) {
        const before = await token.balanceOf(s2.address);
        const tx = await voting.connect(s2).claim(id);
        await tx.wait();
        await settle(`${l} refund`, async () => (await token.balanceOf(s2.address)) - before, r.lockedAmount);
        check(`${l} refunded exactly what was locked`, (await token.balanceOf(s2.address)) - before, r.lockedAmount);
      }
    }
    await expectRevert("creator cannot claim a failed deposit", () => voting.connect(a1).claimDeposit.staticCall(id), "QuorumNotMet");
    if (!f.depositSettled) {
      const supplyBefore = await token.totalSupply();
      const tx = await voting.connect(a2).settleDeposit(id); // permissionless
      await tx.wait();
      await settle("supply burn", async () => supplyBefore - (await token.totalSupply()), f.deposit);
      check("failed deposit burned", supplyBefore - (await token.totalSupply()), f.deposit);
    }
    check("locked liability cleared", await voting.totalLockedLiability(), 0);
    check("deposit liability cleared", await voting.totalDepositLiability(), 0);
    check("contract holds nothing", await token.balanceOf(proxyAddress), 0);
  }

  console.log(`\n================ ${pass} passed, ${fail} failed ================`);
  if (fail) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
