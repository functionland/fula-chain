import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { 
  StakingEngineLinear, 
  StorageToken, 
  StakingPool
} from "../../../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Interface } from "ethers";

// Import the contract factory to handle the MockConcreteGovernance type issues
import { ethers as hardhatEthers } from "hardhat";

// Define roles for governance
const OWNER_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("OWNER_ROLE"));
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const PROPOSER_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("PROPOSER_ROLE"));
const EXECUTOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("EXECUTOR_ROLE"));

// Interface for StakingEngineLinear admin actions
const stakingAdminInterface = new Interface([
  "function pause() external",
  "function unpause() external",
  "function setGovernanceContract(address _newGovernanceContract) external",
  "function addRewardsToPool(uint256 _amount) external",
  "function authorizeUpgrade(address _newImplementation) external"
]);

// Constants for lock periods (same as in contract)
const LOCK_PERIOD_1 = 90 * 24 * 60 * 60;
const LOCK_PERIOD_180_DAYS = 180 * 24 * 60 * 60;
const LOCK_PERIOD_365_DAYS = 365 * 24 * 60 * 60;

describe("StakingEngineLinear Tests", function () {
  // Contract instances
  let stakingEngineLinear: StakingEngineLinear;
  let concreteGovernance: any; // Use 'any' to work around TypeChain typing issues
  let token: StorageToken;
  let stakePoolContract: StakingPool;
  let rewardPoolContract: StakingPool;
  
  // Addresses
  let stakePoolAddress: string;
  let rewardPoolAddress: string;
  
  // Signers
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;
  let user4: HardhatEthersSigner;
  let user5: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let users: HardhatEthersSigner[];
  
  // Token constants
  const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
  const INITIAL_SUPPLY = ethers.parseEther("500000"); // 500K tokens
  const initialPoolAmount = ethers.parseEther("55000"); // Combined initial amount
  const userInitialBalance = ethers.parseEther("1000");
  const ownerRewardSupply = ethers.parseEther("50000");
  
  // Time constants for proposals
  const EXECUTION_DELAY = 24 * 60 * 60 + 1; // 24 hours + 1 second
  const WHITELIST_LOCK_DURATION = 24 * 60 * 60 + 1; // 24 hours + 1 second
  const REFERRER_CLAIM_PERIOD = 1 * 24 * 60 * 60; // 1 day, matching contract

  let mockConcreteGovernanceFactory: any;

  beforeEach(async function () {
    // Get signers
    [owner, admin, user1, user2, user3, user4, user5, attacker, ...users] = await ethers.getSigners();
    
    // --- Deploy StorageToken ---
    const StorageTokenFactory = await ethers.getContractFactory("StorageToken");
    token = await upgrades.deployProxy(
      StorageTokenFactory,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: 'uups', initializer: 'initialize' }
    ) as StorageToken;
    await token.waitForDeployment();
    
    // Wait for role change timelock to expire
    await time.increase(EXECUTION_DELAY);
    await ethers.provider.send("evm_mine", []);
    
    // Set up roles and permissions directly (bootstrap the governance system)
    // The owner can directly set quorum and transaction limit without proposals during initialization
    await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2); // Set minimum quorum to 2
    await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    
    // --- Deploy StakingPool contracts ---
    const StakingPoolFactory = await ethers.getContractFactory("StakingPool");
    stakePoolContract = await StakingPoolFactory.deploy();
    await stakePoolContract.waitForDeployment();
    await stakePoolContract.initialize(await token.getAddress(), owner.address, admin.address);
    
    rewardPoolContract = await StakingPoolFactory.deploy();
    await rewardPoolContract.waitForDeployment();
    await rewardPoolContract.initialize(await token.getAddress(), owner.address, admin.address);
    
    stakePoolAddress = await stakePoolContract.getAddress();
    rewardPoolAddress = await rewardPoolContract.getAddress();
    
    // --- Deploy ConcreteGovernance ---
    mockConcreteGovernanceFactory = await ethers.getContractFactory("MockConcreteGovernance");
    concreteGovernance = await upgrades.deployProxy(
      mockConcreteGovernanceFactory,
      [
        owner.address,
        admin.address,
        stakePoolAddress // Temporary target (will be updated after StakingEngineLinear deployment)
      ],
      { kind: 'uups', initializer: 'initialize' }
    );
    await concreteGovernance.waitForDeployment();
    
    // Grant roles in ConcreteGovernance
    await concreteGovernance.connect(owner).grantRole(PROPOSER_ROLE, admin.address);
    await concreteGovernance.connect(owner).grantRole(EXECUTOR_ROLE, admin.address);
    
    // --- Deploy StakingEngineLinear (Upgradeable) ---
    const StakingEngineLinearFactory = await ethers.getContractFactory("StakingEngineLinear");
    stakingEngineLinear = await upgrades.deployProxy(
      StakingEngineLinearFactory,
      [
        await token.getAddress(),
        stakePoolAddress,
        rewardPoolAddress,
        await concreteGovernance.getAddress()
      ],
      { kind: 'uups', initializer: 'initialize' }
    ) as StakingEngineLinear;
    await stakingEngineLinear.waitForDeployment();
    
    // --- Link Contracts ---
    // Update the target contract in ConcreteGovernance to the real StakingEngineLinear
    await concreteGovernance.connect(admin).setTargetContract(await stakingEngineLinear.getAddress());
    
    // Set staking engine address in both pools
    await stakePoolContract.connect(owner).setStakingEngine(await stakingEngineLinear.getAddress());
    await rewardPoolContract.connect(owner).setStakingEngine(await stakingEngineLinear.getAddress());
    
    // --- Whitelist addresses ---
    const addressesToWhitelist = [
      await stakingEngineLinear.getAddress(),
      stakePoolAddress,
      rewardPoolAddress,
      await concreteGovernance.getAddress(),
      owner.address,
      admin.address,
      user1.address,
      user2.address,
      user3.address,
      user4.address,
      user5.address,
      attacker.address
    ];
    
    // Whitelist each address using the proper proposal process
    for (const addr of addressesToWhitelist) {
      // Create whitelist proposal
      const tx = await token.connect(owner).createProposal(
        5, // AddWhitelist type
        0, // id (uint40)
        addr, // target address
        ethers.ZeroHash, // role
        0n, // amount (uint96)
        ethers.ZeroAddress // tokenAddress
      );
      const receipt = await tx.wait();
      
      // Wait for proposal to be ready for approval
      await time.increase(EXECUTION_DELAY);
      await ethers.provider.send("evm_mine", []);
      
      // Approve proposal
      if (receipt && receipt.logs && receipt.logs.length > 0) {
        const proposalId = receipt.logs[0].topics[1];
        await token.connect(admin).approveProposal(proposalId);
      }
      
      // Wait for the whitelist lock duration to expire
      await time.increase(WHITELIST_LOCK_DURATION);
      await ethers.provider.send("evm_mine", []);
    }
    
    // --- Fund Pools and Users ---
    // Transfer tokens to pools
    await token.connect(owner).transferFromContract(stakePoolAddress, initialPoolAmount / 2n);
    await token.connect(owner).transferFromContract(rewardPoolAddress, initialPoolAmount / 2n);
    
    // Transfer to users and approve the staking contract
    for (const user of [user1, user2, user3, user4, user5, attacker]) {
      await token.connect(owner).transferFromContract(user.address, userInitialBalance);
      await token.connect(user).approve(await stakingEngineLinear.getAddress(), userInitialBalance);
    }
    
    // --- Fund governance for adding rewards ---
    // Transfer reward supply to owner
    await token.connect(owner).transferFromContract(owner.address, ownerRewardSupply);
    await token.connect(owner).approve(await concreteGovernance.getAddress(), ownerRewardSupply);
    
    // --- Add Initial Rewards via Governance ---
    // 1. Encode the addRewardsToPool call data
    const addRewardsData = stakingAdminInterface.encodeFunctionData("addRewardsToPool", [ownerRewardSupply]);
    
    // 2. Create a proposal in ConcreteGovernance
    const proposalTx = await concreteGovernance.connect(admin).createProposal(
      0, // Proposal type (generic execution)
      await stakingEngineLinear.getAddress(), // Target is staking engine
      0, // Value
      addRewardsData // Data to execute
    );
    const receipt = await proposalTx.wait();
    const proposalId = receipt?.logs?.[0]?.topics?.[1];
    
    // 3. Execute the proposal to add rewards
    await token.connect(owner).approve(await stakingEngineLinear.getAddress(), ownerRewardSupply);
    await concreteGovernance.connect(admin).executeProposal(proposalId);
    
    // 4. Unpause the contract via governance
    const unpauseData = stakingAdminInterface.encodeFunctionData("unpause");
    const unpauseProposalTx = await concreteGovernance.connect(admin).createProposal(
      0, // Proposal type
      await stakingEngineLinear.getAddress(), // Target
      0, // Value
      unpauseData // Data
    );
    const unpauseReceipt = await unpauseProposalTx.wait();
    const unpauseProposalId = unpauseReceipt?.logs?.[0]?.topics?.[1];
    await concreteGovernance.connect(admin).executeProposal(unpauseProposalId);
  });

  // --- TEST CASES ---

  describe("Contract Initialization", function() {
    it("should correctly initialize the contract state", async function() {
      // In Ethers v6, we need to use getFunction to access public state variables
      expect(await stakingEngineLinear.getFunction("governanceContract")()).to.equal(await concreteGovernance.getAddress());
      expect(await stakingEngineLinear.token()).to.equal(await token.getAddress());
      expect(await stakingEngineLinear.stakePool()).to.equal(stakePoolAddress);
      expect(await stakingEngineLinear.rewardPool()).to.equal(rewardPoolAddress);
    });
  });

  describe("Token Approval Tests", function() {
    it("should revert when staking without sufficient approval", async function() {
      await token.connect(user1).approve(await stakingEngineLinear.getAddress(), 0);
      const stakeAmount = ethers.parseEther("100");
      await expect(
        stakingEngineLinear.connect(user1).stake(stakeAmount, LOCK_PERIOD_1)
      ).to.be.revertedWithCustomError(stakingEngineLinear, "InsufficientApproval");
    });

    it("should apply penalty when unstaking before lock period ends", async function() {
      const stakeAmount = ethers.parseEther("100");
      await stakingEngineLinear.connect(user1).stake(stakeAmount, LOCK_PERIOD_1);
      
      // Advance time, but less than the lock period
      await time.increase(LOCK_PERIOD_1 / 2);

      // Expect Unstaked event with a non-zero penalty
      await expect(stakingEngineLinear.connect(user1).unstake(0))
        .to.emit(stakingEngineLinear, "Unstaked")
        .withArgs(user1.address, stakeAmount, 0, (penalty: bigint) => penalty > 0);
    });
  });

  describe("Referrer Validation Tests", function() {
    it("should revert when attempting self-referral", async function() {
      const stakeAmount = ethers.parseEther("100");
      await expect(
        stakingEngineLinear.connect(user1).stakeWithReferrer(stakeAmount, LOCK_PERIOD_1, user1.address)
      ).to.be.revertedWithCustomError(stakingEngineLinear, "InvalidReferrerAddress");
    });

    it("should revert when using zero address as referrer", async function() {
      const stakeAmount = ethers.parseEther("100");
      await expect(
        stakingEngineLinear.connect(user1).stakeWithReferrer(
          stakeAmount, 
          LOCK_PERIOD_1, 
          ZeroAddress
        )
      ).to.be.revertedWithCustomError(stakingEngineLinear, "InvalidReferrerAddress");
    });
  });

  describe("Governance Pause/Unpause Tests", function() {
    it("should allow governance to pause the contract", async function() {
      // Check initial pause state
      expect(await stakingEngineLinear.paused()).to.equal(false);
      
      // Create pause proposal through governance
      const pauseData = stakingAdminInterface.encodeFunctionData("pause");
      const pauseProposalTx = await concreteGovernance.connect(admin).createProposal(
        0, // Proposal type
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        pauseData // Data
      );
      
      const pauseReceipt = await pauseProposalTx.wait();
      const pauseProposalId = pauseReceipt?.logs?.[0]?.topics?.[1];
      
      // Execute pause proposal
      await concreteGovernance.connect(admin).executeProposal(pauseProposalId);
      
      // Check contract is paused
      expect(await stakingEngineLinear.paused()).to.equal(true);
      
      // Verify staking fails when paused
      await expect(
        stakingEngineLinear.connect(user1).stake(ethers.parseEther("100"), LOCK_PERIOD_1)
      ).to.be.revertedWithCustomError(stakingEngineLinear, "PausedState");
    });

    it("should allow governance to unpause the contract", async function() {
      // First pause the contract
      const pauseData = stakingAdminInterface.encodeFunctionData("pause");
      const pauseProposalTx = await concreteGovernance.connect(admin).createProposal(
        0, // Proposal type
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        pauseData // Data
      );
      
      const pauseReceipt = await pauseProposalTx.wait();
      const pauseProposalId = pauseReceipt?.logs?.[0]?.topics?.[1];
      await concreteGovernance.connect(admin).executeProposal(pauseProposalId);
      
      // Verify it's paused
      expect(await stakingEngineLinear.paused()).to.equal(true);
      
      // Now unpause via governance
      const unpauseData = stakingAdminInterface.encodeFunctionData("unpause");
      const unpauseProposalTx = await concreteGovernance.connect(admin).createProposal(
        0, // Proposal type
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        unpauseData // Data
      );
      
      const unpauseReceipt = await unpauseProposalTx.wait();
      const unpauseProposalId = unpauseReceipt?.logs?.[0]?.topics?.[1];
      await concreteGovernance.connect(admin).executeProposal(unpauseProposalId);
      
      // Verify it's unpaused
      expect(await stakingEngineLinear.paused()).to.equal(false);
      
      // Verify staking works again
      await stakingEngineLinear.connect(user1).stake(ethers.parseEther("100"), LOCK_PERIOD_1);
    });
  });

  describe("Governance Upgrade Tests", function() {
    it("should allow governance to upgrade the contract implementation", async function() {
      // Deploy new implementation - use as any to work around type mismatch
      const StakingEngineLinearV2 = await ethers.getContractFactory("StakingEngineLinear");
      const stakingEngineLinearV2 = await (StakingEngineLinearV2 as any).deploy();
      await stakingEngineLinearV2.waitForDeployment();
      
      // Create upgrade proposal
      const upgradeData = stakingAdminInterface.encodeFunctionData("authorizeUpgrade", [await stakingEngineLinearV2.getAddress()]);
      const upgradeProposalTx = await concreteGovernance.connect(admin).createProposal(
        0, // Proposal type
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        upgradeData // Data
      );
      
      const upgradeReceipt = await upgradeProposalTx.wait();
      const upgradeProposalId = upgradeReceipt?.logs?.[0]?.topics?.[1];
      
      // Execute upgrade proposal
      await concreteGovernance.connect(admin).executeProposal(upgradeProposalId);
      
      // Verify functionality still works after upgrade
      await stakingEngineLinear.connect(user1).stake(ethers.parseEther("100"), LOCK_PERIOD_1);
    });
  });

  describe("Upgrade Tests", function() {
    it("should upgrade StakingEngineLinear and create new pools with references to it", async function() {
      // First verify the initial state - pools should point to the original staking engine
      const originalEngineAddress = await stakingEngineLinear.getAddress();
      
      expect(await stakePoolContract.getFunction("stakingEngine")()).to.equal(originalEngineAddress);
      expect(await rewardPoolContract.getFunction("stakingEngine")()).to.equal(originalEngineAddress);
      
      // STEP 1: Upgrade the StakingEngineLinear contract
      console.log("STEP 1: Upgrade the StakingEngineLinear contract");
      
      // Deploy the new implementation of StakingEngineLinear
      const StakingEngineLinearFactory = await ethers.getContractFactory("StakingEngineLinear");
      const newStakingEngineImpl = await StakingEngineLinearFactory.deploy();
      await newStakingEngineImpl.waitForDeployment();
      console.log(`New StakingEngineLinear implementation deployed at: ${await newStakingEngineImpl.getAddress()}`);
      
      // Generate the upgrade function data using the helper method in MockConcreteGovernance
      const upgradeStakingEngineData = await concreteGovernance.encodeAuthorizeUpgradeData(await newStakingEngineImpl.getAddress());
      
      // Create upgrade proposal via governance
      const stakingEngineTx = await concreteGovernance.connect(admin).createProposal(
        3, // Custom proposal type for upgrade 
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        upgradeStakingEngineData // Function data for upgrade
      );
      
      // Get proposalId from event logs
      const stakingEngineReceipt = await stakingEngineTx.wait();
      const stakingEngineProposalId = stakingEngineReceipt?.logs?.[0]?.topics?.[1];
      console.log(`Upgrade proposal created for StakingEngineLinear with ID: ${stakingEngineProposalId}`);
      
      // Wait for the execution delay to expire
      await time.increase(EXECUTION_DELAY);
      await ethers.provider.send("evm_mine", []);
      
      // Approve and execute the proposal
      await concreteGovernance.connect(admin).approveProposal(stakingEngineProposalId);
      await concreteGovernance.connect(admin).executeProposal(stakingEngineProposalId);
      console.log("StakingEngineLinear upgrade completed");
      
      // STEP 2: Deploy new StakingPool contracts (since we can't update the stakingEngine on existing ones)
      console.log("\nSTEP 2: Deploy new StakingPool contracts");
      
      // Get the token address from the existing pool
      const tokenAddress = await stakePoolContract.getFunction("token")();
      console.log(`Token address from existing pool: ${tokenAddress}`);
      
      // Deploy new implementations for both pool contracts using the upgrades plugin
      const StakingPoolFactory = await ethers.getContractFactory("StakingPool");
      
      // Deploy new pool proxies
      console.log("Deploying new StakePool proxy...");
      const newStakePool = await upgrades.deployProxy(
        StakingPoolFactory,
        [tokenAddress, owner.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
      ) as StakingPool;
      await newStakePool.waitForDeployment();
      console.log(`New StakePool proxy deployed at: ${await newStakePool.getAddress()}`);
      
      console.log("Deploying new RewardPool proxy...");
      const newRewardPool = await upgrades.deployProxy(
        StakingPoolFactory, 
        [tokenAddress, owner.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
      ) as StakingPool;
      await newRewardPool.waitForDeployment();
      console.log(`New RewardPool proxy deployed at: ${await newRewardPool.getAddress()}`);
      
      // Get the upgraded engine address
      const upgradedEngineAddress = await stakingEngineLinear.getAddress();
      
      // STEP 3: Set stakingEngine references in the new pools
      console.log("\nSTEP 3: Set stakingEngine references in the new pools");
      
      // Set the staking engine reference in both pools
      await newStakePool.connect(owner).setStakingEngine(upgradedEngineAddress);
      console.log(`Set new stake pool's stakingEngine reference to: ${upgradedEngineAddress}`);
      
      await newRewardPool.connect(owner).setStakingEngine(upgradedEngineAddress);
      console.log(`Set new reward pool's stakingEngine reference to: ${upgradedEngineAddress}`);
      
      // Verify the new pools point to the upgraded contract
      expect(await newStakePool.getFunction("stakingEngine")()).to.equal(upgradedEngineAddress);
      expect(await newRewardPool.getFunction("stakingEngine")()).to.equal(upgradedEngineAddress);
      
      // STEP 4: Transfer some tokens to the new pools
      console.log("\nSTEP 4: Transfer tokens to the new pools");
      
      // Transfer tokens to the new pools
      const transferAmount = ethers.parseEther("100");
      await token.connect(owner).transfer(await newStakePool.getAddress(), transferAmount);
      await token.connect(owner).transfer(await newRewardPool.getAddress(), transferAmount);
      
      console.log(`Transferred ${ethers.formatEther(transferAmount)} tokens to each new pool`);
      
      // Verify balances in new pools
      const newStakePoolBalance = await newStakePool.getFunction("getBalance")();
      const newRewardPoolBalance = await newRewardPool.getFunction("getBalance")();
      console.log(`New StakePool balance: ${ethers.formatEther(newStakePoolBalance)}`);
      console.log(`New RewardPool balance: ${ethers.formatEther(newRewardPoolBalance)}`);
      
      // STEP 5: Test functionality with the new pools and upgraded engine
      console.log("\nSTEP 5: Test functionality with new setup");
      
      // Update the contract references for future testing
      stakePoolContract = newStakePool;
      rewardPoolContract = newRewardPool;
      
      // Test basic functionality after upgrade to ensure everything works
      // 1. Stake some tokens through the upgraded contract
      const stakeAmount = ethers.parseEther("10");
      await token.connect(user1).approve(upgradedEngineAddress, stakeAmount);
      
      // Use direct transaction sending to bypass TypeScript checks
      const stakeTx = await user1.sendTransaction({
        to: upgradedEngineAddress,
        data: stakingEngineLinear.interface.encodeFunctionData("stake", [
          stakeAmount,
          LOCK_PERIOD_1
        ])
      });
      await stakeTx.wait();
      console.log(`Successfully staked tokens after upgrade using new setup`);
      
      // 2. Verify the stake was recorded - use the correct function name from the contract
      const stakerInfo = await stakingEngineLinear.getFunction("getUserTotalStaked")(user1.address);
      expect(stakerInfo).to.be.at.least(stakeAmount);
      
      console.log("Upgrade test completed successfully. New pools properly set up and functionality maintained.");
    });
  });

  describe("Whitelist Tests", function() {
    it("should allow whitelisting addresses via governance", async function() {
      // Create whitelist proposal via governance
      const tx = await concreteGovernance.connect(admin).createProposal(
        5, // Proposal type (AddWhitelist)
        await token.getAddress(), // Target
        0, // Value
        "0x" // Empty data
      );
      
      // Get proposalId from event logs
      const receipt = await tx.wait();
      const proposalId = receipt?.logs?.[0]?.topics?.[1];
      
      // Add user to whitelist
      await concreteGovernance.connect(admin).addToWhitelist(proposalId, user1.address);
      
      // Wait for the whitelist lock duration to expire
      await time.increase(WHITELIST_LOCK_DURATION);
      await ethers.provider.send("evm_mine", []);
      
      // Now user1 should be able to receive tokens
      const initialBalance = await token.balanceOf(user1.address);
      const transferAmount = ethers.parseEther("1000");
      await token.connect(owner).transfer(user1.address, transferAmount);
      
      // Verify user1 balance increased by the transfer amount
      expect(await token.balanceOf(user1.address)).to.equal(initialBalance + transferAmount);
    });

    it("should revert transactions for non-whitelisted addresses", async function() {
      // Create a new non-whitelisted account
      const notWhitelisted = ethers.Wallet.createRandom().connect(ethers.provider);
      
      // Fund the non-whitelisted account
      await owner.sendTransaction({
        to: notWhitelisted.address,
        value: ethers.parseEther("1")
      });
      
      // Try to transfer tokens to the non-whitelisted account (should revert)
      await expect(
        token.connect(owner).transferFromContract(notWhitelisted.address, userInitialBalance)
      ).to.be.revertedWithCustomError(token, "NotWhitelisted")
      .withArgs(notWhitelisted.address);
    });
  });

  describe("Reward Distribution Tests", function() {
    it("should distribute rewards correctly based on lock period", async function() {
      // Get initial pool balances
      const initialStakePoolBalance = await token.balanceOf(stakePoolAddress);
      const initialRewardPoolBalance = await token.balanceOf(rewardPoolAddress);
      console.log(`Initial stake pool balance: ${ethers.formatEther(initialStakePoolBalance)}`);
      console.log(`Initial reward pool balance: ${ethers.formatEther(initialRewardPoolBalance)}`);

      const stakeAmount = ethers.parseEther("100");
      
      // User1 stakes for 90 days
      console.log("--- User1 staking for 90 days ---");
      const stakePoolBeforeUser1 = await token.balanceOf(stakePoolAddress);
      
      await stakingEngineLinear.connect(user1).stake(stakeAmount, LOCK_PERIOD_1);
      
      const stakePoolAfterUser1 = await token.balanceOf(stakePoolAddress);
      
      // Verify stake pool balance increased by the staked amount
      expect(stakePoolAfterUser1).to.equal(stakePoolBeforeUser1 + stakeAmount);
      console.log(`Stake pool balance change after user1 stake: +${ethers.formatEther(stakeAmount)} tokens`);
      
      // User2 stakes for 180 days
      console.log("--- User2 staking for 180 days ---");
      const stakePoolBeforeUser2 = await token.balanceOf(stakePoolAddress);
      await stakingEngineLinear.connect(user2).stake(stakeAmount, LOCK_PERIOD_180_DAYS);
      const stakePoolAfterUser2 = await token.balanceOf(stakePoolAddress);
      
      // Verify stake pool balance increased by the staked amount
      expect(stakePoolAfterUser2).to.equal(stakePoolBeforeUser2 + stakeAmount);
      console.log(`Stake pool balance change after user2 stake: +${ethers.formatEther(stakeAmount)} tokens`);
      
      // User3 stakes for 365 days
      console.log("--- User3 staking for 365 days ---");
      const stakePoolBeforeUser3 = await token.balanceOf(stakePoolAddress);
      await stakingEngineLinear.connect(user3).stake(stakeAmount, LOCK_PERIOD_365_DAYS);
      const stakePoolAfterUser3 = await token.balanceOf(stakePoolAddress);
      
      // Verify stake pool balance increased by the staked amount
      expect(stakePoolAfterUser3).to.equal(stakePoolBeforeUser3 + stakeAmount);
      console.log(`Stake pool balance change after user3 stake: +${ethers.formatEther(stakeAmount)} tokens`);
      
      // Fast forward to after lock period
      await time.increase(LOCK_PERIOD_365_DAYS + 10);
      await ethers.provider.send("evm_mine", []);
      
      // User1 unstakes (90 days - 2% APY)
      console.log("--- User1 unstaking (90 days, 2% APY) ---");
      const stakePoolBeforeUnstake1 = await token.balanceOf(stakePoolAddress);
      const rewardPoolBeforeUnstake1 = await token.balanceOf(rewardPoolAddress);
      
      const user1BalanceBefore = await token.balanceOf(user1.address);
      await stakingEngineLinear.connect(user1).unstake(0);
      const user1BalanceAfter = await token.balanceOf(user1.address);
      
      const stakePoolAfterUnstake1 = await token.balanceOf(stakePoolAddress);
      const rewardPoolAfterUnstake1 = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user1Reward = user1BalanceAfter - user1BalanceBefore - stakeAmount;
      const stakePoolDelta1 = stakePoolBeforeUnstake1 - stakePoolAfterUnstake1;
      const rewardPoolDelta1 = rewardPoolBeforeUnstake1 - rewardPoolAfterUnstake1;
      
      // Verify the stake pool decreased by the staked amount
      expect(stakePoolDelta1).to.equal(stakeAmount);
      // Verify the reward pool decreased by approximately the reward amount
      expect(rewardPoolDelta1).to.be.closeTo(user1Reward, ethers.parseEther("0.1")); // Allow for some rounding
      
      console.log(`User1 received principal: ${ethers.formatEther(stakeAmount)} tokens`);
      console.log(`User1 received reward: ${ethers.formatEther(user1Reward)} tokens`);
      console.log(`Stake pool balance change: -${ethers.formatEther(stakePoolDelta1)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta1)} tokens`);
      
      // User2 unstakes (180 days - 6% APY)
      console.log("--- User2 unstaking (180 days, 6% APY) ---");
      const stakePoolBeforeUnstake2 = await token.balanceOf(stakePoolAddress);
      const rewardPoolBeforeUnstake2 = await token.balanceOf(rewardPoolAddress);
      
      const user2BalanceBefore = await token.balanceOf(user2.address);
      await stakingEngineLinear.connect(user2).unstake(0);
      const user2BalanceAfter = await token.balanceOf(user2.address);
      
      const stakePoolAfterUnstake2 = await token.balanceOf(stakePoolAddress);
      const rewardPoolAfterUnstake2 = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user2Reward = user2BalanceAfter - user2BalanceBefore - stakeAmount;
      const stakePoolDelta2 = stakePoolBeforeUnstake2 - stakePoolAfterUnstake2;
      const rewardPoolDelta2 = rewardPoolBeforeUnstake2 - rewardPoolAfterUnstake2;
      
      // Verify the stake pool decreased by the staked amount
      expect(stakePoolDelta2).to.equal(stakeAmount);
      // Verify the reward pool decreased by approximately the reward amount
      expect(rewardPoolDelta2).to.be.closeTo(user2Reward, ethers.parseEther("0.1")); // Allow for some rounding
      
      console.log(`User2 received principal: ${ethers.formatEther(stakeAmount)} tokens`);
      console.log(`User2 received reward: ${ethers.formatEther(user2Reward)} tokens`);
      console.log(`Stake pool balance change: -${ethers.formatEther(stakePoolDelta2)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta2)} tokens`);
      
      // User3 unstakes (365 days - 15% APY)
      console.log("--- User3 unstaking (365 days, 15% APY) ---");
      const stakePoolBeforeUnstake3 = await token.balanceOf(stakePoolAddress);
      const rewardPoolBeforeUnstake3 = await token.balanceOf(rewardPoolAddress);
      
      const user3BalanceBefore = await token.balanceOf(user3.address);
      await stakingEngineLinear.connect(user3).unstake(0);
      const user3BalanceAfter = await token.balanceOf(user3.address);
      
      const stakePoolAfterUnstake3 = await token.balanceOf(stakePoolAddress);
      const rewardPoolAfterUnstake3 = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user3Reward = user3BalanceAfter - user3BalanceBefore - stakeAmount;
      const stakePoolDelta3 = stakePoolBeforeUnstake3 - stakePoolAfterUnstake3;
      const rewardPoolDelta3 = rewardPoolBeforeUnstake3 - rewardPoolAfterUnstake3;
      
      // Verify the stake pool decreased by the staked amount
      expect(stakePoolDelta3).to.equal(stakeAmount);
      // Verify the reward pool decreased by approximately the reward amount
      expect(rewardPoolDelta3).to.be.closeTo(user3Reward, ethers.parseEther("0.1")); // Allow for some rounding
      
      console.log(`User3 received principal: ${ethers.formatEther(stakeAmount)} tokens`);
      console.log(`User3 received reward: ${ethers.formatEther(user3Reward)} tokens`);
      console.log(`Stake pool balance change: -${ethers.formatEther(stakePoolDelta3)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta3)} tokens`);
      
      // Print expected vs actual rewards for debugging
      console.log("\n--- Reward Comparison ---");
      console.log(`Actual reward 90 days (2% APY): ${ethers.formatEther(user1Reward)} tokens`);
      console.log(`Actual reward 180 days (6% APY): ${ethers.formatEther(user2Reward)} tokens`);
      console.log(`Actual reward 365 days (15% APY): ${ethers.formatEther(user3Reward)} tokens`);
      
      // Verify rewards increase with lock period
      expect(user2Reward).to.be.gt(user1Reward);
      expect(user3Reward).to.be.gt(user2Reward);
      
      // Final pool balances
      const finalStakePoolBalance = await token.balanceOf(stakePoolAddress);
      const finalRewardPoolBalance = await token.balanceOf(rewardPoolAddress);
      console.log(`Final stake pool balance: ${ethers.formatEther(finalStakePoolBalance)}`);
      console.log(`Final reward pool balance: ${ethers.formatEther(finalRewardPoolBalance)}`);
      
      // Total expected changes
      const expectedStakePoolChange = stakeAmount * 3n - stakeAmount * 3n; // 3 stakes - 3 unstakes = 0
      const expectedRewardPoolChange = -(user1Reward + user2Reward + user3Reward); // Negative because rewards leave the pool
      
      // Verify total changes
      expect(finalStakePoolBalance - initialStakePoolBalance).to.equal(expectedStakePoolChange);
      expect(finalRewardPoolBalance - initialRewardPoolBalance).to.be.closeTo(expectedRewardPoolChange, ethers.parseEther("0.3"));
      
      console.log(`Total stake pool change: ${ethers.formatEther(finalStakePoolBalance - initialStakePoolBalance)} tokens`);
      console.log(`Total reward pool change: ${ethers.formatEther(finalRewardPoolBalance - initialRewardPoolBalance)} tokens`);
    });
  });

  describe("Referrer Reward Tests", function() {
    it("should work for a staker choosing a referrer, referrer getting rewards, then claiming them", async function() {
      // Get initial pool balances
      const initialStakePoolBalance = await token.balanceOf(stakePoolAddress);
      const initialRewardPoolBalance = await token.balanceOf(rewardPoolAddress);
      console.log(`Initial stake pool balance: ${ethers.formatEther(initialStakePoolBalance)}`);
      console.log(`Initial reward pool balance: ${ethers.formatEther(initialRewardPoolBalance)}`);
      
      // Track initial balances of staker and referrer
      const initialUser1Balance = await token.balanceOf(user1.address);
      const initialUser2Balance = await token.balanceOf(user2.address);
      console.log(`Initial staker (user1) balance: ${ethers.formatEther(initialUser1Balance)}`);
      console.log(`Initial referrer (user2) balance: ${ethers.formatEther(initialUser2Balance)}`);

      const stakeAmount = ethers.parseEther("100");
      
      // User1 stakes with User2 as referrer using 180-day lock (1% referrer reward)
      console.log("--- User1 staking with User2 as referrer (180-day lock, 1% reward) ---");
      const stakePoolBeforeStake = await token.balanceOf(stakePoolAddress);
      
      await stakingEngineLinear.connect(user1).stakeWithReferrer(
        stakeAmount, 
        LOCK_PERIOD_180_DAYS, 
        user2.address
      );
      
      const stakePoolAfterStake = await token.balanceOf(stakePoolAddress);
      
      // Verify stake pool balance increased by the staked amount
      expect(stakePoolAfterStake).to.equal(stakePoolBeforeStake + stakeAmount);
      console.log(`Stake pool balance change after staking: +${ethers.formatEther(stakeAmount)} tokens`);
      
      // Fast forward to after the first claim period
      console.log("Fast forwarding to after the first referrer claim period...");
      await time.increase(REFERRER_CLAIM_PERIOD + 10);
      await ethers.provider.send("evm_mine", []);
      
      // Get claimable referrer rewards 
      const claimable = await stakingEngineLinear.getClaimableReferrerRewards(user2.address);
      console.log(`Claimable referrer rewards for user2: ${ethers.formatEther(claimable)} tokens`);
      expect(claimable).to.be.gt(0);
      
      // User2 claims referrer rewards
      console.log("--- User2 claiming referrer rewards ---");
      const user2BalanceBeforeClaim = await token.balanceOf(user2.address);
      const rewardPoolBeforeClaim = await token.balanceOf(rewardPoolAddress);
      
      // The contract uses claimReferrerRewards() without parameters
      await stakingEngineLinear.connect(user2).claimReferrerRewards();
      
      const user2BalanceAfterClaim = await token.balanceOf(user2.address);
      const rewardPoolAfterClaim = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user2RewardReceived = user2BalanceAfterClaim - user2BalanceBeforeClaim;
      const rewardPoolDelta = rewardPoolBeforeClaim - rewardPoolAfterClaim;
      
      // Verify the reward pool decreased by approximately the claimed amount
      expect(rewardPoolDelta).to.be.closeTo(user2RewardReceived, ethers.parseEther("0.01")); // Small tolerance
      console.log(`User2 received reward: ${ethers.formatEther(user2RewardReceived)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta)} tokens`);
      
      // Fast forward to allow user1 to unstake
      console.log("Fast forwarding to end of lock period...");
      await time.increase(LOCK_PERIOD_180_DAYS - REFERRER_CLAIM_PERIOD);
      await ethers.provider.send("evm_mine", []);
      
      // User1 unstakes
      console.log("--- User1 unstaking ---");
      const user1BalanceBeforeUnstake = await token.balanceOf(user1.address);
      const stakePoolBeforeUnstake = await token.balanceOf(stakePoolAddress);
      const rewardPoolBeforeUnstake = await token.balanceOf(rewardPoolAddress);
      
      await stakingEngineLinear.connect(user1).unstake(0);
      
      const user1BalanceAfterUnstake = await token.balanceOf(user1.address);
      const stakePoolAfterUnstake = await token.balanceOf(stakePoolAddress);
      const rewardPoolAfterUnstake = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user1Principal = stakeAmount;
      const user1Reward = user1BalanceAfterUnstake - user1BalanceBeforeUnstake - user1Principal;
      const stakePoolDelta = stakePoolBeforeUnstake - stakePoolAfterUnstake;
      const rewardPoolDelta2 = rewardPoolBeforeUnstake - rewardPoolAfterUnstake;
      
      // Verify the stake pool decreased by the staked amount
      expect(stakePoolDelta).to.equal(stakeAmount);
      // Verify the reward pool decreased by approximately the reward amount
      expect(rewardPoolDelta2).to.be.closeTo(user1Reward, ethers.parseEther("0.1"));
      
      console.log(`User1 received principal: ${ethers.formatEther(user1Principal)} tokens`);
      console.log(`User1 received reward: ${ethers.formatEther(user1Reward)} tokens`);
      console.log(`Stake pool balance change: -${ethers.formatEther(stakePoolDelta)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta2)} tokens`);
      
      // Fast forward again for more referrer rewards to accumulate
      console.log("Fast forwarding for more referrer rewards...");
      await time.increase(REFERRER_CLAIM_PERIOD * 2);
      await ethers.provider.send("evm_mine", []);
      
      // User2 claims again to collect any remaining rewards
      console.log("--- User2 claiming remaining referrer rewards ---");
      const user2BalanceBeforeClaim2 = await token.balanceOf(user2.address);
      const rewardPoolBeforeClaim2 = await token.balanceOf(rewardPoolAddress);
      
      await stakingEngineLinear.connect(user2).claimReferrerRewards();
      
      const user2BalanceAfterClaim2 = await token.balanceOf(user2.address);
      const rewardPoolAfterClaim2 = await token.balanceOf(rewardPoolAddress);
      
      // Calculate actual balance changes
      const user2RewardReceived2 = user2BalanceAfterClaim2 - user2BalanceBeforeClaim2;
      const rewardPoolDelta3 = rewardPoolBeforeClaim2 - rewardPoolAfterClaim2;
      
      console.log(`User2 received additional reward: ${ethers.formatEther(user2RewardReceived2)} tokens`);
      console.log(`Reward pool balance change: -${ethers.formatEther(rewardPoolDelta3)} tokens`);
      
      // Final pool balances
      const finalStakePoolBalance = await token.balanceOf(stakePoolAddress);
      const finalRewardPoolBalance = await token.balanceOf(rewardPoolAddress);
      const finalUser1Balance = await token.balanceOf(user1.address);
      const finalUser2Balance = await token.balanceOf(user2.address);
      
      console.log(`Final stake pool balance: ${ethers.formatEther(finalStakePoolBalance)}`);
      console.log(`Final reward pool balance: ${ethers.formatEther(finalRewardPoolBalance)}`);
      console.log(`Final staker (user1) balance: ${ethers.formatEther(finalUser1Balance)}`);
      console.log(`Final referrer (user2) balance: ${ethers.formatEther(finalUser2Balance)}`);
      
      // Total token flow summary
      console.log("\n--- Total Token Flow Summary ---");
      console.log(`Stake pool change: ${ethers.formatEther(finalStakePoolBalance - initialStakePoolBalance)} tokens`);
      console.log(`Reward pool change: ${ethers.formatEther(finalRewardPoolBalance - initialRewardPoolBalance)} tokens`);
      console.log(`Staker (user1) balance change: ${ethers.formatEther(finalUser1Balance - initialUser1Balance)} tokens`);
      console.log(`Referrer (user2) balance change: ${ethers.formatEther(finalUser2Balance - initialUser2Balance)} tokens`);
      
      // Verify that the referrer received rewards
      expect(finalUser2Balance).to.be.gt(initialUser2Balance);
      expect(finalUser2Balance - initialUser2Balance).to.equal(user2RewardReceived + user2RewardReceived2);
      
      // Verify that the staker received principal plus rewards
      expect(finalUser1Balance).to.be.gt(initialUser1Balance);
    });
  });

  describe("View Methods: Staker/Referrer Global Queries", function() {
    it("should correctly report global staker and referrer counts and details", async function() {
      // Get fresh signers directly from ethers to ensure they're properly connected
      const allSigners = await ethers.getSigners();
      console.log(`Total signers available: ${allSigners.length}`);
      
      // Allocate our signers - 8 are already allocated to named variables, so we start from index 8
      const ref1 = allSigners[8]; 
      const ref2 = allSigners[9];
      const ref3 = allSigners[10];
      
      // Make sure we don't request more stakers than are available
      // If we assume we have the standard 20 Hardhat accounts, we can use up to 9 stakers
      // (20 accounts - 8 named accounts - 3 refs = 9 stakers)
      const availableForStaking = Math.min(9, allSigners.length - 11);  // 11 = 8 named + 3 refs
      const stakers = allSigners.slice(11, 11 + availableForStaking);
      
      console.log(`Using ${stakers.length} stakers`);
      console.log(`Using referrers: ${ref1.address}, ${ref2.address}, ${ref3.address}`);
      console.log(`First staker address: ${stakers[0].address}`);
      
      // Fund the accounts with ETH to ensure they can send transactions
      for (const account of [...stakers, ref1, ref2, ref3]) {
        // Send some ETH from owner to each account
        await owner.sendTransaction({
          to: account.address,
          value: ethers.parseEther("1")
        });
        console.log(`Funded ${account.address} with 1 ETH`);
      }
      
      // Extract referrers and test users from the users array
      // const [ref1, ref2, ref3, ...testUsers] = users;
      
      // Define stakers as the first 10 users from testUsers
      // const stakers = testUsers.slice(0, 10);
      
      // Whitelist all stakers first to avoid NotWhitelisted error
      for (const staker of stakers) {
        // Debug: Log the staker address we're trying to whitelist
        console.log(`Whitelisting staker address: ${staker.address}`);
        
        // Create whitelist proposal
        const tx = await token.connect(owner).createProposal(
          5, // AddWhitelist type
          0, // id (uint40)
          staker.address, // target address
          ethers.ZeroHash, // role
          0n, // amount (uint96)
          ethers.ZeroAddress // tokenAddress
        );
        const receipt = await tx.wait();
        
        // Wait for proposal to be ready for approval
        console.log(`Waiting for execution delay (${EXECUTION_DELAY} seconds) for ${staker.address}`);
        await time.increase(EXECUTION_DELAY);
        await ethers.provider.send("evm_mine", []);
        
        // Approve proposal (this also automatically executes it if quorum is met and execution time has passed)
        let proposalId;
        if (receipt && receipt.logs && receipt.logs.length > 0) {
          proposalId = receipt.logs[0].topics[1];
          await token.connect(admin).approveProposal(proposalId);
          console.log(`Whitelist proposal approved and executed for ${staker.address}`);
        }
        
        // Wait for the whitelist lock duration to expire
        console.log(`Waiting for whitelist lock duration (${WHITELIST_LOCK_DURATION} seconds) for ${staker.address}`);
        await time.increase(WHITELIST_LOCK_DURATION);
        await ethers.provider.send("evm_mine", []);
      }
      
      // Also whitelist the referrers
      console.log("Now whitelisting all referrers");
      console.log(`ref1 address: ${ref1.address}`);
      console.log(`ref2 address: ${ref2.address}`);
      console.log(`ref3 address: ${ref3.address}`);
      
      for (const referrer of [ref1, ref2, ref3]) {
        console.log(`Whitelisting referrer address: ${referrer.address}`);
        
        // Create whitelist proposal
        const tx = await token.connect(owner).createProposal(
          5, // AddWhitelist type
          0, // id (uint40)
          referrer.address, // target address
          ethers.ZeroHash, // role
          0n, // amount (uint96)
          ethers.ZeroAddress // tokenAddress
        );
        const receipt = await tx.wait();
        
        // Wait for proposal to be ready for approval
        console.log(`Waiting for execution delay (${EXECUTION_DELAY} seconds) for referrer ${referrer.address}`);
        await time.increase(EXECUTION_DELAY);
        await ethers.provider.send("evm_mine", []);
        
        // Approve proposal (this also automatically executes it if quorum is met and execution time has passed)
        let proposalId;
        if (receipt && receipt.logs && receipt.logs.length > 0) {
          proposalId = receipt.logs[0].topics[1];
          await token.connect(admin).approveProposal(proposalId);
          console.log(`Whitelist proposal approved and executed for referrer ${referrer.address}`);
        }
        
        // Wait for the whitelist lock duration to expire
        console.log(`Waiting for whitelist lock duration (${WHITELIST_LOCK_DURATION} seconds) for referrer ${referrer.address}`);
        await time.increase(WHITELIST_LOCK_DURATION);
        await ethers.provider.send("evm_mine", []);
      }
      
      // Add an extra delay to ensure all whitelist locks have fully expired
      console.log("Adding extra delay to ensure all whitelist locks have fully expired");
      await time.increase(WHITELIST_LOCK_DURATION);
      await ethers.provider.send("evm_mine", []);
      
      // Verify all addresses are properly whitelisted by doing small test transfers
      console.log("Verifying all addresses are properly whitelisted with test transfers");
      for (const user of [...stakers, ref1, ref2, ref3]) {
        try {
          console.log(`Testing whitelist status for ${user.address}`);
          // Try a small test transfer to verify whitelisting
          const smallAmount = ethers.parseEther("1");
          await token.connect(owner).transferFromContract(user.address, smallAmount);
          console.log(`✅ Successfully transferred to ${user.address} - whitelist confirmed`);
        } catch (error: unknown) {
          console.error(`❌ Failed to transfer to ${user.address}:`, error instanceof Error ? error.message : String(error));
          throw error; // Re-throw to fail the test
        }
      }
      
      // Transfer tokens to stakers and referrers and set up approvals
      console.log("Setting up token balances and approvals for all users");
      for (const user of [...stakers, ref1, ref2, ref3]) {
        await token.connect(owner).transferFromContract(user.address, userInitialBalance);
        await token.connect(user).approve(await stakingEngineLinear.getAddress(), userInitialBalance);
        console.log(`Approved tokens for ${user.address}`);
      }
      
      // Use alternative syntax to bypass TypeScript type checking
      const stakingEngineAddress = await stakingEngineLinear.getAddress();
      
      // Set up staking with referrers
      const stakeAmount = ethers.parseEther("50");
      console.log("Beginning staking operations");
      
      try {
        // First group stakes with ref1
        for (let i = 0; i < Math.min(3, stakers.length); i++) {
          // Use direct contract call to bypass TypeScript checks
          const stakeTx = await stakers[i].sendTransaction({
            to: stakingEngineAddress,
            data: stakingEngineLinear.interface.encodeFunctionData("stakeWithReferrer", [
              stakeAmount, 
              LOCK_PERIOD_1, 
              ref1.address
            ])
          });
          await stakeTx.wait();
          console.log(`Staker ${i}: Staked with referrer ${ref1.address}`);
        }
        
        // Second group stakes with ref2
        for (let i = 3; i < Math.min(6, stakers.length); i++) {
          const stakeTx = await stakers[i].sendTransaction({
            to: stakingEngineAddress,
            data: stakingEngineLinear.interface.encodeFunctionData("stakeWithReferrer", [
              stakeAmount, 
              LOCK_PERIOD_180_DAYS, 
              ref2.address
            ])
          });
          await stakeTx.wait();
          console.log(`Staker ${i}: Staked with referrer ${ref2.address}`);
        }
        
        // Third group stakes with ref3
        for (let i = 6; i < Math.min(9, stakers.length); i++) {
          const stakeTx = await stakers[i].sendTransaction({
            to: stakingEngineAddress,
            data: stakingEngineLinear.interface.encodeFunctionData("stakeWithReferrer", [
              stakeAmount, 
              LOCK_PERIOD_365_DAYS, 
              ref3.address
            ])
          });
          await stakeTx.wait();
          console.log(`Staker ${i}: Staked with referrer ${ref3.address}`);
        }
        
        // Last staker stakes without referrer
        if (stakers.length > 9) {
          const lastStakeTx = await stakers[9].sendTransaction({
            to: stakingEngineAddress,
            data: stakingEngineLinear.interface.encodeFunctionData("stake", [
              stakeAmount, 
              LOCK_PERIOD_1
            ])
          });
          await lastStakeTx.wait();
          console.log(`Staker ${9}: Staked without referrer`);
        }
      } catch (error: unknown) {
        console.error("Staking operation failed:", error instanceof Error ? error.message : String(error));
        throw error;
      }
      
      // Global counts
      // We can't directly test the counts since the arrays are private
      // But we can test functionality that depends on these arrays
      
      // Referrer specific checks 
      const ref1Info = await stakingEngineLinear.getReferrerStats(ref1.address);
      const ref2Info = await stakingEngineLinear.getReferrerStats(ref2.address);
      const ref3Info = await stakingEngineLinear.getReferrerStats(ref3.address);
      expect(ref1Info.referredStakersCount).to.equal(Math.min(3, stakers.length));
      expect(ref2Info.referredStakersCount).to.equal(Math.min(3, stakers.length - 3));
      expect(ref3Info.referredStakersCount).to.equal(Math.min(3, stakers.length - 6));
      
      // Get the referred stakers for each referrer
      const ref1Referees = await stakingEngineLinear.getReferredStakers(ref1.address);
      const ref2Referees = await stakingEngineLinear.getReferredStakers(ref2.address);
      const ref3Referees = await stakingEngineLinear.getReferredStakers(ref3.address);
      
      // Verify at least one referee for each referrer
      expect(ref1Referees.length).to.equal(Math.min(3, stakers.length));
      expect(ref2Referees.length).to.equal(Math.min(3, stakers.length - 3));
      expect(ref3Referees.length).to.equal(Math.min(3, stakers.length - 6));
    });
  });
});
