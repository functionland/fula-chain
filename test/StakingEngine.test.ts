import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { StakingEngine, StorageToken } from "../typechain-types/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("StakingEngine", function () {
  let stakingEngine: StakingEngine;
  let token: StorageToken;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let users: SignerWithAddress[];
  let rewardPoolAddress: string;
  let stakingPoolAddress: string;
  let calculateExpectedRewards: (p1: any, p2: any, p3: any) => bigint;
  const initialStakinPoolAmount = ethers.parseEther("5000")

  beforeEach(async function () {
    // Get signers
    [owner, user1, user2, ...users] = await ethers.getSigners();

    calculateExpectedRewards = (stakedAmount, fixedAPY, elapsedTime) => {
        const annualRewards = (stakedAmount * BigInt(fixedAPY)) / BigInt(100); // Annualized rewards
        return (annualRewards * BigInt(elapsedTime)) / BigInt(365 * 24 * 60 * 60); // Adjusted for elapsed time
    };
  
    // Deploy StorageToken
    const StorageToken = await ethers.getContractFactory("StorageToken");
    token = (await upgrades.deployProxy(StorageToken, [owner.address])) as StorageToken;
    await token.waitForDeployment();

    // Mint the maximum supply to the owner
    const maxSupply = await token.connect(await ethers.getSigner(owner.address)).maxSupply();
    await token.connect(await ethers.getSigner(owner.address)).mintToken(maxSupply);
  
    // Deploy StakingEngine
    rewardPoolAddress = users[0].address; // Use one of the users as the reward pool address
    stakingPoolAddress = users[1].address; // Use another user as the staking pool address
  
    const StakingEngine = await ethers.getContractFactory("StakingEngine");
    stakingEngine = (await upgrades.deployProxy(StakingEngine, [
      await token.getAddress(),
      rewardPoolAddress,
      stakingPoolAddress,
      owner.address,
    ])) as StakingEngine;
    await stakingEngine.waitForDeployment();
  
    // Transfer tokens to reward pool, staking pool, and reward distribution addresses
    const initialRewardPool = ethers.parseEther("0"); // 10,000 tokens
    await token.transfer(rewardPoolAddress, initialRewardPool);
    console.log(`Token contract balance: ${await token.balanceOf(await token.getAddress())}`);
    await token.transferFromContract(await stakingEngine.getAddress(), ethers.parseEther("5000")); // Add tokens to staking engine contract address directly (this is not needed normally)
    await token.transferFromContract(stakingPoolAddress, initialStakinPoolAmount); // Example amount for staking pool
  
    // Connect the signer (users[0]) to the token contract
    const tokenWithRewardPoolSigner = token.connect(await ethers.getSigner(users[0].address));

    // Approve staking contract to spend tokens from reward pool address
    await tokenWithRewardPoolSigner.approve(await stakingEngine.getAddress(), ethers.MaxUint256);

    // Connect the signer (users[0]) to the token contract
    const tokenWithRewardPoolSigner2 = token.connect(await ethers.getSigner(users[2].address));

    // Approve staking contract to spend tokens from reward pool address
    await tokenWithRewardPoolSigner2.approve(await stakingEngine.getAddress(), ethers.MaxUint256);

    // Connect the signer (users[0]) to the token contract
    const tokenWithRewardPoolSigner1 = token.connect(await ethers.getSigner(users[1].address));

    // Approve staking contract to spend tokens from reward pool address
    await tokenWithRewardPoolSigner1.approve(await stakingEngine.getAddress(), ethers.MaxUint256);
  });
  

  it("should initialize correctly", async function () {
    const rewardPoolBalance = await token.balanceOf(rewardPoolAddress); // rewardPoolAddress
    expect(rewardPoolBalance).to.equal(ethers.parseEther("0"));

    expect(await stakingEngine.totalStaked()).to.equal(0);
  });

  it("should allow adding rewards to the reward pool", async function () {
    const additionalRewards = ethers.parseEther("5000"); // Add an additional reward pool

    // Add rewards to the pool
    const stakingEngineOwner = stakingEngine.connect(await ethers.getSigner(owner.address));

    await stakingEngineOwner.addToRewardPoolFromContract(additionalRewards);

    const updatedRewardPoolBalance = await token.balanceOf(rewardPoolAddress); // Check remaining balance in reward pool address
    expect(updatedRewardPoolBalance).to.equal(ethers.parseEther("5000")); // Initial was 10,000 - added 5,000

    const contractBalance = await token.balanceOf(await stakingEngine.getAddress()); // Check contract's balance
    expect(contractBalance).to.equal(ethers.parseEther("0")); // Contract should now hold added rewards
  });

it("should apply penalties for early unstaking", async function () {
    const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens
    const additionalRewards = ethers.parseEther("5000"); // Add an additional reward pool

    // Add rewards to the pool
    const stakingEngineOwner = stakingEngine.connect(await ethers.getSigner(owner.address));

    await stakingEngineOwner.addToRewardPoolFromContract(additionalRewards);

    // Transfer tokens to user1 and approve staking contract
    await token.transferFromContract(user1.address, stakeAmount);
    const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
    await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);


    // Stake tokens for a year (365 days)
    const lockPeriod = 365 * 24 * 60 * 60; // 365 days in seconds
    const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
    await stakingWithUser1.stakeToken(stakeAmount, lockPeriod);

    // Simulate time passing (e.g., only one month)
    const elapsedTime = 30 * 24 * 60 * 60; // 30 days in seconds
    await time.increase(elapsedTime); // Move forward by one month

    // Unstake early
    const tx = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented, pass the index of the stake
    const receipt = await tx.wait();

    // Parse the "Unstaked" event from the transaction receipt
    const penaltyEvent = receipt?.logs
        .map((log) => {
            try {
                return stakingEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

    if (penaltyEvent) {
        const penalty = penaltyEvent.args?.penalty;
        const finalAmount = penaltyEvent.args?.amount;

        // Verify that a penalty was applied
        expect(penalty).to.be.gt(0); // Penalty should be greater than zero

        // Verify that the final amount received is less than the staked amount due to the penalty
        expect(finalAmount).to.equal(stakeAmount);

        // Verify that user1's balance reflects the staked amount minus the penalty
        const userBalance = await token.balanceOf(user1.address);
        expect(userBalance).to.equal(finalAmount);

        // Verify that the penalty is added back to the reward pool
        const rewardPoolBalance = await token.balanceOf(rewardPoolAddress); // Assuming users[2] is the reward pool address
        expect(rewardPoolBalance).to.be.gt(0); // Reward pool should have received the penalty amount
    }

    // Parse the "RewardDistributionLog" event from the transaction receipt
    const RewardDistributionLog = receipt?.logs
        .map((log) => {
            try {
                return stakingEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "RewardDistributionLog");

    if (RewardDistributionLog) {
        const penalty = RewardDistributionLog.args?.penalty;
        const stakedAmount = RewardDistributionLog.args?.amount;
        const pendingRewards = RewardDistributionLog.args?.pendingRewards;
        const rewardPoolBalanceAtDistribution = RewardDistributionLog.args?.rewardPoolBalance;
        const lockPeriod = RewardDistributionLog.args?.lockPeriod;
        const elapsedTime = RewardDistributionLog.args?.elapsedTime;

        console.log(`Penalty Applied: ${ethers.formatEther(penalty)}`);
        console.log(`Staked Amount: ${ethers.formatEther(stakedAmount)}`);
        console.log(`Pending Rewards: ${ethers.formatEther(pendingRewards)}`);
        console.log(`Reward Pool Balance: ${ethers.formatEther(rewardPoolBalanceAtDistribution)}`);
        console.log(`Lock Period: ${lockPeriod}`);
        console.log(`Elapsed Time: ${elapsedTime}`);

        // Verify that a penalty was applied
        expect(penalty).to.be.gt(0); // Penalty should be greater than zero

        // Verify that the final amount received is less than the staked amount due to the penalty
        expect(stakedAmount).to.be.eq(stakeAmount);

        // Verify that the penalty is added back to the reward pool
        expect(rewardPoolBalanceAtDistribution).to.be.gt(0); // Reward pool should have received the penalty amount
    }
});
  
  
it("should calculate rewards correctly based on fixed APYs for different durations", async function () {
  const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens
  const additionalRewards = ethers.parseEther("5000"); // Add an additional reward pool

  // Add rewards to the pool
  const stakingEngineOwner = stakingEngine.connect(await ethers.getSigner(owner.address));

  await stakingEngineOwner.addToRewardPoolFromContract(additionalRewards);

  // Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Stake tokens for 365 days
  const lockPeriod = 365 * 24 * 60 * 60; // 365 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(stakeAmount, lockPeriod);

  // Simulate time passing (e.g., one month)
  const elapsedTime = 30 * 24 * 60 * 60; // Simulate one month (30 days)
  await time.increase(elapsedTime);

  // Fetch reward pool balance
  const rewardPoolBalance = await token.balanceOf(users[0].address); // Assuming users[0] is the reward pool address
  expect(rewardPoolBalance).to.be.eq(additionalRewards);

  // Calculate expected rewards for different durations
  const fixedAPY60Days = 2; // Fixed APY for 60 days
  const fixedAPY180Days = 9; // Fixed APY for 180 days
  const fixedAPY365Days = 23; // Fixed APY for 365 days

  const expectedRewards60Days = calculateExpectedRewards(stakeAmount, fixedAPY60Days, elapsedTime);
  const expectedRewards180Days = calculateExpectedRewards(stakeAmount, fixedAPY180Days, elapsedTime);
  const expectedRewards365Days = calculateExpectedRewards(stakeAmount, fixedAPY365Days, elapsedTime);

  // Validate rewards using the contract's `calculateRewardsForPeriod`
  const rewardsFor60Days = await stakingEngine.calculateRewardsForPeriod(
      stakeAmount,
      fixedAPY60Days,
      elapsedTime,
      rewardPoolBalance
  );
  const rewardsFor180Days = await stakingEngine.calculateRewardsForPeriod(
      stakeAmount,
      fixedAPY180Days,
      elapsedTime,
      rewardPoolBalance
  );
  const rewardsFor365Days = await stakingEngine.calculateRewardsForPeriod(
      stakeAmount,
      fixedAPY365Days,
      elapsedTime,
      rewardPoolBalance
  );

  // Assertions to validate correctness of rewards
  expect(rewardsFor60Days).to.be.closeTo(expectedRewards60Days, ethers.parseEther("0.01")); // ±0.01 tolerance
  expect(rewardsFor180Days).to.be.closeTo(expectedRewards180Days, ethers.parseEther("0.01")); // ±0.01 tolerance
  expect(rewardsFor365Days).to.be.closeTo(expectedRewards365Days, ethers.parseEther("0.01")); // ±0.01 tolerance

  // Ensure longer durations yield higher rewards
  expect(rewardsFor180Days).to.be.gt(rewardsFor60Days);
  expect(rewardsFor365Days).to.be.gt(rewardsFor180Days);
});


it("should allow multiple staking with different tiers and handle insufficient reward pool balance", async function () {
  const firstStakeAmount = ethers.parseEther("100"); // First stake: user stakes 100 tokens
  const secondStakeAmount = ethers.parseEther("200"); // Second stake: user stakes another 200 tokens
  const initialRewardPoolAmount = ethers.parseEther("5"); // Initial reward pool balance
  const additionalRewardPoolAmount = ethers.parseEther("1500"); // Additional tokens to add to reward pool

  // Transfer initial tokens to reward pool and approve staking contract
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, initialRewardPoolAmount);

  // Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, firstStakeAmount + secondStakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), firstStakeAmount + secondStakeAmount);
  expect(await token.balanceOf(user1.address)).to.equal(firstStakeAmount + secondStakeAmount);

  // Stake first amount for a short lock period (60 days)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(firstStakeAmount, lockPeriod60Days);
  expect(await token.balanceOf(user1.address)).to.equal(secondStakeAmount);

  // Attempt to stake second amount for a longer lock period (180 days)
  const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days in seconds
  await expect(stakingWithUser1.stakeToken(secondStakeAmount, lockPeriod180Days))
      .to.be.revertedWithCustomError(stakingEngine, "APYCannotBeSatisfied")
      .withArgs(2, 0, 9); // Expected arguments in error
  expect(await token.balanceOf(user1.address)).to.equal(secondStakeAmount);

  // Add more tokens to the reward pool to satisfy APY requirements
  const rewardPoolBalanceBefore = await token.balanceOf(rewardPoolAddress);
  expect(rewardPoolBalanceBefore).to.equal(initialRewardPoolAmount);

  await tokenWithOwner.transferFromContract(rewardPoolAddress, additionalRewardPoolAmount);

  const rewardPoolBalanceAfter = await token.balanceOf(rewardPoolAddress);
  expect(rewardPoolBalanceAfter).to.equal(initialRewardPoolAmount + additionalRewardPoolAmount);

  // Retry staking second amount for a longer lock period (180 days)
  await stakingWithUser1.stakeToken(secondStakeAmount, lockPeriod180Days);

  // Verify the total staked amount
  const totalStaked = await stakingEngine.totalStaked();
  expect(totalStaked).to.equal(firstStakeAmount + secondStakeAmount); // Total staked should match both stakes

  // Retrieve and verify individual stakes for user1
  const userStakes = await stakingEngine.getUserStakes(user1.address);
  expect(userStakes.length).to.equal(2); // User should have two separate stakes

  expect(userStakes[0].amount).to.equal(firstStakeAmount);
  expect(userStakes[0].lockPeriod).to.equal(lockPeriod60Days);

  expect(userStakes[1].amount).to.equal(secondStakeAmount);
  expect(userStakes[1].lockPeriod).to.equal(lockPeriod180Days);
});



it("should not apply penalties for unstaking after lock period", async function () {
  const fixedAPY60Days = 2;
  const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens
  const initialRewardPoolAmount = ethers.parseEther("100"); // Initial reward pool balance

  // Transfer initial tokens to reward pool and approve staking contract
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, initialRewardPoolAmount);

  // Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Stake tokens for a short lock period (30 days)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 30 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(stakeAmount, lockPeriod60Days);

  // Simulate time passing (lock period complete)
  const elapsedTime = lockPeriod60Days + 1;
  await time.increase(elapsedTime); // Move forward by slightly more than one month

  // Unstake after lock period
  const tx = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receipt = await tx.wait();

  // Parse the "Unstaked" event from the transaction receipt
  const penaltyEvent = receipt?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEvent) {
      const penalty = penaltyEvent.args?.penalty;
      const unstakedAmount = penaltyEvent.args?.amount;

      console.log(`Penalty Applied: ${ethers.formatEther(penalty)}`);
      console.log(`Unstaked Amount: ${ethers.formatEther(unstakedAmount)}`);

      // Verify that no penalty was applied
      expect(penalty).to.equal(0); // No penalty should be applied

      // Verify that the user received their full staked amount back
      const userBalance = await token.balanceOf(user1.address);
      expect(userBalance).to.be.gt(stakeAmount); // User receives full staked amount plus rewards
      const expectedRewards60Days = calculateExpectedRewards(stakeAmount, fixedAPY60Days, elapsedTime);
      expect(userBalance).to.be.closeTo(stakeAmount + expectedRewards60Days, ethers.parseEther("0.000001"));
  }
});

  
it("should handle staking and unstaking for multiple users", async function () {
  const user1StakeAmount = ethers.parseEther("100"); // User1 stakes 100 tokens
  const user2StakeAmount = ethers.parseEther("200"); // User2 stakes 200 tokens
  const initialRewardPoolAmount = ethers.parseEther("300"); // Initial reward pool balance

  // Transfer initial tokens to reward pool and approve staking contract
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, initialRewardPoolAmount);

  // Transfer tokens to user1 and user2, and approve staking contract
  await token.transferFromContract(user1.address, user1StakeAmount);
  await token.transferFromContract(user2.address, user2StakeAmount);

  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  const tokenWithUser2 = token.connect(await ethers.getSigner(user2.address));

  await tokenWithUser1.approve(await stakingEngine.getAddress(), user1StakeAmount);
  await tokenWithUser2.approve(await stakingEngine.getAddress(), user2StakeAmount);

  // Stake for User1 (60 days lock period)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 30 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(user1StakeAmount, lockPeriod60Days);

  // Stake for User2 (180 days lock period)
  const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days in seconds
  const stakingWithUser2 = stakingEngine.connect(await ethers.getSigner(user2.address));
  await stakingWithUser2.stakeToken(user2StakeAmount, lockPeriod180Days);

  // Verify total staked amount
  const totalStaked = await stakingEngine.totalStaked();
  expect(totalStaked).to.equal(user1StakeAmount + user2StakeAmount); // Total staked should match both stakes

  // Simulate time passing (User1's lock period ends)
  await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than one month

  // User1 unstakes after lock period ends (no penalty)
  const txUser1 = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receiptUser1 = await txUser1.wait();

  // Parse the "Unstaked" event for User1
  const penaltyEventUser1 = receiptUser1?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser1) {
      const penaltyUser1 = penaltyEventUser1.args?.penalty;
      const unstakedAmountUser1 = penaltyEventUser1.args?.amount;

      expect(penaltyUser1).to.equal(0); // No penalty for User1
      expect(unstakedAmountUser1).to.equal(user1StakeAmount); // Full amount returned to User1

      const userBalanceAfterUnstake = await token.balanceOf(user1.address);
      expect(userBalanceAfterUnstake).to.be.gt(user1StakeAmount); // Verify balance after unstaking

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(user2StakeAmount); // Total staked reflects only User2's stake
  }

  // Simulate more time passing (User2's lock period ends)
  await time.increase(lockPeriod180Days - lockPeriod60Days); // Move forward to end of User2's lock period

  // User2 unstakes after lock period ends (no penalty)
  const txUser2 = await stakingWithUser2.unstakeToken(0);
  const receiptUser2 = await txUser2.wait();

  // Parse the "Unstaked" event for User2
  const penaltyEventUser2 = receiptUser2?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser2) {
      const penaltyUser2 = penaltyEventUser2.args?.penalty;
      const unstakedAmountUser2 = penaltyEventUser2.args?.amount;

      expect(penaltyUser2).to.equal(0); // No penalty for User2
      expect(unstakedAmountUser2).to.be.eq(user2StakeAmount); // Full amount returned to User2

      const userBalanceAfterUnstake = await token.balanceOf(user2.address);
      expect(userBalanceAfterUnstake).to.be.gt(user2StakeAmount); // Verify balance after unstaking

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(0); // Total staked is now zero
  }
});

it("should handle staking and unstaking for multiple users2", async function () {
  const user1StakeAmount = ethers.parseEther("100"); // User1 stakes 100 tokens
  const user2StakeAmount = ethers.parseEther("200"); // User2 stakes 200 tokens
  const initialRewardPoolAmount = ethers.parseEther("300"); // Initial reward pool balance

  // Transfer initial tokens to reward pool and approve staking contract
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, initialRewardPoolAmount);

  // Transfer tokens to user1 and user2, and approve staking contract
  await token.transferFromContract(user1.address, user1StakeAmount);
  await token.transferFromContract(user2.address, user2StakeAmount);

  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  const tokenWithUser2 = token.connect(await ethers.getSigner(user2.address));

  await tokenWithUser1.approve(await stakingEngine.getAddress(), user1StakeAmount);
  await tokenWithUser2.approve(await stakingEngine.getAddress(), user2StakeAmount);

  // Stake for User1 (60 days lock period)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(user1StakeAmount, lockPeriod60Days);

  // Stake for User2 (180 days lock period)
  const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days in seconds
  const stakingWithUser2 = stakingEngine.connect(await ethers.getSigner(user2.address));
  await stakingWithUser2.stakeToken(user2StakeAmount, lockPeriod180Days);

  // Verify total staked amount
  const totalStaked = await stakingEngine.totalStaked();
  expect(totalStaked).to.equal(user1StakeAmount + user2StakeAmount); // Total staked should match both stakes

  // Simulate time passing (User1's lock period ends)
  await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than 60 days

  // User1 unstakes after lock period ends (no penalty)
  const txUser1 = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receiptUser1 = await txUser1.wait();

  // Parse the "Unstaked" event for User1
  const penaltyEventUser1 = receiptUser1?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser1) {
      const penaltyUser1 = penaltyEventUser1.args?.penalty;
      const unstakedAmountUser1 = penaltyEventUser1.args?.amount;

      console.log(`Penalty for User1: ${ethers.formatEther(penaltyUser1)}`);
      console.log(`Unstaked Amount for User1: ${ethers.formatEther(unstakedAmountUser1)}`);

      expect(penaltyUser1).to.equal(0); // No penalty for User1
      expect(unstakedAmountUser1).to.equal(user1StakeAmount); // Full amount returned to User1

      const userBalanceAfterUnstake = await token.balanceOf(user1.address);
      expect(userBalanceAfterUnstake).to.be.gt(user1StakeAmount); // Verify balance after unstaking

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(user2StakeAmount); // Total staked reflects only User2's stake
  }

  // Simulate more time passing (User2's lock period ends)
  await time.increase(lockPeriod180Days - lockPeriod60Days); // Move forward to end of User2's lock period

  // User2 unstakes after lock period ends (no penalty)
  const txUser2 = await stakingWithUser2.unstakeToken(0);
  const receiptUser2 = await txUser2.wait();

  // Parse the "Unstaked" event for User2
  const penaltyEventUser2 = receiptUser2?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser2) {
      const penaltyUser2 = penaltyEventUser2.args?.penalty;
      const unstakedAmountUser2 = penaltyEventUser2.args?.amount;

      console.log(`Penalty for User2: ${ethers.formatEther(penaltyUser2)}`);
      console.log(`Unstaked Amount for User2: ${ethers.formatEther(unstakedAmountUser2)}`);

      expect(penaltyUser2).to.equal(0); // No penalty for User2
      expect(unstakedAmountUser2).to.equal(user2StakeAmount); // Full amount returned to User2

      const userBalanceAfterUnstake = await token.balanceOf(user2.address);
      expect(userBalanceAfterUnstake).to.be.gt(user2StakeAmount); // Verify balance after unstaking

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(0); // Total staked is now zero
  }
});


it("should not allow staking without rewards in the pool", async function () {
  const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens

  // Empty the reward pool
  const rewardPoolBalance = await token.balanceOf(rewardPoolAddress);
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transfer(owner.address, rewardPoolBalance); // Transfer all tokens out of the reward pool

  // Verify that the reward pool is empty
  const rewardPoolBalanceAfter = await token.balanceOf(rewardPoolAddress);
  expect(rewardPoolBalanceAfter).to.equal(0); // Reward pool should be empty

  // Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Attempt to stake tokens with an empty reward pool
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days lock period
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));

  await expect(stakingWithUser1.stakeToken(stakeAmount, lockPeriod60Days))
      .to.be.revertedWithCustomError(stakingEngine, "APYCannotBeSatisfied")
      .withArgs(1, 0, 2); // Staking for 60 days requires a minimum APY of 2%
});

it("should prevent unstaking without staking", async function () {
  // Attempt to unstake without staking
  await expect(stakingEngine.connect(await ethers.getSigner(user1.address)).unstakeToken(0)).to.be.revertedWith("Invalid stake index");
});


it("should handle multiple staking and partial unstaking", async function () {
  const firstStakeAmount = ethers.parseEther("100"); // First stake: 100 tokens
  const secondStakeAmount = ethers.parseEther("200"); // Second stake: 200 tokens
  const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance

  // Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, firstStakeAmount + secondStakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), firstStakeAmount + secondStakeAmount);

  // Stake first amount for a short lock period (60 days)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(firstStakeAmount, lockPeriod60Days);

  // Stake second amount for a longer lock period (180 days)
  const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days in seconds
  await stakingWithUser1.stakeToken(secondStakeAmount, lockPeriod180Days);

  // Verify total staked amount
  const totalStaked = await stakingEngine.totalStaked();
  expect(totalStaked).to.equal(firstStakeAmount + secondStakeAmount); // Total staked should match both stakes

  // Simulate time passing (e.g., after the first lock period ends)
  await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than 60 days

  // Unstake the first stake
  const tx = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented with index
  const receipt = await tx.wait();

  // Parse the "Unstaked" event for the first stake
  const penaltyEvent = receipt?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEvent) {
      const penalty = penaltyEvent.args?.penalty;
      const finalAmount = penaltyEvent.args?.amount;

      console.log(`Penalty Applied: ${ethers.formatEther(penalty)}`);
      console.log(`Unstaked Amount: ${ethers.formatEther(finalAmount)}`);

      expect(penalty).to.equal(0); // No penalty for the first unstake
      expect(finalAmount).to.equal(firstStakeAmount); // Full amount returned for the first unstake

      const userBalanceAfterUnstake = await token.balanceOf(user1.address);
      expect(userBalanceAfterUnstake).to.be.gt(firstStakeAmount); // Verify balance after unstaking includes rewards

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(secondStakeAmount); // Total staked reflects only the second stake
  }
});


it("should fail staking if user has insufficient allowance", async function () {
  const stakeAmount = ethers.parseEther("100"); // User tries to stake 100 tokens
  const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance

  // Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Transfer tokens to user1 but do not approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);

  // Attempt to stake without approving
  const lockPeriod60Days = 60 * 24 * 60 * 60; // Valid lock period (60 days)
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(stakeAmount, lockPeriod60Days)
  ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
});


it("should fail staking if user has insufficient balance", async function () {
  const stakeAmount = ethers.parseEther("100"); // User tries to stake 100 tokens
  const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance
  const userBlanace = ethers.parseEther("10"); 

  await token.transferFromContract(user1.address, userBlanace);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Ensure user1 has no tokens
  const userBalance = await token.balanceOf(user1.address);
  expect(userBalance).to.equal(ethers.parseEther("10")); // User1 should have zero balance

  // Attempt to stake without sufficient balance
  const lockPeriod60Days = 60 * 24 * 60 * 60; // Valid lock period (60 days)
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(stakeAmount, lockPeriod60Days)
  ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance"); // Contract should revert due to insufficient balance
});


it("should allow unstaking even if reward distribution address has insufficient tokens", async function () {
  const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens
  const initialRewardPoolAmount = ethers.parseEther("150"); // Reward pool has insufficient tokens for rewards

  // Step 1: Transfer initial tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, initialRewardPoolAmount);

  // Step 3: Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Step 4: Stake tokens for a year (365 days)
  const lockPeriod365Days = 365 * 24 * 60 * 60; // 365 days lock period
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(stakeAmount, lockPeriod365Days);

  const stakingPoolBalanceAfterStaking = await token.balanceOf(stakingPoolAddress);
  console.log(`Staking Pool Balance After Staking: ${ethers.formatEther(stakingPoolBalanceAfterStaking)}`);
  expect(stakingPoolBalanceAfterStaking).to.equal(initialStakinPoolAmount + stakeAmount); // Ensure reward pool balance is zero

  // Step 5: Transfer all tokens out of rewardPoolAddress to make its balance zero
  const rewardPoolBalanceBefore = await token.balanceOf(rewardPoolAddress);
  console.log(`Reward Pool Balance Before: ${ethers.formatEther(rewardPoolBalanceBefore)}`);

  const tokenWithRewardPool = token.connect(await ethers.getSigner(rewardPoolAddress));
  await tokenWithRewardPool.transfer(owner.address, rewardPoolBalanceBefore); // Transfer all tokens out

  const rewardPoolBalanceAfter = await token.balanceOf(rewardPoolAddress);
  console.log(`Reward Pool Balance After: ${ethers.formatEther(rewardPoolBalanceAfter)}`);
  expect(rewardPoolBalanceAfter).to.equal(0); // Ensure reward pool balance is zero

  const stakingPoolBalanceAfterRewardTransferOut = await token.balanceOf(stakingPoolAddress);
  console.log(`Staking Pool Balance After Reward Transfer Out: ${ethers.formatEther(stakingPoolBalanceAfterRewardTransferOut)}`);
  expect(stakingPoolBalanceAfterRewardTransferOut).to.equal(initialStakinPoolAmount + stakeAmount); // Ensure reward pool balance is zero

  // Step 5: Simulate time passing (lock period complete)
  await time.increase(lockPeriod365Days + 1); // Move forward by slightly more than one year

  // Step 6: Unstake after lock period
  const tx = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receipt = await tx.wait();

  // Step 7: Check for MissedRewards event using proper event parsing
  const missedRewardsEvent = receipt?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "MissedRewards");

  if (missedRewardsEvent) {
      const missedAmount = missedRewardsEvent.args?.amount;
      console.log(`Missed Rewards: ${ethers.formatEther(missedAmount)} tokens`);
      expect(missedAmount).to.be.gt(0); // Ensure there were missed rewards due to insufficient reward pool balance
  }

  // Step 8: Check for Unstaked event using proper event parsing
  const penaltyEvent = receipt?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEvent) {
      const penalty = penaltyEvent.args?.penalty;
      const unstakedAmount = penaltyEvent.args?.amount;

      console.log(`Penalty Applied: ${ethers.formatEther(penalty)}`);
      console.log(`Unstaked Amount: ${ethers.formatEther(unstakedAmount)}`);

      expect(penalty).to.equal(0); // No penalty should be applied since lock period is complete
      expect(unstakedAmount).to.equal(stakeAmount); // Full staked amount should be returned

      const userBalanceAfterUnstake = await token.balanceOf(user1.address);
      expect(userBalanceAfterUnstake).to.equal(stakeAmount); // User receives only the staked amount (no rewards)
      expect(await stakingEngine.totalStaked()).to.equal(0); // Total staked is now zero
  }
});


it("should handle multiple users staking and unstaking at different times", async function () {
  const user1StakeAmount = ethers.parseEther("100"); // User1 stakes 100 tokens
  const user2StakeAmount = ethers.parseEther("200"); // User2 stakes 200 tokens
  const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance

  // Step 1: Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Step 2: Transfer tokens to user1 and user2, and approve staking contract
  await token.transferFromContract(user1.address, user1StakeAmount);
  await token.transferFromContract(user2.address, user2StakeAmount);

  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  const tokenWithUser2 = token.connect(await ethers.getSigner(user2.address));

  await tokenWithUser1.approve(await stakingEngine.getAddress(), user1StakeAmount);
  await tokenWithUser2.approve(await stakingEngine.getAddress(), user2StakeAmount);

  // Step 3: User1 stakes for a short lock period (60 days)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days in seconds
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  await stakingWithUser1.stakeToken(user1StakeAmount, lockPeriod60Days);

  // Step 4: User2 stakes for a longer lock period (180 days)
  const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days in seconds
  const stakingWithUser2 = stakingEngine.connect(await ethers.getSigner(user2.address));
  await stakingWithUser2.stakeToken(user2StakeAmount, lockPeriod180Days);

  // Step 5: Verify total staked amount
  const totalStaked = await stakingEngine.totalStaked();
  expect(totalStaked).to.equal(user1StakeAmount + user2StakeAmount); // Total staked should match both stakes

  // Step 6: Simulate time passing (User1's lock period ends)
  await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than 60 days

  // Step 7: User1 unstakes after lock period ends (no penalty)
  const txUser1 = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receiptUser1 = await txUser1.wait();

  // Parse the "Unstaked" event for User1 using proper event parsing
  const penaltyEventUser1 = receiptUser1?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser1) {
      const penaltyUser1 = penaltyEventUser1.args?.penalty;
      const unstakedAmountUser1 = penaltyEventUser1.args?.amount;

      console.log(`Penalty for User1: ${ethers.formatEther(penaltyUser1)}`);
      console.log(`Unstaked Amount for User1: ${ethers.formatEther(unstakedAmountUser1)}`);

      expect(penaltyUser1).to.equal(0); // No penalty for User1
      expect(unstakedAmountUser1).to.equal(user1StakeAmount); // Full amount returned for User1

      const userBalanceAfterUnstake = await token.balanceOf(user1.address);
      expect(userBalanceAfterUnstake).to.be.gt(user1StakeAmount); // Verify balance after unstaking includes rewards

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(user2StakeAmount); // Total staked reflects only User2's stake
  }

  // Step 8: Simulate more time passing (User2's lock period ends)
  await time.increase(lockPeriod180Days - lockPeriod60Days); // Move forward to end of User2's lock period

  // Step 9: User2 unstakes after lock period ends (no penalty)
  const txUser2 = await stakingWithUser2.unstakeToken(0);
  const receiptUser2 = await txUser2.wait();

  // Parse the "Unstaked" event for User2 using proper event parsing
  const penaltyEventUser2 = receiptUser2?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (penaltyEventUser2) {
      const penaltyUser2 = penaltyEventUser2.args?.penalty;
      const unstakedAmountUser2 = penaltyEventUser2.args?.amount;

      console.log(`Penalty for User2: ${ethers.formatEther(penaltyUser2)}`);
      console.log(`Unstaked Amount for User2: ${ethers.formatEther(unstakedAmountUser2)}`);

      expect(penaltyUser2).to.equal(0); // No penalty for User2
      expect(unstakedAmountUser2).to.equal(user2StakeAmount); // Full amount returned for User2

      const userBalanceAfterUnstake = await token.balanceOf(user2.address);
      expect(userBalanceAfterUnstake).to.be.gt(user2StakeAmount); // Verify balance after unstaking includes rewards

      const totalStakedAfterUnstake = await stakingEngine.totalStaked();
      expect(totalStakedAfterUnstake).to.equal(0); // Total staked is now zero
  }
});

it("should prevent staking or unstaking with zero amount", async function () {
  const zeroStakeAmount = ethers.parseEther("0"); // Zero tokens

  // Step 1: Attempt to stake zero tokens
  const lockPeriod60Days = 60 * 24 * 60 * 60; // Valid lock period (60 days)
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(zeroStakeAmount, lockPeriod60Days)
  ).to.be.revertedWith("Amount must be greater than zero");

  // Step 2: Attempt to unstake without any active stake
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).unstakeToken(0) // Assuming multi-staking is implemented
  ).to.be.revertedWith("Invalid stake index");
});



it("should distribute rewards proportionally among multiple stakers", async function () {
  const user1StakeAmount = ethers.parseEther("100"); // User1 stakes 100 tokens
  const user2StakeAmount = ethers.parseEther("200"); // User2 stakes 200 tokens
  const rewardPoolAmount = ethers.parseEther("300"); // Reward pool balance

  // Step 1: Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Step 2: Transfer tokens to user1 and user2, and approve staking contract
  await token.transferFromContract(user1.address, user1StakeAmount);
  await token.transferFromContract(user2.address, user2StakeAmount);

  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  const tokenWithUser2 = token.connect(await ethers.getSigner(user2.address));

  await tokenWithUser1.approve(await stakingEngine.getAddress(), user1StakeAmount);
  await tokenWithUser2.approve(await stakingEngine.getAddress(), user2StakeAmount);

  // Step 3: User1 and User2 stake their tokens for the same lock period (60 days)
  const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days lock period
  const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
  const stakingWithUser2 = stakingEngine.connect(await ethers.getSigner(user2.address));

  await stakingWithUser1.stakeToken(user1StakeAmount, lockPeriod60Days);
  await stakingWithUser2.stakeToken(user2StakeAmount, lockPeriod60Days);

  // Step 4: Simulate time passing (lock period ends)
  await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than 60 days

  // Step 5: Unstake both users and verify proportional rewards
  const txUser1 = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
  const receiptUser1 = await txUser1.wait();

  const txUser2 = await stakingWithUser2.unstakeToken(0);
  const receiptUser2 = await txUser2.wait();

  // Parse the "Unstaked" event for User1 using proper event parsing
  const rewardEventUser1 = receiptUser1?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  // Parse the "Unstaked" event for User2 using proper event parsing
  const rewardEventUser2 = receiptUser2?.logs
      .map((log) => {
          try {
              return stakingEngine.interface.parseLog(log);
          } catch (e) {
              return null; // Ignore logs that don't match the interface
          }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

  if (rewardEventUser1 && rewardEventUser2) {
      const totalRewardPoolBalanceBeforeDistribution = rewardPoolAmount;

      // Calculate rewards for each user based on their stake proportion
      const totalStakedAmount = user1StakeAmount + user2StakeAmount;

      const rewardProportionUser1 = (user1StakeAmount * totalRewardPoolBalanceBeforeDistribution) / (totalStakedAmount);
      const rewardProportionUser2 = (user2StakeAmount * totalRewardPoolBalanceBeforeDistribution) / (totalStakedAmount);

      console.log(`Expected Reward for User1: ${ethers.formatEther(rewardProportionUser1)}`);
      console.log(`Expected Reward for User2: ${ethers.formatEther(rewardProportionUser2)}`);

      // Extract actual rewards from events
      const actualUnstakedAmountUser1 = rewardEventUser1.args?.amount;
      const actualUnstakedAmountUser2 = rewardEventUser2.args?.amount;

      const actualUnstakedRewardUser1 = rewardEventUser1.args?.distributedReward;
      const actualUnstakedRewardUser2 = rewardEventUser2.args?.distributedReward;

      console.log(`Actual Unstaked Amount for User1: ${ethers.formatEther(actualUnstakedAmountUser1)}`);
      console.log(`Actual Unstaked Amount for User2: ${ethers.formatEther(actualUnstakedAmountUser2)}`);
      console.log(`Actual Unstaked Reward for User1: ${ethers.formatEther(actualUnstakedRewardUser1)}`);
      console.log(`Actual Unstaked Reward for User2: ${ethers.formatEther(actualUnstakedRewardUser2)}`);
      

      // Verify proportional rewards
      expect(actualUnstakedRewardUser2 / actualUnstakedAmountUser1).to.be.closeTo(actualUnstakedAmountUser2 / actualUnstakedAmountUser1, ethers.parseEther("0.01")); // Allow small tolerance

      console.log(`Rewards distributed proportionally.`);
  }
});

it("should prevent staking or unstaking when the contract is paused", async function () {
  const stakeAmount = ethers.parseEther("100"); // User tries to stake 100 tokens
  const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance

  // Step 1: Transfer tokens to reward pool
  const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
  await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

  // Step 2: Transfer tokens to user1 and approve staking contract
  await token.transferFromContract(user1.address, stakeAmount);
  const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
  await tokenWithUser1.approve(await stakingEngine.getAddress(), stakeAmount);

  // Step 3: Pause the contract
  await stakingEngine.connect(await ethers.getSigner(owner.address)).emergencyPauseRewardDistribution();

  // Step 4: Attempt to stake while paused
  const lockPeriod60Days = 60 * 24 * 60 * 60; // Valid lock period (60 days)
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(stakeAmount, lockPeriod60Days)
  ).to.be.revertedWithCustomError(stakingEngine, "EnforcedPause");

  // Step 5: Simulate a previous stake and attempt to unstake while paused
  await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).unstakeToken(0) // Assuming multi-staking is implemented
  ).to.be.revertedWithCustomError(stakingEngine, "EnforcedPause");

  // Step 6: Unpause the contract
  await stakingEngine.connect(await ethers.getSigner(owner.address)).emergencyUnpauseRewardDistribution();

  // Step 7: Staking should now succeed
  await stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(stakeAmount, lockPeriod60Days);

  // Verify total staked amount after successful staking
  const totalStaked = await stakingEngine.totalStaked();
  console.log(`Total Staked After Unpausing: ${ethers.formatEther(totalStaked)}`);
  expect(totalStaked).to.equal(stakeAmount);
});

  it("should prevent staking with invalid lock periods", async function () {
    const stakeAmount = ethers.parseEther("100"); // User stakes 100 tokens
  
    // Transfer tokens to user1 and approve staking contract
    await token.transferFromContract(user1.address, stakeAmount);
    await token.connect(await ethers.getSigner(user1.address)).approve(await stakingEngine.getAddress(), stakeAmount);
  
    // Attempt to stake with an invalid lock period (e.g., 45 days)
    const invalidLockPeriod = 45 * 24 * 60 * 60; // Invalid duration
    await expect(
      stakingEngine.connect(await ethers.getSigner(user1.address)).stakeToken(stakeAmount, invalidLockPeriod)
    ).to.be.revertedWith("Invalid lock period");
  });

  it("should handle early unstaking by one user without affecting others", async function () {
    const user1StakeAmount = ethers.parseEther("100"); // User1 stakes 100 tokens
    const user2StakeAmount = ethers.parseEther("200"); // User2 stakes 200 tokens
    const rewardPoolAmount = ethers.parseEther("500"); // Reward pool balance

    // Step 1: Transfer tokens to reward pool
    const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
    await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);

    // Step 2: Transfer tokens to user1 and user2, and approve staking contract
    await token.transferFromContract(user1.address, user1StakeAmount);
    await token.transferFromContract(user2.address, user2StakeAmount);

    const tokenWithUser1 = token.connect(await ethers.getSigner(user1.address));
    const tokenWithUser2 = token.connect(await ethers.getSigner(user2.address));

    await tokenWithUser1.approve(await stakingEngine.getAddress(), user1StakeAmount);
    await tokenWithUser2.approve(await stakingEngine.getAddress(), user2StakeAmount);

    // Step 3: User1 stakes for a short lock period (60 days)
    const lockPeriod60Days = 60 * 24 * 60 * 60; // 60 days lock period
    const stakingWithUser1 = stakingEngine.connect(await ethers.getSigner(user1.address));
    await stakingWithUser1.stakeToken(user1StakeAmount, lockPeriod60Days);

    // Step 4: User2 stakes for a longer lock period (180 days)
    const lockPeriod180Days = 180 * 24 * 60 * 60; // 180 days lock period
    const stakingWithUser2 = stakingEngine.connect(await ethers.getSigner(user2.address));
    await stakingWithUser2.stakeToken(user2StakeAmount, lockPeriod180Days);

    // Verify total staked amount after staking
    const totalStakedAfterStaking = await stakingEngine.totalStaked();
    console.log(`Total Staked After Staking: ${ethers.formatEther(totalStakedAfterStaking)}`);
    expect(totalStakedAfterStaking).to.equal(user1StakeAmount + user2StakeAmount);

    // Step 5: Simulate time passing (User1's lock period ends)
    await time.increase(lockPeriod60Days + 1); // Move forward by slightly more than 60 days

    // Step 6: User1 unstakes after lock period ends (no penalty)
    const txUser1 = await stakingWithUser1.unstakeToken(0); // Assuming multi-staking is implemented
    const receiptUser1 = await txUser1.wait();

    // Parse the "Unstaked" event for User1 using proper event parsing
    const penaltyEventUser1 = receiptUser1?.logs
        .map((log) => {
            try {
                return stakingEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");

    if (penaltyEventUser1) {
        const penaltyUser1 = penaltyEventUser1.args?.penalty;
        const unstakedAmountUser1 = penaltyEventUser1.args?.amount;

        console.log(`Penalty for User1: ${ethers.formatEther(penaltyUser1)}`);
        console.log(`Unstaked Amount for User1: ${ethers.formatEther(unstakedAmountUser1)}`);

        expect(penaltyUser1).to.equal(0); // No penalty for User1 since lock period is complete
        expect(unstakedAmountUser1).to.equal(user1StakeAmount); // Full amount returned to User1

        const userBalanceAfterUnstake = await token.balanceOf(user1.address);
        expect(userBalanceAfterUnstake).to.be.gt(user1StakeAmount); // Verify balance after unstaking includes rewards

        const totalStakedAfterUnstake = await stakingEngine.totalStaked();
        console.log(`Total Staked After User1 Unstake: ${ethers.formatEther(totalStakedAfterUnstake)}`);
        expect(totalStakedAfterUnstake).to.equal(user2StakeAmount); // Total staked reflects only User2's stake
    }

    // Step 7: Verify that User2's stake remains unaffected
    const user2Stakes = await stakingEngine.getUserStakes(user2.address);
    expect(user2Stakes.length).to.equal(1); // Ensure User2 still has one active stake
    expect(user2Stakes[0].amount).to.equal(user2StakeAmount); // Verify User2's stake amount is unchanged
    expect(user2Stakes[0].lockPeriod).to.equal(lockPeriod180Days); // Verify User2's lock period is unchanged

    console.log(`Verified that User2's stake is unaffected.`);
});

});

describe("StakingEngine with large user base", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let users: SignerWithAddress[];
    let rewardPoolAddress: string;
    let stakingPoolAddress: string;

    beforeEach(async function () {
        // Get signers
        [owner, user1, user2, ...users] = await ethers.getSigners();
    
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = (await upgrades.deployProxy(StorageToken, [owner.address])) as StorageToken;
        await token.waitForDeployment();

        const maxSupply = await token.connect(await ethers.getSigner(owner.address)).maxSupply();
        await token.connect(await ethers.getSigner(owner.address)).mintToken(maxSupply);
    
        // Deploy StakingEngine
        rewardPoolAddress = users[0].address; // Use one of the users as the reward pool address
        stakingPoolAddress = users[1].address; // Use another user as the staking pool address
    
        const StakingEngine = await ethers.getContractFactory("StakingEngine");
        stakingEngine = (await upgrades.deployProxy(StakingEngine, [
        await token.getAddress(),
        rewardPoolAddress,
        stakingPoolAddress,
        owner.address,
        ])) as StakingEngine;
        await stakingEngine.waitForDeployment();
    
        // Transfer tokens to reward pool, staking pool, and reward distribution addresses
        const initialRewardPool = ethers.parseEther("10000"); // 10,000 tokens
        await token.transferFromContract(rewardPoolAddress, initialRewardPool);
        await token.transferFromContract(stakingPoolAddress, ethers.parseEther("5000")); // Example amount for staking pool
    
        // Approve staking contract for reward pool and reward distribution addresses
        await token.connect(await ethers.getSigner(users[0].address)).approve(await stakingEngine.getAddress(), ethers.MaxUint256); // Reward pool approval
        await token.connect(await ethers.getSigner(users[1].address)).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
    });

    it("should initialize correctly", async function () {
        const rewardPoolBalance = await token.balanceOf(users[0].address); // rewardPoolAddress
        expect(rewardPoolBalance).to.equal(ethers.parseEther("10000"));
    
        expect(await stakingEngine.totalStaked()).to.equal(0);
      });
  
      it("should handle over 10 users staking and unstaking without issues and verify slippage", async function () {
        const numUsers = 10; // Number of users to simulate
        const stakedAmountPerUser = 2; // Total staked amount per user
        const stakeAmount = ethers.parseEther(stakedAmountPerUser.toString()); // Each user stakes 2 tokens
        const lockPeriod = 180 * 24 * 60 * 60; // Lock period: 180 days
        const rewardPoolAmount = ethers.parseEther("1000"); // Reward pool balance
    
        // Step 1: Transfer tokens to reward pool
        const tokenWithOwner = token.connect(await ethers.getSigner(owner.address));
        await tokenWithOwner.transferFromContract(rewardPoolAddress, rewardPoolAmount);
    
        // Step 2: Transfer tokens to all users and approve staking contract
        for (let i = 3; i < numUsers + 3; i++) {
            await token.transferFromContract(users[i].address, stakeAmount); // Transfer tokens to user
            await token.connect(await ethers.getSigner(users[i].address)).approve(await stakingEngine.getAddress(), stakeAmount); // Approve staking contract
        }
    
        // Step 3: Simulate staking for all users
        for (let i = 3; i < numUsers + 3; i++) {
            await stakingEngine.connect(await ethers.getSigner(users[i].address)).stakeToken(stakeAmount, lockPeriod);
        }
    
        // Verify total staked amount after staking
        const totalStakedAfterStaking = await stakingEngine.totalStaked();
        console.log(`Total Staked After Staking: ${ethers.formatEther(totalStakedAfterStaking)}`);
        expect(totalStakedAfterStaking).to.equal(ethers.parseEther((numUsers * stakedAmountPerUser).toString())); // Total staked should match
    
        // Step 4: Simulate time passing (lock period complete)
        await time.increase(lockPeriod + 2); // Move forward by slightly more than the lock period
    
        // Step 5: Simulate unstaking for all users and verify slippage
        for (let i = 3; i < numUsers + 3; i++) {
            const initialBalance = await token.balanceOf(users[i].address);
            const tx = await stakingEngine.connect(await ethers.getSigner(users[i].address)).unstakeToken(0); // Assuming multi-staking is implemented
            const receipt = await tx.wait();
    
            // Parse the "RewardDistributionLog" event for debugging
            const rewardDistributionEvent = receipt?.logs
                .map((log) => {
                    try {
                        return stakingEngine.interface.parseLog(log);
                    } catch (e) {
                        return null; // Ignore logs that don't match the interface
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "RewardDistributionLog");
    
            if (rewardDistributionEvent) {
                const { pendingRewards, penalty, rewardPoolBalance, lockPeriod, elapsedTime } =
                    rewardDistributionEvent.args;
    
                console.log(`User ${i}:`);
                console.log(`Pending Rewards: ${ethers.formatEther(pendingRewards)}`);
                console.log(`Penalty: ${ethers.formatEther(penalty)}`);
                console.log(`Reward Pool Balance: ${ethers.formatEther(rewardPoolBalance)}`);
                console.log(`Lock Period: ${lockPeriod}`);
                console.log(`Elapsed Time: ${elapsedTime}`);
            }
    
            // Parse the "Unstaked" event to verify penalties and final amounts
            const penaltyEvent = receipt?.logs
                .map((log) => {
                    try {
                        return stakingEngine.interface.parseLog(log);
                    } catch (e) {
                        return null; // Ignore logs that don't match the interface
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "Unstaked");
    
            if (penaltyEvent) {
                const penalty = penaltyEvent.args?.penalty;
                const finalAmount = penaltyEvent.args?.amount;
                const distributedReward = penaltyEvent.args?.distributedReward;
    
                console.log(`User ${i}: Penalty Applied: ${ethers.formatEther(penalty)}`);
                console.log(`User ${i}: Final Amount Received: ${ethers.formatEther(finalAmount)}`);
                console.log(`User ${i}: Final Reward Received: ${ethers.formatEther(distributedReward)}`);
    
                expect(penalty).to.equal(0); // No penalty should be applied after lock period
                expect(finalAmount).to.be.closeTo(
                    stakeAmount,
                    ethers.parseEther("0.01") // Allow a small slippage tolerance (e.g., ±0.01 tokens)
                );
    
                const finalBalance = await token.balanceOf(users[i].address);
                expect(finalBalance).to.equal(initialBalance + finalAmount + distributedReward); // Verify correct balance update
            }
            console.log(`User ${i} finished`);
        }
    
        // Step 6: Verify total staked amount is now zero
        const finalTotalStaked = await stakingEngine.totalStaked();
        console.log(`Final Total Staked: ${ethers.formatEther(finalTotalStaked)}`);
        expect(finalTotalStaked).to.equal(0);
    });
      
  });
  
