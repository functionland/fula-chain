import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { RewardsProgram, RewardsExtension, StorageToken, StakingPool } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

// Helper to create bytes12 memberIDs
function toBytes12(str: string): string {
  const bytes = ethers.toUtf8Bytes(str);
  if (bytes.length > 12) throw new Error("String too long for bytes12");
  const padded = new Uint8Array(12);
  padded.set(bytes);
  return ethers.hexlify(padded);
}

// Helper to create bytes8 program codes
function toBytes8(str: string): string {
  const bytes = ethers.toUtf8Bytes(str);
  if (bytes.length > 8) throw new Error("String too long for bytes8");
  const padded = new Uint8Array(8);
  padded.set(bytes);
  return ethers.hexlify(padded);
}

// MemberRole enum values matching the contract
const MemberRole = {
  None: 0,
  Client: 1,
  TeamLeader: 2,
  ProgramAdmin: 3,
};

const MemberType = {
  Free: 0,
  Vip: 1,
  Elite: 2,
  PSPartner: 3,
};

describe("RewardsProgram", function () {
  let rewardsProgram: RewardsProgram;
  let rewardsExtension: RewardsExtension;
  let extensionAtProxy: RewardsExtension;
  let storageToken: StorageToken;
  let stakingPool: StakingPool;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let programAdmin1: SignerWithAddress;
  let teamLeader1: SignerWithAddress;
  let client1: SignerWithAddress;
  let client2: SignerWithAddress;
  let otherAccount: SignerWithAddress;

  const TOTAL_SUPPLY = ethers.parseEther("2000000000");
  const USER_TOKENS = ethers.parseEther("1000000");
  const DEPOSIT_AMOUNT = ethers.parseEther("10000");

  async function whitelistAccount(account: SignerWithAddress) {
    const addWhitelistType = 5;
    const tx = await storageToken.connect(owner).createProposal(
      addWhitelistType, 0, account.address, ethers.ZeroHash, 0, ZeroAddress
    );
    const receipt = await tx.wait();
    const event = receipt?.logs[0];
    const proposalId = event?.topics[1];
    await time.increase(24 * 60 * 60 + 1);
    await storageToken.connect(admin).approveProposal(proposalId!);
    await time.increase(24 * 60 * 60 + 1);
  }

  beforeEach(async function () {
    [owner, admin, programAdmin1, teamLeader1, client1, client2, otherAccount] =
      await ethers.getSigners();

    // 1. Deploy StorageToken (mock ERC20)
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = (await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, TOTAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as StorageToken;
    await storageToken.waitForDeployment();

    // 2. Deploy StakingPool (token vault)
    const StakingPool = await ethers.getContractFactory("StakingPool");
    stakingPool = (await upgrades.deployProxy(
      StakingPool,
      [await storageToken.getAddress(), owner.address, admin.address],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as StakingPool;
    await stakingPool.waitForDeployment();

    // 3. Deploy RewardsProgram
    const RewardsProgram = await ethers.getContractFactory("RewardsProgram");
    rewardsProgram = (await upgrades.deployProxy(
      RewardsProgram,
      [
        await storageToken.getAddress(),
        await stakingPool.getAddress(),
        owner.address,
        admin.address,
      ],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as RewardsProgram;
    await rewardsProgram.waitForDeployment();

    // 3b. Deploy RewardsExtension and link it
    const RewardsExtensionFactory = await ethers.getContractFactory("RewardsExtension");
    rewardsExtension = (await RewardsExtensionFactory.deploy()) as unknown as RewardsExtension;
    await rewardsExtension.waitForDeployment();
    await rewardsProgram.connect(owner).setExtension(await rewardsExtension.getAddress());

    // Helper: Get extension interface at main contract address (for delegatecall)
    extensionAtProxy = RewardsExtensionFactory.attach(await rewardsProgram.getAddress()) as RewardsExtension;

    // 4. Set RewardsProgram as stakingEngine on StakingPool
    await stakingPool.connect(owner).setStakingEngine(await rewardsProgram.getAddress());

    // 5. Set up governance params
    await time.increase(24 * 60 * 60 + 1);
    await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    await stakingPool.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(24 * 60 * 60 + 1);
    await stakingPool.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    await rewardsProgram.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(24 * 60 * 60 + 1);
    await rewardsProgram.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

    // 6. Whitelist StakingPool and RewardsProgram in StorageToken
    await whitelistAccount(owner as unknown as SignerWithAddress);
    // Whitelist stakingPool address
    const stakingPoolAddr = await stakingPool.getAddress();
    const rewardsProgramAddr = await rewardsProgram.getAddress();

    // Whitelist stakingPool
    const tx1 = await storageToken.connect(owner).createProposal(
      5, 0, stakingPoolAddr, ethers.ZeroHash, 0, ZeroAddress
    );
    const r1 = await tx1.wait();
    const p1 = r1?.logs[0]?.topics[1];
    await time.increase(24 * 60 * 60 + 1);
    await storageToken.connect(admin).approveProposal(p1!);
    await time.increase(24 * 60 * 60 + 1);

    // Whitelist rewardsProgram
    const tx2 = await storageToken.connect(owner).createProposal(
      5, 0, rewardsProgramAddr, ethers.ZeroHash, 0, ZeroAddress
    );
    const r2 = await tx2.wait();
    const p2 = r2?.logs[0]?.topics[1];
    await time.increase(24 * 60 * 60 + 1);
    await storageToken.connect(admin).approveProposal(p2!);
    await time.increase(24 * 60 * 60 + 1);

    // 7. Whitelist test users and transfer tokens
    const users = [programAdmin1, teamLeader1, client1, client2, otherAccount];
    for (const user of users) {
      await whitelistAccount(user as unknown as SignerWithAddress);
      await storageToken.connect(admin).transferFromContract(user.address, USER_TOKENS);
    }
  });

  // ============================================================
  // INITIALIZATION
  // ============================================================

  describe("Initialization", function () {
    it("should initialize with correct token and stakingPool", async function () {
      expect(await rewardsProgram.token()).to.equal(await storageToken.getAddress());
      expect(await rewardsProgram.stakingPool()).to.equal(await stakingPool.getAddress());
    });

    it("should grant ADMIN_ROLE to owner and admin", async function () {
      expect(await rewardsProgram.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await rewardsProgram.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should revert initialization with zero addresses", async function () {
      const RewardsProgram = await ethers.getContractFactory("RewardsProgram");
      await expect(
        upgrades.deployProxy(
          RewardsProgram,
          [ZeroAddress, await stakingPool.getAddress(), owner.address, admin.address],
          { kind: "uups", initializer: "initialize" }
        )
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidAddress");
    });

    it("should set RewardsProgram as stakingEngine", async function () {
      expect(await stakingPool.stakingEngine()).to.equal(await rewardsProgram.getAddress());
    });
  });

  // ============================================================
  // PROGRAM MANAGEMENT
  // ============================================================

  describe("Program Management", function () {
    it("should allow Admin to create a program", async function () {
      const code = toBytes8("SRP");
      await expect(rewardsProgram.connect(owner).createProgram(code, "Solidity Rewards", "A program"))
        .to.emit(rewardsProgram, "ProgramCreated")
        .withArgs(1, code, "Solidity Rewards");

      const program = await rewardsProgram.getProgram(1);
      expect(program.id).to.equal(1);
      expect(program.code).to.equal(code);
      expect(program.name).to.equal("Solidity Rewards");
      expect(program.active).to.be.true;
    });

    it("should auto-increment program IDs", async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      await rewardsProgram.connect(owner).createProgram(toBytes8("GTP"), "P2", "D2");
      await rewardsProgram.connect(owner).createProgram(toBytes8("DEV"), "P3", "D3");

      expect((await rewardsProgram.getProgram(1)).name).to.equal("P1");
      expect((await rewardsProgram.getProgram(2)).name).to.equal("P2");
      expect((await rewardsProgram.getProgram(3)).name).to.equal("P3");
      expect(await rewardsProgram.programCount()).to.equal(3);
    });

    it("should reject duplicate program codes", async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      await expect(
        rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P2", "D2")
      ).to.be.revertedWithCustomError(rewardsProgram, "DuplicateProgramCode");
    });

    it("should reject program creation from non-Admin", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).createProgram(toBytes8("SRP"), "P1", "D1")
      ).to.be.reverted;
    });

    it("should allow lookup by program code via programCodeToId", async function () {
      const code = toBytes8("SRP");
      await rewardsProgram.connect(owner).createProgram(code, "Solidity Rewards", "Desc");
      const id = await rewardsProgram.programCodeToId(code);
      expect(id).to.equal(1);
      const program = await rewardsProgram.getProgram(id);
      expect(program.name).to.equal("Solidity Rewards");
    });
  });

  // ============================================================
  // PROGRAM ADMIN MANAGEMENT
  // ============================================================

  describe("ProgramAdmin Management", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
    });

    it("should allow Admin to assign ProgramAdmin", async function () {
      const memberId = toBytes12("PA001");
      await expect(
        rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, memberId, ethers.ZeroHash, MemberType.Free)
      )
        .to.emit(rewardsProgram, "ProgramAdminAssigned")
        .withArgs(programId, programAdmin1.address, memberId);

      const member = await rewardsProgram.getMember(programId, programAdmin1.address);
      expect(member.role).to.equal(MemberRole.ProgramAdmin);
      expect(member.active).to.be.true;
      expect(member.parent).to.equal(owner.address);
    });

    it("should reject ProgramAdmin assignment from non-Admin", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).assignProgramAdmin(programId, teamLeader1.address, toBytes12("PA002"), ethers.ZeroHash, MemberType.Free)
      ).to.be.reverted;
    });

    it("should allow one user as ProgramAdmin of multiple programs", async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("GTP"), "Go Program", "Desc");

      await rewardsProgram.connect(owner).assignProgramAdmin(1, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(owner).assignProgramAdmin(2, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);

      expect((await rewardsProgram.getMember(1, programAdmin1.address)).active).to.be.true;
      expect((await rewardsProgram.getMember(2, programAdmin1.address)).active).to.be.true;

    });

    it("should allow Admin to remove ProgramAdmin via removeMember", async function () {
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);

      await expect(rewardsProgram.connect(owner).removeMember(programId, programAdmin1.address))
        .to.emit(rewardsProgram, "MemberRemoved")
        .withArgs(programId, programAdmin1.address);

      const member = await rewardsProgram.getMember(programId, programAdmin1.address);
      expect(member.active).to.be.false;
    });

    it("should reject duplicate memberID in same program", async function () {
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await expect(
        rewardsProgram.connect(owner).assignProgramAdmin(programId, teamLeader1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free)
      ).to.be.revertedWithCustomError(rewardsProgram, "DuplicateMemberID");
    });

    it("should allow same memberID in different programs", async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("GTP"), "Go Program", "Desc");
      const memberId = toBytes12("PA001");

      await rewardsProgram.connect(owner).assignProgramAdmin(1, programAdmin1.address, memberId, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(owner).assignProgramAdmin(2, teamLeader1.address, memberId, ethers.ZeroHash, MemberType.Free);

      // Both should succeed - same memberID allowed in different programs
      expect((await rewardsProgram.getMember(1, programAdmin1.address)).memberID).to.equal(memberId);
      expect((await rewardsProgram.getMember(2, teamLeader1.address)).memberID).to.equal(memberId);
    });
  });

  // ============================================================
  // MEMBER MANAGEMENT
  // ============================================================

  describe("Member Management", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
    });

    it("should allow ProgramAdmin to add TeamLeader", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free)
      )
        .to.emit(rewardsProgram, "MemberAdded")
        .withArgs(programId, teamLeader1.address, programAdmin1.address, MemberRole.TeamLeader, MemberType.Free, toBytes12("TL001"));

      const member = await rewardsProgram.getMember(programId, teamLeader1.address);
      expect(member.role).to.equal(MemberRole.TeamLeader);
      expect(member.parent).to.equal(programAdmin1.address);
    });

    it("should allow ProgramAdmin to add Client", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);
      const member = await rewardsProgram.getMember(programId, client1.address);
      expect(member.role).to.equal(MemberRole.Client);
      expect(member.parent).to.equal(programAdmin1.address);
    });

    it("should allow TeamLeader to add Client", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      const member = await rewardsProgram.getMember(programId, client1.address);
      expect(member.role).to.equal(MemberRole.Client);
      expect(member.parent).to.equal(teamLeader1.address);
    });

    it("should reject Client adding sub-members", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);
      await expect(
        rewardsProgram.connect(client1).addMember(programId, client2.address, toBytes12("CL002"), MemberRole.Client, ethers.ZeroHash, MemberType.Free)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should reject TeamLeader adding TeamLeader", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await expect(
        rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("TL002"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should allow Admin to add any role to any program", async function () {
      await rewardsProgram.connect(owner).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(owner).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      expect((await rewardsProgram.getMember(programId, teamLeader1.address)).role).to.equal(MemberRole.TeamLeader);
      expect((await rewardsProgram.getMember(programId, client1.address)).role).to.equal(MemberRole.Client);
    });

    it("should track parent hierarchy correctly", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      // client1's parent is teamLeader1
      expect((await rewardsProgram.getMember(programId, client1.address)).parent).to.equal(teamLeader1.address);
      // teamLeader1's parent is programAdmin1
      expect((await rewardsProgram.getMember(programId, teamLeader1.address)).parent).to.equal(programAdmin1.address);
      // programAdmin1's parent is owner (the admin who assigned them)
      expect((await rewardsProgram.getMember(programId, programAdmin1.address)).parent).to.equal(owner.address);
    });

    it("should look up member by memberID", async function () {
      const memberId = toBytes12("TL001");
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, memberId, MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );

      const member = await rewardsProgram.getMemberByID(memberId, programId);
      expect(member.wallet).to.equal(teamLeader1.address);
      expect(member.role).to.equal(MemberRole.TeamLeader);
    });
  });

  // ============================================================
  // TOKEN DEPOSIT
  // ============================================================

  describe("Token Deposit", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
    });

    it("should transfer FULA from wallet to StakingPool and credit balance", async function () {
      const rpAddr = await rewardsProgram.getAddress();
      const spAddr = await stakingPool.getAddress();

      // Approve and deposit
      await storageToken.connect(programAdmin1).approve(rpAddr, DEPOSIT_AMOUNT);
      await expect(rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, ""))
        .to.emit(rewardsProgram, "TokensDeposited")
        .withArgs(1, programId, programAdmin1.address, DEPOSIT_AMOUNT, 0, "");

      // Check StakingPool received the tokens
      expect(await storageToken.balanceOf(spAddr)).to.equal(DEPOSIT_AMOUNT);

      // Check member's balance
      const [available, permLocked, timeLocked] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      expect(available).to.equal(DEPOSIT_AMOUNT);
      expect(permLocked).to.equal(0);
      expect(timeLocked).to.equal(0);
    });

    it("should reject deposit with zero amount", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).addTokens(programId, 0, 0, "")
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidAmount");
    });

    it("should reject deposit from non-member non-admin", async function () {
      await expect(
        rewardsProgram.connect(otherAccount).addTokens(programId, DEPOSIT_AMOUNT, 0, "")
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");
    });

    it("should allow admin to deposit without being a program member", async function () {
      await storageToken.connect(admin).transferFromContract(owner.address, USER_TOKENS);
      await storageToken.connect(owner).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(owner).addTokens(programId, DEPOSIT_AMOUNT, 0, "");

      const [available] = await rewardsProgram.getBalance(programId, owner.address);
      expect(available).to.equal(DEPOSIT_AMOUNT);
    });
  });

  // ============================================================
  // TRANSFER TO SUB-MEMBER
  // ============================================================

  describe("Transfer to Sub-Member", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      // Deposit tokens for programAdmin1
      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
    });

    it("should transfer unlocked tokens to direct child", async function () {
      const amount = ethers.parseEther("1000");
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, amount, false, 0
        )
      )
        .to.emit(rewardsProgram, "TokensTransferredToMember");

      const [senderAvail] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      expect(senderAvail).to.equal(DEPOSIT_AMOUNT - amount);

      const [receiverAvail] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(receiverAvail).to.equal(amount);
    });

    it("should transfer to indirect child (grandchild)", async function () {
      const amount = ethers.parseEther("500");
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, client1.address, amount, false, 0
      );

      const [receiverAvail] = await rewardsProgram.getBalance(programId, client1.address);
      expect(receiverAvail).to.equal(amount);
    });

    it("should reject transfer to non-sub-member", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, otherAccount.address, ethers.parseEther("100"), false, 0
        )
      ).to.be.revertedWithCustomError(rewardsProgram, "NotSubMember");
    });

    it("should reject transfer exceeding available balance", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, DEPOSIT_AMOUNT + 1n, false, 0
        )
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");
    });

    it("should credit permanentlyLocked when locked=true", async function () {
      const amount = ethers.parseEther("500");
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, amount, true, 0
      );

      const [avail, permLocked] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(avail).to.equal(0);
      expect(permLocked).to.equal(amount);
    });

    it("should credit timeLocked when lockTimeDays > 0", async function () {
      const amount = ethers.parseEther("500");
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, amount, false, 7
      );

      const [avail, permLocked, timeLocked] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(avail).to.equal(0);
      expect(permLocked).to.equal(0);
      expect(timeLocked).to.equal(amount);
    });

    it("should reject lockTimeDays exceeding 3 years", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, ethers.parseEther("100"), false, 1096
        )
      ).to.be.revertedWithCustomError(rewardsProgram, "LockTimeTooLong");
    });
  });

  // ============================================================
  // TRANSFER BACK TO PARENT
  // ============================================================

  describe("Transfer Back to Parent", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      // Deposit and transfer tokens down the chain
      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("5000"), false, 0
      );
      await rewardsProgram.connect(teamLeader1).transferToSubMember(
        programId, client1.address, ethers.parseEther("2000"), false, 0
      );
    });

    it("should transfer back to direct parent", async function () {
      const amount = ethers.parseEther("500");
      await expect(
        rewardsProgram.connect(client1).transferToParent(programId, ZeroAddress, amount)
      )
        .to.emit(rewardsProgram, "TokensTransferredToParent")
        .withArgs(programId, client1.address, teamLeader1.address, amount);

      const [clientAvail] = await rewardsProgram.getBalance(programId, client1.address);
      expect(clientAvail).to.equal(ethers.parseEther("1500"));

      const [tlAvail] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(tlAvail).to.equal(ethers.parseEther("3000") + amount); // 3000 remaining + 500 back
    });

    it("should transfer back to grandparent", async function () {
      const amount = ethers.parseEther("500");
      await rewardsProgram.connect(client1).transferToParent(programId, programAdmin1.address, amount);

      const [paAvail] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      expect(paAvail).to.equal(ethers.parseEther("5000") + amount); // 5000 remaining + 500 back
    });

    it("should transfer back to admin (top of hierarchy)", async function () {
      const amount = ethers.parseEther("200");
      await rewardsProgram.connect(client1).transferToParent(programId, owner.address, amount);

      const [adminAvail] = await rewardsProgram.getBalance(programId, owner.address);
      expect(adminAvail).to.equal(amount);
    });

    it("should reject transfer to non-ancestor", async function () {
      await expect(
        rewardsProgram.connect(client1).transferToParent(programId, otherAccount.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(rewardsProgram, "NotInParentChain");
    });

    it("should transfer permanently locked tokens back to parent", async function () {
      // Transfer locked tokens to client
      await rewardsProgram.connect(teamLeader1).transferToSubMember(
        programId, client1.address, ethers.parseEther("1000"), true, 0
      );

      // Client has 2000 available + 1000 locked
      const [avail, permLocked] = await rewardsProgram.getBalance(programId, client1.address);
      expect(avail).to.equal(ethers.parseEther("2000"));
      expect(permLocked).to.equal(ethers.parseEther("1000"));

      // Transfer back total 2500 (from available first, then locked)
      await rewardsProgram.connect(client1).transferToParent(programId, ZeroAddress, ethers.parseEther("2500"));

      const [newAvail, newLocked] = await rewardsProgram.getBalance(programId, client1.address);
      expect(newAvail).to.equal(0);
      expect(newLocked).to.equal(ethers.parseEther("500")); // 1000 - 500 used from locked
    });
  });

  // ============================================================
  // WITHDRAW
  // ============================================================

  describe("Withdraw", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);

      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
    });

    it("should withdraw from available balance to user wallet", async function () {
      const amount = ethers.parseEther("3000");
      const balBefore = await storageToken.balanceOf(programAdmin1.address);

      await expect(rewardsProgram.connect(programAdmin1).withdraw(programId, amount))
        .to.emit(rewardsProgram, "TokensWithdrawn")
        .withArgs(programId, programAdmin1.address, amount);

      const balAfter = await storageToken.balanceOf(programAdmin1.address);
      expect(balAfter - balBefore).to.equal(amount);

      const [available] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      expect(available).to.equal(DEPOSIT_AMOUNT - amount);
    });

    it("should reject withdrawal exceeding available balance", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).withdraw(programId, DEPOSIT_AMOUNT + 1n)
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");
    });

    it("should auto-resolve expired time locks before withdrawal", async function () {
      // Setup: PA transfers time-locked tokens to TL
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("1000"), false, 7
      );

      // Can't withdraw during lock period
      await expect(
        rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");

      // Advance time past lock period
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Now should be able to withdraw
      // First need to deposit some tokens to StakingPool to cover the withdrawal
      // (tokens were deposited by PA, so pool has them)
      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("1000"));

      const [available, , timeLocked] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(available).to.equal(0);
      expect(timeLocked).to.equal(0);
    });

    it("should reject withdrawal of permanently locked tokens", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("1000"), true, 0
      );

      // TL has only permanently locked balance
      await expect(
        rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");
    });

    it("should reject withdrawal during lockTime period", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("1000"), false, 30
      );

      await expect(
        rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("500"))
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");
    });

    it("should allow withdrawal after lockTime expires", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("1000"), false, 7
      );

      // Advance 7 days
      await time.increase(7 * 24 * 60 * 60 + 1);

      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("1000"));
      const [available] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(available).to.equal(0);
    });
  });

  // ============================================================
  // LOCK MECHANICS INTEGRATION
  // ============================================================

  describe("Lock Mechanics Integration", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
    });

    it("full flow: locked tokens can only be transferred back up hierarchy", async function () {
      // PA transfers locked tokens directly to Client
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, client1.address, ethers.parseEther("500"), true, 0
      );

      // Client cannot withdraw locked tokens
      await expect(
        rewardsProgram.connect(client1).withdraw(programId, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(rewardsProgram, "InsufficientBalance");

      // Client CAN transfer locked tokens back to direct parent (TL)
      await rewardsProgram.connect(client1).transferToParent(
        programId, teamLeader1.address, ethers.parseEther("200")
      );

      // Client CAN transfer locked tokens back to grandparent (PA)
      await rewardsProgram.connect(client1).transferToParent(
        programId, programAdmin1.address, ethers.parseEther("200")
      );

      // Client CAN transfer locked tokens back to admin (owner)
      await rewardsProgram.connect(client1).transferToParent(
        programId, owner.address, ethers.parseEther("100")
      );

      // Client now has 0 balance
      const [avail, locked] = await rewardsProgram.getBalance(programId, client1.address);
      expect(avail).to.equal(0);
      expect(locked).to.equal(0);

      // Parents received tokens as available
      const [tlAvail] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(tlAvail).to.equal(ethers.parseEther("200"));

      const [paAvail] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      // PA: 10000 - 500 (sent to client) + 200 (back from client) = 9700
      expect(paAvail).to.equal(ethers.parseEther("9700"));
    });

    it("full flow: deposit -> transfer with lockTime -> wait -> withdraw", async function () {
      const amount = ethers.parseEther("1000");

      // PA sends time-locked tokens to TL
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, amount, false, 7
      );

      // TL can transfer back to PA even during lock
      await rewardsProgram.connect(teamLeader1).transferToParent(
        programId, ZeroAddress, ethers.parseEther("200")
      );

      // TL has 800 left in time-lock
      const [, , timeLocked] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(timeLocked).to.equal(ethers.parseEther("800"));

      // Wait for lock to expire
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Now TL can withdraw remaining
      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("800"));
      const [available, , tlRemaining] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(available).to.equal(0);
      expect(tlRemaining).to.equal(0);
    });

    it("multiple transfers with different lock times resolve independently", async function () {
      // Transfer 1: 100 FULA, 7 day lock
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("100"), false, 7
      );
      // Transfer 2: 200 FULA, 30 day lock
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("200"), false, 30
      );

      // After 7 days: 100 should be withdrawable (time lock expired), 200 still locked
      await time.increase(7 * 24 * 60 * 60 + 1);

      // getBalance still shows 100 as timeLocked (not yet resolved), but withdraw will resolve it
      const [a1, , tl1] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(a1).to.equal(0); // nothing in available yet
      expect(tl1).to.equal(ethers.parseEther("300")); // both tranches still counted as time-locked

      // Withdraw the unlocked 100 — triggers auto-resolve of expired lock
      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("100"));

      // After 30 days total: remaining 200 should be withdrawable
      await time.increase(23 * 24 * 60 * 60 + 1);

      // Withdraw remaining 200 — triggers auto-resolve
      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("200"));

      const [a2, , tl2] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(a2).to.equal(0);
      expect(tl2).to.equal(0);
    });

    it("should correctly reconcile balances after multiple transfers", async function () {
      const totalDeposit = DEPOSIT_AMOUNT;

      // PA -> TL: 5000
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("5000"), false, 0
      );
      // TL -> Client: 2000
      await rewardsProgram.connect(teamLeader1).transferToSubMember(
        programId, client1.address, ethers.parseEther("2000"), false, 0
      );
      // Client -> TL (back): 500
      await rewardsProgram.connect(client1).transferToParent(programId, ZeroAddress, ethers.parseEther("500"));

      // Check balances
      const [paAvail] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      const [tlAvail] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      const [clAvail] = await rewardsProgram.getBalance(programId, client1.address);

      // Total should equal original deposit
      expect(paAvail + tlAvail + clAvail).to.equal(totalDeposit);

      // PA: 10000 - 5000 = 5000
      expect(paAvail).to.equal(ethers.parseEther("5000"));
      // TL: 5000 - 2000 + 500 = 3500
      expect(tlAvail).to.equal(ethers.parseEther("3500"));
      // Client: 2000 - 500 = 1500
      expect(clAvail).to.equal(ethers.parseEther("1500"));
    });
  });

  // ============================================================
  // ACCESS CONTROL
  // ============================================================

  describe("Access Control", function () {
    it("should respect pause state", async function () {
      await rewardsProgram.connect(owner).emergencyAction(1); // pause

      await expect(
        rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1")
      ).to.be.reverted; // EnforcedPause
    });

    it("should allow unpause after cooldown", async function () {
      await rewardsProgram.connect(owner).emergencyAction(1); // pause
      await time.increase(30 * 60 + 1); // wait cooldown
      await rewardsProgram.connect(owner).emergencyAction(2); // unpause

      // Should work again
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      expect(await rewardsProgram.programCount()).to.equal(1);
    });
  });

  // ============================================================
  // BALANCE RECONCILIATION
  // ============================================================

  describe("Balance Reconciliation", function () {
    it("StakingPool balance should equal sum of all program balances", async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      await rewardsProgram.connect(owner).createProgram(toBytes8("GTP"), "P2", "D2");

      await rewardsProgram.connect(owner).assignProgramAdmin(1, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(owner).assignProgramAdmin(2, teamLeader1.address, toBytes12("PA002"), ethers.ZeroHash, MemberType.Free);

      // Deposit to program 1
      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), ethers.parseEther("5000"));
      await rewardsProgram.connect(programAdmin1).addTokens(1, ethers.parseEther("5000"), 0, "");

      // Deposit to program 2
      await storageToken.connect(teamLeader1).approve(await rewardsProgram.getAddress(), ethers.parseEther("3000"));
      await rewardsProgram.connect(teamLeader1).addTokens(2, ethers.parseEther("3000"), 0, "");

      // Withdraw from program 1
      await rewardsProgram.connect(programAdmin1).withdraw(1, ethers.parseEther("1000"));

      // StakingPool should have 5000 + 3000 - 1000 = 7000
      const poolBalance = await stakingPool.getBalance();
      expect(poolBalance).to.equal(ethers.parseEther("7000"));
    });
  });

  // ============================================================
  // SECURITY AUDIT TESTS
  // ============================================================

  describe("Security Audit Fixes", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), DEPOSIT_AMOUNT);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
    });

    // C-1: uint128 truncation rejection (reverts via Solidity overflow on uint128 cast)
    it("should reject time-locked transfer exceeding uint128 max", async function () {
      const overflowAmount = 2n ** 128n;
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, overflowAmount, false, 7
        )
      ).to.be.reverted; // Solidity arithmetic overflow on uint128(amount) cast
    });

    // MAX_TIME_LOCK_TRANCHES limit
    it("should reject when MAX_TIME_LOCK_TRANCHES (50) is reached", async function () {
      // Deposit enough tokens
      const bigDeposit = ethers.parseEther("100000");
      await storageToken.connect(programAdmin1).approve(await rewardsProgram.getAddress(), bigDeposit);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, bigDeposit, 0, "");

      const smallAmount = ethers.parseEther("10");

      // Create 50 time-lock tranches
      for (let i = 0; i < 50; i++) {
        await rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, smallAmount, false, 30
        );
      }

      // 51st tranche should revert
      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, smallAmount, false, 30
        )
      ).to.be.revertedWithCustomError(rewardsProgram, "MaxTimeLockTranchesReached");
    });

    // Hierarchy depth test
    it("should support hierarchy up to MAX_HIERARCHY_DEPTH", async function () {
      // Build a chain: PA -> TL -> Client1 (already in beforeEach)
      // Verify isInParentChain works across the 3-deep chain
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("1000"), false, 0
      );
      await rewardsProgram.connect(teamLeader1).transferToSubMember(
        programId, client1.address, ethers.parseEther("500"), false, 0
      );

      // Client can transfer back to grandparent (PA) - validates 2-deep chain traversal
      await rewardsProgram.connect(client1).transferToParent(
        programId, programAdmin1.address, ethers.parseEther("100")
      );

      // Client can transfer back to admin (owner) - validates chain through entire hierarchy
      await rewardsProgram.connect(client1).transferToParent(
        programId, owner.address, ethers.parseEther("100")
      );

      const [clAvail] = await rewardsProgram.getBalance(programId, client1.address);
      expect(clAvail).to.equal(ethers.parseEther("300"));
    });

    // Emergency pause blocks all state-changing functions
    it("should block all state-changing functions when paused", async function () {
      await rewardsProgram.connect(owner).emergencyAction(1); // pause

      await expect(
        rewardsProgram.connect(owner).createProgram(toBytes8("GTP"), "P2", "D2")
      ).to.be.reverted;

      await expect(
        rewardsProgram.connect(owner).assignProgramAdmin(programId, otherAccount.address, toBytes12("PA999"), ethers.ZeroHash, MemberType.Free)
      ).to.be.reverted;

      await expect(
        rewardsProgram.connect(programAdmin1).addMember(programId, otherAccount.address, toBytes12("OT001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free)
      ).to.be.reverted;

      await expect(
        rewardsProgram.connect(programAdmin1).addTokens(programId, ethers.parseEther("100"), 0, "")
      ).to.be.reverted;

      await expect(
        rewardsProgram.connect(programAdmin1).transferToSubMember(
          programId, teamLeader1.address, ethers.parseEther("100"), false, 0
        )
      ).to.be.reverted;

      await expect(
        rewardsProgram.connect(programAdmin1).withdraw(programId, ethers.parseEther("100"))
      ).to.be.reverted;
    });

    // M-2: Deactivated member balances are stranded
    it("should strand deactivated member balances (known limitation)", async function () {
      // Give PA2 some tokens and then deactivate
      const pa2 = otherAccount;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, pa2.address, toBytes12("PA002"), ethers.ZeroHash, MemberType.Free);

      await storageToken.connect(pa2).approve(await rewardsProgram.getAddress(), ethers.parseEther("5000"));
      await rewardsProgram.connect(pa2).addTokens(programId, ethers.parseEther("5000"), 0, "");

      // Deactivate
      await rewardsProgram.connect(owner).removeMember(programId, pa2.address);

      // Deactivated member cannot withdraw
      await expect(
        rewardsProgram.connect(pa2).withdraw(programId, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");

      // Balance is still there but inaccessible
      const [avail] = await rewardsProgram.getBalance(programId, pa2.address);
      expect(avail).to.equal(ethers.parseEther("5000"));
    });

    // Balance reconciliation after lock resolution
    it("should reconcile StakingPool balance after time-lock resolution and withdrawal", async function () {
      // Transfer with 7-day lock
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, ethers.parseEther("3000"), false, 7
      );

      // Fast-forward past lock
      await time.increase(7 * 24 * 60 * 60 + 1);

      // TL withdraws resolved tokens
      await rewardsProgram.connect(teamLeader1).withdraw(programId, ethers.parseEther("3000"));

      // PA withdraws remainder
      await rewardsProgram.connect(programAdmin1).withdraw(programId, ethers.parseEther("7000"));

      // StakingPool should be empty (10000 deposited, 10000 withdrawn)
      const poolBalance = await stakingPool.getBalance();
      expect(poolBalance).to.equal(0);

      // Both members should have 0 balance in the program
      const [paAvail] = await rewardsProgram.getBalance(programId, programAdmin1.address);
      const [tlAvail] = await rewardsProgram.getBalance(programId, teamLeader1.address);
      expect(paAvail).to.equal(0);
      expect(tlAvail).to.equal(0);
    });

    // M-5: TimeLockResolved event emission
    it("should emit TimeLockResolved event when expired locks are resolved during withdraw", async function () {
      const lockAmount = ethers.parseEther("2000");

      // Transfer with 7-day lock
      await rewardsProgram.connect(programAdmin1).transferToSubMember(
        programId, teamLeader1.address, lockAmount, false, 7
      );

      // Fast-forward past lock
      await time.increase(7 * 24 * 60 * 60 + 1);

      // Withdraw should emit TimeLockResolved
      await expect(
        rewardsProgram.connect(teamLeader1).withdraw(programId, lockAmount)
      )
        .to.emit(rewardsProgram, "TimeLockResolved")
        .withArgs(programId, teamLeader1.address, lockAmount);
    });
  });

  // ============================================================
  // NEW FUNCTIONS: updateProgram, deactivateProgram, updateMemberID, removeMember
  // ============================================================

  describe("Update Program", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Original Name", "Original Desc");
      programId = 1;
    });

    it("should update program name and description", async function () {
      await expect(
        extensionAtProxy.connect(owner).updateProgram(programId, "New Name", "New Description")
      ).to.emit(extensionAtProxy, "ProgramUpdated").withArgs(programId, "New Name");

      const program = await rewardsProgram.getProgram(programId);
      expect(program.name).to.equal("New Name");
      expect(program.description).to.equal("New Description");
      expect(program.code).to.equal(toBytes8("SRP")); // code unchanged
    });

    it("should reject non-admin caller", async function () {
      await expect(
        extensionAtProxy.connect(programAdmin1).updateProgram(programId, "X", "Y")
      ).to.be.reverted;
    });

    it("should reject update of non-existent program", async function () {
      await expect(
        extensionAtProxy.connect(owner).updateProgram(99, "X", "Y")
      ).to.be.revertedWithCustomError(extensionAtProxy, "ProgramNotFound");
    });
  });

  describe("Deactivate Program", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      programId = 1;
    });

    it("should deactivate an active program", async function () {
      await expect(
        extensionAtProxy.connect(owner).deactivateProgram(programId)
      ).to.emit(extensionAtProxy, "ProgramDeactivated").withArgs(programId);

      const program = await rewardsProgram.getProgram(programId);
      expect(program.active).to.equal(false);
    });

    it("should reject operations on deactivated program", async function () {
      await extensionAtProxy.connect(owner).deactivateProgram(programId);

      // Can't add members to deactivated program
      await expect(
        rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free)
      ).to.be.revertedWithCustomError(rewardsProgram, "ProgramNotActive");
    });

    it("should reject deactivating already-inactive program", async function () {
      await extensionAtProxy.connect(owner).deactivateProgram(programId);

      await expect(
        extensionAtProxy.connect(owner).deactivateProgram(programId)
      ).to.be.revertedWithCustomError(extensionAtProxy, "ProgramNotActive");
    });

    it("should reject non-admin caller", async function () {
      await expect(
        extensionAtProxy.connect(programAdmin1).deactivateProgram(programId)
      ).to.be.reverted;
    });
  });

  describe("Update MemberID", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
    });

    it("should update memberID using old memberID", async function () {
      const oldID = toBytes12("TL001");
      const newID = toBytes12("TL999");

      await expect(
        extensionAtProxy.connect(owner).updateMemberID(programId, oldID, newID)
      ).to.emit(extensionAtProxy, "MemberIDUpdated")
        .withArgs(programId, teamLeader1.address, oldID, newID);

      // New ID resolves to same wallet
      const member = await rewardsProgram.getMemberByID(newID, programId);
      expect(member.wallet).to.equal(teamLeader1.address);
      expect(member.memberID).to.equal(newID);

      // Old ID no longer resolves
      await expect(
        rewardsProgram.getMemberByID(oldID, programId)
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");
    });

    it("should reject if old memberID does not exist", async function () {
      await expect(
        extensionAtProxy.connect(owner).updateMemberID(programId, toBytes12("NOPE"), toBytes12("NEW1"))
      ).to.be.revertedWithCustomError(extensionAtProxy, "MemberNotFound");
    });

    it("should reject if new memberID is already taken", async function () {
      await expect(
        extensionAtProxy.connect(owner).updateMemberID(programId, toBytes12("TL001"), toBytes12("PA001"))
      ).to.be.revertedWithCustomError(extensionAtProxy, "DuplicateMemberID");
    });

    it("should reject zero bytes new memberID", async function () {
      await expect(
        extensionAtProxy.connect(owner).updateMemberID(programId, toBytes12("TL001"), "0x000000000000000000000000")
      ).to.be.revertedWithCustomError(extensionAtProxy, "InvalidMemberID");
    });

    it("should reject non-admin caller", async function () {
      await expect(
        extensionAtProxy.connect(programAdmin1).updateMemberID(programId, toBytes12("TL001"), toBytes12("TL999"))
      ).to.be.reverted;
    });
  });

  describe("Remove Member", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "P1", "D1");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(programAdmin1).addMember(programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free);
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);
    });

    it("should allow admin to remove any member", async function () {
      await expect(
        rewardsProgram.connect(owner).removeMember(programId, client1.address)
      ).to.emit(rewardsProgram, "MemberRemoved").withArgs(programId, client1.address);

      const member = await rewardsProgram.getMember(programId, client1.address);
      expect(member.active).to.equal(false);
    });

    it("should allow admin to remove a ProgramAdmin", async function () {
      await expect(
        rewardsProgram.connect(owner).removeMember(programId, programAdmin1.address)
      ).to.emit(rewardsProgram, "MemberRemoved").withArgs(programId, programAdmin1.address);

      const member = await rewardsProgram.getMember(programId, programAdmin1.address);
      expect(member.active).to.equal(false);
    });

    it("should allow ProgramAdmin to remove a TeamLeader", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).removeMember(programId, teamLeader1.address)
      ).to.emit(rewardsProgram, "MemberRemoved").withArgs(programId, teamLeader1.address);
    });

    it("should allow ProgramAdmin to remove a Client", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).removeMember(programId, client1.address)
      ).to.emit(rewardsProgram, "MemberRemoved").withArgs(programId, client1.address);
    });

    it("should NOT allow ProgramAdmin to remove another ProgramAdmin", async function () {
      // Add a second PA
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, otherAccount.address, toBytes12("PA002"), ethers.ZeroHash, MemberType.Free);

      await expect(
        rewardsProgram.connect(programAdmin1).removeMember(programId, otherAccount.address)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should NOT allow TeamLeader to remove members", async function () {
      await expect(
        rewardsProgram.connect(teamLeader1).removeMember(programId, client1.address)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should NOT allow Client to remove members", async function () {
      await expect(
        rewardsProgram.connect(client1).removeMember(programId, teamLeader1.address)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should reject removing non-existent member", async function () {
      await expect(
        rewardsProgram.connect(owner).removeMember(programId, otherAccount.address)
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");
    });

    it("should clear memberID lookup on removal", async function () {
      await rewardsProgram.connect(owner).removeMember(programId, client1.address);

      // Old memberID no longer resolves
      await expect(
        rewardsProgram.getMemberByID(toBytes12("CL001"), programId)
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");
    });

    it("should allow re-adding a member after removal with new memberID", async function () {
      await rewardsProgram.connect(owner).removeMember(programId, client1.address);

      // Re-add with a new memberID
      await rewardsProgram.connect(teamLeader1).addMember(programId, client1.address, toBytes12("CL002"), MemberRole.Client, ethers.ZeroHash, MemberType.Free);

      const member = await rewardsProgram.getMember(programId, client1.address);
      expect(member.active).to.equal(true);
      expect(member.memberID).to.equal(toBytes12("CL002"));
    });
  });

  // ============================================================
  // EDIT CODE & CLAIM MEMBER
  // ============================================================

  describe("Edit Code & Claim Member", function () {
    let programId: number;
    const editCode = ethers.encodeBytes32String("secret123");
    const editCodeHash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [editCode]));

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Solidity Rewards", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free);
    });

    it("should store edit code hash when adding a member with editCodeHash", async function () {
      // Add a walletless member with an edit code hash
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      // Member should exist (via virtual address) and be active
      const member = await rewardsProgram.getMemberByID(toBytes12("CL001"), programId);
      expect(member.active).to.be.true;
      expect(member.wallet).to.equal(ethers.ZeroAddress);
    });

    it("should allow claiming a member with correct edit code", async function () {
      // Add walletless member with edit code
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      // Claim using the raw edit code — client1 becomes the wallet
      await expect(
        rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode)
      )
        .to.emit(rewardsProgram, "MemberClaimed");

      // Verify wallet is now linked
      const member = await rewardsProgram.getMemberByID(toBytes12("CL001"), programId);
      expect(member.wallet).to.equal(client1.address);
    });

    it("should reject claim with wrong edit code", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      const wrongCode = ethers.encodeBytes32String("wrongcode");
      await expect(
        rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), wrongCode)
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidEditCode");
    });

    it("should reject claim when wallet is already linked", async function () {
      // Add member WITH a wallet — claim blocked because wallet has priority
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, client1.address, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      await expect(
        rewardsProgram.connect(client2).claimMember(programId, toBytes12("CL001"), editCode)
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidEditCode");
    });

    it("should reject claim when no edit code hash is set", async function () {
      // Walletless member with no edit code hash
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free
      );

      await expect(
        rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode)
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidEditCode");
    });

    it("should reject claim for non-existent member", async function () {
      await expect(
        rewardsProgram.connect(client1).claimMember(programId, toBytes12("FAKE01"), editCode)
      ).to.be.revertedWithCustomError(rewardsProgram, "MemberNotFound");
    });

    it("should reject second claim while wallet is linked", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      // First claim succeeds
      await rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode);

      // Second claim fails — wallet is already linked
      await expect(
        rewardsProgram.connect(client2).claimMember(programId, toBytes12("CL001"), editCode)
      ).to.be.revertedWithCustomError(rewardsProgram, "InvalidEditCode");
    });

    it("should allow re-claim after parent removes wallet", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      // First user claims
      await rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode);
      expect((await rewardsProgram.getMemberByID(toBytes12("CL001"), programId)).wallet).to.equal(client1.address);

      // Parent removes wallet
      await rewardsProgram.connect(programAdmin1).setMemberWallet(programId, toBytes12("CL001"), ethers.ZeroAddress);

      // Same edit code works again — new user claims
      await rewardsProgram.connect(client2).claimMember(programId, toBytes12("CL001"), editCode);
      expect((await rewardsProgram.getMemberByID(toBytes12("CL001"), programId)).wallet).to.equal(client2.address);
    });

    it("should allow parent to set edit code hash via setEditCodeHash", async function () {
      // Add member under programAdmin1 (who has a wallet)
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free
      );

      // Parent sets edit code hash
      await expect(
        rewardsProgram.connect(programAdmin1).setEditCodeHash(programId, toBytes12("CL001"), editCodeHash)
      )
        .to.emit(rewardsProgram, "EditCodeHashSet");

      // Now claim should work
      await rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode);
      const member = await rewardsProgram.getMemberByID(toBytes12("CL001"), programId);
      expect(member.wallet).to.equal(client1.address);
    });

    it("should allow admin to set edit code hash", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free
      );

      // Admin (owner) sets edit code hash
      await rewardsProgram.connect(owner).setEditCodeHash(programId, toBytes12("CL001"), editCodeHash);

      // Claim works
      await rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode);
      const member = await rewardsProgram.getMemberByID(toBytes12("CL001"), programId);
      expect(member.wallet).to.equal(client1.address);
    });

    it("should reject setEditCodeHash from unauthorized caller", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, ethers.ZeroHash, MemberType.Free
      );

      // client2 is not parent or admin
      await expect(
        rewardsProgram.connect(client2).setEditCodeHash(programId, toBytes12("CL001"), editCodeHash)
      ).to.be.revertedWithCustomError(rewardsProgram, "UnauthorizedRole");
    });

    it("should allow new claim after parent removes wallet and sets new edit code", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, ethers.ZeroAddress, toBytes12("CL001"), MemberRole.Client, editCodeHash, MemberType.Free
      );

      // First user claims
      await rewardsProgram.connect(client1).claimMember(programId, toBytes12("CL001"), editCode);

      // Parent removes wallet and sets a new edit code
      await rewardsProgram.connect(programAdmin1).setMemberWallet(programId, toBytes12("CL001"), ethers.ZeroAddress);
      const newEditCode = ethers.encodeBytes32String("newsecret");
      const newEditCodeHash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [newEditCode]));
      await rewardsProgram.connect(programAdmin1).setEditCodeHash(programId, toBytes12("CL001"), newEditCodeHash);

      // New user claims with new code
      await rewardsProgram.connect(client2).claimMember(programId, toBytes12("CL001"), newEditCode);
      const member = await rewardsProgram.getMemberByID(toBytes12("CL001"), programId);
      expect(member.wallet).to.equal(client2.address);
    });

    it("should store edit code hash when assigning ProgramAdmin with editCodeHash", async function () {
      // Assign a walletless PA with edit code
      await rewardsProgram.connect(owner).assignProgramAdmin(
        programId, ethers.ZeroAddress, toBytes12("PA002"), editCodeHash, MemberType.Free
      );

      // Claim it
      await rewardsProgram.connect(otherAccount).claimMember(programId, toBytes12("PA002"), editCode);
      const member = await rewardsProgram.getMemberByID(toBytes12("PA002"), programId);
      expect(member.wallet).to.equal(otherAccount.address);
      expect(member.role).to.equal(MemberRole.ProgramAdmin);
    });
  });

  // ============================================================
  // MEMBER TYPE
  // ============================================================

  describe("Member Type", function () {
    let programId: number;

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Test", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(
        programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free
      );
    });

    it("should set member type on creation", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Vip
      );
      const member = await rewardsProgram.getMember(programId, teamLeader1.address);
      expect(member.memberType).to.equal(MemberType.Vip);
    });

    it("should allow parent to change member type via extension", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );
      await extensionAtProxy.connect(programAdmin1).setMemberType(
        programId, toBytes12("TL001"), MemberType.Elite
      );
      const member = await rewardsProgram.getMember(programId, teamLeader1.address);
      expect(member.memberType).to.equal(MemberType.Elite);
    });

    it("should allow admin to change member type", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );
      await extensionAtProxy.connect(owner).setMemberType(
        programId, toBytes12("TL001"), MemberType.PSPartner
      );
      const member = await rewardsProgram.getMember(programId, teamLeader1.address);
      expect(member.memberType).to.equal(MemberType.PSPartner);
    });

    it("should reject invalid member type", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );
      await expect(
        extensionAtProxy.connect(owner).setMemberType(programId, toBytes12("TL001"), 99)
      ).to.be.revertedWithCustomError(extensionAtProxy, "InvalidMemberType");
    });

    it("should reject unauthorized caller for setMemberType", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );
      await expect(
        extensionAtProxy.connect(otherAccount).setMemberType(programId, toBytes12("TL001"), MemberType.Vip)
      ).to.be.revertedWithCustomError(extensionAtProxy, "UnauthorizedRole");
    });

    it("should emit MemberTypeChanged event", async function () {
      await rewardsProgram.connect(programAdmin1).addMember(
        programId, teamLeader1.address, toBytes12("TL001"), MemberRole.TeamLeader, ethers.ZeroHash, MemberType.Free
      );
      await expect(
        extensionAtProxy.connect(owner).setMemberType(programId, toBytes12("TL001"), MemberType.Elite)
      ).to.emit(extensionAtProxy, "MemberTypeChanged")
        .withArgs(programId, teamLeader1.address, MemberType.Free, MemberType.Elite);
    });
  });

  // ============================================================
  // REWARD TYPES (bitmap-based)
  // ============================================================

  describe("Reward Type Management", function () {
    function toBytes16(str: string): string {
      const bytes = ethers.toUtf8Bytes(str);
      if (bytes.length > 16) throw new Error("String too long for bytes16");
      const padded = new Uint8Array(16);
      padded.set(bytes);
      return ethers.hexlify(padded);
    }

    it("should allow admin to add a reward type", async function () {
      await expect(
        extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"))
      ).to.emit(extensionAtProxy, "RewardTypeAdded")
        .withArgs(0, toBytes16("MVP"));

      expect(await rewardsProgram.validRewardTypes()).to.equal(1n); // bit 0 set
      expect(await rewardsProgram.rewardTypeNames(0)).to.equal(toBytes16("MVP"));
    });

    it("should add multiple reward types as bitmap", async function () {
      await extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"));
      await extensionAtProxy.connect(owner).addRewardType(1, toBytes16("Bonus"));
      await extensionAtProxy.connect(owner).addRewardType(5, toBytes16("Marketing"));

      // bitmap: bit 0 + bit 1 + bit 5 = 1 + 2 + 32 = 35
      expect(await rewardsProgram.validRewardTypes()).to.equal(35n);
    });

    it("should allow admin to remove a reward type", async function () {
      await extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"));
      await extensionAtProxy.connect(owner).addRewardType(1, toBytes16("Bonus"));

      await expect(
        extensionAtProxy.connect(owner).removeRewardType(0)
      ).to.emit(extensionAtProxy, "RewardTypeRemoved").withArgs(0);

      expect(await rewardsProgram.validRewardTypes()).to.equal(2n); // only bit 1
    });

    it("should reject non-admin adding reward types", async function () {
      await expect(
        extensionAtProxy.connect(programAdmin1).addRewardType(0, toBytes16("MVP"))
      ).to.be.reverted;
    });

    it("should return reward types via getRewardTypes", async function () {
      await extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"));
      await extensionAtProxy.connect(owner).addRewardType(3, toBytes16("Admin"));

      const [ids, names] = await extensionAtProxy.getRewardTypes();
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(0);
      expect(ids[1]).to.equal(3);
      expect(names[0]).to.equal(toBytes16("MVP"));
      expect(names[1]).to.equal(toBytes16("Admin"));
    });
  });

  // ============================================================
  // SUB-TYPE MANAGEMENT
  // ============================================================

  describe("Sub-Type Management", function () {
    let programId: number;

    function toBytes16(str: string): string {
      const bytes = ethers.toUtf8Bytes(str);
      if (bytes.length > 16) throw new Error("String too long for bytes16");
      const padded = new Uint8Array(16);
      padded.set(bytes);
      return ethers.hexlify(padded);
    }

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("BBL"), "Basketball", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(
        programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free
      );
      // Add a reward type first
      await extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"));
    });

    it("should allow PA to add sub-types for their program", async function () {
      await expect(
        extensionAtProxy.connect(programAdmin1).addSubType(programId, 0, 0, toBytes16("3pShotMade"))
      ).to.emit(extensionAtProxy, "SubTypeAdded")
        .withArgs(programId, 0, 0, toBytes16("3pShotMade"));
    });

    it("should allow admin to add sub-types", async function () {
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 1, toBytes16("2pShotMade"));
      const bitmap = await rewardsProgram.validSubTypes(programId, 0);
      expect(bitmap).to.equal(2n); // bit 1
    });

    it("should reject non-PA/admin from adding sub-types", async function () {
      await expect(
        extensionAtProxy.connect(otherAccount).addSubType(programId, 0, 0, toBytes16("test"))
      ).to.be.revertedWithCustomError(extensionAtProxy, "UnauthorizedRole");
    });

    it("should remove sub-types", async function () {
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 0, toBytes16("3pShotMade"));
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 1, toBytes16("2pShotMade"));
      await extensionAtProxy.connect(owner).removeSubType(programId, 0, 0);

      const bitmap = await rewardsProgram.validSubTypes(programId, 0);
      expect(bitmap).to.equal(2n); // only bit 1
    });

    it("should return sub-types via getSubTypes", async function () {
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 0, toBytes16("3pShotMade"));
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 2, toBytes16("Freethrows"));

      const [ids, names] = await extensionAtProxy.getSubTypes(programId, 0);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(0);
      expect(ids[1]).to.equal(2);
    });
  });

  // ============================================================
  // DEPOSIT WITH METADATA
  // ============================================================

  describe("Deposit with Metadata", function () {
    let programId: number;

    function toBytes16(str: string): string {
      const bytes = ethers.toUtf8Bytes(str);
      if (bytes.length > 16) throw new Error("String too long for bytes16");
      const padded = new Uint8Array(16);
      padded.set(bytes);
      return ethers.hexlify(padded);
    }

    beforeEach(async function () {
      await rewardsProgram.connect(owner).createProgram(toBytes8("SRP"), "Test", "Desc");
      programId = 1;
      await rewardsProgram.connect(owner).assignProgramAdmin(
        programId, programAdmin1.address, toBytes12("PA001"), ethers.ZeroHash, MemberType.Free
      );

      // Approve tokens
      const rpAddr = await rewardsProgram.getAddress();
      await storageToken.connect(programAdmin1).approve(rpAddr, ethers.parseEther("100000"));

      // Add reward types and sub-types
      await extensionAtProxy.connect(owner).addRewardType(0, toBytes16("MVP"));
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 0, toBytes16("3pShot"));
      await extensionAtProxy.connect(owner).addSubType(programId, 0, 1, toBytes16("2pShot"));
    });

    it("should deposit with reward type and note", async function () {
      await expect(
        rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "Great game")
      ).to.emit(rewardsProgram, "TokensDeposited")
        .withArgs(1, programId, programAdmin1.address, DEPOSIT_AMOUNT, 0, "Great game");
    });

    it("should reject note longer than 128 bytes", async function () {
      const longNote = "x".repeat(129);
      await expect(
        rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, longNote)
      ).to.be.revertedWithCustomError(rewardsProgram, "NoteTooLong");
    });

    it("should accept note of exactly 128 bytes", async function () {
      const note128 = "x".repeat(128);
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, note128);
    });

    it("should increment depositId across multiple deposits", async function () {
      await rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "");
      await expect(
        rewardsProgram.connect(programAdmin1).addTokens(programId, DEPOSIT_AMOUNT, 0, "second")
      ).to.emit(rewardsProgram, "TokensDeposited")
        .withArgs(2, programId, programAdmin1.address, DEPOSIT_AMOUNT, 0, "second");
    });

    it("should deposit with sub-type breakdown via addTokensDetailed", async function () {
      const amount = ethers.parseEther("21");
      const subTypeIds = [0, 1];
      const subTypeQtys = [ethers.parseEther("12"), ethers.parseEther("9")];

      await expect(
        extensionAtProxy.connect(programAdmin1).addTokensDetailed(
          programId, amount, 0, "MVP game", subTypeIds, subTypeQtys
        )
      ).to.emit(extensionAtProxy, "DepositSubTypes");
    });

    it("should reject sub-type breakdown where quantities don't sum to amount", async function () {
      const amount = ethers.parseEther("21");
      const subTypeIds = [0, 1];
      const subTypeQtys = [ethers.parseEther("10"), ethers.parseEther("5")]; // 15 != 21

      await expect(
        extensionAtProxy.connect(programAdmin1).addTokensDetailed(
          programId, amount, 0, "", subTypeIds, subTypeQtys
        )
      ).to.be.revertedWithCustomError(extensionAtProxy, "InvalidSubTypeData");
    });

    it("should reject sub-type breakdown with invalid sub-type ID", async function () {
      const amount = ethers.parseEther("21");
      const subTypeIds = [0, 99]; // 99 is not a valid sub-type
      const subTypeQtys = [ethers.parseEther("12"), ethers.parseEther("9")];

      await expect(
        extensionAtProxy.connect(programAdmin1).addTokensDetailed(
          programId, amount, 0, "", subTypeIds, subTypeQtys
        )
      ).to.be.revertedWithCustomError(extensionAtProxy, "InvalidSubTypeData");
    });

    it("should reject mismatched subTypeIds and subTypeQtys arrays", async function () {
      const amount = ethers.parseEther("21");
      const subTypeIds = [0, 1];
      const subTypeQtys = [ethers.parseEther("21")]; // length mismatch

      await expect(
        extensionAtProxy.connect(programAdmin1).addTokensDetailed(
          programId, amount, 0, "", subTypeIds, subTypeQtys
        )
      ).to.be.revertedWithCustomError(extensionAtProxy, "InvalidSubTypeData");
    });
  });

  // ============================================================
  // EXTENSION DELEGATION
  // ============================================================

  describe("Extension Delegation", function () {
    it("should revert when extension is not set", async function () {
      // Deploy a fresh RewardsProgram without extension
      const RewardsProgramFactory = await ethers.getContractFactory("RewardsProgram");
      const fresh = (await upgrades.deployProxy(
        RewardsProgramFactory,
        [await storageToken.getAddress(), await stakingPool.getAddress(), owner.address, admin.address],
        { kind: "uups", initializer: "initialize" }
      )) as unknown as RewardsProgram;

      const freshExt = (await ethers.getContractFactory("RewardsExtension"))
        .attach(await fresh.getAddress()) as RewardsExtension;

      // Calling an extension function without setExtension should fail
      await expect(
        freshExt.connect(owner).addRewardType(0, ethers.zeroPadValue("0x", 16))
      ).to.be.revertedWithCustomError(fresh, "ExtensionNotSet");
    });

    it("should allow admin to update extension address", async function () {
      const newExt = await (await ethers.getContractFactory("RewardsExtension")).deploy();
      await expect(
        rewardsProgram.connect(owner).setExtension(await newExt.getAddress())
      ).to.emit(rewardsProgram, "ExtensionUpdated");
    });

    it("should reject non-admin from setting extension", async function () {
      await expect(
        rewardsProgram.connect(otherAccount).setExtension(otherAccount.address)
      ).to.be.reverted;
    });
  });
});
