// CommunityVoting â€” voting power (Steps 4, 5 and 6).
//
//  Step 4: fresh locks and the sqrt power curve
//  Step 5: staked-balance qualification
//  Step 6: the DePIN membership multiplier
//
// The staking engine and storage pool are test doubles. The states that actually need coverage â€”
// "stake exists but is inactive", "lock ends one second before close", "membership row deleted
// but joinTimestamp left behind" â€” cannot be staged against the real contracts, which have no
// early-exit path. Behaviour against the deployed contracts is covered by the Base fork test.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, ZeroHash, BytesLike, Contract } from "ethers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60;
const TOTAL_SUPPLY = ethers.parseEther("1000000000");
const PT_ADD_WHITELIST = 5;
const PT_SET_PARAM = 14;
const P_STAKE_WEIGHT_BPS = 7;
const P_MEMBER_MULTIPLIER_BPS = 6;
const P_STAKER_MULTIPLIER_BPS = 13;
const P_MIN_VOTE_BASIS = 3;

/** Apply a bps multiplier the way the contract does: sqrt first, then scale. */
function powerOf(basis: bigint, multiplierBps: bigint = 10000n): bigint {
  return (isqrt(basis) * multiplierBps) / 10000n;
}

const OPTS = ["Yes", "No", "Abstain"];
const PEER = ethers.keccak256(ethers.toUtf8Bytes("peer-1"));
const POOL_ID = 1;

/** Reference integer square root (Newton's method) for the differential test. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

describe("CommunityVoting â€” voting power", function () {
  let voting: Contract;
  let token: Contract;
  let stakingEngine: Contract;
  let storagePool: Contract;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let voter: HardhatEthersSigner;
  let voter2: HardhatEthersSigner;
  let subjectCreatedAt: number;

  beforeEach(async function () {
    [owner, admin, creator, voter, voter2] = await ethers.getSigners();

    const StorageToken = await ethers.getContractFactory("StorageToken");
    token = (await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, TOTAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await token.waitForDeployment();

    await time.increase(DAY + 1);
    await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(DAY + 1);
    await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    await runTokenProposal(PT_ADD_WHITELIST, owner.address);
    await token.connect(owner).transferFromContract(owner.address, ethers.parseEther("50000000"));

    stakingEngine = (await (await ethers.getContractFactory("MockStakingEngine")).deploy()) as unknown as Contract;
    storagePool = (await (await ethers.getContractFactory("MockStoragePool")).deploy()) as unknown as Contract;

    const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
    voting = (await upgrades.deployProxy(
      CommunityVoting,
      [
        await token.getAddress(),
        await stakingEngine.getAddress(),
        await storagePool.getAddress(),
        owner.address,
        admin.address,
      ],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await voting.waitForDeployment();
    await time.increase(DAY + 1);
    await voting.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

    for (const who of [creator, voter, voter2]) {
      await token.connect(owner).transfer(who.address, ethers.parseEther("5000000"));
      await token.connect(who).approve(await voting.getAddress(), ethers.MaxUint256);
    }

    const tx = await voting.connect(creator).createSubject("Q", "CID", OPTS, 7 * DAY);
    const receipt = await tx.wait();
    subjectCreatedAt = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
  });

  // -------------------------------------------------------------------------
  // Step 4 â€” fresh locks and the power curve
  // -------------------------------------------------------------------------
  describe("sqrt power curve", function () {
    it("matches an off-chain integer square root across the whole realistic range", async function () {
      const harness = await (await ethers.getContractFactory("VotingMathHarness")).deploy();
      const samples: bigint[] = [0n, 1n, 2n, 3n, 4n, 10n ** 18n, 10n ** 18n - 1n];
      // Sweep exponents from a single wei up past the full 2e27 wei supply.
      for (let e = 0; e <= 27; e++) {
        const base = 10n ** BigInt(e);
        samples.push(base, base + 1n, base * 3n, base * 7n + 13n);
      }
      samples.push(2n * 10n ** 27n); // entire supply
      for (let i = 1; i <= 120; i++) {
        samples.push(BigInt(i) * 987654321987654321n * BigInt(i));
      }
      for (const value of samples) {
        expect(await harness.sqrt(value), `sqrt(${value})`).to.equal(isqrt(value));
      }
    });

    it("applies the multiplier after the root, not inside it", async function () {
      const harness = await (await ethers.getContractFactory("VotingMathHarness")).deploy();
      const basis = ethers.parseEther("1000000");
      // 2x on the power, which is NOT the same as sqrt(2 * basis) ~= 1.41x.
      expect(await harness.power(basis, 20000)).to.equal(isqrt(basis) * 2n);
      expect(await harness.power(basis, 20000)).to.not.equal(isqrt(basis * 2n));
    });

    it("gives 1 FULA one power unit of 1e9, and 100x tokens only 10x power", async function () {
      const one = await (await ethers.getContractFactory("VotingMathHarness")).deploy();
      expect(await one.sqrt(ethers.parseEther("1"))).to.equal(10n ** 9n);
      const small = await one.sqrt(ethers.parseEther("10000"));
      const large = await one.sqrt(ethers.parseEther("1000000"));
      expect(large / small).to.equal(10n); // 100x the stake, 10x the say
    });
  });

  describe("casting a vote with a fresh lock", function () {
    it("records power as sqrt of the locked amount", async function () {
      const lock = ethers.parseEther("1000000");
      await voting.connect(voter).vote(1, 0, lock, [], 0, ZeroHash);

      const r = await voting.getReceipt(1, voter.address);
      expect(r.voted).to.equal(true);
      expect(r.lockedAmount).to.equal(lock);
      expect(r.basis).to.equal(lock);
      expect(r.power).to.equal(isqrt(lock));
      expect(r.option).to.equal(0);
      expect(r.multiplierBps).to.equal(10000);
    });

    it("updates the tally, the subject totals and the liability", async function () {
      const lock = ethers.parseEther("1000000");
      await voting.connect(voter).vote(1, 1, lock, [], 0, ZeroHash);

      expect(await voting.tally(1, 1)).to.equal(isqrt(lock));
      expect(await voting.tally(1, 0)).to.equal(0n);

      const s = await voting.getSubject(1);
      expect(s.totalPowerCast).to.equal(isqrt(lock));
      expect(s.totalBasis).to.equal(lock);
      expect(s.voterCount).to.equal(1);
      expect(await voting.totalLockedLiability()).to.equal(lock);
    });

    it("emits VoteCast with the basis and the derived power", async function () {
      const lock = ethers.parseEther("1000000");
      await expect(voting.connect(voter).vote(1, 2, lock, [], 0, ZeroHash))
        .to.emit(voting, "VoteCast")
        .withArgs(1, voter.address, 2, lock, isqrt(lock), 10000);
    });

    it("dampens a whale relative to many small holders", async function () {
      // One wallet with 100x the capital of another gets only 10x the power. This is the whole
      // point of the curve â€” and it is also why wallet-splitting is the residual risk.
      await voting.connect(voter).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await voting.connect(voter2).vote(1, 1, ethers.parseEther("10000"), [], 0, ZeroHash);
      const whale = await voting.tally(1, 0);
      const minnow = await voting.tally(1, 1);
      expect(whale / minnow).to.equal(10n);
    });

    it("rejects a basis below the minimum", async function () {
      await expect(
        voting.connect(voter).vote(1, 0, ethers.parseEther("9999"), [], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "BasisBelowMinimum");
      // Exactly the minimum is accepted.
      await voting.connect(voter).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
    });

    it("allows only one vote per wallet per subject", async function () {
      await voting.connect(voter).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
      await expect(
        voting.connect(voter).vote(1, 1, ethers.parseEther("10000"), [], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "AlreadyVoted");
    });

    it("rejects an unknown subject, a closed subject and an out-of-range option", async function () {
      await expect(
        voting.connect(voter).vote(99, 0, ethers.parseEther("10000"), [], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "SubjectNotFound");
      await expect(
        voting.connect(voter).vote(1, 3, ethers.parseEther("10000"), [], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "InvalidOption");

      await time.increase(7 * DAY + 1);
      await expect(
        voting.connect(voter).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "SubjectClosed");
    });

    it("is blocked while paused", async function () {
      await voting.connect(owner).emergencyAction(1);
      await expect(
        voting.connect(voter).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash)
      ).to.be.reverted;
    });

    it("counts only what arrived when a transfer fee is active", async function () {
      await runTokenProposal(11 /* ChangeTreasuryFee */, voter2.address, 500);
      const lock = ethers.parseEther("1000000");
      await voting.connect(voter).vote(1, 0, lock, [], 0, ZeroHash);

      const netted = (lock * 9500n) / 10000n;
      const r = await voting.getReceipt(1, voter.address);
      expect(r.lockedAmount).to.equal(netted);
      expect(r.basis).to.equal(netted);
      expect(r.power).to.equal(isqrt(netted));
      expect(await voting.totalLockedLiability()).to.equal(netted);
    });
  });

  // -------------------------------------------------------------------------
  // Step 5 â€” staked balances
  // -------------------------------------------------------------------------
  describe("staked balances", function () {
    const STAKE = ethers.parseEther("2000000");

    /** A stake opened before the subject and locked well past its close. */
    async function addQualifyingStake(user: string, amount = STAKE) {
      await stakingEngine.addStake(user, amount, 365 * DAY, subjectCreatedAt - DAY, true);
    }

    it("counts a qualifying stake toward the basis without locking anything fresh", async function () {
      await addQualifyingStake(voter.address);
      await voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash);

      const r = await voting.getReceipt(1, voter.address);
      expect(r.lockedAmount).to.equal(0n);
      expect(r.basis).to.equal(STAKE);
      // A qualifying stake also earns the 1.5x staker commitment boost.
      expect(r.multiplierBps).to.equal(15000);
      expect(r.power).to.equal(powerOf(STAKE, 15000n));
      // Nothing was transferred in, so nothing is owed back.
      expect(await voting.totalLockedLiability()).to.equal(0n);
    });

    it("adds a fresh lock and a stake together", async function () {
      await addQualifyingStake(voter.address);
      const lock = ethers.parseEther("1000000");
      await voting.connect(voter).vote(1, 0, lock, [0], 0, ZeroHash);
      const r = await voting.getReceipt(1, voter.address);
      expect(r.basis).to.equal(STAKE + lock);
      expect(r.power).to.equal(powerOf(STAKE + lock, 15000n));
    });

    it("sums several stakes before applying the weight once", async function () {
      await addQualifyingStake(voter.address, ethers.parseEther("1000000"));
      await addQualifyingStake(voter.address, ethers.parseEther("3000000"));
      await voting.connect(voter).vote(1, 0, 0, [0, 1], 0, ZeroHash);
      expect((await voting.getReceipt(1, voter.address)).basis).to.equal(ethers.parseEther("4000000"));
    });

    it("rejects a stake whose lock ends before the subject closes", async function () {
      const closeTime = Number((await voting.getSubject(1)).closeTime);
      // Ends one second short of the close.
      await stakingEngine.addStake(voter.address, STAKE, closeTime - subjectCreatedAt - 1, subjectCreatedAt, true);
      await expect(
        voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "StakeNotQualifying");
    });

    it("accepts a stake whose lock ends exactly at the close", async function () {
      const closeTime = Number((await voting.getSubject(1)).closeTime);
      await stakingEngine.addStake(voter.address, STAKE, closeTime - subjectCreatedAt, subjectCreatedAt, true);
      await voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash);
      expect((await voting.getReceipt(1, voter.address)).basis).to.equal(STAKE);
    });

    it("rejects an inactive stake", async function () {
      await addQualifyingStake(voter.address);
      await stakingEngine.setActive(voter.address, 0, false);
      await expect(
        voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "StakeNotQualifying");
    });

    it("rejects a stake opened after the subject, blocking last-minute snipes", async function () {
      // Stake-derived power costs nothing per subject, so without this rule someone could buy
      // FULA and open a long stake moments before close purely to swing the result for free.
      await stakingEngine.addStake(voter.address, STAKE, 365 * DAY, subjectCreatedAt + 1, true);
      await expect(
        voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "StakeNotQualifying");
    });

    it("rejects duplicate or descending indices", async function () {
      await addQualifyingStake(voter.address);
      await addQualifyingStake(voter.address);
      await expect(
        voting.connect(voter).vote(1, 0, 0, [0, 0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "StakeIndicesNotAscending");
      await expect(
        voting.connect(voter).vote(1, 0, 0, [1, 0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "StakeIndicesNotAscending");
    });

    it("accepts up to 100 indices, matching the staking engine's own cap, and rejects 101", async function () {
      for (let i = 0; i < 101; i++) await addQualifyingStake(voter.address, ethers.parseEther("1000"));
      await expect(
        voting.connect(voter).vote(1, 0, 0, Array.from({ length: 101 }, (_, i) => i), 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "TooManyStakeIndices");

      await voting.connect(voter).vote(1, 0, 0, Array.from({ length: 100 }, (_, i) => i), 0, ZeroHash);
      expect((await voting.getReceipt(1, voter.address)).basis).to.equal(ethers.parseEther("100000"));
    });

    it("gives no staker boost to a stake below the participation floor", async function () {
      // The boost is meant to reward capital genuinely locked into the network, so it requires
      // the stake ALONE to clear the same floor a vote needs — a dust position earns nothing.
      const dust = ethers.parseEther("9999"); // minVoteBasis is 10,000
      await stakingEngine.addStake(voter.address, dust, 365 * DAY, subjectCreatedAt - DAY, true);
      const lock = ethers.parseEther("1000000");
      await voting.connect(voter).vote(1, 0, lock, [0], 0, ZeroHash);

      const r = await voting.getReceipt(1, voter.address);
      expect(r.basis).to.equal(lock + dust); // still counts toward basis
      expect(r.multiplierBps).to.equal(10000); // but earns no boost
    });

    it("snapshots the staker boost per subject", async function () {
      await addQualifyingStake(voter.address);
      await runParamProposal(P_STAKER_MULTIPLIER_BPS, 10000); // switch the boost off

      // The open subject keeps the boost it was created with.
      await voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash);
      expect((await voting.getReceipt(1, voter.address)).multiplierBps).to.equal(15000);

      // The next subject reflects the change.
      await voting.connect(creator).createSubject("Q2", "CID", OPTS, 7 * DAY);
      await addQualifyingStake(voter2.address);
      await voting.connect(voter2).vote(2, 0, 0, [0], 0, ZeroHash);
      expect((await voting.getReceipt(2, voter2.address)).multiplierBps).to.equal(10000);
    });

    it("reverts on an index the caller has no stake at", async function () {
      // The staking contract's array access panics rather than returning a custom error. That is
      // acceptable â€” it costs only the caller their own transaction and can never affect anyone
      // else's vote, claim, or a finalization â€” but it is recorded here rather than assumed.
      await addQualifyingStake(voter.address);
      await expect(voting.connect(voter).vote(1, 0, 0, [99], 0, ZeroHash)).to.be.reverted;
    });

    it("counts another wallet's stakes for nobody", async function () {
      // Ownership is read only from stakes[msg.sender][index]; there is no caller-supplied owner.
      await addQualifyingStake(voter2.address);
      await expect(voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash)).to.be.reverted;
    });

    it("snapshots stakeWeightBps per subject, so a mid-poll change cannot reweight it", async function () {
      // Receipts are immutable, so early voters are fixed at the rules they voted under. If the
      // weight applied live, governance could hand late voters a different exchange rate in the
      // middle of a vote already in progress.
      await addQualifyingStake(voter.address);
      await runParamProposal(P_STAKE_WEIGHT_BPS, 5000); // 50%

      // Subject 1 was created under the old rule and keeps it.
      await voting.connect(voter).vote(1, 0, 0, [0], 0, ZeroHash);
      expect((await voting.getReceipt(1, voter.address)).basis).to.equal(STAKE);

      // A subject created afterwards picks the new weight up.
      await voting.connect(creator).createSubject("Q2", "CID", OPTS, 7 * DAY);
      await addQualifyingStake(voter2.address);
      await voting.connect(voter2).vote(2, 0, 0, [0], 0, ZeroHash);
      expect((await voting.getReceipt(2, voter2.address)).basis).to.equal(STAKE / 2n);
    });

    it("can switch stake-derived power off entirely for new subjects", async function () {
      await runParamProposal(P_STAKE_WEIGHT_BPS, 0);
      await voting.connect(creator).createSubject("Q2", "CID", OPTS, 7 * DAY);
      await addQualifyingStake(voter.address);
      await expect(
        voting.connect(voter).vote(2, 0, 0, [0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(voting, "BasisBelowMinimum");
    });

    it("reports a clear error when the staking engine is not configured", async function () {
      const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
      const bare = (await upgrades.deployProxy(
        CommunityVoting,
        [await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address],
        { kind: "uups", initializer: "initialize" }
      )) as unknown as Contract;
      await time.increase(DAY + 1);
      await bare.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
      await token.connect(creator).approve(await bare.getAddress(), ethers.MaxUint256);
      await token.connect(voter).approve(await bare.getAddress(), ethers.MaxUint256);
      await bare.connect(creator).createSubject("Q", "CID", OPTS, 7 * DAY);

      await expect(
        bare.connect(voter).vote(1, 0, ethers.parseEther("10000"), [0], 0, ZeroHash)
      ).to.be.revertedWithCustomError(bare, "IntegrationDisabled");
      // With no indices supplied it degrades gracefully to fresh-lock-only voting.
      await bare.connect(voter).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
    });
  });

  // -------------------------------------------------------------------------
  // Step 6 â€” the DePIN membership multiplier
  // -------------------------------------------------------------------------
  describe("membership multiplier", function () {
    const LOCK = ethers.parseEther("1000000");

    async function makeEligible(user: string, lockedTokens = ethers.parseEther("100")) {
      await storagePool.setMember(POOL_ID, PEER, user, lockedTokens, subjectCreatedAt - 30 * DAY);
    }

    it("doubles the power of a proven pool member", async function () {
      await makeEligible(voter.address);
      await voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER);
      const r = await voting.getReceipt(1, voter.address);
      expect(r.power).to.equal(isqrt(LOCK) * 2n);
      expect(r.multiplierBps).to.not.equal(10000);
      // The basis is unchanged â€” only the derived power is boosted, so quorum stays honest.
      expect(r.basis).to.equal(LOCK);
    });

    it("leaves the quorum basis untouched by the multiplier", async function () {
      await makeEligible(voter.address);
      await voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER);
      expect((await voting.getSubject(1)).totalBasis).to.equal(LOCK);
    });

    it("refuses a peer owned by somebody else", async function () {
      await makeEligible(voter2.address);
      await expect(
        voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER)
      ).to.be.revertedWithCustomError(voting, "MembershipNotEligible");
    });

    it("refuses a peer that has posted less than the minimum join stake", async function () {
      // This is the check that matters: a privileged createPool records zero locked tokens and a
      // pool admin can add members directly, so a pool can advertise a high requirement while a
      // given member has staked nothing.
      await makeEligible(voter.address, 0n);
      await expect(
        voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER)
      ).to.be.revertedWithCustomError(voting, "MembershipNotEligible");
    });

    it("ignores joinTimestamp entirely, so a peer-id squatter cannot strip the multiplier", async function () {
      // StoragePool.joinTimestamp is keyed by peer id GLOBALLY while membership is per-pool, and
      // createPool overwrites it with no cross-pool uniqueness check. Any age rule built on it
      // could therefore be griefed: take a victim's public peer id, spin up a pool around it, and
      // reset their apparent join time â€” or delete the pool to zero it. Eligibility must not
      // depend on that value. Here the timestamp is set to "just now" and even to zero, and the
      // multiplier still stands, because only live membership and the peer's own stake matter.
      await storagePool.setMember(POOL_ID, PEER, voter.address, ethers.parseEther("100"), 0);
      await voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER);
      expect((await voting.getReceipt(1, voter.address)).multiplierBps).to.not.equal(10000);
    });

    it("refuses a peer whose membership has been removed", async function () {
      // The pool-scoped membership row is the authority, and an outsider cannot touch it.
      await makeEligible(voter.address);
      await storagePool.clearMembership(POOL_ID, PEER);
      await expect(
        voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER)
      ).to.be.revertedWithCustomError(voting, "MembershipNotEligible");
    });

    it("refuses a forfeited account", async function () {
      await makeEligible(voter.address);
      await storagePool.setForfeited(voter.address, true);
      await expect(
        voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER)
      ).to.be.revertedWithCustomError(voting, "MembershipNotEligible");
    });

    it("cannot be stacked, because a wallet votes only once", async function () {
      await makeEligible(voter.address);
      await voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER);
      const other = ethers.keccak256(ethers.toUtf8Bytes("peer-2"));
      await storagePool.setMember(POOL_ID, other, voter.address, ethers.parseEther("100"), subjectCreatedAt - 30 * DAY);
      await expect(
        voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, other)
      ).to.be.revertedWithCustomError(voting, "AlreadyVoted");
      expect((await voting.getReceipt(1, voter.address)).power).to.equal(isqrt(LOCK) * 2n);
    });

    it("snapshots the multiplier size per subject", async function () {
      // The sharpest version of the mid-poll reweighting problem: without the snapshot, two
      // admins could raise the multiplier partway through a vote and hand every remaining
      // member-voter 2.5x the influence of the ones who already voted.
      await makeEligible(voter.address);
      await runParamProposal(P_MEMBER_MULTIPLIER_BPS, 50000); // 5x, the hard maximum

      await voting.connect(voter).vote(1, 0, LOCK, [], POOL_ID, PEER);
      expect((await voting.getReceipt(1, voter.address)).power).to.equal(isqrt(LOCK) * 2n);

      await voting.connect(creator).createSubject("Q2", "CID", OPTS, 7 * DAY);
      await storagePool.setMember(POOL_ID, PEER, voter2.address, ethers.parseEther("100"), subjectCreatedAt - 30 * DAY);
      await voting.connect(voter2).vote(2, 0, LOCK, [], POOL_ID, PEER);
      expect((await voting.getReceipt(2, voter2.address)).power).to.equal(isqrt(LOCK) * 5n);
    });

    it("compounds with the staker boost, and caps the combination at 5x", async function () {
      // A pool operator who is also a long-term staker is the most committed participant there
      // is, so the two boosts stack: 2x * 1.5x = 3x.
      await makeEligible(voter.address);
      await stakingEngine.addStake(voter.address, ethers.parseEther("2000000"), 365 * DAY, subjectCreatedAt - DAY, true);
      await voting.connect(voter).vote(1, 0, LOCK, [0], POOL_ID, PEER);

      const r = await voting.getReceipt(1, voter.address);
      expect(r.multiplierBps).to.equal(30000);
      expect(r.power).to.equal(powerOf(r.basis, 30000n));

      // Pushing the member boost to its 5x maximum would give 5 * 1.5 = 7.5x unchecked; the
      // combined ceiling clamps it back to 5x so stacking can never exceed either boost alone.
      await runParamProposal(P_MEMBER_MULTIPLIER_BPS, 50000);
      await voting.connect(creator).createSubject("Q2", "CID", OPTS, 7 * DAY);
      await storagePool.setMember(POOL_ID, PEER, voter2.address, ethers.parseEther("100"), 0);
      await stakingEngine.addStake(voter2.address, ethers.parseEther("2000000"), 365 * DAY, subjectCreatedAt - DAY, true);
      await voting.connect(voter2).vote(2, 0, LOCK, [0], POOL_ID, PEER);
      expect((await voting.getReceipt(2, voter2.address)).multiplierBps).to.equal(50000);
    });

    it("votes without the multiplier when no peer is supplied", async function () {
      await makeEligible(voter.address);
      await voting.connect(voter).vote(1, 0, LOCK, [], 0, ZeroHash);
      const r = await voting.getReceipt(1, voter.address);
      expect(r.multiplierBps).to.equal(10000);
      expect(r.power).to.equal(isqrt(LOCK));
    });
  });

  async function runTokenProposal(proposalType: number, target: string, amount: number | bigint = 0) {
    const tx = await token.connect(owner).createProposal(proposalType, 0, target, ZeroHash, amount, ZeroAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];
    await time.increase(DAY + 1);
    await token.connect(admin).approveProposal(proposalId);
    await time.increase(DAY + 1);
  }

  async function runParamProposal(paramId: number, value: bigint | number) {
    const tx = await voting
      .connect(owner)
      .createProposal(PT_SET_PARAM, paramId, await voting.getAddress(), ZeroHash, value, ZeroAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];
    await time.increase(DAY + 1);
    await voting.connect(admin).approveProposal(proposalId);
  }
});
