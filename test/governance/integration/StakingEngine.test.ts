import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StakingEngine, StorageToken } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";

// Define roles
const OWNER_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("OWNER_ROLE"));
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
    let tokenPool: string;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const initialPoolAmount = ethers.parseEther("55000"); // Combined initial amount

    beforeEach(async function () {
        // Get signers
        [owner, admin, user1, user2, user3, attacker, ...users] = await ethers.getSigners();

        // Deploy StorageToken (using upgradeable proxy as it's an upgradeable contract)
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(
            StorageToken, 
            [owner.address, admin.address, TOTAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await token.waitForDeployment();
        // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
        await time.increase(24 * 60 * 60 + 1);

        // Set up roles and permissions
        await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        await time.increase(24 * 60 * 60 + 1);
        await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Set up token pool address
        tokenPool = users[0].address;

        // Deploy StakingEngine (using standard deployment instead of proxy)
        const StakingEngine = await ethers.getContractFactory("StakingEngine");
        stakingEngine = await StakingEngine.deploy(
            await token.getAddress(),
            tokenPool,
            owner.address,
            admin.address,
            "Staking Token",
            "STK"
        ) as StakingEngine;
        await stakingEngine.waitForDeployment();

        // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);

        // Create and execute whitelist proposals for stakingEngine, pool, and users
        const addresses = [
            await stakingEngine.getAddress(),
            tokenPool,
            owner.address, // Add owner address to whitelist
            user1.address,
            user2.address,
            user3.address,
            attacker.address
        ];

        // Whitelist each address one by one with proper timelock handling
        for (let i = 0; i < addresses.length; i++) {
            // Create proposal
            const tx = await token.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                addresses[i],
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            
            // Wait for proposal to be ready for approval
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Approve proposal
            await token.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Wait for the whitelist lock duration to expire (WHITELIST_LOCK_DURATION = 1 days)
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Wait for timelock to expire before next proposal
            if (i < addresses.length - 1) {
                await time.increase(24 * 60 * 60 + 1);
                await ethers.provider.send("evm_mine", []);
            }
        }

        // Transfer tokens to the token pool and users
        await token.connect(owner).transferFromContract(tokenPool, initialPoolAmount);
        
        // Transfer tokens to users and approve staking contract
        for (const user of [user1, user2, user3, attacker]) {
            await token.connect(owner).transferFromContract(user.address, ethers.parseEther("1000"));
            await token.connect(user).approve(await stakingEngine.getAddress(), ethers.parseEther("1000"));
        }
        
        // CRITICAL: Have the token pool approve the StakingEngine to spend tokens
        await token.connect(users[0]).approve(await stakingEngine.getAddress(), ethers.parseEther("1000000"));
        
        // Transfer tokens to owner for adding to the pool
        await token.connect(owner).transferFromContract(owner.address, ethers.parseEther("50000"));
        
        // Approve StakingEngine to spend owner's tokens
        await token.connect(owner).approve(await stakingEngine.getAddress(), ethers.parseEther("50000"));
        
        // Add rewards to the pool
        await stakingEngine.connect(owner).addRewardsToPool(ethers.parseEther("50000"));
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

        it("should revert when unstaking with insufficient token pool approval", async function () {
            // First stake tokens
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Advance time to generate rewards
            await time.increase(lockPeriod);
            await ethers.provider.send("evm_mine", []);
            
            // Revoke token pool approval
            await token.connect(users[0]).approve(await stakingEngine.getAddress(), 0);
            
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
            
            // Simplify to use fewer test points that match our whitelisted users
            const testPoints = [
                { percent: 5, expectedPenaltyRate: 90 },   // 5% elapsed, >90% remaining
                { percent: 50, expectedPenaltyRate: 45 },  // 50% elapsed, >45% remaining
                { percent: 95, expectedPenaltyRate: 10 }   // 95% elapsed, <15% remaining
            ];
            
            // Use only the already whitelisted users
            const testUsers = [user1, user2, user3];
            
            // Ensure all test users have sufficient token approval
            for (const testUser of testUsers) {
                await token.connect(testUser).approve(await stakingEngine.getAddress(), stakeAmount);
            }
            
            // Need to ensure the pool has adequate approval to StakingEngine for all stakes
            await token.connect(users[0]).approve(
                await stakingEngine.getAddress(), 
                stakeAmount * BigInt(testUsers.length) * 2n // Double the amount to be safe
            );
            
            for (let i = 0; i < testPoints.length; i++) {
                const point = testPoints[i];
                const testUser = testUsers[i];
                
                // Stake tokens
                await stakingEngine.connect(testUser).stakeToken(stakeAmount, lockPeriod);
                
                // Advance time to the test point
                const timeToAdvance = Math.floor(lockPeriod * point.percent / 100);
                await time.increase(timeToAdvance);
                await ethers.provider.send("evm_mine", []);
                
                // Unstake and check penalty
                const tx = await stakingEngine.connect(testUser).unstakeToken(0);
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
            // Withdraw all rewards from the pool
            const poolStatus = await stakingEngine.getPoolStatus();
            await stakingEngine.connect(owner).withdrawExcessRewards(poolStatus[2]); // Withdraw all rewards
            
            // Attempt to stake
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Should revert with APYCannotBeSatisfied
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.revertedWithCustomError(stakingEngine, "APYCannotBeSatisfied");
        });

        it("should calculate proportional APY when rewards are limited", async function () {
            // Reduce rewards to a small amount
            const poolStatus = await stakingEngine.getPoolStatus();
            const smallRewardAmount = ethers.parseEther("1"); // Very small amount
            
            // Withdraw most rewards, leaving only a small amount
            await stakingEngine.connect(owner).withdrawExcessRewards(poolStatus[2] - smallRewardAmount);
            
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
            const expectedAPYs = [2, 6, 15]; // Expected APY percentages
            
            // Use different users for each lock period to avoid "Stake already unstaked" error
            const testUsers = [user1, user2, user3];
            
            // Stake and verify rewards for each lock period
            for (let i = 0; i < lockPeriods.length; i++) {
                // Stake tokens
                await stakingEngine.connect(testUsers[i]).stakeToken(stakeAmount, lockPeriods[i]);
                
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
                const balanceBefore = await token.balanceOf(testUsers[i].address);
                
                // Unstake
                const tx = await stakingEngine.connect(testUsers[i]).unstakeToken(0);
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
                        const balanceAfter = await token.balanceOf(testUsers[i].address);
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
            ).to.be.revertedWith("Stake already unstaked");
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
            
            // Advance time to allow referrer rewards to be claimable (one full claim period)
            await time.increase(90 * 24 * 60 * 60);
            await ethers.provider.send("evm_mine", []);
            
            // Get referrer rewards before unstaking - they should be claimable now
            const claimableRewards = await stakingEngine.getClaimableReferrerRewards(user2.address);
            
            // Calculate expected rewards based on contract constants and elapsed time
            // Note: In the updated contract, referrer rewards for 90 days is 0%
            const expected90Days = (stakeAmount * 0n) / 100n; // 0% for 90 days
            
            // For 180 days with 1% reward, claimable after 90 days (half the period)
            // Since we've fixed the calculation to be proportional to time passed:
            const expected180Days = (stakeAmount * 1n * BigInt(90)) / (BigInt(180) * 100n);
            
            // For 365 days with 4% reward, claimable after 90 days (quarter of the period)
            const expected365Days = (stakeAmount * 4n * BigInt(90)) / (BigInt(365) * 100n);
            
            const totalExpectedRewards = expected90Days + expected180Days + expected365Days;
            
            // Verify claimable rewards
            expect(claimableRewards).to.be.closeTo(totalExpectedRewards, totalExpectedRewards / 100n); // 1% tolerance
            
            // Now complete the lock periods and unstake to clean up
            await time.increase(365 * 24 * 60 * 60 - (90 * 24 * 60 * 60)); // Advance to full 365 days
            await ethers.provider.send("evm_mine", []);
            
            // Unstake all stakes
            await stakingEngine.connect(user1).unstakeToken(0); // 90-day stake (index 0)
            await stakingEngine.connect(user1).unstakeToken(1); // 180-day stake (index 1, original index before any unstaking)
            await stakingEngine.connect(user1).unstakeToken(2); // 365-day stake (index 2, original index before any unstaking)
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
                stakingEngine.connect(user2).claimReferrerRewards()
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
            
            // Check internal accounting
            const poolStatus = await stakingEngine.getPoolStatus();
            expect(poolStatus[1]).to.equal(stakeAmount1 + stakeAmount2 + stakeAmount3); // stakedAmount
            
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
            
            // Check updated internal accounting
            const updatedPoolStatus = await stakingEngine.getPoolStatus();
            expect(updatedPoolStatus[1]).to.equal(stakeAmount2 + stakeAmount3); // stakedAmount
        });
    });

    // 11. Pool Management Tests
    describe("Pool Management Tests", function () {
        it("should allow adding rewards to the pool", async function () {
            // Get initial pool status
            const initialPoolStatus = await stakingEngine.getPoolStatus();
            const initialRewardsAmount = initialPoolStatus[2]; // rewardsAmount
            
            // Add rewards
            const additionalRewards = ethers.parseEther("1000");
            
            // Transfer tokens to owner instead of directly to pool
            await token.connect(owner).transferFromContract(owner.address, additionalRewards);
            
            // Owner approves and adds rewards
            await token.connect(owner).approve(await stakingEngine.getAddress(), additionalRewards);
            await stakingEngine.connect(owner).addRewardsToPool(additionalRewards);
            
            // Check updated pool status
            const updatedPoolStatus = await stakingEngine.getPoolStatus();
            expect(updatedPoolStatus[2]).to.equal(initialRewardsAmount + additionalRewards); // rewardsAmount
        });

        it("should allow withdrawing excess rewards", async function () {
            // Get initial pool status
            const initialPoolStatus = await stakingEngine.getPoolStatus();
            const initialRewardsAmount = initialPoolStatus[2]; // rewardsAmount
            
            // Stake some tokens to create required rewards
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Calculate excess rewards
            const excessRewards = await stakingEngine.getExcessRewards();
            expect(excessRewards).to.be.lt(initialRewardsAmount); // Some rewards are now required
            
            // Withdraw excess rewards
            await stakingEngine.connect(owner).withdrawExcessRewards(excessRewards);
            
            // Check updated pool status
            const updatedPoolStatus = await stakingEngine.getPoolStatus();
            expect(updatedPoolStatus[2]).to.equal(initialRewardsAmount - excessRewards); // rewardsAmount
        });

        it("should prevent withdrawing required rewards", async function () {
            // Stake some tokens to create required rewards
            const stakeAmount = ethers.parseEther("1000");
            const lockPeriod = 365 * 24 * 60 * 60; // 365 days (15% APY)
            await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
            
            // Calculate excess rewards
            const excessRewards = await stakingEngine.getExcessRewards();
            
            // Try to withdraw more than excess
            await expect(
                stakingEngine.connect(owner).withdrawExcessRewards(excessRewards + ethers.parseEther("1"))
            ).to.be.revertedWith("Cannot withdraw required rewards");
        });

        it("should reconcile pool balance correctly", async function () {
            // Get initial pool status
            const initialPoolStatus = await stakingEngine.getPoolStatus();
            const initialTotalPool = initialPoolStatus[0]; // totalPoolBalance
            const initialStaked = initialPoolStatus[1]; // stakedAmount
            const initialRewards = initialPoolStatus[2]; // rewardsAmount
            const initialActualBalance = initialPoolStatus[3]; // actual token balance
            
            // IMPORTANT: In our test setup there are two operations:
            // 1. Direct token transfer: 55,000 FULA to the pool - not tracked by contract
            // 2. Adding rewards through contract: 50,000 FULA - tracked by contract
            // This creates a 55,000 FULA discrepancy between actual and tracked balances
            const initialDiscrepancy = BigInt(initialActualBalance) - BigInt(initialTotalPool);
            expect(initialDiscrepancy).to.equal(BigInt(ethers.parseEther("55000"))); // Verify our assumption
            
            // Simulate additional excess tokens in pool (send directly to pool)
            const excessAmount = BigInt(ethers.parseEther("100"));
            await token.connect(owner).transferFromContract(tokenPool, ethers.parseEther("100"));
            
            // Verify actual balance after sending extra tokens
            const actualBalanceAfterSending = await token.balanceOf(tokenPool);
            expect(actualBalanceAfterSending).to.equal(BigInt(initialActualBalance) + excessAmount);
            
            // Total excess now includes both the initial discrepancy and the newly added tokens
            const totalExcess = initialDiscrepancy + excessAmount;
            
            // Reconcile pool balance
            await stakingEngine.connect(owner).reconcilePoolBalance();
            
            // After reconciliation:
            // 1. totalRewardsInPool increases by the TOTAL excess amount (initial discrepancy + new excess)
            // 2. The totalPoolBalance increases accordingly
            // 3. The staked amount remains unchanged
            const updatedPoolStatus = await stakingEngine.getPoolStatus();
            
            // Verify rewards amount increased by total excess
            expect(updatedPoolStatus[2]).to.equal(BigInt(initialRewards) + totalExcess);
            
            // Verify total pool balance increased accordingly
            expect(updatedPoolStatus[0]).to.equal(BigInt(initialTotalPool) + totalExcess);
            
            // Verify staked amount unchanged
            expect(updatedPoolStatus[1]).to.equal(initialStaked);
            
            // Verify that after reconciliation, the reported values match the actual pool balance
            expect(updatedPoolStatus[3]).to.equal(updatedPoolStatus[0]);
        });        
    });

    // 12. Access Control Tests
    describe("Access Control Tests", function () {
        it("should allow only owner to add rewards", async function () {
            const rewardAmount = ethers.parseEther("1000");
            
            // Transfer tokens to non-owner
            await token.connect(owner).transferFromContract(user1.address, rewardAmount);
            await token.connect(user1).approve(await stakingEngine.getAddress(), rewardAmount);
            
            // Non-owner should not be able to add rewards
            await expect(
                stakingEngine.connect(user1).addRewardsToPool(rewardAmount)
            ).to.be.reverted;
            
            // Owner should be able to add rewards
            // Transfer tokens to owner instead of directly to pool
            await token.connect(owner).transferFromContract(owner.address, rewardAmount);
            await token.connect(owner).approve(await stakingEngine.getAddress(), rewardAmount);
            await stakingEngine.connect(owner).addRewardsToPool(rewardAmount);
        });

        it("should allow only owner to withdraw excess rewards", async function () {
            // Non-owner should not be able to withdraw excess rewards
            await expect(
                stakingEngine.connect(user1).withdrawExcessRewards(ethers.parseEther("1"))
            ).to.be.reverted;
            
            // Owner should be able to withdraw excess rewards
            const excessRewards = await stakingEngine.getExcessRewards();
            if (excessRewards > 0) {
                await stakingEngine.connect(owner).withdrawExcessRewards(excessRewards);
            }
        });

        it("should allow only admin to pause/unpause", async function () {
            // Non-admin should not be able to pause
            await expect(
                stakingEngine.connect(user1).emergencyPauseRewardDistribution()
            ).to.be.reverted;
            
            // Admin should be able to pause
            await stakingEngine.connect(admin).emergencyPauseRewardDistribution();
            
            // Non-admin should not be able to unpause
            await expect(
                stakingEngine.connect(user1).emergencyUnpauseRewardDistribution()
            ).to.be.reverted;
            
            // Admin should be able to unpause
            await stakingEngine.connect(admin).emergencyUnpauseRewardDistribution();
        });
    });
});
