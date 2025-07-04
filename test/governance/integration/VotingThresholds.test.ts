import { expect } from "chai";
import { ethers } from "hardhat";
import { StoragePool, StorageToken } from "../../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("StoragePool Voting Thresholds", function () {
  let storagePool: StoragePool;
  let storageToken: StorageToken;
  let owner: HardhatEthersSigner;
  let poolCreator: HardhatEthersSigner;
  let members: HardhatEthersSigner[];
  let joiner: HardhatEthersSigner;

  const POOL_CREATION_TOKENS = ethers.parseEther("500000");
  const REQUIRED_TOKENS = ethers.parseEther("100000");

  beforeEach(async function () {
    [owner, poolCreator, joiner, ...members] = await ethers.getSigners();

    // Deploy StorageToken
    const StorageTokenFactory = await ethers.getContractFactory("StorageToken");
    const storageTokenImpl = await StorageTokenFactory.deploy();
    await storageTokenImpl.waitForDeployment();

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const tokenProxy = await ProxyFactory.deploy(
      await storageTokenImpl.getAddress(),
      storageTokenImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        owner.address,
        ethers.parseEther("1000000000")
      ])
    );
    await tokenProxy.waitForDeployment();

    storageToken = StorageTokenFactory.attach(await tokenProxy.getAddress()) as StorageToken;

    // Deploy StoragePool
    const StoragePoolFactory = await ethers.getContractFactory("StoragePool", {
      libraries: {
        StoragePoolLib: await (await ethers.getContractFactory("StoragePoolLib")).deploy()
      }
    });
    const storagePoolImpl = await StoragePoolFactory.deploy();
    await storagePoolImpl.waitForDeployment();

    const poolProxy = await ProxyFactory.deploy(
      await storagePoolImpl.getAddress(),
      storagePoolImpl.interface.encodeFunctionData("initialize", [
        await storageToken.getAddress(),
        owner.address
      ])
    );
    await poolProxy.waitForDeployment();

    storagePool = StoragePoolFactory.attach(await poolProxy.getAddress()) as StoragePool;

    // Wait for timelock to expire
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine");

    // Whitelist accounts and distribute tokens
    const accounts = [poolCreator, joiner, ...members.slice(0, 10)];
    for (const account of accounts) {
      // Create proposal to whitelist account
      const addWhitelistType = 5; // AddWhitelist type
      const tx = await storageToken.connect(owner).createProposal(
        addWhitelistType,
        0,
        account.address,
        ethers.ZeroHash,
        0,
        ethers.ZeroAddress
      );

      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];

      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      // Approve whitelist proposal
      await storageToken.connect(owner).approveProposal(proposalId);

      // Wait for whitelist lock duration
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");

      // Transfer tokens
      await storageToken.connect(owner).transferFromContract(account.address, ethers.parseEther("10000000"));
    }
  });

  async function createPoolWithMembers(memberCount: number): Promise<number> {
    // Create pool
    await storageToken.connect(poolCreator).approve(await storagePool.getAddress(), POOL_CREATION_TOKENS);
    await storagePool.connect(poolCreator).createDataPool(
      "Test Pool",
      "US-East",
      REQUIRED_TOKENS,
      100,
      7 * 24 * 60 * 60,
      "QmTestPeerId"
    );
    const poolId = 1;

    // Add members
    for (let i = 0; i < memberCount; i++) {
      const member = members[i];
      await storageToken.connect(member).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(member).submitJoinRequest(poolId, `QmMember${i}PeerId`);
      
      // Pool creator approves the join request
      await storagePool.connect(poolCreator).voteOnJoinRequest(poolId, `QmMember${i}PeerId`, true);
    }

    return poolId;
  }

  describe("Approval Thresholds", function () {
    it("should require 1 approval for pools with 1 member (creator only)", async function () {
      const poolId = await createPoolWithMembers(0); // Only creator
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 approval from creator should be sufficient
      await expect(storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", true))
        .to.emit(storagePool, "MemberAdded");
    });

    it("should require 1 approval for pools with 2 members", async function () {
      const poolId = await createPoolWithMembers(1); // Creator + 1 member
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 approval should be sufficient
      await expect(storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", true))
        .to.emit(storagePool, "MemberAdded");
    });

    it("should require 1 approval for pools with 3 members", async function () {
      const poolId = await createPoolWithMembers(2); // Creator + 2 members
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 approval should be sufficient (ceiling of 3/3 = 1)
      await expect(storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", true))
        .to.emit(storagePool, "MemberAdded");
    });

    it("should require 2 approvals for pools with 4-5 members", async function () {
      const poolId = await createPoolWithMembers(3); // Creator + 3 members = 4 total
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 approval should not be sufficient (ceiling of 4/3 = 2)
      await storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", true);
      
      // Should not be added yet
      const pool = await storagePool.pools(poolId);
      expect(pool.memberList.length).to.equal(4); // Still 4 members
      
      // 2nd approval should be sufficient
      await expect(storagePool.connect(members[0]).voteOnJoinRequest(poolId, "QmJoinerPeerId", true))
        .to.emit(storagePool, "MemberAdded");
    });
  });

  describe("Rejection Thresholds", function () {
    it("should require 1 rejection for pools with 1 member (creator only)", async function () {
      const poolId = await createPoolWithMembers(0); // Only creator
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 rejection from creator should be sufficient
      await expect(storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", false))
        .to.emit(storagePool, "JoinRequestRejected");
    });

    it("should require 2 rejections for pools with 2 members", async function () {
      const poolId = await createPoolWithMembers(1); // Creator + 1 member
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 rejection should not be sufficient (majority of 2 = 2)
      await storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", false);
      
      // Should not be rejected yet - check by trying to vote again with different member
      await expect(storagePool.connect(members[0]).voteOnJoinRequest(poolId, "QmJoinerPeerId", false))
        .to.emit(storagePool, "JoinRequestRejected");
    });

    it("should require 2 rejections for pools with 3 members", async function () {
      const poolId = await createPoolWithMembers(2); // Creator + 2 members
      
      // Submit join request
      await storageToken.connect(joiner).approve(await storagePool.getAddress(), REQUIRED_TOKENS);
      await storagePool.connect(joiner).submitJoinRequest(poolId, "QmJoinerPeerId");
      
      // 1 rejection should not be sufficient (majority of 3 = 2)
      await storagePool.connect(poolCreator).voteOnJoinRequest(poolId, "QmJoinerPeerId", false);
      
      // 2nd rejection should be sufficient
      await expect(storagePool.connect(members[0]).voteOnJoinRequest(poolId, "QmJoinerPeerId", false))
        .to.emit(storagePool, "JoinRequestRejected");
    });
  });
});
