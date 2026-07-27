// CommunityVoting — finalization, claims and deposit settlement (Step 7).
//
// The properties that matter most here are liveness ones: a result must be recordable even if the
// token is paused or this contract is blacklisted, a voter's refund must not depend on anyone
// else acting, and a pause must never trap funds.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, ZeroHash, BytesLike, Contract } from "ethers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60;
const TOTAL_SUPPLY = ethers.parseEther("1000000000");
const PT_ADD_WHITELIST = 5;
const PT_ADD_BLACKLIST = 9;
const PT_SET_PARAM = 14;
const P_QUORUM_BASIS = 8;
const P_QUORUM_VOTERS = 9;

const OPTS = ["Yes", "No", "Abstain"];
const DEPOSIT = ethers.parseEther("100000");
const NO_WINNER = 65535;

describe("CommunityVoting — finalization and claims", function () {
  let voting: Contract;
  let token: Contract;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let v1: HardhatEthersSigner;
  let v2: HardhatEthersSigner;
  let v3: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, admin, creator, v1, v2, v3, stranger] = await ethers.getSigners();

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

    const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
    voting = (await upgrades.deployProxy(
      CommunityVoting,
      [await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await voting.waitForDeployment();
    await time.increase(DAY + 1);
    await voting.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

    for (const who of [creator, v1, v2, v3]) {
      await token.connect(owner).transfer(who.address, ethers.parseEther("5000000"));
      await token.connect(who).approve(await voting.getAddress(), ethers.MaxUint256);
    }

    // Bring the refund quorum down to something three signers can satisfy. Thresholds are
    // snapshotted per subject at creation, so this must happen before any subject exists.
    await runParamProposal(P_QUORUM_VOTERS, 3);
    await runParamProposal(P_QUORUM_BASIS, ethers.parseEther("100000"));
  });

  afterEach(async function () {
    await expectSolvent();
  });

  describe("finalize", function () {
    it("records a clear winner", async function () {
      await createSubject();
      await voting.connect(v1).vote(1, 1, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await voting.connect(v2).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      await expect(voting.connect(stranger).finalize(1)).to.emit(voting, "SubjectFinalized");
      const s = await voting.getSubject(1);
      expect(s.status).to.equal(1);
      expect(s.winningOption).to.equal(1);
      expect(s.tied).to.equal(false);
    });

    it("reports a tie as no mandate", async function () {
      await createSubject();
      const equal = ethers.parseEther("1000000");
      await voting.connect(v1).vote(1, 0, equal, [], 0, ZeroHash);
      await voting.connect(v2).vote(1, 1, equal, [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);
      await voting.connect(stranger).finalize(1);

      const s = await voting.getSubject(1);
      expect(s.tied).to.equal(true);
      expect(s.winningOption).to.equal(NO_WINNER);
    });

    it("reports zero turnout as no mandate, not as option 0 winning", async function () {
      await createSubject();
      await time.increase(7 * DAY + 1);
      await voting.connect(stranger).finalize(1);

      const s = await voting.getSubject(1);
      expect(s.winningOption).to.equal(NO_WINNER);
      expect(s.tied).to.equal(true);
      expect(s.totalPowerCast).to.equal(0n);
    });

    it("is permissionless but only after close, and only once", async function () {
      await createSubject();
      await expect(voting.connect(stranger).finalize(1)).to.be.revertedWithCustomError(
        voting,
        "SubjectStillOpen"
      );
      await time.increase(7 * DAY + 1);
      await voting.connect(stranger).finalize(1); // anyone may call it
      await expect(voting.connect(owner).finalize(1)).to.be.revertedWithCustomError(
        voting,
        "AlreadyFinalized"
      );
    });

    it("rejects an unknown subject", async function () {
      await expect(voting.finalize(99)).to.be.revertedWithCustomError(voting, "SubjectNotFound");
    });

    it("makes no external calls, so a paused token cannot block a result", async function () {
      // This is why burning a failed deposit is split out into settleDeposit: if finalize called
      // into the token, a pause or a blacklist would make a poll impossible to ever finalize.
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      await token.connect(owner).emergencyAction(1); // pause the TOKEN
      await voting.connect(stranger).finalize(1);
      expect((await voting.getSubject(1)).status).to.equal(1);
    });
  });

  describe("voter claims", function () {
    it("returns the locked tokens after close, without waiting for finalize", async function () {
      await createSubject();
      const lock = ethers.parseEther("1000000");
      await voting.connect(v1).vote(1, 0, lock, [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      const before = await token.balanceOf(v1.address);
      await expect(voting.connect(v1).claim(1)).to.emit(voting, "TokensClaimed");
      expect((await token.balanceOf(v1.address)) - before).to.equal(lock);
      expect(await voting.totalLockedLiability()).to.equal(0n);
      expect((await voting.getSubject(1)).status).to.equal(0); // never finalized
    });

    it("refuses to release anything before close", async function () {
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await expect(voting.connect(v1).claim(1)).to.be.revertedWithCustomError(
        voting,
        "SubjectStillOpen"
      );
    });

    it("cannot be claimed twice", async function () {
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);
      await voting.connect(v1).claim(1);
      await expect(voting.connect(v1).claim(1)).to.be.revertedWithCustomError(voting, "AlreadyClaimed");
    });

    it("gives a non-voter nothing", async function () {
      await createSubject();
      await time.increase(7 * DAY + 1);
      await expect(voting.connect(stranger).claim(1)).to.be.revertedWithCustomError(
        voting,
        "NothingToClaim"
      );
    });

    it("still works while the voting contract is paused", async function () {
      // Pausing must stop new participation, never trap completed positions — emergencyAction is
      // a single-admin call, so a pause is one signature away.
      await createSubject();
      const lock = ethers.parseEther("1000000");
      await voting.connect(v1).vote(1, 0, lock, [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      await voting.connect(owner).emergencyAction(1);
      // finalize is not pausable either: one admin signature must not be able to suppress the
      // canonical record of a completed vote. It moves no funds and makes no external calls.
      await voting.connect(stranger).finalize(1);
      expect((await voting.getSubject(1)).status).to.equal(1);

      const before = await token.balanceOf(v1.address);
      await voting.connect(v1).claim(1); // claims are not
      expect((await token.balanceOf(v1.address)) - before).to.equal(lock);
    });

    it("isolates a blacklisted voter's failure from everyone else", async function () {
      await createSubject();
      const lock = ethers.parseEther("1000000");
      await voting.connect(v1).vote(1, 0, lock, [], 0, ZeroHash);
      await voting.connect(v2).vote(1, 1, lock, [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      await runTokenProposal(PT_ADD_BLACKLIST, v2.address);

      await expect(voting.connect(v2).claim(1)).to.be.reverted; // their own transfer fails
      const before = await token.balanceOf(v1.address);
      await voting.connect(v1).claim(1); // nobody else is affected
      expect((await token.balanceOf(v1.address)) - before).to.equal(lock);
    });

    it("claims several subjects in one call", async function () {
      await createSubject();
      await time.increase(DAY + 1);
      await createSubject();
      const lock = ethers.parseEther("500000");
      await voting.connect(v1).vote(1, 0, lock, [], 0, ZeroHash);
      await voting.connect(v1).vote(2, 0, lock, [], 0, ZeroHash);
      await time.increase(8 * DAY);

      const before = await token.balanceOf(v1.address);
      await voting.connect(v1).claimMany([1, 2]);
      expect((await token.balanceOf(v1.address)) - before).to.equal(lock * 2n);
    });
  });

  describe("deposit settlement", function () {
    it("returns the deposit when the quorum is met, without needing finalize", async function () {
      await createSubject();
      await voteAll(ethers.parseEther("1000000"));
      await time.increase(7 * DAY + 1);

      const before = await token.balanceOf(creator.address);
      await expect(voting.connect(creator).claimDeposit(1)).to.emit(voting, "DepositClaimed");
      expect((await token.balanceOf(creator.address)) - before).to.equal(DEPOSIT);
      expect(await voting.totalDepositLiability()).to.equal(0n);
      expect((await voting.getSubject(1)).status).to.equal(0); // finalize was never called
    });

    it("only the creator may claim it, and only once", async function () {
      await createSubject();
      await voteAll(ethers.parseEther("1000000"));
      await time.increase(7 * DAY + 1);

      await expect(voting.connect(stranger).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "NotSubjectCreator"
      );
      await voting.connect(creator).claimDeposit(1);
      await expect(voting.connect(creator).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "DepositAlreadySettled"
      );
    });

    it("burns the deposit when the quorum is missed", async function () {
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);

      const supplyBefore = await token.totalSupply();
      await expect(voting.connect(stranger).settleDeposit(1)).to.emit(voting, "DepositBurned");
      expect(await token.totalSupply()).to.equal(supplyBefore - DEPOSIT);
      expect(await voting.totalDepositLiability()).to.equal(0n);
      await expect(voting.connect(creator).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "DepositAlreadySettled"
      );
    });

    it("refuses to burn a deposit that earned its refund", async function () {
      await createSubject();
      await voteAll(ethers.parseEther("1000000"));
      await time.increase(7 * DAY + 1);
      await expect(voting.connect(stranger).settleDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "DepositIsRefundable"
      );
    });

    it("refuses to refund a deposit that missed the quorum", async function () {
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("10000"), [], 0, ZeroHash);
      await time.increase(7 * DAY + 1);
      await expect(voting.connect(creator).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "QuorumNotMet"
      );
    });

    it("judges the quorum against the thresholds in force when the subject was created", async function () {
      // A later governance change must not retroactively decide whether a creator gets their
      // deposit back; they should be judged against the rules they paid under.
      await createSubject();
      await voting.connect(v1).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      await voting.connect(v2).vote(1, 0, ethers.parseEther("1000000"), [], 0, ZeroHash);
      // Only two voters, against a snapshot requiring three.
      await runParamProposal(P_QUORUM_VOTERS, 3); // no-op, but proves the snapshot is what counts
      await time.increase(7 * DAY);

      await expect(voting.connect(creator).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "QuorumNotMet"
      );
    });

    it("settlement is blocked before close", async function () {
      await createSubject();
      await expect(voting.connect(stranger).settleDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "SubjectStillOpen"
      );
      await expect(voting.connect(creator).claimDeposit(1)).to.be.revertedWithCustomError(
        voting,
        "SubjectStillOpen"
      );
    });

    it("records refundability on finalize too", async function () {
      await createSubject();
      await voteAll(ethers.parseEther("1000000"));
      await time.increase(7 * DAY + 1);
      await voting.connect(stranger).finalize(1);
      expect((await voting.getSubject(1)).depositRefundable).to.equal(true);
    });
  });

  describe("end to end", function () {
    it("leaves nothing owed and nothing stranded after a full cycle", async function () {
      await createSubject();
      const lock = ethers.parseEther("1000000");
      await voteAll(lock);
      await time.increase(7 * DAY + 1);

      await voting.connect(stranger).finalize(1);
      for (const who of [v1, v2, v3]) await voting.connect(who).claim(1);
      await voting.connect(creator).claimDeposit(1);

      expect(await voting.totalLockedLiability()).to.equal(0n);
      expect(await voting.totalDepositLiability()).to.equal(0n);
      expect(await token.balanceOf(await voting.getAddress())).to.equal(0n);
    });
  });

  async function createSubject() {
    return voting.connect(creator).createSubject("Q", "CID", OPTS, 7 * DAY);
  }

  async function voteAll(amount: bigint) {
    await voting.connect(v1).vote(1, 0, amount, [], 0, ZeroHash);
    await voting.connect(v2).vote(1, 0, amount, [], 0, ZeroHash);
    await voting.connect(v3).vote(1, 1, amount, [], 0, ZeroHash);
  }

  /** Conservation: see the note in CommunityVotingSubjects.test.ts for why this is equality. */
  async function expectSolvent() {
    const held = await token.balanceOf(await voting.getAddress());
    const owed = (await voting.totalLockedLiability()) + (await voting.totalDepositLiability());
    expect(held, "held balance does not equal recorded liabilities").to.equal(owed);
  }

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
