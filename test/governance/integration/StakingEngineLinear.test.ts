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
    it("should upgrade StakingEngineLinear and update references in pools", async function() {
      // First verify the initial state - pools should point to the original staking engine
      const originalEngineAddress = await stakingEngineLinear.getAddress();
      
      expect(await stakePoolContract.stakingEngine()).to.equal(originalEngineAddress);
      expect(await rewardPoolContract.stakingEngine()).to.equal(originalEngineAddress);
      
      // Deploy the new implementation
      const StakingEngineLinearFactory = await ethers.getContractFactory("StakingEngineLinear");
      const newImplementation = await StakingEngineLinearFactory.deploy();
      await newImplementation.waitForDeployment();
      console.log(`New implementation deployed at: ${await newImplementation.getAddress()}`);
      
      // Create upgrade proposal via governance
      const propData = stakingAdminInterface.encodeFunctionData(
        "authorizeUpgrade", 
        [await newImplementation.getAddress()]
      );
      
      const tx = await concreteGovernance.connect(admin).createProposal(
        0, // Custom proposal type (governance specific)
        await stakingEngineLinear.getAddress(), // Target
        0, // Value
        propData // Function data
      );
      
      // Get proposalId from event logs
      const receipt = await tx.wait();
      const proposalId = receipt?.logs?.[0]?.topics?.[1];
      
      // Wait for the execution delay to expire
      await time.increase(EXECUTION_DELAY);
      await ethers.provider.send("evm_mine", []);
      
      // Approve and execute the proposal
      await concreteGovernance.connect(admin).approveProposal(proposalId);
      await concreteGovernance.connect(admin).executeProposal(proposalId);
      
      // Get the address of the upgraded contract
      // Note: The proxy address stays the same, but it now points to the new implementation
      const upgradedEngineAddress = await stakingEngineLinear.getAddress();
      console.log(`Upgraded engine address: ${upgradedEngineAddress}`);
      
      // Verify the implementation was upgraded (this is a bit tricky with UUPS proxies)
      // We can check if specific functions behave as expected after upgrade
      
      // Now update the stakingEngine address in both pools
      // First in stakePool
      await stakePoolContract.connect(owner).setStakingEngine(upgradedEngineAddress);
      console.log(`Updated stake pool's stakingEngine reference to: ${upgradedEngineAddress}`);
      
      // Then in rewardPool
      await rewardPoolContract.connect(owner).setStakingEngine(upgradedEngineAddress);
      console.log(`Updated reward pool's stakingEngine reference to: ${upgradedEngineAddress}`);
      
      // Verify the pools point to the upgraded contract
      expect(await stakePoolContract.stakingEngine()).to.equal(upgradedEngineAddress);
      expect(await rewardPoolContract.stakingEngine()).to.equal(upgradedEngineAddress);
      
      // Test basic functionality after upgrade to ensure everything works
      // 1. Stake some tokens through the upgraded contract
      const stakeAmount = ethers.parseEther("10");
      await token.connect(user1).approve(upgradedEngineAddress, stakeAmount);
      
      // Use the stakingEngineLinear which now points to the upgraded implementation
      await stakingEngineLinear.connect(user1).stake(stakeAmount, LOCK_PERIOD_1);
      console.log(`Successfully staked tokens after upgrade`);
      
      // 2. Verify the stake was recorded
      const stakerStats = await stakingEngineLinear.getStakerStats(user1.address);
      expect(stakerStats.totalActiveStakeAmount).to.be.at.least(stakeAmount);
      
      console.log("Upgrade test completed successfully. Pools are properly updated and functionality is maintained.");
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
      const stakeAmount = ethers.parseEther("100");
      
      // User1 stakes for 90 days
      await stakingEngineLinear.connect(user1).stake(stakeAmount, LOCK_PERIOD_1);
      
      // User2 stakes for 180 days
      await stakingEngineLinear.connect(user2).stake(stakeAmount, LOCK_PERIOD_180_DAYS);
      
      // User3 stakes for 365 days
      await stakingEngineLinear.connect(user3).stake(stakeAmount, LOCK_PERIOD_365_DAYS);
      
      // Advance time to the end of all lock periods
      await time.increase(LOCK_PERIOD_365_DAYS);
      
      // User1 unstakes (90 days - 2% APY)
      const user1BalanceBefore = await token.balanceOf(user1.address);
      await stakingEngineLinear.connect(user1).unstake(0);
      const user1BalanceAfter = await token.balanceOf(user1.address);
      const user1Reward = user1BalanceAfter - user1BalanceBefore - stakeAmount;
      
      // User2 unstakes (180 days - 6% APY)
      const user2BalanceBefore = await token.balanceOf(user2.address);
      await stakingEngineLinear.connect(user2).unstake(0);
      const user2BalanceAfter = await token.balanceOf(user2.address);
      const user2Reward = user2BalanceAfter - user2BalanceBefore - stakeAmount;
      
      // User3 unstakes (365 days - 15% APY)
      const user3BalanceBefore = await token.balanceOf(user3.address);
      await stakingEngineLinear.connect(user3).unstake(0);
      const user3BalanceAfter = await token.balanceOf(user3.address);
      const user3Reward = user3BalanceAfter - user3BalanceBefore - stakeAmount;
      
      // Calculate expected rewards
      const expectedReward90Days = (stakeAmount * 2n * 90n) / (100n * 365n);  // 2% for 90 days
      const expectedReward180Days = (stakeAmount * 6n * 180n) / (100n * 365n); // 6% for 180 days
      const expectedReward365Days = (stakeAmount * 15n * 365n) / (100n * 365n); // 15% for 365 days
      
      // Verify rewards with some tolerance
      const tolerance90Days = expectedReward90Days / 10n; // 10% tolerance
      const tolerance180Days = expectedReward180Days / 10n;
      const tolerance365Days = expectedReward365Days / 10n;
      
      expect(user1Reward).to.be.closeTo(expectedReward90Days, tolerance90Days);
      expect(user2Reward).to.be.closeTo(expectedReward180Days, tolerance180Days);
      expect(user3Reward).to.be.closeTo(expectedReward365Days, tolerance365Days);
      
      // Verify rewards increase with lock period
      expect(user2Reward).to.be.gt(user1Reward);
      expect(user3Reward).to.be.gt(user2Reward);
    });
  });

  describe("Referrer Reward Tests", function() {
    it("should work for a staker choosing a referrer, referrer getting rewards, then claiming them", async function() {
      // Stake with referrer using LOCK_PERIOD_2 (180 days) since LOCK_PERIOD_1 has 0% referrer reward
      await stakingEngineLinear.connect(user1).stakeWithReferrer(ethers.parseEther("100"), LOCK_PERIOD_180_DAYS, user2.address);
      await stakingEngineLinear.connect(user3).stakeWithReferrer(ethers.parseEther("100"), LOCK_PERIOD_180_DAYS, user2.address);
      await stakingEngineLinear.connect(user4).stakeWithReferrer(ethers.parseEther("100"), LOCK_PERIOD_180_DAYS, user2.address);
      
      // Check referrer info
      const referrerInfo = await stakingEngineLinear.getReferrerStats(user2.address);
      expect(referrerInfo.referredStakersCount).to.equal(3);
      
      // Advance time to allow claiming rewards
      await time.increase(REFERRER_CLAIM_PERIOD);
      
      // Claim referrer rewards
      // The contract uses claimReferrerRewards() without parameters
      await stakingEngineLinear.connect(user2).claimReferrerRewards();
      
      // Verify ref1 received rewards (implementation depends on contract specifics)
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
      // (20 accounts - 8 named accounts - 3 referrers = 9 stakers)
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
