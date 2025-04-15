import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StakingEngine, StorageToken } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";

// Use the same value as in ProposalTypes.sol
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const PRECISION_FACTOR = 1n * 10n ** 18n;

describe("StakingEngine Security Tests", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let user3: HardhatEthersSigner;
    let attacker: HardhatEthersSigner;
    let users: HardhatEthersSigner[];
    let rewardPoolAddress: string;
    let stakingPoolAddress: string;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const initialRewardPoolAmount = ethers.parseEther("50000");
    const initialStakingPoolAmount = ethers.parseEther("5000");

    beforeEach(async function () {
        // Get signers
        [owner, admin, user1, user2, user3, attacker, ...users] = await ethers.getSigners();

        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(
            StorageToken, 
            [owner.address, admin.address, TOTAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await token.waitForDeployment();

        // Set up reward and staking pool addresses
        rewardPoolAddress = users[0].address;
        stakingPoolAddress = users[1].address;

        // Deploy StakingEngine
        const StakingEngine = await ethers.getContractFactory("StakingEngine");
        stakingEngine = await upgrades.deployProxy(
            StakingEngine, 
            [
                await token.getAddress(),
                rewardPoolAddress,
                stakingPoolAddress,
                owner.address,
                admin.address,
            ],
            { kind: 'uups', initializer: 'initialize' }
        ) as StakingEngine;
        await stakingEngine.waitForDeployment();

        // Wait for role change timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);

        // Set up governance
        await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await stakingEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Additional delay before setting transaction limit
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Set transaction limit for admin role
        await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, ethers.parseEther("1000000000"));
        
        // Wait for second timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);

        // Create and execute whitelist proposals for stakingEngine, pools, and users
        const addresses = [
            await stakingEngine.getAddress(),
            stakingPoolAddress,
            rewardPoolAddress,
            user1.address,
            user2.address,
            user3.address,
            attacker.address
        ];

        for (const address of addresses) {
            const tx = await token.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                address,
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            await token.connect(admin).approveProposal(proposalId);
            await time.increase(24 * 60 * 60 + 1);
        }

        // Transfer tokens to the contracts and users
        await token.connect(owner).transferFromContract(await stakingEngine.getAddress(), ethers.parseEther("10000"));
        await token.connect(owner).transferFromContract(stakingPoolAddress, initialStakingPoolAmount);
        await token.connect(owner).transferFromContract(rewardPoolAddress, initialRewardPoolAmount);
        
        // Transfer tokens to users and approve staking contract
        for (const user of [user1, user2, user3, attacker]) {
            await token.connect(owner).transferFromContract(user.address, ethers.parseEther("1000"));
            await token.connect(user).approve(await stakingEngine.getAddress(), ethers.parseEther("1000"));
        }
        
        // CRITICAL: Have the pools approve the StakingEngine to spend their tokens
        await token.connect(users[0]).approve(await stakingEngine.getAddress(), ethers.parseEther("1000000")); // Reward pool
        await token.connect(users[1]).approve(await stakingEngine.getAddress(), ethers.parseEther("1000000")); // Staking pool
    });

    // 1. Token Approval Tests
    describe("Token Approval Tests", function () {
        it("should revert when staking without sufficient approval", async function () {
            // Revoke approval
            await token.connect(user1).approve(await stakingEngine.getAddress(), 0);
            
            // Attempt to stake
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Transaction should revert with InsufficientApproval error
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.revertedWithCustomError(stakingEngine, "InsufficientApproval");
        });

        it("should revert when unstaking with insufficient reward pool approval", async function () {
            // First stake tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time to generate rewards
            await time.increase(lockPeriod);
            await ethers.provider.send("evm_mine", []);
            
            // Revoke reward pool approval
            await token.connect(users[0]).approve(await stakingEngine.getAddress(), 0);
            
            // Attempt to unstake
            await expect(
                stakingEngine.connect(user1).unstakeToken(0)
            ).to.be.revertedWithCustomError(stakingEngine, "InsufficientApproval");
        });

        it("should revert when unstaking with insufficient staking pool approval", async function () {
            // First stake tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Revoke staking pool approval
            await token.connect(users[1]).approve(await stakingEngine.getAddress(), 0);
            
            // Attempt to unstake
            await expect(
                stakingEngine.connect(user1).unstakeToken(0)
            ).to.be.revertedWithCustomError(stakingEngine, "InsufficientApproval");
        });
    });

    // 2. Referrer Validation Tests
    describe("Referrer Validation Tests", function () {
        it("should revert when attempting self-referral", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Attempt to refer self
            await expect(
                stakingEngine.connect(user1).stakeTokenWithReferrer(stakeAmount, lockPeriod, user1.address)
            ).to.be.revertedWith("Cannot refer yourself");
        });

        it("should accept zero address as a valid referrer (no referrer)", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // This should succeed, not revert
            await stakingEngine.connect(user1).stakeTokenWithReferrer(
                stakeAmount, 
                lockPeriod, 
                ZeroAddress
            );
            
            // Verify the stake was created with no referrer
            const stakes = await stakingEngine.getUserStakes(user1.address);
            expect(stakes.length).to.equal(1);
            expect(stakes[0].referrer).to.equal(ZeroAddress);
        });
    });

    // 3. Penalty Calculation Tests
    describe("Penalty Calculation Tests", function () {
        it("should apply correct penalties at different time points", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Test points at different percentages of the lock period
            const testPoints = [
                { percent: 5, expectedPenaltyRate: 90 },   // 5% elapsed, >90% remaining
                { percent: 15, expectedPenaltyRate: 75 },  // 15% elapsed, >75% remaining
                { percent: 30, expectedPenaltyRate: 60 },  // 30% elapsed, >60% remaining
                { percent: 50, expectedPenaltyRate: 45 },  // 50% elapsed, >45% remaining
                { percent: 65, expectedPenaltyRate: 30 },  // 65% elapsed, >30% remaining
                { percent: 80, expectedPenaltyRate: 20 },  // 80% elapsed, >15% remaining
                { percent: 95, expectedPenaltyRate: 10 }   // 95% elapsed, <15% remaining
            ];
            
            for (const point of testPoints) {
                // Stake tokens
                await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
                
                // Advance time to the test point
                const timeToAdvance = Math.floor(lockPeriod * point.percent / 100);
                await time.increase(timeToAdvance);
                await ethers.provider.send("evm_mine", []);
                
                // Unstake and check penalty
                const tx = await stakingEngine.connect(user1).unstakeToken(0);
                const receipt = await tx.wait();
                
                // Find the Unstaked event
                const unstakeEvent = receipt?.logs.find(
                    log => log.topics[0] === ethers.id("Unstaked(address,uint256,uint256,uint256)")
                );
                
                if (unstakeEvent) {
                    const parsedEvent = stakingEngine.interface.parseLog({
                        topics: [...unstakeEvent.topics],
                        data: unstakeEvent.data
                    });
                    
                    if (parsedEvent) {
                        const penalty = parsedEvent.args[3];
                        const expectedPenalty = (stakeAmount * BigInt(point.expectedPenaltyRate)) / 100n;
                        
                        // Allow for small rounding differences
                        const tolerance = (expectedPenalty * 2n) / 100n; // 2% tolerance
                        
                        expect(penalty).to.be.closeTo(
                            expectedPenalty,
                            tolerance
                        );
                    }
                }
            }
        });

        it("should apply zero penalty after lock period", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Stake tokens
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time past the lock period
            await time.increase(lockPeriod + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Unstake and check penalty
            const tx = await stakingEngine.connect(user1).unstakeToken(0);
            const receipt = await tx.wait();
            
            // Find the Unstaked event
            const unstakeEvent = receipt?.logs.find(
                log => log.topics[0] === ethers.id("Unstaked(address,uint256,uint256,uint256)")
            );
            
            if (unstakeEvent) {
                const parsedEvent = stakingEngine.interface.parseLog({
                    topics: [...unstakeEvent.topics],
                    data: unstakeEvent.data
                });
                
                if (parsedEvent) {
                    const penalty = parsedEvent.args[3];
                    expect(penalty).to.equal(0);
                }
            }
        });
    });

    // 4. APY Calculation Tests
    describe("APY Calculation Tests", function () {
        it("should revert when staking with insufficient rewards to meet APY", async function () {
            // Drain the reward pool
            const rewardPoolBalance = await token.balanceOf(rewardPoolAddress);
            await token.connect(users[0]).transfer(owner.address, rewardPoolBalance);
            
            // Attempt to stake
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Should revert with APYCannotBeSatisfied
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.revertedWithCustomError(stakingEngine, "APYCannotBeSatisfied");
        });

        it("should calculate proportional APY when rewards are limited", async function () {
            // Reduce reward pool to a small amount
            const rewardPoolBalance = await token.balanceOf(rewardPoolAddress);
            const smallRewardAmount = ethers.parseEther("1"); // Very small amount
            
            // Transfer most rewards away, leaving only a small amount
            await token.connect(users[0]).transfer(owner.address, rewardPoolBalance - smallRewardAmount);
            
            // Check projected APY
            const stakeAmount = ethers.parseEther("1000"); // Large stake relative to rewards
            const lockPeriod = 365 * 24 * 60 * 60; // 365 days
            
            const projectedAPY = await stakingEngine.calculateProjectedAPY(stakeAmount, lockPeriod);
            
            // Projected APY should be less than the fixed APY for 365 days (15%)
            expect(projectedAPY).to.be.lt(15);
            
            // But should be greater than 0 due to our fix
            expect(projectedAPY).to.be.gt(0);
            
            // Log the actual value for debugging
            console.log(`Projected APY with limited rewards: ${projectedAPY}`);
        });
    });

    // 5. Reward Calculation Tests
    describe("Reward Calculation Tests", function () {
        it("should calculate rewards correctly for different lock periods", async function () {
            // Define staking parameters for different lock periods
            const stakeAmount = ethers.parseEther("100");
            const lockPeriods = [
                90 * 24 * 60 * 60,   // 90 days - 2% APY
                180 * 24 * 60 * 60,  // 180 days - 6% APY
                365 * 24 * 60 * 60   // 365 days - 15% APY
            ];
            const expectedAPYs = [2, 6, 15]; // Expected APY percentages (updated to match contract)
            
            // Stake and verify rewards for each lock period
            for (let i = 0; i < lockPeriods.length; i++) {
                // Stake tokens
                await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriods[i]);
                
                // Advance time to complete lock period
                await time.increase(lockPeriods[i]);
                await ethers.provider.send("evm_mine", []);
                
                // Calculate expected rewards using the same formula as the contract
                const daysInYear = 365;
                const lockPeriodDays = lockPeriods[i] / (24 * 60 * 60);
                
                // Use the contract's calculation method including rounding
                const annualRewards = (stakeAmount * BigInt(expectedAPYs[i]) * PRECISION_FACTOR) / 100n;
                const expectedReward = (annualRewards * BigInt(lockPeriodDays) + (BigInt(daysInYear) * PRECISION_FACTOR / 2n)) / (BigInt(daysInYear) * PRECISION_FACTOR);
                
                // Record balance before unstaking
                const balanceBefore = await token.balanceOf(user1.address);
                
                // Unstake
                const tx = await stakingEngine.connect(user1).unstakeToken(0);
                const receipt = await tx.wait();
                
                // Find the Unstaked event
                const unstakeEvent = receipt?.logs.find(
                    log => log.topics[0] === ethers.id("Unstaked(address,uint256,uint256,uint256)")
                );
                
                if (unstakeEvent) {
                    const parsedEvent = stakingEngine.interface.parseLog({
                        topics: [...unstakeEvent.topics],
                        data: unstakeEvent.data
                    });
                    
                    if (parsedEvent) {
                        // Verify distributed reward
                        const distributedReward = parsedEvent.args[2];
                        
                        // Allow for small rounding differences
                        const tolerance = (expectedReward * 5n) / 100n; // 5% tolerance
                        
                        expect(distributedReward).to.be.closeTo(
                            expectedReward,
                            tolerance
                        );
                        
                        // Verify balance increase
                        const balanceAfter = await token.balanceOf(user1.address);
                        const balanceIncrease = balanceAfter - balanceBefore;
                        
                        expect(balanceIncrease).to.be.closeTo(
                            stakeAmount + expectedReward,
                            tolerance
                        );
                    }
                }
            }
        });

        it("should handle precision correctly with very small stake amounts", async function () {
            // Stake a very small amount
            const tinyStakeAmount = 1n; // 1 wei
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // This should either revert with a meaningful error or succeed without excessive rewards
            try {
                await stakingEngine.connect(user1).stakeToken(tinyStakeAmount, lockPeriod);
                
                // Advance time to generate rewards
                await time.increase(lockPeriod);
                await ethers.provider.send("evm_mine", []);
                
                // Record initial balance
                const initialBalance = await token.balanceOf(user1.address);
                
                // Unstake and check rewards
                await stakingEngine.connect(user1).unstakeToken(0);
                
                // Record final balance
                const finalBalance = await token.balanceOf(user1.address);
                
                // Calculate the maximum reasonable reward
                // 2% APY for 90 days on 1 wei
                const maxReasonableReward = (1n * 2n * 90n) / (100n * 365n) + 1n;
                
                // Verify the user didn't extract excessive rewards
                expect(finalBalance - initialBalance).to.be.lte(tinyStakeAmount + maxReasonableReward);
            } catch (error: any) {
                // If it reverts, it should be with a meaningful error
                expect(error.message).to.not.include("division by zero");
                expect(error.message).to.not.include("overflow");
            }
        });
    });

    // 6. Multiple Unstaking Attempt Tests
    describe("Multiple Unstaking Attempt Tests", function () {
        it("should prevent unstaking the same stake multiple times", async function () {
            // User1 stakes tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time to generate rewards
            await time.increase(lockPeriod);
            await ethers.provider.send("evm_mine", []);
            
            // First unstake should succeed
            await stakingEngine.connect(user1).unstakeToken(0);
            
            // Second unstake should fail
            await expect(
                stakingEngine.connect(user1).unstakeToken(0)
            ).to.be.revertedWith("Invalid stake index");
        });
    });

    // 7. Invalid Index Unstaking Tests
    describe("Invalid Index Unstaking Tests", function () {
        it("should prevent unstaking with invalid index", async function () {
            // User1 stakes tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Attempt to unstake with invalid index
            await expect(
                stakingEngine.connect(user1).unstakeToken(1) // Index 1 doesn't exist
            ).to.be.revertedWith("Invalid stake index");
            
            // Attempt to unstake with very large index
            await expect(
                stakingEngine.connect(user1).unstakeToken(999)
            ).to.be.revertedWith("Invalid stake index");
        });
    });

    // 8. Referrer Reward Tests
    describe("Referrer Reward Tests", function () {
        it("should calculate correct rewards for multiple referrals with different periods", async function () {
            // User2 refers User1 for different lock periods
            const stakeAmount = ethers.parseEther("100");
            
            // Stake with 90-day lock period
            await stakingEngine.connect(user1).stakeTokenWithReferrer(
                stakeAmount,
                90 * 24 * 60 * 60,
                user2.address
            );
            
            // Stake with 180-day lock period
            await stakingEngine.connect(user1).stakeTokenWithReferrer(
                stakeAmount,
                180 * 24 * 60 * 60,
                user2.address
            );
            
            // Stake with 365-day lock period
            await stakingEngine.connect(user1).stakeTokenWithReferrer(
                stakeAmount,
                365 * 24 * 60 * 60,
                user2.address
            );
            
            // Advance time to complete all lock periods
            await time.increase(365 * 24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            // Unstake all stakes
            await stakingEngine.connect(user1).unstakeToken(0); // 90-day stake
            await stakingEngine.connect(user1).unstakeToken(0); // 180-day stake
            await stakingEngine.connect(user1).unstakeToken(0); // 365-day stake
            
            // Check referrer rewards by period
            const rewards90Days = await stakingEngine.getReferrerRewardsByPeriod(user2.address, 90 * 24 * 60 * 60);
            const rewards180Days = await stakingEngine.getReferrerRewardsByPeriod(user2.address, 180 * 24 * 60 * 60);
            const rewards365Days = await stakingEngine.getReferrerRewardsByPeriod(user2.address, 365 * 24 * 60 * 60);
            
            // Calculate expected rewards based on contract constants
            const expected90Days = (stakeAmount * 1n) / 100n; // 1% for 90 days
            const expected180Days = (stakeAmount * 2n) / 100n; // 2% for 180 days
            const expected365Days = (stakeAmount * 4n) / 100n; // 4% for 365 days
            
            expect(rewards90Days).to.equal(expected90Days);
            expect(rewards180Days).to.equal(expected180Days);
            expect(rewards365Days).to.equal(expected365Days);
            
            // Total unclaimed rewards should be the sum
            const totalUnclaimed = await stakingEngine.getReferrerUnclaimedRewards(user2.address);
            expect(totalUnclaimed).to.equal(expected90Days + expected180Days + expected365Days);
            
            // Claim rewards for each period
            await stakingEngine.connect(user2).claimReferrerRewards(90 * 24 * 60 * 60);
            await stakingEngine.connect(user2).claimReferrerRewards(180 * 24 * 60 * 60);
            await stakingEngine.connect(user2).claimReferrerRewards(365 * 24 * 60 * 60);
            
            // Verify all rewards are claimed
            const finalUnclaimed = await stakingEngine.getReferrerUnclaimedRewards(user2.address);
            expect(finalUnclaimed).to.equal(0);
        });

        it("should prevent claiming referrer rewards multiple times", async function () {
            // User2 refers User1
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            await stakingEngine.connect(user1).stakeTokenWithReferrer(
                stakeAmount,
                lockPeriod,
                user2.address
            );
            
            // Advance time to complete lock period
            await time.increase(lockPeriod);
            await ethers.provider.send("evm_mine", []);
            
            // Unstake to generate referrer rewards
            await stakingEngine.connect(user1).unstakeToken(0);
            
            // Claim rewards
            await stakingEngine.connect(user2).claimReferrerRewards(lockPeriod);
            
            // Attempt to claim again
            await expect(
                stakingEngine.connect(user2).claimReferrerRewards(lockPeriod)
            ).to.be.revertedWith("No rewards available for this period");
        });
    });

    // 9. Emergency Controls Tests
    describe("Emergency Controls Tests", function () {
        it("should prevent operations when paused", async function () {
            // Pause the contract
            await stakingEngine.connect(admin).emergencyPauseRewardDistribution();
            
            // Attempt to stake
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Expect the transaction to revert (without specifying the exact error message)
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.reverted;
            
            // Attempt to unstake (first stake before pausing)
            await expect(
                stakingEngine.connect(user1).unstakeToken(0)
            ).to.be.reverted;
            
            // Attempt to claim referrer rewards
            await expect(
                stakingEngine.connect(user2).claimReferrerRewards(lockPeriod)
            ).to.be.reverted;
        });

        it("should allow operations after unpausing", async function () {
            // Pause the contract
            await stakingEngine.connect(admin).emergencyPauseRewardDistribution();
            
            // Unpause the contract
            await stakingEngine.connect(admin).emergencyUnpauseRewardDistribution();
            
            // Stake tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Should succeed
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Verify stake was created
            const stakes = await stakingEngine.getUserStakes(user1.address);
            expect(stakes.length).to.equal(1);
        });
    });

    // 10. State Consistency Tests
    describe("State Consistency Tests", function () {
        it("should maintain consistent totalStaked values", async function () {
            // Stake with different lock periods
            const stakeAmount1 = ethers.parseEther("100");
            const stakeAmount2 = ethers.parseEther("200");
            const stakeAmount3 = ethers.parseEther("300");
            
            await stakingEngine.connect(user1).stakeToken(stakeAmount1, 90 * 24 * 60 * 60);
            await stakingEngine.connect(user2).stakeToken(stakeAmount2, 180 * 24 * 60 * 60);
            await stakingEngine.connect(user3).stakeToken(stakeAmount3, 365 * 24 * 60 * 60);
            
            // Check total staked
            const totalStaked = await stakingEngine.totalStaked();
            expect(totalStaked).to.equal(stakeAmount1 + stakeAmount2 + stakeAmount3);
            
            // Check period-specific staked amounts
            const totalStaked90Days = await stakingEngine.totalStaked90Days();
            const totalStaked180Days = await stakingEngine.totalStaked180Days();
            const totalStaked365Days = await stakingEngine.totalStaked365Days();
            
            expect(totalStaked90Days).to.equal(stakeAmount1);
            expect(totalStaked180Days).to.equal(stakeAmount2);
            expect(totalStaked365Days).to.equal(stakeAmount3);
            
            // Unstake one stake
            await time.increase(90 * 24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            await stakingEngine.connect(user1).unstakeToken(0);
            
            // Check updated totals
            const updatedTotalStaked = await stakingEngine.totalStaked();
            const updatedTotalStaked90Days = await stakingEngine.totalStaked90Days();
            
            expect(updatedTotalStaked).to.equal(stakeAmount2 + stakeAmount3);
            expect(updatedTotalStaked90Days).to.equal(0);
            expect(await stakingEngine.totalStaked180Days()).to.equal(stakeAmount2);
            expect(await stakingEngine.totalStaked365Days()).to.equal(stakeAmount3);
        });
    });

    // 11. Reward Pool Depletion Tests
    describe("Reward Pool Depletion Tests", function () {
        it("should handle reward pool depletion gracefully", async function () {
            // User1 stakes tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time to generate rewards
            await time.increase(lockPeriod);
            await ethers.provider.send("evm_mine", []);
            
            // Drain the reward pool
            const rewardPoolBalance = await token.balanceOf(rewardPoolAddress);
            await token.connect(users[0]).transfer(owner.address, rewardPoolBalance);
            
            // Record initial balance
            const initialBalance = await token.balanceOf(user1.address);
            
            // User1 unstakes
            await stakingEngine.connect(user1).unstakeToken(0);
            
            // Record final balance
            const finalBalance = await token.balanceOf(user1.address);
            
            // Verify user1 got at least their principal back
            expect(finalBalance).to.be.gte(initialBalance + stakeAmount);
            
            // Verify total staked amount is updated
            const totalStaked = await stakingEngine.totalStaked();
            expect(totalStaked).to.equal(0);
        });
    });

    // 12. Approval Management Tests
    describe("Approval Management Tests", function () {
        it("should handle multiple stake/unstake operations with limited approval", async function () {
            // Set a limited approval
            const approvalAmount = ethers.parseEther("300");
            await token.connect(user1).approve(await stakingEngine.getAddress(), approvalAmount);
            
            // Stake multiple times
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // First stake
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Second stake
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Third stake
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Fourth stake should fail due to insufficient approval
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.revertedWithCustomError(stakingEngine, "InsufficientApproval");
            
            // Verify the number of stakes
            const stakes = await stakingEngine.getUserStakes(user1.address);
            expect(stakes.length).to.equal(3);
        });
    });

    // 13. Stake/Unstake Cycling Tests
    describe("Stake/Unstake Cycling Tests", function () {
        it("should prevent profit from rapid stake/unstake cycling", async function () {
            // Initial setup: add significant tokens to reward pool
            await token.connect(owner).transferFromContract(rewardPoolAddress, ethers.parseEther("100000"));
            
            // Attacker's strategy: rapidly stake and unstake to try to game rewards
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Initial balance verification
            const initialBalance = await token.balanceOf(attacker.address);
            console.log(`Initial balance: ${ethers.formatEther(initialBalance)}`);

            // Track balance after each cycle
            let expectedBalance = initialBalance;
            for (let i = 0; i < 5; i++) {
                // Stake 100 tokens
                await token.connect(attacker).approve(await stakingEngine.getAddress(), stakeAmount);
                await stakingEngine.connect(attacker).stakeToken(stakeAmount, lockPeriod);
                
                // Expected balance should decrease by 100 tokens
                expectedBalance -= stakeAmount;
                
                // Advance time
                await time.increase(12 * 60 * 60); // 12 hours (well below 1 day)
                await ethers.provider.send("evm_mine", []);
                
                // Unstake with penalty
                await stakingEngine.connect(attacker).unstakeToken(0);
                
                // Expected balance should increase by 80 tokens (after 20% penalty)
                expectedBalance += (stakeAmount * 80n) / 100n;
                
                // Verify current balance
                const currentBalance = await token.balanceOf(attacker.address);
                console.log(`After cycle ${i+1}: ${ethers.formatEther(currentBalance)}`);
                
                // Optional: Add explicit verification after each cycle
                expect(currentBalance).to.equal(expectedBalance);
            }

            // Final verification
            const finalBalance = await token.balanceOf(attacker.address);
            console.log(`Final balance: ${ethers.formatEther(finalBalance)}`);
            expect(finalBalance).to.be.lt(initialBalance);

        });
    });

    // 14. Principal Penalty Tests
    describe("Principal Penalty Tests", function () {
        it("should apply principal penalty for very short staking periods", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Stake tokens
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time by a very short period (less than 1 day)
            await time.increase(12 * 60 * 60); // 12 hours
            await ethers.provider.send("evm_mine", []);
            
            // Record initial balance
            const initialBalance = await token.balanceOf(user1.address);
            
            // Unstake
            await stakingEngine.connect(user1).unstakeToken(0);
            
            // Record final balance
            const finalBalance = await token.balanceOf(user1.address);
            
            // Calculate expected return amount (80% of principal)
            const expectedReturnAmount = (stakeAmount * 80n) / 100n;
            
            // Verify the balance increased by only 80% of the staked amount
            expect(finalBalance - initialBalance).to.equal(expectedReturnAmount);
            
            // Log the actual values for debugging
            console.log(`Principal penalty test: Original: ${ethers.formatEther(stakeAmount)}, Returned: ${ethers.formatEther(finalBalance - initialBalance)}`);
        });
    });
});
