import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("GovernanceModule", function () {
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let otherAccount: SignerWithAddress;
  const initialSupply = ethers.parseEther("1000000");
  const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));
  const CONTRACT_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("CONTRACT_OPERATOR_ROLE"));

  beforeEach(async function () {
    [owner, admin, otherAccount] = await ethers.getSigners();
    
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = await StorageToken.deploy();
    await storageToken.waitForDeployment();
    await storageToken.initialize(owner.address, admin.address, initialSupply);
  });

  describe("Initialization", function () {
    it("should correctly initialize the contract with proper roles and settings", async function () {
      // Test initial roles
      expect(await storageToken.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await storageToken.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      
      // Test ownership
      expect(await storageToken.owner()).to.equal(owner.address);
      
      // Test initial token supply
      expect(await storageToken.balanceOf(await storageToken.getAddress())).to.equal(initialSupply);
      
      // Test that contract is not paused initially
      expect(await storageToken.paused()).to.be.false;
    });

    it("should revert when initialized with zero addresses", async function () {
      const StorageToken = await ethers.getContractFactory("StorageToken");
      const newStorageToken = await StorageToken.deploy();
      
      await expect(
        newStorageToken.initialize(ZeroAddress, admin.address, initialSupply)
      ).to.be.revertedWithCustomError(newStorageToken, "InvalidAddress");
      
      await expect(
        newStorageToken.initialize(owner.address, ZeroAddress, initialSupply)
      ).to.be.revertedWithCustomError(newStorageToken, "InvalidAddress");
    });

    it("should emit proper events during initialization", async function () {
      const StorageToken = await ethers.getContractFactory("StorageToken");
      const newStorageToken = await StorageToken.deploy();
      
      await expect(newStorageToken.initialize(owner.address, admin.address, initialSupply))
        .to.emit(newStorageToken, "TokensAllocatedToContract")
        .withArgs(initialSupply)
        .and.to.emit(newStorageToken, "TokensMinted")
        .withArgs(await newStorageToken.getAddress(), initialSupply);
    });
  });

  describe("transferOwnership", function () {
    it("should correctly initiate ownership transfer", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Transfer ownership to otherAccount
      await expect(storageToken.connect(owner).transferOwnership(otherAccount.address))
        .to.emit(storageToken, "OwnershipTransferStarted")
        .withArgs(owner.address, otherAccount.address);
  
      // Check pending owner is set correctly
      expect(await storageToken.pendingOwner()).to.equal(otherAccount.address);
      
      // Verify owner hasn't changed yet
      expect(await storageToken.owner()).to.equal(owner.address);
    });
  
    it("should revert when called by non-owner", async function () {
      await expect(
        storageToken.connect(otherAccount).transferOwnership(otherAccount.address)
      ).to.be.revertedWithCustomError(storageToken, "OwnableUnauthorizedAccount")
      .withArgs(otherAccount.address);
    });
  
    it("should revert when transferring to zero address", async function () {
      await expect(
        storageToken.connect(owner).transferOwnership(ZeroAddress)
      ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");
    });
  
    it("should revert when contract is paused", async function () {
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

      // Pause the contract first
      await storageToken.connect(owner).emergencyAction(1);
      
      await expect(
        storageToken.connect(owner).transferOwnership(otherAccount.address)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  });

  describe("acceptOwnership", function () {
    beforeEach(async function () {
      // Setup ownership transfer
      await storageToken.connect(owner).transferOwnership(otherAccount.address);
    });
  
    it("should correctly transfer ownership when accepted by pending owner", async function () {
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
  
      await expect(storageToken.connect(otherAccount).acceptOwnership())
        .to.emit(storageToken, "OwnershipTransferred")
        .withArgs(owner.address, otherAccount.address);
  
      // Verify owner has changed
      expect(await storageToken.owner()).to.equal(otherAccount.address);
      // Verify pending owner is cleared
      expect(await storageToken.pendingOwner()).to.equal(ZeroAddress);
    });
  
    it("should revert when called by non-pending owner", async function () {
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
  
      await expect(
        storageToken.connect(admin).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "NotPendingOwner");
    });
  
    it("should revert when contract is paused", async function () {
      // Time lock for pause
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
  
      // Pause the contract
      await storageToken.connect(owner).emergencyAction(1);
  
      // Try to accept ownership
      await expect(
        storageToken.connect(otherAccount).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  
    it("should revert when there is no pending ownership transfer", async function () {
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
  
      // Complete the ownership transfer first
      await storageToken.connect(otherAccount).acceptOwnership();
  
      // Try to accept again
      await expect(
        storageToken.connect(otherAccount).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "NotPendingOwner");
    });
  });

  describe("acceptOwnership", function () {
    let newOwner: SignerWithAddress;
  
    beforeEach(async function () {
      [owner, admin, otherAccount, newOwner] = await ethers.getSigners();
      
      // Transfer ownership first
      await storageToken.connect(owner).transferOwnership(newOwner.address);
    });
  
    it("should correctly accept ownership transfer", async function () {
      // Accept ownership
      await expect(storageToken.connect(newOwner).acceptOwnership())
        .to.emit(storageToken, "OwnershipTransferred")
        .withArgs(owner.address, newOwner.address);
  
      // Verify new owner
      expect(await storageToken.owner()).to.equal(newOwner.address);
      
      // Verify pending owner is cleared
      expect(await storageToken.pendingOwner()).to.equal(ZeroAddress);
    });
  
    it("should revert when called by non-pending owner", async function () {
      await expect(
        storageToken.connect(otherAccount).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "NotPendingOwner");
    });
  
    it("should revert when contract is paused", async function () {
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      
      // Pause the contract
      await storageToken.connect(owner).emergencyAction(1);
      
      await expect(
        storageToken.connect(newOwner).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  
    it("should clear pending ownership flag after successful transfer", async function () {
      await storageToken.connect(newOwner).acceptOwnership();
      
      // Try to accept ownership again should fail
      await expect(
        storageToken.connect(newOwner).acceptOwnership()
      ).to.be.revertedWithCustomError(storageToken, "NotPendingOwner");
    });
  });
  
  describe("setRoleTransactionLimit", function () {
    let newLimit: bigint;
    
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      newLimit = ethers.parseEther("1000");
    });
  
    it("should correctly set transaction limit for a role", async function () {
      const adminRole = ADMIN_ROLE;
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      
      await expect(storageToken.connect(owner).setRoleTransactionLimit(adminRole, newLimit))
        .to.emit(storageToken, "TransactionLimitUpdated")
        .withArgs(adminRole, newLimit);
        const roleConfig = await storageToken.roleConfigs(ADMIN_ROLE);
        const transactionLimit = roleConfig.transactionLimit;
      expect(transactionLimit).to.equal(newLimit);
    });
  
    it("should revert when called by non-admin", async function () {
      const adminRole = ADMIN_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).setRoleTransactionLimit(adminRole, newLimit)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, adminRole);
    });
  
    it("should revert when contract is paused", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Time lock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  
      // Pause the contract
      await storageToken.connect(owner).emergencyAction(1);
      
      await expect(
        storageToken.connect(owner).setRoleTransactionLimit(adminRole, newLimit)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  
    it("should revert when timelocked", async function () {
      const adminRole = ADMIN_ROLE;
      
      await expect(
        storageToken.connect(owner).setRoleTransactionLimit(adminRole, newLimit)
      ).to.be.revertedWithCustomError(storageToken, "TimeLockActive")
      .withArgs(owner.address);
    });
  });

  describe("Role Activity", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
    });
  
    describe("checkRoleActivity and getRoleActivity", function () {
      it("should correctly track and report activity status", async function () {
        const adminRole = ADMIN_ROLE;
        
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        
        // Perform an action to update activity timestamp
        await storageToken.connect(owner).setRoleTransactionLimit(adminRole, 1000);
        
        // Get TimeConfig struct directly from storage
        const timeConfig = await storageToken.timeConfigs(owner.address);
        
        // Check lastActivityTime directly from the struct
        expect(timeConfig.lastActivityTime).to.be.gt(0);
    });    
  
    it("should return false for inactive accounts", async function () {
      const INACTIVITY_THRESHOLD = 365 * 24 * 60 * 60 +1; // 90 days in seconds
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      
      // Perform action to set initial activity
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleTransactionLimit(adminRole, 1000);
      
      // Get block timestamp after action
      const blockAfterAction = await ethers.provider.getBlock("latest");
  
      // Move time beyond inactivity threshold
      await ethers.provider.send("evm_setNextBlockTimestamp", 
          [blockAfterAction.timestamp + INACTIVITY_THRESHOLD + 1]
      );
      await ethers.provider.send("evm_mine");
  
      // Check timeConfig directly from storage
      const timeConfig = await storageToken.timeConfigs(owner.address);
      const currentTime = await time.latest();
      
      // Verify inactivity by comparing timestamps
      expect(BigInt(currentTime) - BigInt(timeConfig.lastActivityTime)).to.be.gt(BigInt(INACTIVITY_THRESHOLD));
    });
  
    it("should return 0 timestamp for addresses with no activity", async function () {
      const timeConfig = await storageToken.timeConfigs(otherAccount.address);
      expect(timeConfig.lastActivityTime).to.equal(0);
    });
    
    it("should update activity timestamp after role-related actions", async function () {
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        
        const adminRole = ADMIN_ROLE;
        
        // Get initial activity timestamp from storage
        const beforeConfig = await storageToken.timeConfigs(owner.address);
        const beforeActivity = beforeConfig.lastActivityTime;
        
        await ethers.provider.send("evm_increaseTime", [60]); // Add 1 minute
        
        await storageToken.connect(owner).setRoleTransactionLimit(adminRole, 2000);
        
        // Get updated activity timestamp from storage
        const afterConfig = await storageToken.timeConfigs(owner.address);
        expect(afterConfig.lastActivityTime).to.be.gt(beforeActivity);
    });  
    });
  });

  describe("Role Quorum", function () {
    beforeEach(async function () {
        [owner, admin, otherAccount] = await ethers.getSigners();
    });

    it("should correctly return role quorum", async function () {
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

        // Set quorums for different roles
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 3);
        await storageToken.connect(owner).setRoleQuorum(BRIDGE_OPERATOR_ROLE, 4);
        await storageToken.connect(owner).setRoleQuorum(CONTRACT_OPERATOR_ROLE, 5);

        // Check quorums directly from storage
        const adminConfig = await storageToken.roleConfigs(ADMIN_ROLE);
        const bridgeConfig = await storageToken.roleConfigs(BRIDGE_OPERATOR_ROLE);
        const contractConfig = await storageToken.roleConfigs(CONTRACT_OPERATOR_ROLE);

        expect(adminConfig.quorum).to.equal(3);
        expect(bridgeConfig.quorum).to.equal(4);
        expect(contractConfig.quorum).to.equal(5);
    });

    it("should return 0 for roles without set quorum", async function () {
        const config = await storageToken.roleConfigs(CONTRACT_OPERATOR_ROLE);
        expect(config.quorum).to.equal(0);
    });

    it("should be readable by non-admin accounts", async function () {
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        
        // Set quorum as admin
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 3);
        
        // Read quorum directly from storage as non-admin
        const config = await storageToken.connect(otherAccount).roleConfigs(ADMIN_ROLE);
        expect(config.quorum).to.equal(3);
    });
  });

  
  describe("createProposal", function () {
    let newAccount: SignerWithAddress;
    beforeEach(async function () {
      [owner, admin, otherAccount, newAccount] = await ethers.getSigners();
    });
  
    it("should correctly create a role addition proposal", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  
      // Set quorum first
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
  
      const proposalType = 1; // AddRole type
      
      await expect(
        storageToken.connect(owner).createProposal(
          proposalType,
          0,
          otherAccount.address,
          adminRole,
          0,
          ZeroAddress
        )
      ).to.emit(storageToken, "ProposalCreated")
      .withArgs(
        anyValue,
        proposalType,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress,
        owner.address
      );
  
      // Get proposal ID from event
      const receipt = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        newAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      const txReceipt = await receipt.wait();
      const event = txReceipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Check proposal details
      const proposal = await storageToken.proposals(proposalId);

      // Basic proposal details are directly accessible
      expect(proposal.proposalType).to.equal(proposalType);
      expect(proposal.target).to.equal(newAccount.address);
      expect(proposal.role).to.equal(adminRole);

      // Access config struct fields
      expect(proposal.config.approvals).to.equal(1);
      expect(proposal.config.status).to.equal(0);
    });
  
    it("should revert when creating proposal with zero address target", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
  
      await expect(
        storageToken.connect(owner).createProposal(
          1,
          0,
          ZeroAddress,
          adminRole,
          0,
          ZeroAddress
        )
      ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");
    });
  
    it("should revert when creating proposal with invalid role", async function () {
      const invalidRole = ethers.keccak256(ethers.toUtf8Bytes("INVALID_ROLE"));
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      // Set quorum first
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
  
      await expect(
        storageToken.connect(owner).createProposal(
          1,
          0,
          otherAccount.address,
          invalidRole,
          0,
          ZeroAddress
        )
      ).to.be.revertedWithCustomError(storageToken, "InvalidRole")
      .withArgs(invalidRole);
    });
  
    it("should revert when creating duplicate proposal", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      // Set quorum first
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
  
      // Create first proposal
      await storageToken.connect(owner).createProposal(
        1,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
  
      // Try to create duplicate proposal
      await expect(
        storageToken.connect(owner).createProposal(
          1,
          0,
          otherAccount.address,
          adminRole,
          0,
          ZeroAddress
        )
      ).to.be.revertedWithCustomError(storageToken, "ExistingActiveProposal")
      .withArgs(otherAccount.address);
    });
  });
  
  describe("approveProposal", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      
      // Set quorum
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    });
  
    it("should correctly approve a proposal", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type

      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
      
      // Create a proposal first
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];

      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve proposal by another admin
      await expect(storageToken.connect(admin).approveProposal(proposalId))
        .to.emit(storageToken, "ProposalApproved")
        .withArgs(proposalId, proposalType, admin.address)
        .to.emit(storageToken, "ProposalReadyForExecution")
        .withArgs(proposalId, proposalType)
        .to.emit(storageToken, "ProposalExecuted")
        .withArgs(proposalId, proposalType, otherAccount.address);
    });
  
    it("should revert when approving non-existent proposal", async function () {
      const nonExistentProposalId = ethers.keccak256(ethers.toUtf8Bytes("non-existent"));
      
      await expect(
        storageToken.connect(admin).approveProposal(nonExistentProposalId)
      ).to.be.revertedWithCustomError(storageToken, "ProposalErr");
    });
  
    it("should revert when approving already approved proposal", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Try to approve by the same admin who created it
      await expect(
        storageToken.connect(owner).approveProposal(proposalId)
      ).to.be.revertedWithCustomError(storageToken, "ProposalErr");
    });
  
    it("should revert when approving expired proposal", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Move time beyond proposal timeout (48 hours)
      await ethers.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
      
      await expect(
        storageToken.connect(admin).approveProposal(proposalId)
      ).to.be.revertedWithCustomError(storageToken, "ProposalErr");
    });
  });
  
  describe("executeProposal", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      
      // Set quorum
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    });
  
    it("should correctly execute a role addition proposal", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Approve by second admin
      await storageToken.connect(admin).approveProposal(proposalId);

      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Execute proposal
      await expect(storageToken.connect(owner).executeProposal(proposalId))
        .to.emit(storageToken, "ProposalExecuted")
        .withArgs(proposalId, proposalType, otherAccount.address);
  
      // Verify role was granted
      expect(await storageToken.hasRole(adminRole, otherAccount.address)).to.be.true;
    });
  
    it("should revert when executing non-existent proposal", async function () {
      const nonExistentProposalId = ethers.keccak256(ethers.toUtf8Bytes("non-existent"));
      
      await expect(
        storageToken.connect(owner).executeProposal(nonExistentProposalId)
      ).to.be.revertedWithCustomError(storageToken, "ProposalErr");
    });
  
    it("should revert when executing proposal with insufficient approvals", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Try to execute without second approval
      await expect(
        storageToken.connect(owner).executeProposal(proposalId)
      ).to.be.revertedWithCustomError(storageToken, "InsufficientApprovals")
      .withArgs(2, 1);
    });
  
    it("should revert when executing before execution delay", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Approve by second admin
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Try to execute before delay
      await expect(
        storageToken.connect(owner).executeProposal(proposalId)
      ).to.be.revertedWithCustomError(storageToken, "ExecutionDelayNotMet");
    });
  });
  
  describe("Emergency Functions", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
    });
  
    describe("emergencyPause", function () {
      it("should correctly pause the contract", async function () {
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        await expect(storageToken.connect(owner).emergencyAction(1))
          .to.emit(storageToken, "EA")
          .withArgs(1, await time.latest() +1, owner.address)
          .to.emit(storageToken, "Paused")
          .withArgs(owner.address);
  
        expect(await storageToken.paused()).to.be.true;
      });
  
      it("should revert when called by non-admin", async function () {
        const adminRole = ADMIN_ROLE;
        
        await expect(
          storageToken.connect(otherAccount).emergencyAction(1)
        ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
        .withArgs(otherAccount.address, adminRole);
      });
  
      it("should revert when called during cooldown period", async function () {
        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // First pause
        await storageToken.connect(owner).emergencyAction(1);
        
        // Try to pause again immediately
        await expect(
          storageToken.connect(owner).emergencyAction(1)
        ).to.be.revertedWithCustomError(storageToken, "CoolDownActive");
      });
    });
  
    describe("emergencyUnpause", function () {
      beforeEach(async function () {
        // Wait for timelock to expire and pause the contract
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).emergencyAction(1);
      });
  
      it("should correctly unpause the contract", async function () {
        // Wait for cooldown
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        await expect(storageToken.connect(owner).emergencyAction(2))
          .to.emit(storageToken, "EA")
          .withArgs(2, await time.latest() +1, owner.address)
          .to.emit(storageToken, "Unpaused")
          .withArgs(owner.address);
  
        expect(await storageToken.paused()).to.be.false;
      });
  
      it("should revert when called by non-admin", async function () {
        const adminRole = ADMIN_ROLE;
        
        await expect(
          storageToken.connect(otherAccount).emergencyAction(2)
        ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
        .withArgs(otherAccount.address, adminRole);
      });
  
      it("should revert when called during cooldown period", async function () {
        // Try to unpause immediately after pause
        await expect(
          storageToken.connect(owner).emergencyAction(2)
        ).to.be.revertedWithCustomError(storageToken, "CoolDownActive");
      });
  
      it("should run after cooldown", async function () {
        await expect(
            storageToken.connect(owner).emergencyAction(2)
          ).to.be.revertedWithCustomError(storageToken, "CoolDownActive");
        await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        await expect(
          storageToken.connect(owner).emergencyAction(2)
        ).to.not.be.reverted;
      });
    });
  });
  
  describe("setRoleQuorum", function () {
    let wallet1: SignerWithAddress;
    let wallet2: SignerWithAddress;
    let wallet3: SignerWithAddress;
    let wallets: [SignerWithAddress, SignerWithAddress, SignerWithAddress];
    beforeEach(async function () {
      [owner, admin, otherAccount, wallet1, wallet2, wallet3] = await ethers.getSigners();
      wallets = [wallet1, wallet2, wallet3];
    });
  
    it("should correctly set quorum for a role", async function () {
      const adminRole = ADMIN_ROLE;
      const newQuorum = 3;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      await expect(storageToken.connect(owner).setRoleQuorum(adminRole, newQuorum))
        .to.emit(storageToken, "QuorumUpdated")
        .withArgs(adminRole, newQuorum);
  
        const roleConfig = await storageToken.roleConfigs(adminRole);
        expect(roleConfig.quorum).to.equal(newQuorum);
    });
  
    it("should revert when setting quorum less than or equal to 1", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      await expect(
        storageToken.connect(owner).setRoleQuorum(adminRole, 1)
      ).to.be.revertedWithCustomError(storageToken, "InvalidQuorumErr")
      .withArgs(adminRole, 1);
  
      await expect(
        storageToken.connect(owner).setRoleQuorum(adminRole, 0)
      ).to.be.revertedWithCustomError(storageToken, "InvalidQuorumErr")
      .withArgs(adminRole, 0);
    });
  
    it("should revert when called by non-admin", async function () {
      const adminRole = ADMIN_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).setRoleQuorum(adminRole, 3)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, adminRole);
    });
  
    it("should revert when contract is paused", async function () {
      const adminRole = ADMIN_ROLE;
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause the contract
      await storageToken.connect(owner).emergencyAction(1);
      
      await expect(
        storageToken.connect(owner).setRoleQuorum(adminRole, 3)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });

    describe("getPendingProposals", function () {
        beforeEach(async function () {
          [owner, admin, otherAccount] = await ethers.getSigners();
          
          // Wait for timelock to expire
          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine");
          
          // Set quorum
          const adminRole = ADMIN_ROLE;
          await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
        });
      
        it("should correctly return pending proposals with pagination", async function () {
            const adminRole = ADMIN_ROLE;
            const proposalType = 1; // AddRole type
            
            // Create multiple proposals
            for(let i = 0; i < 3; i++) {
              await storageToken.connect(owner).createProposal(
                proposalType,
                0,
                await wallets[i].getAddress(), // Generate new address for each proposal
                adminRole,
                0,
                ZeroAddress
              );
            }
          
            // Get total proposal count
            const count = await storageToken.proposalCount();

            // Read proposals directly from storage
            const proposals: any[] = [];
            for(let i = 0; i < 2; i++) {
                // Get proposalId from registry
                const proposalId = await storageToken.proposalRegistry(i);
                // Get full proposal details from storage
                const proposal = await storageToken.proposals(proposalId);
                proposals.push({
                    id: proposalId,
                    type: proposal.proposalType,
                    target: proposal.target,
                    expiryTime: proposal.config.expiryTime
                });
            }

            expect(proposals.length).to.equal(2);

            // Verify each proposal
            for(let i = 0; i < proposals.length; i++) {
                const proposal = await storageToken.proposals(proposals[i].id);
                expect(proposal.proposalType).to.equal(proposals[i].type);
                expect(proposal.target).to.equal(proposals[i].target);
                expect(proposal.config.expiryTime).to.equal(proposals[i].expiryTime);
            }
        });
      
      });
  });
  
  describe("getProposalDetails", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      
      // Set quorum
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    });
  
    it("should correctly return proposal details", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      const amount = 0;
      
      // Create a proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        amount,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Get proposal directly from storage
      const proposal = await storageToken.proposals(proposalId);

      // Check basic proposal fields
      expect(proposal.proposalType).to.equal(proposalType);
      expect(proposal.target).to.equal(otherAccount.address);
      expect(proposal.role).to.equal(adminRole);
      expect(proposal.amount).to.equal(amount);
      expect(proposal.tokenAddress).to.equal(ZeroAddress);

      // Check config fields
      expect(proposal.config.approvals).to.equal(1);
      expect(proposal.config.status).to.equal(0); // executed status

      // Check hasApproved mapping separately
      const hasApproved = await storageToken.hasProposalApproval(proposalId, owner.address);
      expect(hasApproved).to.be.true;

    });
  
    it("should return correct details after proposal approval", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create a proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve by second admin
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Get proposal directly from storage
      const proposal = await storageToken.proposals(proposalId);

      // Check if proposal is empty/invalid by checking critical fields
      expect(proposal.proposalType).to.equal(0);
      expect(proposal.target).to.equal(ZeroAddress);
    });
  
    it("should return zero values for non-existent proposal", async function () {
      const nonExistentProposalId = ethers.keccak256(ethers.toUtf8Bytes("non-existent"));
      
      const proposal = await storageToken.proposals(nonExistentProposalId);

      // Check if proposal is empty/non-existent by verifying all fields are empty/default values
      expect(proposal.proposalType).to.equal(0);
      expect(proposal.target).to.equal(ZeroAddress);
      expect(proposal.role).to.equal(ethers.ZeroHash);
      expect(proposal.amount).to.equal(0);
      expect(proposal.tokenAddress).to.equal(ZeroAddress);
      expect(proposal.config.approvals).to.equal(0);
      expect(proposal.config.status).to.equal(0);
    });
  
    it("should show correct approval status for different accounts", async function () {
      const adminRole = ADMIN_ROLE;
      const proposalType = 1; // AddRole type
      
      // Create a proposal
      const tx = await storageToken.connect(owner).createProposal(
        proposalType,
        0,
        otherAccount.address,
        adminRole,
        0,
        ZeroAddress
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Check details from different accounts
      const hasApproved = await storageToken.connect(owner).hasProposalApproval(proposalId, owner.address);
      expect(hasApproved).to.be.true; // Creator approved
  
      const adminApproved = await storageToken.connect(admin).hasProposalApproval(proposalId, admin.address);
      expect(adminApproved).to.be.false; 
    });
  });
  describe("Role Assignment and Removal", function () {
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      
      // Set quorum
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    });
  
    it("should correctly assign and remove role through proposals", async function () {
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      
      // Create role assignment proposal
      const addRoleType = 1; // AddRole type
      const addTx = await storageToken.connect(owner).createProposal(
        addRoleType,
        0,
        otherAccount.address,
        bridgeOperatorRole,
        0,
        ZeroAddress
      );
      
      const addReceipt = await addTx.wait();
      const addEvent = addReceipt?.logs[0];
      const addProposalId = addEvent?.topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute role assignment
      await storageToken.connect(admin).approveProposal(addProposalId);
  
      // Verify role was assigned
      expect(await storageToken.hasRole(bridgeOperatorRole, otherAccount.address)).to.be.true;
  
      // Wait for timelock again
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Create role removal proposal
      const removeRoleType = 2; // RemoveRole type
      const removeTx = await storageToken.connect(owner).createProposal(
        removeRoleType,
        0,
        otherAccount.address,
        bridgeOperatorRole,
        0,
        ZeroAddress
      );
      
      const removeReceipt = await removeTx.wait();
      const removeEvent = removeReceipt?.logs[0];
      const removeProposalId = removeEvent?.topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute role removal
      await storageToken.connect(admin).approveProposal(removeProposalId);
  
      // Verify role was removed
      expect(await storageToken.hasRole(bridgeOperatorRole, otherAccount.address)).to.be.false;
    });
  });
  
});


describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let operator: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
    const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));
    const CONTRACT_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("CONTRACT_OPERATOR_ROLE"));
    beforeEach(async () => {
        [owner, admin, addr1, operator] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);

        // Set quorums for both roles first
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleQuorum(CONTRACT_OPERATOR_ROLE, 2);

        // Setup operator role through proposal
        const tx = await storageToken.connect(owner).createProposal(
            1, // RoleChange
            0,
            addr1.address,
            ADMIN_ROLE,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs
            .map((log) => {
                try {
                    return storageToken.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
        
        const proposalId = event?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId);
        
        const executionDelay = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
        await storageToken.connect(owner).executeProposal(proposalId);
    });

    describe("upgrade", () => {
        it("should properly handle contract upgrades with all features", async () => {
            // Create factory with addr1 signer
            const StorageTokenV2 = await ethers.getContractFactory("StorageToken", addr1);
        
            // Get the implementation address that will be used by the upgrade
            const implementationAddress = await upgrades.prepareUpgrade(
                await storageToken.getAddress(),
                StorageTokenV2
            );

            const executionDelay2 = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay2 + 1]);

            // Create and execute upgrade proposal first
            const tx = await storageToken.connect(addr1).createProposal(
                3, // Upgrade
                0,
                implementationAddress,
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event?.args?.proposalId;
            console.log(`proposalId=${proposalId}`);
            console.log(`implementationAddress=${implementationAddress}`);
    
            // Add approval
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
    
            // Now test upgrade when paused
            await storageToken.connect(owner).emergencyAction(1);
            await expect(
                upgrades.upgradeProxy(
                    await storageToken.getAddress(),
                    StorageTokenV2,
                    { kind: 'uups' }
                )
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    
            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyAction(2);
    
            // Test successful upgrade
            const upgradedToken = await upgrades.upgradeProxy(
                await storageToken.getAddress(),
                StorageTokenV2,
                { kind: 'uups' }
            );
        });
    });
});