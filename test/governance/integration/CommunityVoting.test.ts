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
      const p = await voting.params();
      expect(p.burnFee).to.equal(ethers.parseEther("50000"));
      expect(p.deposit).to.equal(ethers.parseEther("100000"));
      expect(p.minVoteBasis).to.equal(ethers.parseEther("10000"));
      expect(p.minDuration).to.equal(3 * DAY);
      expect(p.maxDuration).to.equal(30 * DAY);
      expect(p.memberMultiplierBps).to.equal(20000);
      expect(p.stakeWeightBps).to.equal(10000);
      expect(p.quorumBasis).to.equal(ethers.parseEther("5000000"));
      expect(p.quorumVoters).to.equal(15);
      expect(p.maxOpenPerCreator).to.equal(3);
      expect(p.createCooldown).to.equal(DAY);
      expect(p.minPoolJoinStake).to.equal(ethers.parseEther("1"));
      expect(p.minMembershipAge).to.equal(14 * DAY);
    });

    it("every default sits inside its own hard bounds", async function () {
      const p = await voting.params();
      const values: Record<number, bigint> = {
        [P.BURN_FEE]: p.burnFee,
        [P.DEPOSIT]: p.deposit,
        [P.MIN_VOTE_BASIS]: p.minVoteBasis,
        [P.MIN_DURATION]: BigInt(p.minDuration),
        [P.MAX_DURATION]: BigInt(p.maxDuration),
        [P.MEMBER_MULTIPLIER_BPS]: BigInt(p.memberMultiplierBps),
        [P.STAKE_WEIGHT_BPS]: BigInt(p.stakeWeightBps),
        [P.QUORUM_BASIS]: p.quorumBasis,
        [P.QUORUM_VOTERS]: BigInt(p.quorumVoters),
        [P.MAX_OPEN_PER_CREATOR]: BigInt(p.maxOpenPerCreator),
        [P.CREATE_COOLDOWN]: BigInt(p.createCooldown),
        [P.MIN_POOL_JOIN_STAKE]: p.minPoolJoinStake,
        [P.MIN_MEMBERSHIP_AGE]: BigInt(p.minMembershipAge),
      };
      for (const [id, value] of Object.entries(values)) {
        const [lo, hi] = await voting.paramBounds(Number(id));
        expect(value, `param ${id} default out of bounds`).to.be.gte(lo).and.to.be.lte(hi);
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

  describe("custom proposal types (not yet implemented at this step)", function () {
    it("reverts for the parameter and integration types", async function () {
      await expect(
        voting.connect(owner).createProposal(PT_SET_PARAM, P.BURN_FEE, await voting.getAddress(), ZeroHash, 1, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidProposalType");
      await expect(
        voting.connect(owner).createProposal(PT_SET_INTEGRATION, 1, await voting.getAddress(), ZeroHash, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(voting, "InvalidProposalType");
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
