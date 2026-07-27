// CommunityVoting — core contract tests.
//
// Step 1 of the implementation plan: initialization, parameter bounds, and the governance
// overrides. The centrepiece is the `Recovery` guard: GovernanceModule ships a proposal type
// that transfers an arbitrary ERC20 out of the inheriting contract's balance, and this contract
// custodies voters' locked FULA. Without the override, two admins could drain every lock.
// See docs/voting-design.md §5.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, ZeroHash, BytesLike, Contract } from "ethers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const POOL_ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("POOL_ADMIN_ROLE"));

// Proposal types from ProposalTypes.ProposalType
const PT_ADD_ROLE = 1;
const PT_UPGRADE = 3;
const PT_RECOVERY = 4;

// Contract-local proposal types (see CommunityVoting)
const PT_SET_PARAM = 14;
const PT_SET_INTEGRATION = 15;

// Parameter ids
const P = {
  BURN_FEE: 1,
  DEPOSIT: 2,
  MIN_VOTE_BASIS: 3,
  MIN_DURATION: 4,
  MAX_DURATION: 5,
  MEMBER_MULTIPLIER_BPS: 6,
  STAKE_WEIGHT_BPS: 7,
  QUORUM_BASIS: 8,
  QUORUM_VOTERS: 9,
  MAX_OPEN_PER_CREATOR: 10,
  CREATE_COOLDOWN: 11,
  MIN_POOL_JOIN_STAKE: 12,
  MIN_MEMBERSHIP_AGE: 13,
};

const DAY = 24 * 60 * 60;
const TOTAL_SUPPLY = ethers.parseEther("1000000000"); // 1B of the 2B cap

describe("CommunityVoting — core", function () {
  let voting: Contract;
  let token: Contract;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, admin, user1, user2] = await ethers.getSigners();

    const StorageToken = await ethers.getContractFactory("StorageToken");
    token = (await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, TOTAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await token.waitForDeployment();

    // GovernanceModule locks both initial admins for ROLE_CHANGE_DELAY (1 day) after init.
    await time.increase(DAY + 1);
    await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(DAY + 1);
    // transferFromContract is additionally capped by the caller role's transaction limit,
    // which defaults to 0 — without this, moving any token out of StorageToken reverts LowAllowance.
    await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

    const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
    voting = (await upgrades.deployProxy(
      CommunityVoting,
      [await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await voting.waitForDeployment();

    await time.increase(DAY + 1);
    // Nothing in the proposal flow works until quorum is set — it defaults to 0 and
    // _validateQuorum rejects anything below 2. This is a mandatory deploy step.
    await voting.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
  });

  describe("initialization", function () {
    it("wires the token and leaves optional integrations unset", async function () {
      expect(await voting.token()).to.equal(await token.getAddress());
      expect(await voting.stakingEngine()).to.equal(ZeroAddress);
      expect(await voting.storagePool()).to.equal(ZeroAddress);
      expect(await voting.subjectCount()).to.equal(0n);
    });

    it("grants ADMIN_ROLE to both the owner and the admin", async function () {
      expect(await voting.hasRole(ADMIN_ROLE, owner.address)).to.equal(true);
      expect(await voting.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
      expect(await voting.adminCount()).to.equal(2n);
    });

    it("seeds the documented default parameters", async function () {
      expect(await voting.paramValue(P.BURN_FEE)).to.equal(ethers.parseEther("50000"));
      expect(await voting.paramValue(P.DEPOSIT)).to.equal(ethers.parseEther("100000"));
      expect(await voting.paramValue(P.MIN_VOTE_BASIS)).to.equal(ethers.parseEther("10000"));
      expect(await voting.paramValue(P.MIN_DURATION)).to.equal(3 * DAY);
      expect(await voting.paramValue(P.MAX_DURATION)).to.equal(30 * DAY);
      expect(await voting.paramValue(P.MEMBER_MULTIPLIER_BPS)).to.equal(20000);
      expect(await voting.paramValue(P.STAKE_WEIGHT_BPS)).to.equal(10000);
      expect(await voting.paramValue(P.QUORUM_BASIS)).to.equal(ethers.parseEther("5000000"));
      expect(await voting.paramValue(P.QUORUM_VOTERS)).to.equal(15);
      expect(await voting.paramValue(P.MAX_OPEN_PER_CREATOR)).to.equal(3);
      expect(await voting.paramValue(P.CREATE_COOLDOWN)).to.equal(DAY);
      expect(await voting.paramValue(P.MIN_POOL_JOIN_STAKE)).to.equal(ethers.parseEther("1"));
      expect(await voting.paramValue(P.MIN_MEMBERSHIP_AGE)).to.equal(14 * DAY);
    });

    it("every default sits inside its own hard bounds", async function () {
      for (let id = 1; id <= 13; id++) {
        const value = await voting.paramValue(id);
        const [lo, hi] = await voting.paramBounds(id);
        expect(value, `param ${id} default out of bounds`).to.be.gte(lo).and.to.be.lte(hi);
      }
    });

    it("allParams agrees with paramValue for every id", async function () {
      const all = await voting.allParams();
      for (let id = 1; id <= 13; id++) {
        expect(all[id], `param ${id}`).to.equal(await voting.paramValue(id));
      }
    });

    it("rejects a zero token address", async function () {
      const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
      await expect(
        upgrades.deployProxy(
          CommunityVoting,
          [ZeroAddress, ZeroAddress, ZeroAddress, owner.address, admin.address],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.revertedWithCustomError(voting, "InvalidAddress");
    });

    it("cannot be initialized twice", async function () {
      await expect(
        voting
          .connect(owner)
          .initialize(await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address)
      ).to.be.revertedWithCustomError(voting, "InvalidInitialization");
    });
  });

  describe("paramBounds", function () {
    it("min never exceeds max, for every known parameter", async function () {
      for (let id = 1; id <= 13; id++) {
        const [lo, hi] = await voting.paramBounds(id);
        expect(lo, `param ${id}`).to.be.lte(hi);
      }
    });

    it("rejects unknown parameter ids", async function () {
      await expect(voting.paramBounds(0)).to.be.revertedWithCustomError(voting, "InvalidParam");
      await expect(voting.paramBounds(14)).to.be.revertedWithCustomError(voting, "InvalidParam");
      await expect(voting.paramBounds(255)).to.be.revertedWithCustomError(voting, "InvalidParam");
    });
  });

  // -------------------------------------------------------------------------
  // The critical guard.
  // -------------------------------------------------------------------------
  describe("Recovery proposal guard", function () {
    const amount = ethers.parseEther("1000");

    it("refuses a Recovery proposal targeting the governed token", async function () {
      await expect(
        voting
          .connect(owner)
          .createProposal(PT_RECOVERY, 0, user1.address, ZeroHash, amount, await token.getAddress())
      ).to.be.revertedWithCustomError(voting, "RecoveryBlocked");
    });

    it("refuses it regardless of which admin proposes or who the beneficiary is", async function () {
      const tokenAddr = await token.getAddress();
      for (const proposer of [owner, admin]) {
        for (const beneficiary of [user1, user2, owner, admin]) {
          await expect(
            voting
              .connect(proposer)
              .createProposal(PT_RECOVERY, 0, beneficiary.address, ZeroHash, amount, tokenAddr)
          ).to.be.revertedWithCustomError(voting, "RecoveryBlocked");
        }
      }
    });

    it("refuses it even when the contract actually holds a balance to take", async function () {
      // Make the attack materially worthwhile: give the voting contract real FULA.
      // (Whitelist + transferFromContract is the only way tokens leave StorageToken.)
      const votingAddr = await voting.getAddress();
      await createAndExecuteTokenProposal(5 /* AddWhitelist */, votingAddr);
      await token.connect(owner).transferFromContract(votingAddr, ethers.parseEther("1000000"));
      expect(await token.balanceOf(votingAddr)).to.equal(ethers.parseEther("1000000"));

      await expect(
        voting
          .connect(owner)
          .createProposal(PT_RECOVERY, 0, user1.address, ZeroHash, amount, await token.getAddress())
      ).to.be.revertedWithCustomError(voting, "RecoveryBlocked");
    });

    it("still allows recovering an unrelated token sent here by mistake", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const mock = await MockERC20.deploy(ethers.parseEther("1000"));
      await mock.waitForDeployment();

      await expect(
        voting
          .connect(owner)
          .createProposal(PT_RECOVERY, 0, user1.address, ZeroHash, amount, await mock.getAddress())
      ).to.emit(voting, "ProposalCreated");
    });
  });

  // -------------------------------------------------------------------------
  // `createProposal` is a hand-written mirror of the parent (Solidity forbids `super` on an
  // overridden external function), so every inherited branch needs its own coverage to catch
  // divergence from GovernanceModule.
  // -------------------------------------------------------------------------
  describe("createProposal — inherited branches still behave", function () {
    it("creates a role-change proposal", async function () {
      await expect(
        voting.connect(owner).createProposal(PT_ADD_ROLE, 0, user1.address, POOL_ADMIN_ROLE, 0, ZeroAddress)
      ).to.emit(voting, "ProposalCreated");
    });

    it("rejects an unknown role on a role-change proposal", async function () {
      const bogusRole = ethers.keccak256(ethers.toUtf8Bytes("NOT_A_ROLE"));
      await expect(
        voting.connect(owner).createProposal(PT_ADD_ROLE, 0, user1.address, bogusRole, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidRole");
    });

    it("creates an upgrade proposal and rejects self-targeting", async function () {
      const Impl = await ethers.getContractFactory("CommunityVoting");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();

      await expect(
        voting.connect(owner).createProposal(PT_UPGRADE, 0, await newImpl.getAddress(), ZeroHash, 0, ZeroAddress)
      ).to.emit(voting, "ProposalCreated");

      await expect(
        voting.connect(owner).createProposal(PT_UPGRADE, 0, await voting.getAddress(), ZeroHash, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "AlreadyUpgraded");
    });

    it("rejects a zero target", async function () {
      await expect(
        voting.connect(owner).createProposal(PT_ADD_ROLE, 0, ZeroAddress, ADMIN_ROLE, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidAddress");
    });

    it("rejects a second pending proposal for the same target", async function () {
      await voting.connect(owner).createProposal(PT_ADD_ROLE, 0, user1.address, POOL_ADMIN_ROLE, 0, ZeroAddress);
      await expect(
        voting.connect(owner).createProposal(PT_ADD_ROLE, 0, user1.address, POOL_ADMIN_ROLE, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "ExistingActiveProposal");
    });

    it("rejects callers without ADMIN_ROLE", async function () {
      await expect(
        voting.connect(user1).createProposal(PT_ADD_ROLE, 0, user2.address, POOL_ADMIN_ROLE, 0, ZeroAddress)
      ).to.be.reverted;
    });

    it("rejects unknown proposal types", async function () {
      await expect(
        voting.connect(owner).createProposal(99, 0, user1.address, ZeroHash, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidProposalType");
    });

    it("refuses to create anything until quorum is configured", async function () {
      const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
      const fresh = (await upgrades.deployProxy(
        CommunityVoting,
        [await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address],
        { kind: "uups", initializer: "initialize" }
      )) as unknown as Contract;
      await fresh.waitForDeployment();
      await time.increase(DAY + 1);

      await expect(
        fresh.connect(owner).createProposal(PT_ADD_ROLE, 0, user1.address, POOL_ADMIN_ROLE, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(fresh, "InvalidQuorumErr");
    });
  });

  describe("parameter governance (proposal type 14)", function () {
    it("applies a change through the full two-admin flow", async function () {
      const newFee = ethers.parseEther("75000");
      await expect(runParamProposal(P.BURN_FEE, newFee))
        .to.emit(voting, "ParamUpdated")
        .withArgs(P.BURN_FEE, ethers.parseEther("50000"), newFee);
      expect(await voting.paramValue(P.BURN_FEE)).to.equal(newFee);
    });

    it("can set every parameter to both its exact minimum and maximum", async function () {
      // MIN_DURATION is skipped in the max pass and MAX_DURATION in the min pass, because
      // the cross-field invariant (min <= max) legitimately forbids those two combinations.
      for (let id = 1; id <= 13; id++) {
        const [lo, hi] = await voting.paramBounds(id);
        if (id !== P.MAX_DURATION) {
          await runParamProposal(id, lo);
          expect(await voting.paramValue(id), `param ${id} at min`).to.equal(lo);
        }
        if (id !== P.MIN_DURATION) {
          await runParamProposal(id, hi);
          expect(await voting.paramValue(id), `param ${id} at max`).to.equal(hi);
        }
      }
    });

    it("rejects a value one below the minimum, at creation", async function () {
      for (let id = 1; id <= 13; id++) {
        const [lo] = await voting.paramBounds(id);
        if (lo === 0n) continue; // no representable value below zero
        await expect(
          createParamProposal(id, lo - 1n),
          `param ${id} accepted min-1`
        ).to.be.revertedWithCustomError(voting, "ParamOutOfBounds");
      }
    });

    it("rejects a value one above the maximum, at creation", async function () {
      for (let id = 1; id <= 13; id++) {
        const [, hi] = await voting.paramBounds(id);
        await expect(
          createParamProposal(id, hi + 1n),
          `param ${id} accepted max+1`
        ).to.be.revertedWithCustomError(voting, "ParamOutOfBounds");
      }
    });

    it("re-checks the cross-field duration invariant at execution time", async function () {
      // Both values are individually in-bounds, so this can only be caught by the check that
      // runs when the proposal executes — 24h after it was created and validated.
      await runParamProposal(P.MIN_DURATION, 20 * DAY);
      expect(await voting.paramValue(P.MIN_DURATION)).to.equal(20 * DAY);

      const [lo] = await voting.paramBounds(P.MAX_DURATION);
      expect(lo).to.be.lte(10 * DAY); // 10 days is a legal MAX_DURATION on its own

      const proposalId = await createParamProposal(P.MAX_DURATION, BigInt(10 * DAY));
      await time.increase(DAY + 1);
      await expect(
        voting.connect(admin).approveProposal(proposalId)
      ).to.be.revertedWithCustomError(voting, "ParamOutOfBounds");
      // The old, coherent window is intact.
      expect(await voting.paramValue(P.MAX_DURATION)).to.equal(30 * DAY);
    });

    it("rejects unknown parameter ids", async function () {
      await expect(createParamProposal(0, 1n)).to.be.revertedWithCustomError(voting, "InvalidParam");
      await expect(createParamProposal(14, 1n)).to.be.revertedWithCustomError(voting, "InvalidParam");
    });

    it("cannot be tricked by an id that truncates into a valid one", async function () {
      // uint8(2**32 + 1) == 1 == P_BURN_FEE. The id is range-checked as a uint40 precisely so
      // this cannot silently become a burn-fee change.
      const truncating = 2n ** 32n + 1n; // still inside uint40
      await expect(
        voting
          .connect(owner)
          .createProposal(PT_SET_PARAM, truncating, await voting.getAddress(), ZeroHash, ethers.parseEther("60000"), ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidParam");
    });

    it("requires canonical zero values in the unused proposal fields", async function () {
      const self = await voting.getAddress();
      const value = ethers.parseEther("60000");
      // non-zero role
      await expect(
        voting.connect(owner).createProposal(PT_SET_PARAM, P.BURN_FEE, self, ADMIN_ROLE, value, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "NonCanonicalProposalField");
      // non-zero tokenAddress
      await expect(
        voting.connect(owner).createProposal(PT_SET_PARAM, P.BURN_FEE, self, ZeroHash, value, await token.getAddress())
      ).to.be.revertedWithCustomError(voting, "NonCanonicalProposalField");
      // target must be the contract itself
      await expect(
        voting.connect(owner).createProposal(PT_SET_PARAM, P.BURN_FEE, user1.address, ZeroHash, value, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "NonCanonicalProposalField");
    });

    it("persists the payload so execution cannot silently apply zero", async function () {
      // Guards against the class of bug StorageToken hit with ChangeTreasuryFee, where the
      // proposal's `amount` was never stored and execution set the value to 0.
      const newDeposit = ethers.parseEther("250000");
      await runParamProposal(P.DEPOSIT, newDeposit);
      expect(await voting.paramValue(P.DEPOSIT)).to.equal(newDeposit);
      expect(await voting.paramValue(P.DEPOSIT)).to.not.equal(0n);
    });

    it("cannot execute after the 48h expiry window", async function () {
      const proposalId = await createParamProposal(P.BURN_FEE, ethers.parseEther("60000"));
      await time.increase(3 * DAY); // past the 48h PROPOSAL_TIMEOUT
      await expect(voting.connect(admin).approveProposal(proposalId)).to.be.reverted;
      expect(await voting.paramValue(P.BURN_FEE)).to.equal(ethers.parseEther("50000"));
    });

    it("serialises parameter proposals, and an expired one blocks until cleaned up", async function () {
      // All parameter proposals share `target == address(this)`, and GovernanceModule's
      // pendingProposals check does not test for expiry. This is a real operational footgun:
      // one abandoned proposal freezes all parameter governance until cleanup is run.
      await createParamProposal(P.BURN_FEE, ethers.parseEther("60000"));

      await expect(
        createParamProposal(P.DEPOSIT, ethers.parseEther("200000"))
      ).to.be.revertedWithCustomError(voting, "ExistingActiveProposal");

      // Let it expire — it still blocks.
      await time.increase(3 * DAY);
      await expect(
        createParamProposal(P.DEPOSIT, ethers.parseEther("200000"))
      ).to.be.revertedWithCustomError(voting, "ExistingActiveProposal");

      // Cleanup clears the slot and governance resumes.
      await voting.connect(owner).cleanupExpiredProposals(10);
      await runParamProposal(P.DEPOSIT, ethers.parseEther("200000"));
      expect(await voting.paramValue(P.DEPOSIT)).to.equal(ethers.parseEther("200000"));
    });
  });

  describe("integration governance (proposal type 15)", function () {
    it("sets and clears the staking engine and storage pool", async function () {
      await expect(runIntegrationProposal(1, user1.address))
        .to.emit(voting, "IntegrationUpdated")
        .withArgs(1, ZeroAddress, user1.address);
      expect(await voting.stakingEngine()).to.equal(user1.address);

      await runIntegrationProposal(2, user2.address);
      expect(await voting.storagePool()).to.equal(user2.address);

      // Zero is a legal value: it is how an integration is switched off. This is why the new
      // address travels in `tokenAddress` and not `target`, which the base forbids being zero.
      await runIntegrationProposal(1, ZeroAddress);
      expect(await voting.stakingEngine()).to.equal(ZeroAddress);
    });

    it("rejects unknown integration slots and non-canonical fields", async function () {
      const self = await voting.getAddress();
      await expect(
        voting.connect(owner).createProposal(PT_SET_INTEGRATION, 3, self, ZeroHash, 0, user1.address)
      ).to.be.revertedWithCustomError(voting, "InvalidParam");
      await expect(
        voting.connect(owner).createProposal(PT_SET_INTEGRATION, 1, self, ZeroHash, 1, user1.address)
      ).to.be.revertedWithCustomError(voting, "NonCanonicalProposalField");
      await expect(
        voting.connect(owner).createProposal(PT_SET_INTEGRATION, 1, user1.address, ZeroHash, 0, user1.address)
      ).to.be.revertedWithCustomError(voting, "NonCanonicalProposalField");
    });
  });

  describe("upgrade authorization", function () {
    it("cannot be upgraded without a passed proposal", async function () {
      const Impl = await ethers.getContractFactory("CommunityVoting");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();

      await expect(
        voting.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.reverted;
    });

    it("cannot be upgraded by a non-admin", async function () {
      const Impl = await ethers.getContractFactory("CommunityVoting");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();

      await expect(
        voting.connect(user1).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.reverted;
    });
  });

  /** Stage a parameter proposal; returns its id. Does not approve or execute. */
  async function createParamProposal(paramId: number, value: bigint): Promise<string> {
    const tx = await voting
      .connect(owner)
      .createProposal(PT_SET_PARAM, paramId, await voting.getAddress(), ZeroHash, value, ZeroAddress);
    const receipt = await tx.wait();
    return receipt!.logs[0].topics[1];
  }

  /**
   * Run a parameter change end-to-end: propose (auto-approves for the proposer), wait out the
   * 24h execution delay, then have the second admin approve — which auto-executes once quorum
   * and the delay are both satisfied.
   */
  async function runParamProposal(paramId: number, value: bigint | number) {
    const proposalId = await createParamProposal(paramId, BigInt(value));
    await time.increase(DAY + 1);
    return voting.connect(admin).approveProposal(proposalId);
  }

  async function runIntegrationProposal(slot: number, newAddress: string) {
    const tx = await voting
      .connect(owner)
      .createProposal(PT_SET_INTEGRATION, slot, await voting.getAddress(), ZeroHash, 0, newAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];
    await time.increase(DAY + 1);
    return voting.connect(admin).approveProposal(proposalId);
  }

  // Helper: run a StorageToken proposal (e.g. AddWhitelist) through the full 2-admin flow.
  async function createAndExecuteTokenProposal(proposalType: number, target: string) {
    const tx = await token
      .connect(owner)
      .createProposal(proposalType, 0, target, ZeroHash, 0, ZeroAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];

    await time.increase(DAY + 1); // execution delay
    await token.connect(admin).approveProposal(proposalId);
    await time.increase(DAY + 1); // whitelist lock
    return proposalId;
  }
});
