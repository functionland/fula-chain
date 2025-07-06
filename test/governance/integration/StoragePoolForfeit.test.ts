import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StoragePool, StorageToken } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const POOL_CREATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("POOL_CREATOR_ROLE"));

describe("StoragePool Forfeit Functionality", function () {
  let storagePool: StoragePool;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1B tokens

  beforeEach(async function () {
    [owner, admin, user1, user2] = await ethers.getSigners();

    // Deploy StorageToken
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: 'uups', initializer: 'initialize' }
    ) as StorageToken;
    await storageToken.waitForDeployment();

    // Wait for timelock period
    await time.increase(24 * 60 * 60 + 1);

    // Set up token governance
    const storageTokenWithAdmin = storageToken.connect(admin);
    await storageTokenWithAdmin.setRoleQuorum(ADMIN_ROLE, 2);
    await storageTokenWithAdmin.setRoleTransactionLimit(ADMIN_ROLE, ethers.parseEther("100000000"));

    // Deploy StoragePool
    const StoragePool = await ethers.getContractFactory("StoragePool");
    storagePool = await upgrades.deployProxy(
      StoragePool,
      [await storageToken.getAddress(), owner.address, admin.address],
      { kind: 'uups', initializer: 'initialize' }
    ) as StoragePool;
    await storagePool.waitForDeployment();

    // Set up pool governance
    const storagePoolWithAdmin = storagePool.connect(admin);
    await storagePoolWithAdmin.setRoleQuorum(ADMIN_ROLE, 2);
    await storagePoolWithAdmin.setRoleTransactionLimit(ADMIN_ROLE, ethers.parseEther("100000000"));

    // Fund users with tokens
    await storageToken.transfer(user1.address, ethers.parseEther("1000000"));
    await storageToken.transfer(user2.address, ethers.parseEther("1000000"));

    // Approve tokens for pool operations
    await storageToken.connect(user1).approve(await storagePool.getAddress(), ethers.parseEther("1000000"));
    await storageToken.connect(user2).approve(await storagePool.getAddress(), ethers.parseEther("1000000"));
  });

  describe("Forfeit Flag Management", function () {
    let poolId: number;

    beforeEach(async function () {
      // Create a pool
      const poolName = "Test Pool";
      const region = "Test Region";
      const requiredTokens = ethers.parseEther("100");
      const minPingTime = 50;
      const maxChallengeResponsePeriod = 10 * 24 * 60 * 60; // 10 days
      const creatorPeerId = "QmTestCreator";

      await storagePool.connect(user1).createDataPool(
        poolName,
        region,
        requiredTokens,
        minPingTime,
        maxChallengeResponsePeriod,
        creatorPeerId
      );

      poolId = 1;

      // Add user2 as a member
      await storagePool.connect(user1).addMemberDirectly(
        poolId,
        user2.address,
        "QmTestUser2",
        true
      );
    });

    it("should allow admin to set forfeit flag for a member", async function () {
      // Admin sets forfeit flag for user2
      await expect(storagePool.connect(admin).setMemberForfeitFlag(poolId, user2.address, true))
        .to.emit(storagePool, "MemberForfeitFlagSet")
        .withArgs(poolId, user2.address, true, admin.address);

      // Check that forfeit flag is set
      expect(await storagePool.getMemberForfeitFlag(poolId, user2.address)).to.be.true;
    });

    it("should allow admin to unset forfeit flag for a member", async function () {
      // First set the forfeit flag
      await storagePool.connect(admin).setMemberForfeitFlag(poolId, user2.address, true);
      expect(await storagePool.getMemberForfeitFlag(poolId, user2.address)).to.be.true;

      // Then unset it
      await expect(storagePool.connect(admin).setMemberForfeitFlag(poolId, user2.address, false))
        .to.emit(storagePool, "MemberForfeitFlagSet")
        .withArgs(poolId, user2.address, false, admin.address);

      // Check that forfeit flag is unset
      expect(await storagePool.getMemberForfeitFlag(poolId, user2.address)).to.be.false;
    });

    it("should not allow non-admin to set forfeit flag", async function () {
      await expect(storagePool.connect(user1).setMemberForfeitFlag(poolId, user2.address, true))
        .to.be.revertedWith("Not authorized");
    });

    it("should not allow setting forfeit flag for non-member", async function () {
      const [, , , , nonMember] = await ethers.getSigners();
      await expect(storagePool.connect(admin).setMemberForfeitFlag(poolId, nonMember.address, true))
        .to.be.revertedWith("Not a member");
    });
  });

  describe("Token Forfeit on Leave", function () {
    let poolId: number;

    beforeEach(async function () {
      // Create a pool
      const poolName = "Test Pool";
      const region = "Test Region";
      const requiredTokens = ethers.parseEther("100");
      const minPingTime = 50;
      const maxChallengeResponsePeriod = 10 * 24 * 60 * 60; // 10 days
      const creatorPeerId = "QmTestCreator";

      await storagePool.connect(user1).createDataPool(
        poolName,
        region,
        requiredTokens,
        minPingTime,
        maxChallengeResponsePeriod,
        creatorPeerId
      );

      poolId = 1;

      // Add user2 as a member with token lock
      await storagePool.connect(user1).addMemberDirectly(
        poolId,
        user2.address,
        "QmTestUser2",
        true
      );
    });

    it("should forfeit tokens when member with forfeit flag leaves pool", async function () {
      // Set forfeit flag for user2
      await storagePool.connect(admin).setMemberForfeitFlag(poolId, user2.address, true);

      // Get initial token balance
      const initialBalance = await storageToken.balanceOf(user2.address);

      // User2 leaves the pool
      await storagePool.connect(user2).leavePool(poolId);

      // Check that tokens were not refunded (forfeited)
      const finalBalance = await storageToken.balanceOf(user2.address);
      expect(finalBalance).to.equal(initialBalance); // No refund
    });

    it("should refund tokens when member without forfeit flag leaves pool", async function () {
      // Get initial token balance
      const initialBalance = await storageToken.balanceOf(user2.address);

      // User2 leaves the pool (forfeit flag is false by default)
      await storagePool.connect(user2).leavePool(poolId);

      // Check that tokens were refunded
      const finalBalance = await storageToken.balanceOf(user2.address);
      expect(finalBalance).to.equal(initialBalance + ethers.parseEther("100")); // Refunded
    });
  });

  describe("Token Forfeit on Removal", function () {
    let poolId: number;

    beforeEach(async function () {
      // Create a pool
      const poolName = "Test Pool";
      const region = "Test Region";
      const requiredTokens = ethers.parseEther("100");
      const minPingTime = 50;
      const maxChallengeResponsePeriod = 10 * 24 * 60 * 60; // 10 days
      const creatorPeerId = "QmTestCreator";

      await storagePool.connect(user1).createDataPool(
        poolName,
        region,
        requiredTokens,
        minPingTime,
        maxChallengeResponsePeriod,
        creatorPeerId
      );

      poolId = 1;

      // Add user2 as a member with token lock
      await storagePool.connect(user1).addMemberDirectly(
        poolId,
        user2.address,
        "QmTestUser2",
        true
      );
    });

    it("should forfeit tokens when member with forfeit flag is removed", async function () {
      // Set forfeit flag for user2
      await storagePool.connect(admin).setMemberForfeitFlag(poolId, user2.address, true);

      // Get initial token balance
      const initialBalance = await storageToken.balanceOf(user2.address);

      // Admin removes user2 from the pool
      await storagePool.connect(admin).removeMember(poolId, user2.address);

      // Check that tokens were not refunded (forfeited)
      const finalBalance = await storageToken.balanceOf(user2.address);
      expect(finalBalance).to.equal(initialBalance); // No refund
    });

    it("should refund tokens when member without forfeit flag is removed", async function () {
      // Get initial token balance
      const initialBalance = await storageToken.balanceOf(user2.address);

      // Admin removes user2 from the pool (forfeit flag is false by default)
      await storagePool.connect(admin).removeMember(poolId, user2.address);

      // Check that tokens were refunded
      const finalBalance = await storageToken.balanceOf(user2.address);
      expect(finalBalance).to.equal(initialBalance + ethers.parseEther("100")); // Refunded
    });
  });
});
