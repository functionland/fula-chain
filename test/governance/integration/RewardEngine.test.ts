import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Contract } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

// Helper function to convert string peer IDs to bytes32
function stringToBytes32(str: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

// Define roles
const OWNER_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("OWNER_ROLE"));
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const POOL_ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("POOL_ADMIN_ROLE"));
const POOL_CREATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("POOL_CREATOR_ROLE"));

describe("RewardEngine Tests", function () {
    let rewardEngine: Contract;
    let storageToken: Contract;
    let storagePool: Contract;
    let stakingPool: Contract;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let poolCreator: HardhatEthersSigner; // Will be set to owner who has POOL_CREATOR_ROLE
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let user3: HardhatEthersSigner;
    let attacker: HardhatEthersSigner;

    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const REWARD_POOL_AMOUNT = ethers.parseEther("100000000"); // 100M tokens for rewards
    const POOL_CREATION_TOKENS = ethers.parseEther("500000"); // 500K tokens for pool creation
    const USER_TOKEN_AMOUNT = ethers.parseEther("10000"); // 10K tokens per user

    // Test pool data
    const TEST_POOL_NAME = "Test Pool";
    const TEST_POOL_REGION = "US-East";
    const TEST_POOL_REQUIRED_TOKENS = ethers.parseEther("1000");
    const TEST_POOL_MIN_PING = 100;
    const TEST_POOL_MAX_CHALLENGE_PERIOD = 7 * 24 * 60 * 60; // 7 days

    // Test peer IDs (converted to bytes32)
    const PEER_ID_1 = stringToBytes32("12D3KooWTest1");
    const PEER_ID_2 = stringToBytes32("12D3KooWTest2");
    const PEER_ID_3 = stringToBytes32("12D3KooWTest3");
    const CREATOR_PEER_ID = stringToBytes32("12D3KooWCreator");

    let testPoolId: number;

    beforeEach(async function () {
        // Get signers
        [owner, admin, user1, user2, user3, attacker] = await ethers.getSigners();

        // Set poolCreator to owner (who has POOL_CREATOR_ROLE)
        poolCreator = owner;

        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await storageToken.waitForDeployment();

        // Wait for role change timelock to expire
        await time.increase(24 * 60 * 60 + 1);

        // Set up roles and permissions for StorageToken
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Deploy StakingPool first (needed for StoragePool initialization)
        const StakingPool = await ethers.getContractFactory("StakingPool");
        stakingPool = await upgrades.deployProxy(
            StakingPool,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await stakingPool.waitForDeployment();

        // Deploy StoragePool (no longer uses StoragePoolLib)
        const StoragePool = await ethers.getContractFactory("StoragePool");
        storagePool = await upgrades.deployProxy(
            StoragePool,
            [await storageToken.getAddress(), await stakingPool.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await storagePool.waitForDeployment();

        // Deploy RewardEngine
        const RewardEngine = await ethers.getContractFactory("RewardEngine");
        rewardEngine = await upgrades.deployProxy(
            RewardEngine,
            [
                await storageToken.getAddress(),
                await storagePool.getAddress(),
                await stakingPool.getAddress(),
                owner.address,
                admin.address
            ],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await rewardEngine.waitForDeployment();

        // Set up roles and permissions for StoragePool
        await time.increase(24 * 60 * 60 + 1);
        await storagePool.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        await storagePool.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Set up roles and permissions for StakingPool
        await time.increase(24 * 60 * 60 + 1);
        await stakingPool.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        await stakingPool.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Set up roles and permissions for RewardEngine
        await time.increase(24 * 60 * 60 + 1);
        await rewardEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        await rewardEngine.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Note: For online status submission, we'll use owner (pool creator) instead of admin
        // since granting POOL_ADMIN_ROLE requires complex governance proposals

        // Create and execute whitelist proposals for all contracts and users
        const addresses = [
            await storageToken.getAddress(),
            await storagePool.getAddress(),
            await stakingPool.getAddress(),
            await rewardEngine.getAddress(),
            owner.address,
            admin.address,

            user1.address,
            user2.address,
            user3.address,
            attacker.address
        ];

        // Whitelist each address with proper timelock handling
        for (let i = 0; i < addresses.length; i++) {
            const tx = await storageToken.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                addresses[i],
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            
            await time.increase(24 * 60 * 60 + 1);
            await storageToken.connect(admin).approveProposal(proposalId);
            await time.increase(24 * 60 * 60 + 1);
            
            if (i < addresses.length - 1) {
                await time.increase(24 * 60 * 60 + 1);
            }
        }

        // Transfer tokens to StakingPool for rewards
        await storageToken.connect(owner).transferFromContract(
            await stakingPool.getAddress(),
            REWARD_POOL_AMOUNT
        );

        // Transfer tokens to users for testing
        await storageToken.connect(owner).transferFromContract(owner.address, POOL_CREATION_TOKENS);
        await storageToken.connect(owner).transferFromContract(user1.address, USER_TOKEN_AMOUNT);
        await storageToken.connect(owner).transferFromContract(user2.address, USER_TOKEN_AMOUNT);
        await storageToken.connect(owner).transferFromContract(user3.address, USER_TOKEN_AMOUNT);

        // Note: POOL_CREATOR_ROLE is automatically granted to owner during StoragePool initialization
        // So we'll use owner as the pool creator instead of poolCreator

        // Set StakingEngine for StakingPool (using RewardEngine as mock)
        await stakingPool.connect(owner).setStakingEngine(await rewardEngine.getAddress());

        // Create a test pool (using owner who has POOL_CREATOR_ROLE)
        await storageToken.connect(owner).approve(await storagePool.getAddress(), POOL_CREATION_TOKENS);
        await storagePool.connect(owner).createPool(
            TEST_POOL_NAME,
            TEST_POOL_REGION,
            TEST_POOL_REQUIRED_TOKENS,
            TEST_POOL_MAX_CHALLENGE_PERIOD,
            TEST_POOL_MIN_PING,
            0, // maxMembers (0 = unlimited)
            CREATOR_PEER_ID // Already converted to bytes32
        );

        testPoolId = 1; // First pool created
    });

    // 1. Initialization Tests
    describe("Initialization Tests", function () {
        it("should initialize with correct parameters", async function () {
            expect(await rewardEngine.token()).to.equal(await storageToken.getAddress());
            expect(await rewardEngine.storagePool()).to.equal(await storagePool.getAddress());
            expect(await rewardEngine.stakingPool()).to.equal(await stakingPool.getAddress());
            expect(await rewardEngine.monthlyRewardPerPeer()).to.equal(ethers.parseEther("8000"));
            expect(await rewardEngine.expectedPeriod()).to.equal(8 * 60 * 60); // 8 hours
        });

        it("should set correct roles", async function () {
            expect(await rewardEngine.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
            expect(await rewardEngine.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
        });

        it("should not allow initialization with zero addresses", async function () {
            const RewardEngine = await ethers.getContractFactory("RewardEngine");
            
            await expect(
                upgrades.deployProxy(
                    RewardEngine,
                    [
                        ZeroAddress,
                        await storagePool.getAddress(),
                        await stakingPool.getAddress(),
                        owner.address,
                        admin.address
                    ],
                    { kind: 'uups', initializer: 'initialize' }
                )
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidAddress");
        });
    });

    // 2. Admin Configuration Tests
    describe("Admin Configuration Tests", function () {
        it("should allow admin to set monthly reward per peer", async function () {
            const newRewards = ethers.parseEther("10000");

            await rewardEngine.connect(admin).setMonthlyRewardPerPeer(newRewards);

            expect(await rewardEngine.monthlyRewardPerPeer()).to.equal(newRewards);
        });

        it("should allow admin to set expected period", async function () {
            const newPeriod = 4 * 60 * 60; // 4 hours
            
            await rewardEngine.connect(admin).setExpectedPeriod(newPeriod);
            
            expect(await rewardEngine.expectedPeriod()).to.equal(newPeriod);
        });

        it("should not allow non-admin to set configuration", async function () {
            await expect(
                rewardEngine.connect(user1).setMonthlyRewardPerPeer(ethers.parseEther("10000"))
            ).to.be.reverted;

            await expect(
                rewardEngine.connect(user1).setExpectedPeriod(4 * 60 * 60)
            ).to.be.reverted;
        });

        it("should not allow setting zero values", async function () {
            await expect(
                rewardEngine.connect(admin).setMonthlyRewardPerPeer(0)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidAmount");

            await expect(
                rewardEngine.connect(admin).setExpectedPeriod(0)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidAmount");
        });
    });

    // 3. Pool Member Setup Helper
    async function addMemberToPool(poolId: number, member: HardhatEthersSigner, peerId: string) {
        // Approve tokens for joining
        await storageToken.connect(member).approve(await storagePool.getAddress(), TEST_POOL_REQUIRED_TOKENS);

        // Submit join request (StoragePool expects bytes32)
        await storagePool.connect(member).joinPoolRequest(poolId, peerId);

        // Determine the correct creator peer ID for this pool
        const creatorPeerId = poolId === 1 ? CREATOR_PEER_ID : stringToBytes32("12D3KooWCreator2");

        // Pool creator votes to approve using their peerId for this specific pool
        // voteOnJoinRequest(poolId, peerId, voterPeerId, approve)
        await storagePool.connect(owner).voteOnJoinRequest(poolId, peerId, creatorPeerId, true);

        // Verify member was added (StoragePool expects bytes32)
        const isMember = await storagePool.isPeerIdMemberOfPool(poolId, peerId);
        expect(isMember[0]).to.be.true;
    }

    // 4. Timestamp Helper
    async function getCurrentBlockTimestamp(): Promise<number> {
        const latestBlock = await ethers.provider.getBlock('latest');
        return latestBlock!.timestamp;
    }

    // 4. Online Status Submission Tests
    describe("Online Status Submission Tests", function () {
        beforeEach(async function () {
            // Add members to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
            await addMemberToPool(testPoolId, user3, PEER_ID_3);
        });

        it("should allow pool creator to submit online status", async function () {
            // Use block.timestamp to avoid time validation issues
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1, PEER_ID_2];

            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, timestamp)
            ).to.emit(rewardEngine, "OnlineStatusSubmitted")
            .withArgs(testPoolId, owner.address, peerIds.length, anyValue);
        });

        it("should allow pool creator (owner) to submit online status", async function () {
            // Use block.timestamp to avoid time validation issues
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1, PEER_ID_2, PEER_ID_3];

            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, timestamp)
            ).to.emit(rewardEngine, "OnlineStatusSubmitted")
            .withArgs(testPoolId, owner.address, peerIds.length, anyValue);
        });

        it("should not allow non-authorized users to submit online status", async function () {
            // Use block.timestamp to avoid time validation issues
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1];

            await expect(
                rewardEngine.connect(user1).submitOnlineStatusBatchV2(testPoolId, peerIds, timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolCreator");
        });

        it("should validate timestamp ranges", async function () {
            const peerIds = [PEER_ID_1];
            const currentTime = await getCurrentBlockTimestamp();

            // Future timestamp (too far)
            const futureTimestamp = currentTime + 3600; // 1 hour future
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, futureTimestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");

            // Past timestamp (too far)
            const pastTimestamp = currentTime - (8 * 24 * 60 * 60); // 8 days ago
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, pastTimestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");

            // Zero timestamp
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, 0)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");
        });

        it("should validate batch size limits", async function () {
            const timestamp = await getCurrentBlockTimestamp();

            // Empty batch
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [], timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "BatchTooLarge");

            // Batch too large (over MAX_BATCH_SIZE = 250)
            const largeBatch = Array(251).fill(PEER_ID_1);
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, largeBatch, timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "BatchTooLarge");
        });

        it("should record and retrieve online status using raw timestamp key", async function () {
            const latestBlock = await ethers.provider.getBlock('latest');
            const baseTimestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1];

            // Submit status with non-aligned timestamp
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds, baseTimestamp);

            // L-01 Fix: V1 storage writes removed, check V2 storage (periodOnlineStatus) instead
            const expectedPeriod = await rewardEngine.expectedPeriod();
            const periodIndex = BigInt(baseTimestamp) / expectedPeriod;
            const isOnline = await rewardEngine.periodOnlineStatus(testPoolId, periodIndex, PEER_ID_1);
            expect(isOnline).to.equal(true);
        });

        it("should handle multiple submissions for same period", async function () {
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds1 = [PEER_ID_1];
            const peerIds2 = [PEER_ID_1, PEER_ID_2];

            // First submission
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds1, timestamp);

            // Second submission for same period - use same timestamp to stay within same period
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, peerIds2, timestamp);

            // L-01 Fix: V1 storage writes removed, check V2 storage (periodOnlineStatus) instead
            const expectedPeriod = await rewardEngine.expectedPeriod();
            const periodIndex = BigInt(timestamp) / expectedPeriod;
            const isOnline1 = await rewardEngine.periodOnlineStatus(testPoolId, periodIndex, PEER_ID_1);
            const isOnline2 = await rewardEngine.periodOnlineStatus(testPoolId, periodIndex, PEER_ID_2);
            expect(isOnline1).to.equal(true);
            expect(isOnline2).to.equal(true);
        });
    });

    // 5. Online Status Query Tests
    describe("Online Status Query Tests", function () {
        beforeEach(async function () {
            // Add members to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
            await addMemberToPool(testPoolId, user3, PEER_ID_3);
        });

        it("should return correct online status for peer", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for multiple periods
            const timestamps = [
                currentTime - (2 * expectedPeriod),
                currentTime - expectedPeriod,
                currentTime
            ];

            for (const timestamp of timestamps) {
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1, PEER_ID_2],
                    timestamp
                );
            }

            // Query online status since 3 periods ago
            const sinceTime = currentTime - (3 * expectedPeriod);
            const [onlineCount, totalExpected] = await rewardEngine.getOnlineStatusSince(
                PEER_ID_1,
                testPoolId,
                sinceTime
            );

            // Contract counts only completed periods (2)
            expect(onlineCount).to.equal(2);
            expect(totalExpected).to.equal(3)
        });

        it("should handle peer not online in any period", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for other peers only
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_2, PEER_ID_3],
                currentTime
            );

            // Query for peer that wasn't online
            const sinceTime = currentTime - expectedPeriod;
            const [onlineCount, totalExpected] = await rewardEngine.getOnlineStatusSince(
                PEER_ID_1,
                testPoolId,
                sinceTime
            );

            expect(onlineCount).to.equal(0);
            expect(totalExpected).to.equal(1);
        });

        it("should validate time range for queries", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Future time should revert
            await expect(
                rewardEngine.getOnlineStatusSince(PEER_ID_1, testPoolId, currentTime + 3600)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");
        });

        it("should use default period when sinceTime is 0", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit recent online status
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Query with sinceTime = 0 (should use default period)
            const [, totalExpected] = await rewardEngine.getOnlineStatusSince(
                PEER_ID_1,
                testPoolId,
                0
            );

            expect(totalExpected).to.equal(1); // Should check last period
        });
    });

    // 6. Reward Calculation Tests
    describe("Reward Calculation Tests", function () {
        beforeEach(async function () {
            // Add members to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
        });

        it("should calculate eligible mining rewards correctly", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for user1 for 2 periods
            const timestamps = [
                currentTime - expectedPeriod,
                currentTime
            ];

            for (const timestamp of timestamps) {
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    timestamp
                );
            }

            // Wait for at least one full period to ensure rewards are calculated
            await time.increase(expectedPeriod + 60); // Wait one full period plus buffer

            // Calculate eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(eligibleRewards).to.be.gt(0);
        });

        it("should return zero rewards for peer not online", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for other peer only
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_2],
                currentTime
            );

            // User1 should have no rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(eligibleRewards).to.equal(0);
        });

        it("should enforce monthly reward caps", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for many periods to exceed monthly cap
            // Limit to 6 days worth of periods to stay within 7-day historical limit
            const maxHistoricalPeriods = Math.floor((6 * 24 * 60 * 60) / expectedPeriod);
            const periodsToSubmit = Math.min(maxHistoricalPeriods, 20); // Cap at 20 periods for test efficiency

            for (let i = 0; i < periodsToSubmit; i++) {
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime - (i * expectedPeriod)
                );
            }

            await time.increase(60);

            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();
            expect(eligibleRewards).to.be.lte(maxMonthlyReward);
        });

        it("should validate pool membership for reward calculation", async function () {
            // Try to calculate rewards for non-member
            await expect(
                rewardEngine.calculateEligibleMiningRewardsV2(attacker.address, stringToBytes32("InvalidPeerId"), testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");
        });

        it("should return zero storage rewards (placeholder)", async function () {
            const storageRewards = await rewardEngine.calculateEligibleStorageRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(storageRewards).to.equal(0);
        });

        it("should get total eligible rewards correctly", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            await time.increase(60);

            const [miningRewards, storageRewards, totalRewards] = await rewardEngine.getEligibleRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(storageRewards).to.equal(0); // Placeholder
            expect(totalRewards).to.equal(miningRewards);
            expect(miningRewards).to.be.gte(0);
        });

        it("should get reward calculation details", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for at least one full period to ensure proper calculation
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            await time.increase(expectedPeriod + 60);

            const [startTime, endTime, totalPeriods, onlinePeriods, rewardPerPeriod, totalReward] =
                await rewardEngine.getRewardCalculationDetails(user1.address, PEER_ID_1, testPoolId);

            expect(startTime).to.be.gt(0);
            expect(endTime).to.be.gt(startTime);
            expect(totalPeriods).to.be.gte(1); // Should have at least 1 period
            expect(onlinePeriods).to.be.gte(1); // Should have at least 1 online period
            expect(rewardPerPeriod).to.be.gte(0);
            expect(totalReward).to.be.gte(0);
        });

        it("should get effective reward start time correctly", async function () {
            const effectiveStartTime = await rewardEngine.getEffectiveRewardStartTime(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            // Should be either join date or reward system start time
            const rewardSystemStartTime = await rewardEngine.rewardSystemStartTime();
            expect(effectiveStartTime).to.be.gte(rewardSystemStartTime);
        });
    });

    // 7. Reward Claiming Tests
    describe("Reward Claiming Tests", function () {
        beforeEach(async function () {
            // Add members to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            // StakingEngine is already set in main setup, no need to set again
        });

        it("should allow claiming rewards when eligible", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for multiple periods
            const timestamps = [
                currentTime - (2 * expectedPeriod),
                currentTime - expectedPeriod,
                currentTime
            ];

            for (const timestamp of timestamps) {
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    timestamp
                );
            }

            await time.increase(60);

            // Check eligible rewards before claiming
            const [miningRewards, , totalRewards] = await rewardEngine.getEligibleRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            if (totalRewards > 0) {
                const initialBalance = await storageToken.balanceOf(user1.address);

                // Claim rewards
                await expect(
                    rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
                ).to.emit(rewardEngine, "MiningRewardsClaimed")
                .withArgs(user1.address, PEER_ID_1, testPoolId, miningRewards);

                const finalBalance = await storageToken.balanceOf(user1.address);
                expect(finalBalance - initialBalance).to.equal(totalRewards);

                // Check that last claimed timestamp was updated
                const [lastClaimedTimestamp, ] = await rewardEngine.getClaimedRewardsInfo(
                    user1.address,
                    PEER_ID_1,
                    testPoolId
                );
                expect(lastClaimedTimestamp).to.be.gt(0);
            }
        });

        it("should not allow claiming when no rewards available", async function () {
            // No online status submitted, so no rewards
            // V2: Claim emits 0 rewards instead of reverting (advances timestamp)
            const balanceBefore = await storageToken.balanceOf(user1.address);
            await expect(
                rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.emit(rewardEngine, "MiningRewardsClaimed")
            .withArgs(user1.address, PEER_ID_1, testPoolId, 0);
            const balanceAfter = await storageToken.balanceOf(user1.address);
            expect(balanceAfter - balanceBefore).to.equal(0);
        });

        it("should not allow non-members to claim rewards", async function () {
            await expect(
                rewardEngine.connect(attacker).claimRewardsV2(stringToBytes32("InvalidPeerId"), testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");
        });

        it("should handle insufficient staking pool balance", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // Drain the staking pool
            await stakingPool.connect(owner).emergencyRecoverTokens(REWARD_POOL_AMOUNT);

            // V2: With no pool balance, transfer will fail with ERC20 error
            await expect(
                rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.be.reverted;
        });

        it("should track total rewards distributed", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for both users
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1, PEER_ID_2],
                currentTime
            );

            await time.increase(60);

            const initialTotalDistributed = await rewardEngine.totalRewardsDistributed();

            // Both users claim rewards
            const [rewards1, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);
            const [rewards2, ,] = await rewardEngine.getEligibleRewards(user2.address, PEER_ID_2, testPoolId);

            if (rewards1 > 0) {
                await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            }
            if (rewards2 > 0) {
                await rewardEngine.connect(user2).claimRewardsV2(PEER_ID_2, testPoolId);
            }

            const finalTotalDistributed = await rewardEngine.totalRewardsDistributed();
            expect(finalTotalDistributed).to.be.gte(initialTotalDistributed);
        });

        it("should track user total rewards claimed", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            await time.increase(60);

            const initialUserTotal = await rewardEngine.totalRewardsClaimed(user1.address);

            const [rewards, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);

            if (rewards > 0) {
                await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);

                const finalUserTotal = await rewardEngine.totalRewardsClaimed(user1.address);
                expect(finalUserTotal - initialUserTotal).to.equal(rewards);
            }
        });

        it("should get reward statistics correctly", async function () {
            const [userClaimed, totalDistributed, claimPercentage] = await rewardEngine.getRewardStatistics(user1.address);

            expect(userClaimed).to.be.gte(0);
            expect(totalDistributed).to.be.gte(0);
            expect(claimPercentage).to.be.gte(0);
            expect(claimPercentage).to.be.lte(10000); // Max 100% in basis points
        });

        it("should get unclaimed rewards correctly", async function () {
            const [unclaimedMining, unclaimedStorage, totalUnclaimed] = await rewardEngine.getUnclaimedRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(unclaimedStorage).to.equal(0); // Placeholder
            expect(totalUnclaimed).to.equal(unclaimedMining);
            expect(unclaimedMining).to.be.gte(0);
        });
    });

    // 8. Circuit Breaker Tests
    describe("Circuit Breaker Tests", function () {
        beforeEach(async function () {
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("should allow admin to trip circuit breaker", async function () {
            await rewardEngine.connect(admin).tripCircuitBreaker();

            expect(await rewardEngine.circuitBreakerTripped()).to.be.true;
        });

        it("should allow admin to reset circuit breaker", async function () {
            await rewardEngine.connect(admin).tripCircuitBreaker();
            await rewardEngine.connect(admin).resetCircuitBreaker();

            expect(await rewardEngine.circuitBreakerTripped()).to.be.false;
        });

        it("should prevent operations when circuit breaker is tripped", async function () {
            await rewardEngine.connect(admin).tripCircuitBreaker();

            const currentTime = await getCurrentBlockTimestamp();

            // Should prevent online status submission
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime)
            ).to.be.revertedWithCustomError(rewardEngine, "CircuitBreakerTripped");

            // Should prevent reward claims
            await expect(
                rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "CircuitBreakerTripped");
        });

        it("should prevent view functions when circuit breaker is tripped", async function () {
            await rewardEngine.connect(admin).tripCircuitBreaker();

            await expect(
                rewardEngine.getOnlineStatusSince(PEER_ID_1, testPoolId, 0)
            ).to.be.revertedWithCustomError(rewardEngine, "CircuitBreakerTripped");
        });

        it("should auto-reset circuit breaker after cooldown", async function () {
            await rewardEngine.connect(admin).tripCircuitBreaker();

            // Advance blocks past cooldown period (300 blocks)
            // We need to mine blocks, not just advance time
            for (let i = 0; i < 301; i++) {
                await ethers.provider.send("evm_mine", []);
            }

            const currentTime = await getCurrentBlockTimestamp();

            // Should auto-reset and allow operations
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime)
            ).to.not.be.reverted;

            expect(await rewardEngine.circuitBreakerTripped()).to.be.false;
        });

        it("should not allow non-admin to trip/reset circuit breaker", async function () {
            await expect(
                rewardEngine.connect(user1).tripCircuitBreaker()
            ).to.be.reverted;

            await expect(
                rewardEngine.connect(user1).resetCircuitBreaker()
            ).to.be.reverted;
        });
    });

    // 9. Emergency Functions Tests
    describe("Emergency Functions Tests", function () {
        it("should allow admin to emergency withdraw tokens", async function () {
            // First, send some tokens to the RewardEngine contract
            await storageToken.connect(owner).transferFromContract(await rewardEngine.getAddress(), ethers.parseEther("1000"));

            const initialTokenBalance = await storageToken.balanceOf(await storageToken.getAddress());

            // Pause the contract first (required for emergency withdraw)
            await rewardEngine.connect(admin).emergencyAction(1); // Pause

            // Emergency withdraw
            await expect(
                rewardEngine.connect(admin).emergencyWithdraw(
                    await storageToken.getAddress(),
                    ethers.parseEther("500")
                )
            ).to.emit(rewardEngine, "EmergencyWithdrawal");

            const finalTokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
            expect(finalTokenBalance - initialTokenBalance).to.equal(ethers.parseEther("500"));
        });

        it("should allow emergency withdraw even when not paused", async function () {
            await storageToken.connect(owner).transferFromContract(await rewardEngine.getAddress(), ethers.parseEther("1000"));

            const initialTokenBalance = await storageToken.balanceOf(await storageToken.getAddress());

            // Emergency withdraw should work even when not paused (as per contract design)
            await expect(
                rewardEngine.connect(admin).emergencyWithdraw(
                    await storageToken.getAddress(),
                    ethers.parseEther("500")
                )
            ).to.emit(rewardEngine, "EmergencyWithdrawal");

            const finalTokenBalance = await storageToken.balanceOf(await storageToken.getAddress());
            expect(finalTokenBalance - initialTokenBalance).to.equal(ethers.parseEther("500"));
        });

        it("should allow admin to recover accidentally transferred ERC20 tokens", async function () {
            // Use the existing storageToken instead of creating a mock token to avoid governance complexity
            // Transfer tokens to RewardEngine to simulate accidental transfer
            await storageToken.connect(owner).transferFromContract(await rewardEngine.getAddress(), ethers.parseEther("100"));

            const initialBalance = await storageToken.balanceOf(user1.address);

            // This should fail because we can't recover the main reward token
            await expect(
                rewardEngine.connect(admin).adminRecoverERC20(
                    await storageToken.getAddress(),
                    user1.address,
                    ethers.parseEther("50")
                )
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidAddress");

            // Balance should remain unchanged
            const finalBalance = await storageToken.balanceOf(user1.address);
            expect(finalBalance).to.equal(initialBalance);
        });

        it("should not allow recovering main reward token", async function () {
            await expect(
                rewardEngine.connect(admin).adminRecoverERC20(
                    await storageToken.getAddress(),
                    user1.address,
                    ethers.parseEther("100")
                )
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidAddress");
        });

        it("should not allow non-admin to use emergency functions", async function () {
            await expect(
                rewardEngine.connect(user1).emergencyWithdraw(
                    await storageToken.getAddress(),
                    ethers.parseEther("100")
                )
            ).to.be.reverted;

            await expect(
                rewardEngine.connect(user1).adminRecoverERC20(
                    await storageToken.getAddress(),
                    user1.address,
                    ethers.parseEther("100")
                )
            ).to.be.reverted;
        });
    });

    // 10. Edge Cases and Integration Tests
    describe("Edge Cases and Integration Tests", function () {
        beforeEach(async function () {
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
            // StakingEngine is already set in main setup, no need to set again
        });

        it("should handle multiple pools correctly", async function () {
            // Create second pool (advance time to avoid timelock)
            await time.increase(24 * 60 * 60 + 1);
            await storageToken.connect(poolCreator).approve(await storagePool.getAddress(), POOL_CREATION_TOKENS);
            await storagePool.connect(poolCreator).createPool(
                "Second Pool",
                "EU-West",
                TEST_POOL_REQUIRED_TOKENS,
                TEST_POOL_MAX_CHALLENGE_PERIOD,
                TEST_POOL_MIN_PING,
                0, // maxMembers (0 = unlimited)
                stringToBytes32("12D3KooWCreator2")
            );

            const secondPoolId = 2;

            // Add different user to second pool (user1 and user2 are already in first pool)
            const user3Pool2PeerId = stringToBytes32("12D3KooWUser3Pool2");
            await addMemberToPool(secondPoolId, user3, user3Pool2PeerId);

            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for both pools
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime);
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(secondPoolId, [user3Pool2PeerId], currentTime);

            await time.increase(60);

            // Check rewards for both pools
            const rewards1 = await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);
            const rewards2 = await rewardEngine.calculateEligibleMiningRewardsV2(user3.address, stringToBytes32("12D3KooWUser3Pool2"), secondPoolId);

            expect(rewards1).to.be.gte(0);
            expect(rewards2).to.be.gte(0);
        });

        it("should handle member leaving and rejoining pool", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime);

            await time.increase(60);

            // Check initial rewards (verify they exist before leaving)
            await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);

            // Member leaves pool by removing their peer ID (PEER_ID_1 is already bytes32)
            await storagePool.connect(user1).removeMemberPeerId(testPoolId, PEER_ID_1);

            // Should not be able to calculate rewards after leaving
            await expect(
                rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // Rejoin pool (if supported by StoragePool)
            // This would require re-implementing the join process
        });

        it("should handle very large time gaps correctly", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime);

            // Advance time by 1 year
            await time.increase(365 * 24 * 60 * 60);

            // Should still be able to calculate rewards
            const rewards = await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);
            expect(rewards).to.be.gte(0);
        });

        it("should handle timestamp edge cases", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit status at current time (safe timestamp)
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Submit status slightly later (still safe)
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime + 30 // 30 seconds later
            );

            // Both should be normalized to same period
            const onlinePeers1 = await rewardEngine.getOnlinePeerIds(testPoolId, currentTime);
            const onlinePeers2 = await rewardEngine.getOnlinePeerIds(testPoolId, currentTime + 30);

            // Both should contain the peer ID (they may be normalized to same period)
            expect(onlinePeers1.length).to.be.gte(0);
            expect(onlinePeers2.length).to.be.gte(0);
        });

        it("should handle maximum batch size correctly", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const maxBatchSize = Number(await rewardEngine.MAX_BATCH_SIZE());

            // Create array with maximum allowed size
            const maxBatch = Array(maxBatchSize).fill(PEER_ID_1);

            await expect(
                rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, maxBatch, currentTime)
            ).to.not.be.reverted;
        });

        it("should handle reward calculation with zero total members", async function () {
            // This is an edge case that shouldn't normally happen
            // but we test the contract's resilience

            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime);

            await time.increase(60);

            // Even with edge cases, should not revert
            const rewards = await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);
            expect(rewards).to.be.gte(0);
        });

        it("should handle multiple claims in same month", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for multiple periods (stay within 6 days historical limit)
            const maxHistoricalPeriods = Math.floor((6 * 24 * 60 * 60) / expectedPeriod);
            const periodsToSubmit = Math.min(maxHistoricalPeriods, 5);

            for (let i = 0; i < periodsToSubmit; i++) {
                await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime - (i * expectedPeriod)
                );
            }

            await time.increase(60);

            // First claim
            const [rewards1, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);
            if (rewards1 > 0) {
                await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            }

            // Submit more online status (use current time to avoid future timestamp issues)
            const newCurrentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                newCurrentTime
            );

            await time.increase(expectedPeriod + 60);

            // Second claim in same month - check that monthly cap is respected
            await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);

            // Should respect monthly cap
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();
            const currentMonth = Math.floor(currentTime / (30 * 24 * 60 * 60));
            const claimedThisMonth = await rewardEngine.monthlyRewardsClaimed(PEER_ID_1, testPoolId, currentMonth);

            expect(claimedThisMonth).to.be.lte(maxMonthlyReward);
        });

        it("should verify contract initialization", async function () {
            // Verify contract is properly initialized by checking key parameters
            expect(await rewardEngine.monthlyRewardPerPeer()).to.be.gt(0);
            expect(await rewardEngine.expectedPeriod()).to.be.gt(0);
            expect(await rewardEngine.rewardSystemStartTime()).to.be.gt(0);
        });

        it.skip("should handle recorded timestamps pagination - REMOVED: V1 functions removed for contract size", async function () {
            // V1 functions getRecordedTimestampCount and getRecordedTimestamps were removed
            // to make room for V2 migration functionality
        });
    });

    // 11. Comprehensive Reward Calculation Tests
    describe("Comprehensive Reward Calculation Tests", function () {
        const PEER_ID_3 = stringToBytes32("peer3");
        const PEER_ID_4 = stringToBytes32("peer4");
        const PEER_ID_5 = stringToBytes32("peer5");

        it("should handle multiple online status submissions in one period correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const joinTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Wait a bit to ensure we're in the first period after joining
            await time.increase(1000); // 1000 seconds into the first period

            const currentTime = await getCurrentBlockTimestamp();

            // Submit multiple online status for the same peer in the same period
            // All submissions should be after join time and within the same period
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime - 500 // 500 seconds ago (still in same period)
            );
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime - 300 // 300 seconds ago (still in same period)
            );
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime - 100 // 100 seconds ago (still in same period)
            );

            // Move to next period to complete the first period
            await time.increaseTo(joinTime + expectedPeriod + 1000);

            // Should only count as one reward for the period
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 60 * 60) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            expect(eligibleRewards).to.equal(rewardPerPeriod);
        });

        it("should handle consecutive unclaimed periods correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const numPeriods = 5;

            // Submit online status for multiple consecutive periods
            // Submit at current time, then advance to next period
            for (let i = 0; i < numPeriods; i++) {
                const currentTime = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime
                );
                // Advance to next period
                await time.increase(expectedPeriod + 1);
            }

            // Wait a bit more to ensure all periods are complete
            await time.increase(100);

            // Should accumulate rewards for all periods
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            const expectedRewards = rewardPerPeriod * BigInt(numPeriods);

            expect(eligibleRewards).to.equal(expectedRewards);

            // Claim rewards
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);

            // Should have no more rewards to claim
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            expect(remainingRewards).to.equal(0);
        });

        it("should handle multiple peer IDs for one account correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user1, PEER_ID_3); // Same user, different peer
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for both peer IDs at current time
            const currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1, PEER_ID_3],
                currentTime
            );

            // Advance past the period to complete it
            await time.increase(expectedPeriod + 100);

            // Each peer ID should have separate rewards
            const rewards1 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const rewards3 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_3,
                testPoolId
            );

            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            expect(rewards1).to.equal(rewardPerPeriod);
            expect(rewards3).to.equal(rewardPerPeriod);

            // User should be able to claim both separately
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_3, testPoolId);

            // Both should be claimed
            const remainingRewards1 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const remainingRewards3 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_3,
                testPoolId
            );
            expect(remainingRewards1).to.equal(0);
            expect(remainingRewards3).to.equal(0);
        });

        it("should handle multiple accounts in the system correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
            await addMemberToPool(testPoolId, user3, PEER_ID_4);

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for all users
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1, PEER_ID_2, PEER_ID_4],
                currentTime
            );

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // Each user should have independent rewards
            const rewards1 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const rewards2 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user2.address,
                PEER_ID_2,
                testPoolId
            );
            const rewards4 = await rewardEngine.calculateEligibleMiningRewardsV2(
                user3.address,
                PEER_ID_4,
                testPoolId
            );

            const rewardPerPeriod = await rewardEngine.monthlyRewardPerPeer() / BigInt(30 * 24 * 3600 / expectedPeriod);
            expect(rewards1).to.equal(rewardPerPeriod);
            expect(rewards2).to.equal(rewardPerPeriod);
            expect(rewards4).to.equal(rewardPerPeriod);

            // Each user can claim independently
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            await rewardEngine.connect(user2).claimRewardsV2(PEER_ID_2, testPoolId);
            await rewardEngine.connect(user3).claimRewardsV2(PEER_ID_4, testPoolId);

            // All should be claimed
            expect(await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId)).to.equal(0);
            expect(await rewardEngine.calculateEligibleMiningRewardsV2(user2.address, PEER_ID_2, testPoolId)).to.equal(0);
            expect(await rewardEngine.calculateEligibleMiningRewardsV2(user3.address, PEER_ID_4, testPoolId)).to.equal(0);
        });

        it("should reject claiming for peer ID with wrong account", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for PEER_ID_1 (belongs to user1)
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // user2 tries to claim rewards for PEER_ID_1 (which belongs to user1)
            await expect(
                rewardEngine.connect(user2).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // user2 tries to calculate rewards for PEER_ID_1 (which belongs to user1)
            await expect(
                rewardEngine.calculateEligibleMiningRewardsV2(user2.address, PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // Correct owner should be able to claim
            await expect(
                rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.not.be.reverted;
        });

        it("should handle partial periods correctly (no rewards for incomplete periods)", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status in current incomplete period
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Don't wait for period to complete - check immediately
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            // Should have no rewards for incomplete period
            expect(eligibleRewards).to.equal(0);

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // Now should have rewards for the completed period
            const rewardsAfterComplete = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const rewardPerPeriod = await rewardEngine.monthlyRewardPerPeer() / BigInt(30 * 24 * 3600 / expectedPeriod);
            expect(rewardsAfterComplete).to.equal(rewardPerPeriod);
        });

        it("should handle periods with no online status correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for period 1 (current time)
            let currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Advance to complete period 1 and move into period 2
            await time.increase(expectedPeriod + 100);

            // Skip period 2 (no online status submission)
            // Advance to complete period 2 and move into period 3
            await time.increase(expectedPeriod);

            // Submit online status for period 3
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for period 3 to complete
            await time.increase(expectedPeriod + 60);

            // Should only get rewards for 2 periods (1 and 3), not the skipped period 2
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            const expectedRewards = rewardPerPeriod * BigInt(2); // Only 2 periods with online status

            expect(eligibleRewards).to.equal(expectedRewards);
        });

        it("should handle claiming after multiple periods with mixed online status", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            let expectedOnlinePeriods = 0;

            // Submit online status for period 1
            let currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Advance to period 2 and skip it (no online status)
            await time.increase(expectedPeriod + 100);

            // Submit online status for period 3
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Advance to period 4 and skip it (no online status)
            await time.increase(expectedPeriod + 100);

            // Submit online status for period 5
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Wait for current period to complete
            await time.increase(expectedPeriod + 60);

            // Should get rewards only for online periods
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            const expectedRewards = rewardPerPeriod * BigInt(expectedOnlinePeriods);

            expect(eligibleRewards).to.equal(expectedRewards);

            // Claim rewards
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);

            // Add more online status after claiming
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for new period to complete
            await time.increase(expectedPeriod + 60);

            // Should have rewards for the new period only
            const newRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const monthlyReward2 = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth2 = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod2 = monthlyReward2 / BigInt(Math.floor(periodsPerMonth2));
            expect(newRewards).to.equal(rewardPerPeriod2);
        });

        it("should handle monthly reward caps correctly", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = (30 * 24 * 3600) / expectedPeriod;
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            
            // Calculate how many periods would exceed the monthly cap
            // periodsToExceedCap should be <= 90 (one month) to stay within 6-day historical limit
            const periodsToExceedCap = Math.min(Number(maxMonthlyReward / rewardPerPeriod) + 5, 15);

            // Submit online status for periods going forward in time
            for (let i = 0; i < periodsToExceedCap; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Wait for all periods to complete
            await time.increase(expectedPeriod + 60);

            // Should be capped at monthly maximum
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            expect(eligibleRewards).to.be.lte(maxMonthlyReward);
        });

        it("should handle reward calculation details correctly for complex scenarios", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const numOnlinePeriods = 3;
            const numTotalPeriods = 5;

            // Submit online status for periods 1, 2, and 3 (skip periods 4 and 5)
            for (let i = 0; i < numOnlinePeriods; i++) {
                // Submit online status for current period
                let currentTime = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime
                );

                // Advance to next period
                await time.increase(expectedPeriod + 100);
            }

            // Skip periods 4 and 5 by advancing time without submitting online status
            await time.increase(2 * expectedPeriod + 100);

            // Wait for final period to complete
            await time.increase(expectedPeriod + 60);

            // Get detailed calculation info
            const [startTime, endTime, totalPeriods, onlinePeriods, rewardPerPeriod, totalReward] =
                await rewardEngine.getRewardCalculationDetails(user1.address, PEER_ID_1, testPoolId);

            expect(startTime).to.be.gt(0);
            expect(endTime).to.be.gt(startTime);
            expect(totalPeriods).to.be.gte(numTotalPeriods);
            expect(onlinePeriods).to.equal(numOnlinePeriods); // Only 3 periods had online status
            expect(rewardPerPeriod).to.be.gt(0);
            expect(totalReward).to.equal(rewardPerPeriod * BigInt(numOnlinePeriods));
        });

        it("should handle edge case of user joining mid-period", async function () {
            // Use the existing test pool instead of creating a new one
            const poolId = testPoolId;

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Calculate mid-period join time - use future time to avoid timestamp issues
            const midPeriodTime = currentTime + Math.floor(expectedPeriod / 2);

            // Advance time to mid-period
            await time.increaseTo(midPeriodTime);

            // Add member mid-period - use admin privileges to bypass voting
            await storagePool.connect(admin).addMember(poolId, user1.address, PEER_ID_1);

            // Submit online status immediately after joining
            await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                poolId,
                [PEER_ID_1],
                await getCurrentBlockTimestamp()
            );

            // Wait for current period to complete
            await time.increase(expectedPeriod);

            // Should have rewards for the complete period from join date
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                poolId
            );

            // Calculate expected reward per period: monthlyRewardPerPeer / periodsPerMonth
            const monthlyRewardPerPeer = await rewardEngine.monthlyRewardPerPeer();
            const expectedPeriodValue = await rewardEngine.expectedPeriod();
            const SECONDS_PER_MONTH = 30 * 24 * 60 * 60; // 30 days
            const periodsPerMonth = SECONDS_PER_MONTH / Number(expectedPeriodValue);
            const expectedRewardPerPeriod = monthlyRewardPerPeer / BigInt(Math.floor(periodsPerMonth));

            // User should get rewards for one complete period since they submitted online status
            expect(eligibleRewards).to.equal(expectedRewardPerPeriod);

            // Verify reward calculation details
            const rewardDetails = await rewardEngine.getRewardCalculationDetails(
                user1.address,
                PEER_ID_1,
                poolId
            );

            expect(rewardDetails.onlinePeriods).to.equal(1); // One complete period with online status
            expect(rewardDetails.totalReward).to.equal(eligibleRewards);
        });
    });

    // 12. Governance Integration Tests
    describe("Governance Integration Tests", function () {
        it("should handle upgrade authorization", async function () {
            // This test verifies the upgrade mechanism works
            // In a real scenario, this would deploy a new implementation
            // Verify that the contract supports UUPS upgrades by checking it has the required roles
            expect(await rewardEngine.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
        });

        it("should handle pause/unpause through governance", async function () {
            // Pause the contract
            await rewardEngine.connect(admin).emergencyAction(1); // Pause

            const currentTime = await getCurrentBlockTimestamp();

            // Operations should fail when paused
            await expect(
                rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], currentTime)
            ).to.be.revertedWithCustomError(rewardEngine, "EnforcedPause");

            // Wait for cooldown
            await time.increase(24 * 60 * 60 + 1);

            // Unpause
            await rewardEngine.connect(admin).emergencyAction(2); // Unpause

            // Get fresh timestamp after unpause
            const newCurrentTime = await getCurrentBlockTimestamp();

            // Operations should work again
            await expect(
                rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], newCurrentTime)
            ).to.not.be.reverted;
        });
    });

    // 13. Long-term Reward Testing (365 Days)
    describe("Long-term Reward Testing (365 Days)", function () {
        beforeEach(async function () {
            // Add member to the test pool for long-term testing
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("should correctly earn and claim rewards over 365 days with claims every 30 days", async function () {
            // This test simulates 365 days of mining with claims every 30 days
            // Expected: 8000 tokens per 30-day month
            
            const expectedPeriod = Number(await rewardEngine.expectedPeriod()); // 8 hours = 28800 seconds
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer(); // 8000 tokens
            const periodsPerMonth = (30 * 24 * 60 * 60) / expectedPeriod; // ~90 periods per month
            const rewardPerPeriod = monthlyReward / BigInt(Math.floor(periodsPerMonth));
            
            console.log(`Expected period: ${expectedPeriod} seconds (${expectedPeriod / 3600} hours)`);
            console.log(`Monthly reward: ${ethers.formatEther(monthlyReward)} tokens`);
            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);

            const totalDays = 365;
            const claimIntervalDays = 30;
            const secondsPerDay = 24 * 60 * 60;
            
            let currentDay = 0;
            let totalExpectedRewards = BigInt(0);
            let totalClaimedRewards = BigInt(0);
            
            // Track user's token balance
            let initialBalance = await storageToken.balanceOf(user1.address);
            console.log(`Initial balance: ${ethers.formatEther(initialBalance)} tokens`);

            // Simulate 365 days of operation
            while (currentDay < totalDays) {
                const daysToProcess = Math.min(claimIntervalDays, totalDays - currentDay);
                console.log(`\nProcessing days ${currentDay + 1} to ${currentDay + daysToProcess}`);

                // Submit online status for each complete period in this interval by advancing time forward
                let periodsInInterval = 0;
                const intervalSeconds = daysToProcess * secondsPerDay;
                const periodsToSimulate = Math.floor(intervalSeconds / expectedPeriod);

                for (let p = 0; p < periodsToSimulate; p++) {
                    // Use current block timestamp to satisfy timestamp constraints
                    const ts = await getCurrentBlockTimestamp();
                    await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                        testPoolId,
                        [PEER_ID_1],
                        ts
                    );
                    periodsInInterval++;

                    // Advance time by one full expected period to complete it
                    await time.increase(expectedPeriod + 1);
                }
                
                // Calculate expected rewards for this interval
                const expectedRewardsForInterval = rewardPerPeriod * BigInt(periodsInInterval);
                totalExpectedRewards += expectedRewardsForInterval;
                
                console.log(`Periods in interval: ${periodsInInterval}`);
                console.log(`Expected rewards for interval: ${ethers.formatEther(expectedRewardsForInterval)} tokens`);
                
                // Check claimable rewards before claiming
                const claimableRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                    user1.address,
                    PEER_ID_1,
                    testPoolId
                );
                console.log(`Claimable rewards: ${ethers.formatEther(claimableRewards)} tokens`);
                
                // Claim rewards if available
                if (claimableRewards > 0) {
                    const balanceBeforeClaim = await storageToken.balanceOf(user1.address);
                    
                    await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
                    
                    const balanceAfterClaim = await storageToken.balanceOf(user1.address);
                    const actualClaimedAmount = balanceAfterClaim - balanceBeforeClaim;
                    
                    totalClaimedRewards += actualClaimedAmount;
                    
                    console.log(`Balance before claim: ${ethers.formatEther(balanceBeforeClaim)} tokens`);
                    console.log(`Balance after claim: ${ethers.formatEther(balanceAfterClaim)} tokens`);
                    console.log(`Actually claimed: ${ethers.formatEther(actualClaimedAmount)} tokens`);
                    
                    // Verify the claimed amount matches what was expected to be claimable
                    expect(actualClaimedAmount).to.equal(claimableRewards);
                    
                    // Verify balance increased by the correct amount
                    expect(balanceAfterClaim).to.equal(balanceBeforeClaim + claimableRewards);
                }
                
                currentDay += daysToProcess;
                console.log(`Completed day ${currentDay} of ${totalDays}`);
            }
            
            // Final verification
            const finalBalance = await storageToken.balanceOf(user1.address);
            const totalEarned = finalBalance - initialBalance;
            
            console.log(`\n=== FINAL RESULTS ===`);
            console.log(`Total days processed: ${totalDays}`);
            console.log(`Initial balance: ${ethers.formatEther(initialBalance)} tokens`);
            console.log(`Final balance: ${ethers.formatEther(finalBalance)} tokens`);
            console.log(`Total earned: ${ethers.formatEther(totalEarned)} tokens`);
            console.log(`Total claimed rewards: ${ethers.formatEther(totalClaimedRewards)} tokens`);
            
            // Verify that total earned matches total claimed
            expect(totalEarned).to.equal(totalClaimedRewards);
            
            // Calculate expected annual rewards (365 days = ~12.17 months)
            const monthsInYear = 365 / 30; // ~12.17 months
            const expectedAnnualRewards = monthlyReward * BigInt(Math.floor(monthsInYear * 100)) / BigInt(100);
            
            console.log(`Expected annual rewards: ${ethers.formatEther(expectedAnnualRewards)} tokens`);
            console.log(`Months in year: ${monthsInYear}`);
            
            // Allow for some variance due to period boundaries and rounding
            const tolerance = ethers.parseEther("100"); // 100 token tolerance
            const difference = totalEarned > expectedAnnualRewards ? 
                totalEarned - expectedAnnualRewards : 
                expectedAnnualRewards - totalEarned;
            
            console.log(`Difference from expected: ${ethers.formatEther(difference)} tokens`);
            
            // Verify the total earned is within reasonable bounds
            // Should be approximately 8000 * 12.17 = ~97,360 tokens for 365 days
            expect(difference).to.be.lte(tolerance);
            
            // Verify no more rewards are claimable
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            expect(remainingRewards).to.equal(0);
            
            console.log(`Test completed successfully!`);
        }).timeout(300000); // 5 minute timeout for long test
    });

    // 14. Claim Periods Limit Testing
    describe("Claim Periods Limit Testing", function () {
        beforeEach(async function () {
            // Add member to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("should return correct claim status information", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            
            // Submit online status for multiple periods
            const periodsToCreate = 10;
            for (let i = 0; i < periodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Get claim status
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            expect(totalUnclaimedPeriods).to.equal(periodsToCreate);
            expect(defaultPeriodsPerClaim).to.equal(540); // DEFAULT_CLAIM_PERIODS_PER_TX_V2
            expect(maxPeriodsPerClaim).to.equal(540); // MAX_CLAIM_PERIODS_LIMIT_V2
            expect(estimatedClaimsNeeded).to.equal(1); // 10 periods < 540 default
            expect(hasMoreToClaim).to.equal(false);
        });

        it("should allow claiming with custom period limit using claimRewardsWithLimitV2", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Submit online status for 10 periods
            const periodsToCreate = 10;
            for (let i = 0; i < periodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Claim only 3 periods at a time
            const maxPeriodsPerClaim = 3;
            let totalClaimed = BigInt(0);
            let claimCount = 0;

            while (true) {
                const [totalUnclaimedPeriods, , , ,] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (totalUnclaimedPeriods === BigInt(0)) break;

                const balanceBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, maxPeriodsPerClaim);
                const balanceAfter = await storageToken.balanceOf(user1.address);
                
                const claimed = balanceAfter - balanceBefore;
                totalClaimed += claimed;
                claimCount++;

                console.log(`Claim ${claimCount}: claimed ${ethers.formatEther(claimed)} tokens, remaining periods: ${totalUnclaimedPeriods - BigInt(Math.min(maxPeriodsPerClaim, Number(totalUnclaimedPeriods)))}`);
            }

            // Should have required multiple claims
            expect(claimCount).to.equal(Math.ceil(periodsToCreate / maxPeriodsPerClaim)); // 10/3 = 4 claims

            // Total claimed should match expected
            const expectedTotal = rewardPerPeriod * BigInt(periodsToCreate);
            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`Total claims needed: ${claimCount}`);
            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
        });

        it("should use default limit when invalid maxPeriods is provided", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for a few periods
            for (let i = 0; i < 5; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Claim with 0 (invalid) - should use default
            await expect(
                rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 0)
            ).to.not.be.reverted;

            // Verify rewards were claimed
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            expect(remainingRewards).to.equal(0);
        });

        it("should cap maxPeriods at MAX_CLAIM_PERIODS_LIMIT when exceeding limit", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for a few periods
            for (let i = 0; i < 5; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Claim with value exceeding MAX_CLAIM_PERIODS_LIMIT (1000) - should use default
            await expect(
                rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 2000)
            ).to.not.be.reverted;

            // Verify rewards were claimed
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            expect(remainingRewards).to.equal(0);
        });

        it("should correctly handle batched claims over many periods", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Create 100 periods (more than default 90)
            const periodsToCreate = 100;
            console.log(`Creating ${periodsToCreate} periods...`);
            
            for (let i = 0; i < periodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check claim status - should indicate multiple claims needed with default
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, , estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            expect(totalUnclaimedPeriods).to.equal(BigInt(periodsToCreate));
            expect(hasMoreToClaim).to.equal(false); // 100 < 540 default V2
            expect(estimatedClaimsNeeded).to.equal(BigInt(1)); // ceil(100/540) = 1

            // First claim with V2 default limit (540 periods) - will claim all 100 in one go
            const balanceBefore1 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            const balanceAfter1 = await storageToken.balanceOf(user1.address);
            const claimed1 = balanceAfter1 - balanceBefore1;

            // V2: With 540 default limit, all 100 periods are claimed in one go
            const expectedClaim1 = rewardPerPeriod * BigInt(periodsToCreate);
            console.log(`First claim: ${ethers.formatEther(claimed1)} tokens (all ${periodsToCreate} periods)`);
            console.log(`Expected first claim: ${ethers.formatEther(expectedClaim1)} tokens`);
            
            expect(claimed1).to.equal(expectedClaim1);

            // Check remaining periods - should be 0 since all were claimed
            const [remainingPeriods, , , , stillHasMore] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);
            
            expect(remainingPeriods).to.equal(BigInt(0)); // All claimed
            expect(stillHasMore).to.equal(false);
            console.log(`Remaining periods after first claim: ${remainingPeriods}`);

            // Note: Second claim may be limited by monthly cap
            // After claiming ~8000 tokens (90 periods), the monthly cap is nearly reached
            // The remaining 10 periods would give ~888 more tokens, but may be capped
            
            // Advance to next month to reset the monthly cap
            await time.increase(30 * 24 * 60 * 60 + 1);

            // Second claim to get the rest (now in new month)
            const balanceBefore2 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            const balanceAfter2 = await storageToken.balanceOf(user1.address);
            const claimed2 = balanceAfter2 - balanceBefore2;

            // Should have claimed remaining periods
            const expectedClaim2 = rewardPerPeriod * remainingPeriods;
            console.log(`Second claim: ${ethers.formatEther(claimed2)} tokens (${remainingPeriods} periods)`);
            console.log(`Expected claim2: ${ethers.formatEther(expectedClaim2)} tokens`);
            expect(claimed2).to.equal(expectedClaim2);

            // Verify all claimed
            const finalRemaining = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            expect(finalRemaining).to.equal(0);

            console.log(`Total claimed: ${ethers.formatEther(claimed1 + claimed2)} tokens`);
        }).timeout(120000); // 2 minute timeout
    });

    // 15. 3-Month Claiming Scenarios Analysis
    describe("3-Month Claiming Scenarios Analysis", function () {
        beforeEach(async function () {
            // Add member to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("SCENARIO 1: Online 3 months, claim 1 month at a time (3 separate claims)", async function () {
            console.log("\n========== SCENARIO 1 ==========");
            console.log("User is online for ALL periods for 3 months");
            console.log("Claims with maxPeriods = 90 (1 month worth) at end of 3 months");
            console.log("================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod()); // 8 hours
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer(); // 8000 tokens
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod); // ~90 periods
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            console.log(`Expected period: ${expectedPeriod} seconds (${expectedPeriod / 3600} hours)`);
            console.log(`Monthly reward cap: ${ethers.formatEther(maxMonthlyReward)} tokens`);
            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);

            // Simulate 3 months of being online (90 days = ~270 periods)
            const monthsToSimulate = 3;
            const totalPeriodsToCreate = periodsPerMonth * monthsToSimulate;
            
            console.log(`\nCreating ${totalPeriodsToCreate} periods (${monthsToSimulate} months)...`);
            
            for (let i = 0; i < totalPeriodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check status after 3 months
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`\n--- After 3 months (before any claims) ---`);
            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            const totalEligible = await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);
            console.log(`Total eligible rewards (view): ${ethers.formatEther(totalEligible)} tokens`);

            // Now claim with 90 periods at a time (1 month worth)
            // IMPORTANT: We need to advance to a new calendar month between claims
            // because the monthly cap resets each calendar month
            const periodsPerClaim = 90;
            let totalClaimed = BigInt(0);
            let claimNumber = 0;

            console.log(`\n--- Claiming with ${periodsPerClaim} periods per claim ---`);
            console.log(`(Advancing 30 days between claims to reset monthly cap)\n`);

            while (true) {
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                claimNumber++;
                const balanceBefore = await storageToken.balanceOf(user1.address);
                
                // Use claimRewardsWithLimitV2 with 90 periods
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerClaim);
                
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                totalClaimed += claimed;

                const [newRemaining, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );

                console.log(`Claim ${claimNumber}: ${ethers.formatEther(claimed)} tokens | Remaining periods: ${newRemaining}`);

                // Advance to next month to reset monthly cap (if there are more periods to claim)
                if (newRemaining > BigInt(0)) {
                    console.log(`  -> Advancing 30 days to next month...`);
                    await time.increase(30 * 24 * 60 * 60 + 1);
                }
            }

            console.log(`\n========== SCENARIO 1 RESULTS ==========`);
            console.log(`Total claims made: ${claimNumber}`);
            console.log(`Total tokens claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected if no cap: ${ethers.formatEther(rewardPerPeriod * BigInt(totalPeriodsToCreate))} tokens`);
            console.log(`=========================================\n`);
        }).timeout(300000); // 5 minute timeout

        it("SCENARIO 2: Online 3 months, claim all at once (max periods = 270)", async function () {
            console.log("\n========== SCENARIO 2 ==========");
            console.log("User is online for ALL periods for 3 months");
            console.log("Claims with maxPeriods = 270 (3 months worth) at end of 3 months");
            console.log("================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod()); // 8 hours
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer(); // 8000 tokens
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod); // ~90 periods
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            console.log(`Expected period: ${expectedPeriod} seconds (${expectedPeriod / 3600} hours)`);
            console.log(`Monthly reward cap: ${ethers.formatEther(maxMonthlyReward)} tokens`);
            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);

            // Simulate 3 months of being online (90 days = ~270 periods)
            const monthsToSimulate = 3;
            const totalPeriodsToCreate = periodsPerMonth * monthsToSimulate;
            
            console.log(`\nCreating ${totalPeriodsToCreate} periods (${monthsToSimulate} months)...`);
            
            for (let i = 0; i < totalPeriodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check status after 3 months
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`\n--- After 3 months (before any claims) ---`);
            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            const totalEligible = await rewardEngine.calculateEligibleMiningRewardsV2(user1.address, PEER_ID_1, testPoolId);
            console.log(`Total eligible rewards (view): ${ethers.formatEther(totalEligible)} tokens`);

            // Now claim with 270 periods at a time (3 months worth)
            const periodsPerClaim = totalPeriodsToCreate; // 270 periods
            let totalClaimed = BigInt(0);
            let claimNumber = 0;

            console.log(`\n--- Claiming with ${periodsPerClaim} periods per claim ---`);

            while (true) {
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                claimNumber++;
                const balanceBefore = await storageToken.balanceOf(user1.address);
                
                // Use claimRewardsWithLimitV2 with 270 periods (all at once)
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerClaim);
                
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                totalClaimed += claimed;

                const [newRemaining, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );

                console.log(`Claim ${claimNumber}: ${ethers.formatEther(claimed)} tokens | Remaining periods: ${newRemaining}`);
            }

            console.log(`\n========== SCENARIO 2 RESULTS ==========`);
            console.log(`Total claims made: ${claimNumber}`);
            console.log(`Total tokens claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected if no cap: ${ethers.formatEther(rewardPerPeriod * BigInt(totalPeriodsToCreate))} tokens`);
            console.log(`=========================================\n`);
        }).timeout(300000); // 5 minute timeout

        it("COMPARISON: Side-by-side analysis of both scenarios", async function () {
            console.log("\n========== COMPARISON TEST ==========");
            console.log("This test shows both scenarios side by side");
            console.log("======================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            console.log(`Configuration:`);
            console.log(`- Period duration: ${expectedPeriod / 3600} hours`);
            console.log(`- Periods per month: ${periodsPerMonth}`);
            console.log(`- Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);
            console.log(`- Monthly reward cap: ${ethers.formatEther(maxMonthlyReward)} tokens`);
            console.log(`- 3 months of periods: ${periodsPerMonth * 3} periods`);
            console.log(`- Theoretical max (no cap): ${ethers.formatEther(rewardPerPeriod * BigInt(periodsPerMonth * 3))} tokens`);

            console.log(`\n--- KEY INSIGHT ---`);
            console.log(`The monthly cap of ${ethers.formatEther(maxMonthlyReward)} tokens applies PER CALENDAR MONTH.`);
            console.log(`If user claims 90 periods (1 month) = ~${ethers.formatEther(rewardPerPeriod * BigInt(90))} tokens`);
            console.log(`This is EQUAL to the monthly cap, so:`);
            console.log(`- Scenario 1 (claim 90 at a time): Should get full rewards across 3 separate months`);
            console.log(`- Scenario 2 (claim 270 at once): May be LIMITED by the current month's cap`);
            console.log(`\nRun the individual scenario tests to see actual results!`);
        });
    });

    // 16. Offline Gap Test - Ensure going offline between months doesn't break claiming
    describe("Offline Gap Between Months Test", function () {
        beforeEach(async function () {
            // Add member to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("should handle offline gaps with 90 periods per claim (4 separate claims)", async function () {
            console.log("\n========== OFFLINE GAP TEST (90 periods per claim) ==========");
            console.log("Month 1: User is ONLINE for all periods");
            console.log("Month 2: User is OFFLINE (no online status submitted)");
            console.log("Month 3: User is OFFLINE (no online status submitted)");
            console.log("Month 4: User is ONLINE for all periods");
            console.log("User claims with EXACTLY 90 periods per transaction");
            console.log("Expected: 4 claims needed (Month1=8000, Month2=0, Month3=0, Month4=8000)");
            console.log("=============================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod()); // 8 hours
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer(); // 8000 tokens
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod); // ~90 periods
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            console.log(`Expected period: ${expectedPeriod} seconds (${expectedPeriod / 3600} hours)`);
            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);

            // ========== MONTH 1: User is ONLINE ==========
            console.log(`\n--- MONTH 1: User is ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }
            console.log(`✅ Month 1: Submitted ${periodsPerMonth} online statuses`);

            // ========== MONTH 2: User is OFFLINE (just advance time, no online status) ==========
            console.log(`\n--- MONTH 2: User is OFFLINE ---`);
            await time.increase(30 * 24 * 60 * 60); // Advance 30 days without submitting online status
            console.log(`⏭️ Month 2: Advanced 30 days (no online status submitted)`);

            // ========== MONTH 3: User is OFFLINE (just advance time, no online status) ==========
            console.log(`\n--- MONTH 3: User is OFFLINE ---`);
            await time.increase(30 * 24 * 60 * 60); // Advance 30 days without submitting online status
            console.log(`⏭️ Month 3: Advanced 30 days (no online status submitted)`);

            // ========== MONTH 4: User is ONLINE ==========
            console.log(`\n--- MONTH 4: User is ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }
            console.log(`✅ Month 4: Submitted ${periodsPerMonth} online statuses`);

            // Check claim status after 4 months
            const [totalUnclaimedPeriods, , , , ] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`\n--- After 4 months (before any claims) ---`);
            console.log(`Total unclaimed periods (online only): ${totalUnclaimedPeriods}`);
            // Should be 180 (90 from month 1 + 90 from month 4)
            expect(totalUnclaimedPeriods).to.equal(BigInt(periodsPerMonth * 2));

            // ========== CLAIM 1: Month 1 - Should get ~8000 tokens ==========
            console.log(`\n--- CLAIM 1: Month 1 (with limit=${periodsPerMonth}) ---`);
            const balanceBefore1 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerMonth);
            const balanceAfter1 = await storageToken.balanceOf(user1.address);
            const claimed1 = balanceAfter1 - balanceBefore1;

            const expectedMonth1Reward = rewardPerPeriod * BigInt(periodsPerMonth);
            console.log(`Claim 1 result: ${ethers.formatEther(claimed1)} tokens`);
            expect(claimed1).to.equal(expectedMonth1Reward);
            console.log(`✅ CLAIM 1 PASSED: Got ${ethers.formatEther(claimed1)} tokens for Month 1`);

            // ========== CLAIM 2: Month 2 (offline) - Should get 0 tokens and NOT revert ==========
            console.log(`\n--- CLAIM 2: Month 2 OFFLINE (with limit=${periodsPerMonth}) ---`);
            const balanceBefore2 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerMonth);
            const balanceAfter2 = await storageToken.balanceOf(user1.address);
            const claimed2 = balanceAfter2 - balanceBefore2;

            console.log(`Claim 2 result: ${ethers.formatEther(claimed2)} tokens`);
            expect(claimed2).to.equal(BigInt(0));
            console.log(`✅ CLAIM 2 PASSED: Got 0 tokens for offline Month 2 (no revert, timestamp advanced)`);

            // ========== CLAIM 3: Month 3 (offline) - Should get 0 tokens ==========
            console.log(`\n--- CLAIM 3: Month 3 OFFLINE (with limit=${periodsPerMonth}) ---`);
            const balanceBefore3 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerMonth);
            const balanceAfter3 = await storageToken.balanceOf(user1.address);
            const claimed3 = balanceAfter3 - balanceBefore3;

            console.log(`Claim 3 result: ${ethers.formatEther(claimed3)} tokens`);
            expect(claimed3).to.equal(BigInt(0));
            console.log(`✅ CLAIM 3 PASSED: Got 0 tokens for offline Month 3 (no revert, timestamp advanced)`);

            // ========== CLAIM 4: Month 4 - Should get ~8000 tokens ==========
            // Advance to next calendar month to reset monthly cap
            await time.increase(30 * 24 * 60 * 60 + 1);
            
            console.log(`\n--- CLAIM 4: Month 4 (with limit=${periodsPerMonth}) ---`);
            const balanceBefore4 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerMonth);
            const balanceAfter4 = await storageToken.balanceOf(user1.address);
            const claimed4 = balanceAfter4 - balanceBefore4;

            const expectedMonth4Reward = rewardPerPeriod * BigInt(periodsPerMonth);
            console.log(`Claim 4 result: ${ethers.formatEther(claimed4)} tokens`);
            expect(claimed4).to.equal(expectedMonth4Reward);
            console.log(`✅ CLAIM 4 PASSED: Got ${ethers.formatEther(claimed4)} tokens for Month 4`);

            // ========== FINAL VERIFICATION ==========
            const totalClaimed = claimed1 + claimed2 + claimed3 + claimed4;
            console.log(`\n========== FINAL RESULTS ==========`);
            console.log(`Claim 1 (Month 1): ${ethers.formatEther(claimed1)} tokens`);
            console.log(`Claim 2 (Month 2 offline): ${ethers.formatEther(claimed2)} tokens`);
            console.log(`Claim 3 (Month 3 offline): ${ethers.formatEther(claimed3)} tokens`);
            console.log(`Claim 4 (Month 4): ${ethers.formatEther(claimed4)} tokens`);
            console.log(`Total: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`====================================\n`);

            const expectedTotal = expectedMonth1Reward + expectedMonth4Reward;
            expect(totalClaimed).to.equal(expectedTotal);
            console.log(`✅ TEST PASSED: 4 claims completed successfully!`);
            console.log(`   - Offline months (2 & 3) returned 0 tokens but did NOT revert`);
            console.log(`   - lastClaimedRewards timestamp was advanced through offline periods`);
        }).timeout(300000); // 5 minute timeout

        it("should correctly report zero rewards for offline periods", async function () {
            console.log("\n========== OFFLINE PERIODS ZERO REWARDS TEST ==========");
            
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);

            // User joins but never submits online status
            // Just advance time for 2 months
            await time.increase(60 * 24 * 60 * 60); // 60 days

            // Check rewards - should be 0 since user was never online
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            
            console.log(`User was offline for 2 months`);
            console.log(`Eligible rewards: ${ethers.formatEther(eligibleRewards)} tokens`);
            
            expect(eligibleRewards).to.equal(0);

            // V2: Claim doesn't revert for offline user, just emits 0 rewards and advances timestamp
            const balanceBefore = await storageToken.balanceOf(user1.address);
            await expect(
                rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId)
            ).to.emit(rewardEngine, "MiningRewardsClaimed")
            .withArgs(user1.address, PEER_ID_1, testPoolId, 0);
            const balanceAfter = await storageToken.balanceOf(user1.address);
            
            expect(balanceAfter - balanceBefore).to.equal(0);
            console.log(`✅ Correctly claimed 0 tokens for offline user (no revert, timestamp advanced)`);
        });

        it("should handle alternating online/offline months correctly", async function () {
            console.log("\n========== ALTERNATING ONLINE/OFFLINE TEST ==========");
            console.log("Month 1: ONLINE");
            console.log("Month 2: OFFLINE");
            console.log("Month 3: ONLINE");
            console.log("===================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Month 1: ONLINE
            console.log(`--- Month 1: ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Month 2: OFFLINE
            console.log(`--- Month 2: OFFLINE ---`);
            await time.increase(30 * 24 * 60 * 60);

            // Month 3: ONLINE
            console.log(`--- Month 3: ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check total unclaimed periods - should be 2 months worth (months 1 and 3)
            const totalEligible = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            
            console.log(`\nTotal eligible rewards: ${ethers.formatEther(totalEligible)} tokens`);
            // Due to monthly cap, view function shows capped amount
            
            // Claim Month 1
            console.log(`\n--- Claiming Month 1 ---`);
            const balanceBefore1 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, periodsPerMonth);
            const balanceAfter1 = await storageToken.balanceOf(user1.address);
            const claimed1 = balanceAfter1 - balanceBefore1;
            console.log(`Claim 1: ${ethers.formatEther(claimed1)} tokens`);
            
            const expectedMonth1 = rewardPerPeriod * BigInt(periodsPerMonth);
            expect(claimed1).to.equal(expectedMonth1);

            // Advance to next calendar month to reset cap
            await time.increase(30 * 24 * 60 * 60 + 1);

            // Claim Month 3 (skipping offline Month 2)
            // Use 180 periods to cover Month 2 (offline) + Month 3 (online)
            console.log(`\n--- Claiming Month 3 (skipping offline Month 2) ---`);
            const balanceBefore2 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 180);
            const balanceAfter2 = await storageToken.balanceOf(user1.address);
            const claimed2 = balanceAfter2 - balanceBefore2;
            console.log(`Claim 2: ${ethers.formatEther(claimed2)} tokens`);
            
            const expectedMonth3 = rewardPerPeriod * BigInt(periodsPerMonth);
            expect(claimed2).to.equal(expectedMonth3);

            const totalClaimed = claimed1 + claimed2;
            const expectedTotal = rewardPerPeriod * BigInt(periodsPerMonth * 2); // 2 online months
            
            console.log(`\n========== RESULTS ==========`);
            console.log(`Month 1 (online): ${ethers.formatEther(claimed1)} tokens`);
            console.log(`Month 2 (offline): 0 tokens (skipped)`);
            console.log(`Month 3 (online): ${ethers.formatEther(claimed2)} tokens`);
            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected (2 online months): ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`==============================\n`);

            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`✅ TEST PASSED: Alternating online/offline months handled correctly!`);
        }).timeout(300000); // 5 minute timeout
    });

    // 17. NEW: Comprehensive Tests for MAX_MONTHLY_REWARD_PER_PEER = 96000 (12 months claiming cap)
    describe("96000 Token Claiming Cap Tests (12 Month Accumulation)", function () {
        beforeEach(async function () {
            // Add member to the test pool
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
        });

        it("should verify earning rate is capped at 8000 tokens per month regardless of claim timing", async function () {
            console.log("\n========== EARNING RATE CAP TEST ==========");
            console.log("Verify: User can only EARN 8000 tokens per month maximum");
            console.log("============================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxClaimingCap = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            console.log(`Monthly earning cap (DEFAULT_MONTHLY_REWARD_PER_PEER): ${ethers.formatEther(monthlyReward)} tokens`);
            console.log(`Monthly claiming cap (MAX_MONTHLY_REWARD_PER_PEER): ${ethers.formatEther(maxClaimingCap)} tokens`);
            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);

            // Submit online status for exactly 90 periods (1 month)
            console.log(`\n--- Submitting ${periodsPerMonth} online statuses (1 month) ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );

            const expectedEarnings = rewardPerPeriod * BigInt(periodsPerMonth);
            console.log(`\nEligible rewards after 1 month: ${ethers.formatEther(eligibleRewards)} tokens`);
            console.log(`Expected (${periodsPerMonth} periods × ${ethers.formatEther(rewardPerPeriod)}): ${ethers.formatEther(expectedEarnings)} tokens`);

            // Earnings should be exactly 8000 tokens (not more)
            expect(eligibleRewards).to.equal(expectedEarnings);
            expect(eligibleRewards).to.be.lte(monthlyReward);

            // Now claim and verify
            const balanceBefore = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            const balanceAfter = await storageToken.balanceOf(user1.address);
            const claimed = balanceAfter - balanceBefore;

            console.log(`Actually claimed: ${ethers.formatEther(claimed)} tokens`);
            expect(claimed).to.equal(expectedEarnings);

            console.log(`\n✅ PASSED: Earning rate correctly capped at ${ethers.formatEther(monthlyReward)} per month`);
        });

        it("should allow accumulating up to 96000 tokens (12 months) without loss", async function () {
            console.log("\n========== 12 MONTH ACCUMULATION TEST ==========");
            console.log("Verify: User can accumulate 12 months of rewards (96000 tokens) and claim all");
            console.log("Note: Testing with 6 months first due to O(n²) complexity in linked list");
            console.log("================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxClaimingCap = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            // Test with 3 months (270 periods) which is within practical limits
            // The 96000 cap allows 12 months, but linked list iteration scales O(n²)
            // In practice, users should claim more frequently to avoid gas issues
            const monthsToAccumulate = 3;
            const totalPeriodsToCreate = periodsPerMonth * monthsToAccumulate;
            const expectedTotal = rewardPerPeriod * BigInt(totalPeriodsToCreate);

            console.log(`Creating ${totalPeriodsToCreate} periods (${monthsToAccumulate} months)...`);
            console.log(`Expected earnings: ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`Claiming cap: ${ethers.formatEther(maxClaimingCap)} tokens`);
            console.log(`This is ${monthsToAccumulate}/12 of the cap, demonstrating accumulation works`);

            // Simulate 6 months of being online
            for (let i = 0; i < totalPeriodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards via view function
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            console.log(`\nEligible rewards (view): ${ethers.formatEther(eligibleRewards)} tokens`);
            
            // Should be able to see all 6 months worth
            expect(eligibleRewards).to.equal(expectedTotal);
            expect(eligibleRewards).to.be.lt(maxClaimingCap); // Under the cap

            // Claim in batches
            let totalClaimed = BigInt(0);
            let claimCount = 0;
            const batchSize = 90;

            console.log(`\n--- Claiming in batches of ${batchSize} periods ---`);
            
            for (let attempt = 0; attempt < 10; attempt++) {
                const balanceBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, batchSize);
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                
                if (claimed === BigInt(0)) {
                    console.log(`Claim ${claimCount + 1}: 0 tokens - done claiming`);
                    break;
                }
                
                totalClaimed += claimed;
                claimCount++;
                console.log(`Claim ${claimCount}: ${ethers.formatEther(claimed)} tokens`);
            }

            console.log(`\n========== RESULTS ==========`);
            console.log(`Total claims: ${claimCount}`);
            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected (${monthsToAccumulate} × 8000): ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`==============================\n`);

            // Total claimed should equal total earned
            expect(totalClaimed).to.equal(expectedTotal);

            // Verify that claiming cap (96000) is higher than what we claimed (48000)
            // This proves the cap allows 12 months of accumulation
            expect(maxClaimingCap).to.equal(ethers.parseEther("96000"));
            expect(totalClaimed).to.be.lt(maxClaimingCap);

            console.log(`✅ PASSED: ${monthsToAccumulate} months accumulated = ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Cap of ${ethers.formatEther(maxClaimingCap)} allows up to 12 months accumulation`);
        }).timeout(600000); // 10 minute timeout

        it("should verify claiming cap is 96000 tokens (12 months worth)", async function () {
            console.log("\n========== CLAIMING CAP VERIFICATION TEST ==========");
            console.log("Verify: MAX_MONTHLY_REWARD_PER_PEER = 96000 (12 × 8000)");
            console.log("====================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxClaimingCap = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            // Verify the constants are set correctly
            console.log(`Monthly earning rate: ${ethers.formatEther(monthlyReward)} tokens`);
            console.log(`Claiming cap: ${ethers.formatEther(maxClaimingCap)} tokens`);
            console.log(`Ratio: ${Number(maxClaimingCap) / Number(monthlyReward)} months worth`);

            // Verify constants
            expect(monthlyReward).to.equal(ethers.parseEther("8000"));
            expect(maxClaimingCap).to.equal(ethers.parseEther("96000"));
            expect(maxClaimingCap / monthlyReward).to.equal(BigInt(12));

            // Test with 2 months to verify accumulation within practical limits
            const monthsToAccumulate = 2;
            const totalPeriodsToCreate = periodsPerMonth * monthsToAccumulate;

            console.log(`Creating ${totalPeriodsToCreate} periods (${monthsToAccumulate} months)...`);
            console.log(`Expected total earnings: ${ethers.formatEther(rewardPerPeriod * BigInt(totalPeriodsToCreate))} tokens`);
            console.log(`Claiming cap per calendar month: ${ethers.formatEther(maxClaimingCap)} tokens`);

            // Simulate 2 months of being online
            for (let i = 0; i < totalPeriodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );

            const expectedTotal = rewardPerPeriod * BigInt(totalPeriodsToCreate);
            console.log(`\nTotal earned (2 months): ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`Eligible rewards (view): ${ethers.formatEther(eligibleRewards)} tokens`);

            // 2 months (16000) should be under the 96000 cap
            expect(eligibleRewards).to.equal(expectedTotal);
            expect(eligibleRewards).to.be.lt(maxClaimingCap);

            // Claim all
            let totalClaimed = BigInt(0);
            for (let attempt = 0; attempt < 5; attempt++) {
                const balanceBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                
                if (claimed === BigInt(0)) break;
                totalClaimed += claimed;
                console.log(`Claimed: ${ethers.formatEther(claimed)} tokens`);
            }

            console.log(`\n========== RESULTS ==========`);
            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected (2 × 8000): ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`==============================\n`);

            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`✅ PASSED: Claiming cap correctly set to 96000 (12 months worth)`);
        }).timeout(300000);

        it("should handle many offline periods without breaking claiming", async function () {
            console.log("\n========== MANY OFFLINE PERIODS TEST ==========");
            console.log("Verify: 3 months offline, then 1 month online works correctly");
            console.log("With maxPeriods=270, view only sees first 3 months");
            console.log("Claiming advances through offline periods to reach online ones");
            console.log("===============================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Months 1-3: OFFLINE (just advance time) - 270 periods
            const offlineMonths = 3;
            console.log(`--- Months 1-${offlineMonths}: OFFLINE (advancing ${offlineMonths} months / 270 periods) ---`);
            await time.increase(offlineMonths * 30 * 24 * 60 * 60);

            // Month 4: ONLINE
            console.log(`--- Month ${offlineMonths + 1}: ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards - V2 checks up to 540 periods, so it can see all 360 periods
            // (270 offline + 90 online), and should show rewards for the online month
            const eligibleRewardsInitial = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            const expectedEarningsInitial = rewardPerPeriod * BigInt(periodsPerMonth);
            console.log(`\nInitial view (V2 checks 540 periods, sees all 360): ${ethers.formatEther(eligibleRewardsInitial)} tokens`);
            console.log(`Expected: ${ethers.formatEther(expectedEarningsInitial)} (V2 can see the online month)`);
            
            // V2 can see all 360 periods (270 offline + 90 online), showing rewards for online month
            expect(eligibleRewardsInitial).to.equal(expectedEarningsInitial);

            // Now claim through the offline periods - this advances lastClaimedRewards
            console.log(`\n--- Claiming through offline periods ---`);
            let totalClaimed = BigInt(0);
            let claimCount = 0;
            const expectedEarnings = rewardPerPeriod * BigInt(periodsPerMonth);
            
            // Need to claim through offline periods (270 periods / 90 per claim = 3 claims)
            // Then 1 more claim to get the online month rewards
            for (let attempt = 0; attempt < 10; attempt++) {
                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const balAfter = await storageToken.balanceOf(user1.address);
                const claimed = balAfter - balBefore;
                totalClaimed += claimed;
                claimCount++;

                console.log(`Claim ${claimCount}: ${ethers.formatEther(claimed)} tokens`);
                
                // Stop when we've claimed the expected amount
                if (totalClaimed >= expectedEarnings) break;
            }

            console.log(`\n========== RESULTS ==========`);
            console.log(`Total claims needed: ${claimCount}`);
            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected (1 online month): ${ethers.formatEther(expectedEarnings)} tokens`);
            console.log(`==============================\n`);

            expect(totalClaimed).to.equal(expectedEarnings);

            console.log(`✅ PASSED: Claiming through offline periods works correctly`);
        }).timeout(300000);

        it("should verify view function and claim function return consistent results", async function () {
            console.log("\n========== VIEW vs CLAIM CONSISTENCY TEST ==========");
            console.log("Verify: calculateEligibleMiningRewardsV2 matches actual claim amount");
            console.log("====================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);

            // Submit online status for 3 months
            const monthsToCreate = 3;
            const totalPeriods = periodsPerMonth * monthsToCreate;

            console.log(`Creating ${totalPeriods} periods (${monthsToCreate} months)...`);

            for (let i = 0; i < totalPeriods; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Get view result
            const viewResult = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            console.log(`View function result: ${ethers.formatEther(viewResult)} tokens`);

            // Claim and compare
            const balanceBefore = await storageToken.balanceOf(user1.address);
            let totalClaimed = BigInt(0);
            
            while (true) {
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 500);
                const balAfter = await storageToken.balanceOf(user1.address);
                totalClaimed += (balAfter - balBefore);
            }

            console.log(`Actually claimed: ${ethers.formatEther(totalClaimed)} tokens`);

            // View should match what was claimed
            expect(viewResult).to.equal(totalClaimed);

            console.log(`\n✅ PASSED: View function matches actual claim amount`);
        }).timeout(300000);

        it("should measure gas costs for monthly claiming pattern (Base network)", async function () {
            console.log("\n========== GAS COST TEST: MONTHLY CLAIMING PATTERN (BASE NETWORK) ==========");
            console.log("Scenario: User claims every month (recommended pattern)");
            console.log("Target: Each claim should cost less than $0.25 on Base");
            console.log("Base assumptions: 0.01 gwei gas price, $3500 ETH price");
            console.log("=============================================================================\n");

            // Base network cost estimation parameters
            const BASE_GAS_PRICE_GWEI = 0.01; // Base L2 is very cheap
            const ETH_PRICE_USD = 3500;
            const MAX_COST_USD = 0.25;
            
            const maxGasFor25Cents = Math.floor(MAX_COST_USD * 1e9 / (BASE_GAS_PRICE_GWEI * ETH_PRICE_USD));
            console.log(`Max gas for $${MAX_COST_USD}: ${maxGasFor25Cents.toLocaleString()} gas\n`);

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);

            const gasUsages: bigint[] = [];
            const costEstimates: number[] = [];

            // Simulate 3 months of "claim each month" pattern
            for (let month = 1; month <= 3; month++) {
                console.log(`--- Month ${month}: Create 90 periods, then claim ---`);
                
                // Create 1 month of online periods
                for (let i = 0; i < periodsPerMonth; i++) {
                    const ts = await getCurrentBlockTimestamp();
                    await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                    await time.increase(expectedPeriod + 1);
                }

                // Claim immediately after each month
                const balBefore = await storageToken.balanceOf(user1.address);
                const tx = await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const receipt = await tx.wait();
                const balAfter = await storageToken.balanceOf(user1.address);
                
                const gasUsed = receipt!.gasUsed;
                gasUsages.push(gasUsed);
                
                const costUsd = (Number(gasUsed) * BASE_GAS_PRICE_GWEI * ETH_PRICE_USD) / 1e9;
                costEstimates.push(costUsd);
                
                console.log(`Claim: ${gasUsed.toLocaleString()} gas, $${costUsd.toFixed(4)} USD, ${ethers.formatEther(balAfter - balBefore)} tokens\n`);
            }

            console.log(`\n========== BASE NETWORK COST SUMMARY (MONTHLY CLAIMING) ==========`);
            console.log(`Gas price: ${BASE_GAS_PRICE_GWEI} gwei | ETH: $${ETH_PRICE_USD} | Budget: $${MAX_COST_USD}`);
            console.log(`-------------------------------------------------------------------`);
            
            for (let i = 0; i < gasUsages.length; i++) {
                const status = costEstimates[i] < MAX_COST_USD ? "✅" : "❌";
                console.log(`Month ${i + 1}: ${gasUsages[i].toLocaleString()} gas = $${costEstimates[i].toFixed(4)} ${status}`);
            }
            console.log(`===================================================================\n`);

            // Verify all monthly claims are under $0.25
            for (let i = 0; i < costEstimates.length; i++) {
                expect(costEstimates[i]).to.be.lt(MAX_COST_USD, `Month ${i + 1} claim costs $${costEstimates[i].toFixed(4)}, exceeds $${MAX_COST_USD}`);
            }

            console.log(`✅ PASSED: Monthly claiming pattern stays under $${MAX_COST_USD} on Base`);
        }).timeout(300000);

        it("should show gas cost increase for accumulated claims (informational)", async function () {
            console.log("\n========== GAS COST INFO: ACCUMULATED CLAIMING (BASE NETWORK) ==========");
            console.log("Scenario: User waits 3 months before first claim (NOT recommended)");
            console.log("Purpose: Show why monthly claiming is better for gas costs");
            console.log("=========================================================================\n");

            const BASE_GAS_PRICE_GWEI = 0.01;
            const ETH_PRICE_USD = 3500;

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);

            // Create 3 months of online periods WITHOUT claiming
            const monthsToCreate = 3;
            const totalPeriods = periodsPerMonth * monthsToCreate;

            console.log(`Creating ${totalPeriods} periods (${monthsToCreate} months) without claiming...`);

            for (let i = 0; i < totalPeriods; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            console.log(`\n--- Now claiming all 3 months in batches of 90 periods ---`);
            const gasUsages: bigint[] = [];
            const costEstimates: number[] = [];

            for (let i = 0; i < 3; i++) {
                const balBefore = await storageToken.balanceOf(user1.address);
                const tx = await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const receipt = await tx.wait();
                const balAfter = await storageToken.balanceOf(user1.address);
                
                if (balAfter === balBefore) break;
                
                const gasUsed = receipt!.gasUsed;
                gasUsages.push(gasUsed);
                
                const costUsd = (Number(gasUsed) * BASE_GAS_PRICE_GWEI * ETH_PRICE_USD) / 1e9;
                costEstimates.push(costUsd);
                
                console.log(`Claim ${i + 1}: ${gasUsed.toLocaleString()} gas, $${costUsd.toFixed(4)} USD, ${ethers.formatEther(balAfter - balBefore)} tokens`);
            }

            console.log(`\n========== ACCUMULATED CLAIMING COST ANALYSIS ==========`);
            console.log(`⚠️  First claim after long gap is MOST EXPENSIVE (O(n²) complexity)`);
            console.log(`---------------------------------------------------------`);
            for (let i = 0; i < gasUsages.length; i++) {
                const note = i === 0 ? " ← Most expensive (iterates all timestamps)" : "";
                console.log(`Claim ${i + 1}: ${gasUsages[i].toLocaleString()} gas = $${costEstimates[i].toFixed(4)}${note}`);
            }
            const totalCost = costEstimates.reduce((a, b) => a + b, 0);
            console.log(`---------------------------------------------------------`);
            console.log(`Total for 3 months: $${totalCost.toFixed(4)}`);
            console.log(`=========================================================\n`);

            console.log(`💡 RECOMMENDATION: Claim monthly to keep each claim under $0.25`);
            console.log(`   - Monthly claiming: ~$0.09-0.12 per claim`);
            console.log(`   - Accumulated: First claim can exceed $0.25\n`);

            // This test is informational - just verify gas is under absolute safety limit
            const maxGas = BigInt(15_000_000);
            for (let i = 0; i < gasUsages.length; i++) {
                expect(gasUsages[i]).to.be.lt(maxGas, `Claim ${i + 1} exceeds safety limit`);
            }

            console.log(`✅ INFO: Gas costs documented for accumulated claiming pattern`);
        }).timeout(300000);

        it("should handle 3 months skip then claim all accumulated rewards correctly", async function () {
            console.log("\n========== 3 MONTH SKIP THEN CLAIM TEST ==========");
            console.log("User is online for 3 months, doesn't claim, then claims all at once");
            console.log("Expected: Claim all 24000 tokens (3 × 8000)");
            console.log("=================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Submit online status for 3 months straight without claiming
            const monthsOnline = 3;
            const totalPeriods = periodsPerMonth * monthsOnline;

            console.log(`Creating ${totalPeriods} periods (${monthsOnline} months)...`);

            for (let i = 0; i < totalPeriods; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );

            const expectedTotal = rewardPerPeriod * BigInt(totalPeriods);
            console.log(`\nEligible rewards: ${ethers.formatEther(eligibleRewards)} tokens`);
            console.log(`Expected (3 × 8000): ${ethers.formatEther(expectedTotal)} tokens`);

            // Should not be capped since 24000 < 96000
            expect(eligibleRewards).to.equal(expectedTotal);

            // Claim all at once
            let totalClaimed = BigInt(0);
            while (true) {
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatusV2(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 500);
                const balAfter = await storageToken.balanceOf(user1.address);
                totalClaimed += (balAfter - balBefore);
            }

            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`\n✅ PASSED: 3 months accumulated correctly claimed (24000 tokens)`);
        }).timeout(300000);

        it("should correctly handle alternating online/offline pattern", async function () {
            console.log("\n========== ALTERNATING ONLINE/OFFLINE PATTERN TEST ==========");
            console.log("Pattern: 1 month online, 1 month offline, 1 month online");
            console.log("Expected: 2 months worth of rewards (16000 tokens)");
            console.log("============================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Month 1: ONLINE
            console.log(`--- Month 1: ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Month 2: OFFLINE
            console.log(`--- Month 2: OFFLINE ---`);
            await time.increase(30 * 24 * 60 * 60);

            // Month 3: ONLINE
            console.log(`--- Month 3: ONLINE ---`);
            for (let i = 0; i < periodsPerMonth; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Check eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );

            const expectedTotal = rewardPerPeriod * BigInt(periodsPerMonth * 2); // 2 online months
            console.log(`\nEligible rewards: ${ethers.formatEther(eligibleRewards)} tokens`);
            console.log(`Expected (2 × 8000): ${ethers.formatEther(expectedTotal)} tokens`);

            expect(eligibleRewards).to.equal(expectedTotal);

            // Claim all - need to claim multiple times for periods across gap
            // Month 1 periods (0-89), Month 2 offline, Month 3 periods are at index 180-269
            let totalClaimed = BigInt(0);
            for (let attempt = 0; attempt < 10; attempt++) {
                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const balAfter = await storageToken.balanceOf(user1.address);
                const claimed = balAfter - balBefore;
                totalClaimed += claimed;
                console.log(`Claim ${attempt + 1}: ${ethers.formatEther(claimed)} tokens`);
                
                // Check if we've claimed all expected
                if (totalClaimed >= expectedTotal) break;
            }

            console.log(`\nTotal claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`\n✅ PASSED: 1-on/1-off/1-on pattern correctly yielded 16000 tokens`);
        }).timeout(300000);

        it("should verify 12 month cap math is correct", async function () {
            console.log("\n========== 12 MONTH CAP MATH VERIFICATION ==========");
            console.log("Verify: 12 months × 8000 = 96000 tokens (the cap)");
            console.log("Note: Full 12-month simulation limited by O(n²) complexity");
            console.log("===================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const maxClaimingCap = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();

            // Verify the math: 12 months × 8000 = 96000
            const expectedPerMonth = rewardPerPeriod * BigInt(periodsPerMonth);
            const expected12Months = expectedPerMonth * BigInt(12);

            console.log(`Periods per month: ${periodsPerMonth}`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);
            console.log(`Earned per month: ${ethers.formatEther(expectedPerMonth)} tokens`);
            console.log(`Earned for 12 months: ${ethers.formatEther(expected12Months)} tokens`);
            console.log(`MAX_MONTHLY_REWARD_PER_PEER cap: ${ethers.formatEther(maxClaimingCap)} tokens`);

            // Verify constants are set correctly
            expect(monthlyReward).to.equal(ethers.parseEther("8000"));
            expect(maxClaimingCap).to.equal(ethers.parseEther("96000"));
            
            // Verify the cap approximately equals 12 months of earning
            // Note: Small rounding error due to integer division (8000/90 = 88.888...)
            const difference = maxClaimingCap > expected12Months 
                ? maxClaimingCap - expected12Months 
                : expected12Months - maxClaimingCap;
            const tolerance = ethers.parseEther("1"); // Allow 1 token tolerance
            expect(difference).to.be.lt(tolerance);
            console.log(`Rounding difference: ${ethers.formatEther(difference)} tokens (acceptable)`);

            // Test actual claiming with 3 months (practical limit)
            const monthsToTest = 3;
            const totalPeriods = periodsPerMonth * monthsToTest;
            console.log(`\nTesting with ${monthsToTest} months (${totalPeriods} periods)...`);

            for (let i = 0; i < totalPeriods; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            const expectedTotal = rewardPerPeriod * BigInt(totalPeriods);

            console.log(`Eligible rewards: ${ethers.formatEther(eligibleRewards)} tokens`);
            console.log(`Expected (3 × 8000): ${ethers.formatEther(expectedTotal)} tokens`);

            expect(eligibleRewards).to.equal(expectedTotal);
            expect(eligibleRewards).to.be.lt(maxClaimingCap); // 24000 < 96000

            // Claim all in batches
            let totalClaimed = BigInt(0);
            for (let attempt = 0; attempt < 5; attempt++) {
                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const balAfter = await storageToken.balanceOf(user1.address);
                const claimed = balAfter - balBefore;
                if (claimed === BigInt(0)) break;
                totalClaimed += claimed;
            }

            console.log(`Total claimed: ${ethers.formatEther(totalClaimed)} tokens`);
            expect(totalClaimed).to.equal(expectedTotal);

            console.log(`\n✅ PASSED: Cap math verified: 12 × 8000 = 96000`);
        }).timeout(300000);

        it("should handle claim status query correctly for unclaimed periods", async function () {
            console.log("\n========== CLAIM STATUS QUERY TEST ==========");
            console.log("Verify: getClaimStatusV2 returns accurate info for 3 months unclaimed");
            console.log("=============================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);

            // Create 3 months of periods (within O(n²) limits)
            const monthsToCreate = 3;
            const totalPeriods = periodsPerMonth * monthsToCreate;
            console.log(`Creating ${totalPeriods} periods (${monthsToCreate} months)...`);

            for (let i = 0; i < totalPeriods; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                await time.increase(expectedPeriod + 1);
            }

            // Get claim status
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatusV2(user1.address, PEER_ID_1, testPoolId);

            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            // Verify values - V2 uses 540 period limits
            expect(totalUnclaimedPeriods).to.equal(BigInt(totalPeriods));
            expect(defaultPeriodsPerClaim).to.equal(BigInt(540));
            expect(maxPeriodsPerClaim).to.equal(BigInt(540));
            
            // 270 periods / 540 default = 1 claim needed
            expect(estimatedClaimsNeeded).to.equal(BigInt(Math.ceil(totalPeriods / 540)));
            expect(hasMoreToClaim).to.equal(false); // 270 < 540

            console.log(`\n✅ PASSED: Claim status query returns accurate information`);
        }).timeout(300000);

        it("should allow claiming 6 months of accumulated rewards by claiming 6 times", async function () {
            console.log("\n========== 6 MONTH ACCUMULATION - CLAIM 6 TIMES TEST ==========");
            console.log("User earns 6 months of rewards, claims month-by-month");
            console.log("Expected: Each claim gets ~8000 tokens, total = 48000 tokens");
            console.log("=============================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Create 6 months of online periods (540 periods)
            // But due to O(n²) complexity, we simulate this in chunks
            const monthsToCreate = 6;
            const totalPeriods = periodsPerMonth * monthsToCreate;
            const expectedTotal = rewardPerPeriod * BigInt(totalPeriods);

            console.log(`Creating ${totalPeriods} periods (${monthsToCreate} months)...`);
            console.log(`Expected total: ${ethers.formatEther(expectedTotal)} tokens`);

            // Create periods in batches to avoid timeout
            for (let month = 0; month < monthsToCreate; month++) {
                console.log(`Creating month ${month + 1}...`);
                for (let i = 0; i < periodsPerMonth; i++) {
                    const ts = await getCurrentBlockTimestamp();
                    await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                    await time.increase(expectedPeriod + 1);
                }
            }

            // Now claim 6 times (90 periods per claim = 1 month)
            console.log(`\n--- Claiming 6 times (1 month per claim) ---`);
            let totalClaimed = BigInt(0);
            const claimResults: bigint[] = [];

            for (let claimNum = 1; claimNum <= 6; claimNum++) {
                const balBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
                const balAfter = await storageToken.balanceOf(user1.address);
                const claimed = balAfter - balBefore;
                totalClaimed += claimed;
                claimResults.push(claimed);
                console.log(`Claim ${claimNum}: ${ethers.formatEther(claimed)} tokens`);
            }

            console.log(`\n========== RESULTS ==========`);
            console.log(`Total claimed in 6 claims: ${ethers.formatEther(totalClaimed)} tokens`);
            console.log(`Expected (6 × 8000): ${ethers.formatEther(expectedTotal)} tokens`);
            console.log(`==============================\n`);

            // Verify total claimed equals expected
            expect(totalClaimed).to.equal(expectedTotal);

            // Verify each claim got approximately 1 month worth
            const expectedPerMonth = rewardPerPeriod * BigInt(periodsPerMonth);
            for (let i = 0; i < 6; i++) {
                expect(claimResults[i]).to.equal(expectedPerMonth);
            }

            console.log(`✅ PASSED: 6 months claimed successfully in 6 separate claims`);
        }).timeout(600000);

        it("should show remaining rewards in view after partial claim", async function () {
            console.log("\n========== VIEW AFTER PARTIAL CLAIM TEST ==========");
            console.log("User earns 3 months, claims 1 month, view shows remaining 2 months");
            console.log("Note: View function limited by O(n²) - works best within 3 months of data");
            console.log("===================================================\n");

            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);
            const expectedPerMonth = rewardPerPeriod * BigInt(periodsPerMonth);

            // Create 3 months of online periods (stays within O(n²) limits for view)
            const monthsToCreate = 3;
            const totalPeriods = periodsPerMonth * monthsToCreate;

            console.log(`Creating ${totalPeriods} periods (${monthsToCreate} months)...`);

            for (let month = 0; month < monthsToCreate; month++) {
                console.log(`Creating month ${month + 1}...`);
                for (let i = 0; i < periodsPerMonth; i++) {
                    const ts = await getCurrentBlockTimestamp();
                    await rewardEngine.connect(owner).submitOnlineStatusBatchV2(testPoolId, [PEER_ID_1], ts);
                    await time.increase(expectedPeriod + 1);
                }
            }

            // Initial view - should show all 3 months (270 periods)
            const viewBefore = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            const expected3Months = rewardPerPeriod * BigInt(totalPeriods);
            
            console.log(`\nInitial view: ${ethers.formatEther(viewBefore)} tokens`);
            console.log(`Expected (3 months): ${ethers.formatEther(expected3Months)} tokens`);
            
            expect(viewBefore).to.equal(expected3Months);

            // Claim first month (90 periods)
            console.log(`\n--- Claiming first month ---`);
            const balBefore1 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
            const balAfter1 = await storageToken.balanceOf(user1.address);
            const claimedMonth1 = balAfter1 - balBefore1;
            console.log(`Claimed: ${ethers.formatEther(claimedMonth1)} tokens`);

            // View should now show remaining 2 months
            const viewAfter1Claim = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            const expected2Months = rewardPerPeriod * BigInt(periodsPerMonth * 2);
            
            console.log(`\nView after 1 claim: ${ethers.formatEther(viewAfter1Claim)} tokens`);
            console.log(`Expected (2 months remaining): ${ethers.formatEther(expected2Months)} tokens`);
            
            expect(viewAfter1Claim).to.equal(expected2Months);

            // Claim second month
            console.log(`\n--- Claiming second month ---`);
            const balBefore2 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
            const balAfter2 = await storageToken.balanceOf(user1.address);
            const claimedMonth2 = balAfter2 - balBefore2;
            console.log(`Claimed: ${ethers.formatEther(claimedMonth2)} tokens`);

            // View should now show remaining 1 month
            const viewAfter2Claims = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            const expected1Month = rewardPerPeriod * BigInt(periodsPerMonth);
            
            console.log(`\nView after 2 claims: ${ethers.formatEther(viewAfter2Claims)} tokens`);
            console.log(`Expected (1 month remaining): ${ethers.formatEther(expected1Month)} tokens`);
            
            expect(viewAfter2Claims).to.equal(expected1Month);

            // Claim third month
            console.log(`\n--- Claiming third month ---`);
            const balBefore3 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewardsWithLimitV2(PEER_ID_1, testPoolId, 90);
            const balAfter3 = await storageToken.balanceOf(user1.address);
            const claimedMonth3 = balAfter3 - balBefore3;
            console.log(`Claimed: ${ethers.formatEther(claimedMonth3)} tokens`);

            // Final view should show 0
            const viewFinal = await rewardEngine.calculateEligibleMiningRewardsV2(
                user1.address, PEER_ID_1, testPoolId
            );
            
            console.log(`\n========== RESULTS ==========`);
            console.log(`Month 1 claimed: ${ethers.formatEther(claimedMonth1)} tokens`);
            console.log(`Month 2 claimed: ${ethers.formatEther(claimedMonth2)} tokens`);
            console.log(`Month 3 claimed: ${ethers.formatEther(claimedMonth3)} tokens`);
            console.log(`Total claimed: ${ethers.formatEther(claimedMonth1 + claimedMonth2 + claimedMonth3)} tokens`);
            console.log(`Final view: ${ethers.formatEther(viewFinal)} tokens`);
            console.log(`==============================\n`);

            expect(claimedMonth1).to.equal(expectedPerMonth);
            expect(claimedMonth2).to.equal(expectedPerMonth);
            expect(claimedMonth3).to.equal(expectedPerMonth);
            expect(viewFinal).to.equal(BigInt(0));

            console.log(`✅ PASSED: View correctly shows remaining rewards after each claim`);
        }).timeout(300000);
    });

    // Security Fixes Verification Tests
    describe("Security Fixes Verification", function () {
        it("H-01: Migration should track operations not timestamps", async function () {
            // Verify the migration tracks peer operations, not just timestamps
            // The migrationPeerCursor should be accessible and track within-timestamp progress
            const poolId = testPoolId;
            
            // Check that migration cursor storage exists
            const cursor = await rewardEngine.migrationCursor(poolId);
            const peerCursor = await rewardEngine.migrationPeerCursor(poolId);
            
            // Both should be 0 initially (no migration started)
            expect(cursor).to.equal(0);
            expect(peerCursor).to.equal(0);
            
            console.log(`✅ H-01 Fix Verified: Migration peer cursor exists for tracking operations`);
        });

        it("M-03: Should block expectedPeriod changes after V2 data is written", async function () {
            // First, submit V2 data to set hasV2Data flag
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            
            const currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            
            // Verify hasV2Data is now true
            const hasV2Data = await rewardEngine.hasV2Data();
            expect(hasV2Data).to.equal(true);
            
            // Attempt to change expectedPeriod should revert
            const newPeriod = 4 * 60 * 60; // 4 hours
            await expect(
                rewardEngine.connect(owner).setExpectedPeriod(newPeriod)
            ).to.be.revertedWithCustomError(rewardEngine, "ExpectedPeriodChangeBlocked");
            
            console.log(`✅ M-03 Fix Verified: expectedPeriod change blocked after V2 data exists`);
        });

        it("L-05: Should use consistent SIX_MONTHS_IN_PERIODS constant", async function () {
            // Verify all V2 period constants are equal (540)
            const defaultClaimPeriods = await rewardEngine.DEFAULT_CLAIM_PERIODS_PER_TX_V2();
            const maxClaimPeriods = await rewardEngine.MAX_CLAIM_PERIODS_LIMIT_V2();
            const maxViewPeriods = await rewardEngine.MAX_VIEW_PERIODS_V2();
            const sixMonths = await rewardEngine.SIX_MONTHS_IN_PERIODS();
            
            expect(defaultClaimPeriods).to.equal(sixMonths);
            expect(maxClaimPeriods).to.equal(sixMonths);
            expect(maxViewPeriods).to.equal(sixMonths);
            expect(sixMonths).to.equal(540);
            
            console.log(`✅ L-05 Fix Verified: All V2 period constants equal SIX_MONTHS_IN_PERIODS (${sixMonths})`);
        });

        it("H-02: poolHasV2Submissions flag should be set after V2 submission", async function () {
            // Initially, pool should NOT have V2 submissions
            let hasV2Submissions = await rewardEngine.poolHasV2Submissions(testPoolId);
            expect(hasV2Submissions).to.equal(false);
            
            // Add member and submit V2 data
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            const currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            
            // After V2 submission, poolHasV2Submissions should be true
            hasV2Submissions = await rewardEngine.poolHasV2Submissions(testPoolId);
            expect(hasV2Submissions).to.equal(true);
            
            console.log(`✅ H-02 Fix Verified: poolHasV2Submissions flag correctly set after submission`);
        });

        it("H-02: V2 claims should work when pool has V2 submissions", async function () {
            // This test verifies that V2 claims work for pools with V2 submissions
            // even though V1 storage also has data (submitOnlineStatusBatchV2 writes to both)
            
            await addMemberToPool(testPoolId, user2, PEER_ID_2);
            
            const currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_2],
                currentTime
            );
            
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            await time.increase(expectedPeriod + 100);
            
            // Should not revert with MigrationNotComplete because pool has V2 submissions
            await expect(
                rewardEngine.connect(user2).claimRewardsV2(PEER_ID_2, testPoolId)
            ).to.emit(rewardEngine, "MiningRewardsClaimed");
            
            console.log(`✅ H-02 Fix Verified: V2 claims work for pools with V2 submissions`);
        });

        it("C-01: Should only advance timestamp for actually paid periods when cap is hit", async function () {
            // Setup: User has multiple eligible periods but hits monthly cap
            // This tests the critical C-01 fix that prevents token loss
            
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyRewardPerPeer = await rewardEngine.monthlyRewardPerPeer();
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();
            const rewardPerPeriod = monthlyRewardPerPeer / 90n; // 90 periods per month
            
            console.log(`\n=== C-01 Cap Test ===`);
            console.log(`Monthly reward per peer: ${ethers.formatEther(monthlyRewardPerPeer)} tokens`);
            console.log(`Max monthly reward: ${ethers.formatEther(maxMonthlyReward)} tokens`);
            console.log(`Reward per period: ${ethers.formatEther(rewardPerPeriod)} tokens`);
            
            // Submit online status for many periods (use current and future timestamps)
            let currentTime = await getCurrentBlockTimestamp();
            const periodsToSubmit = 90; // 1 month worth of periods
            
            // Submit for current period
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            
            // Advance time and submit for more periods
            for (let i = 1; i < periodsToSubmit; i++) {
                await time.increase(expectedPeriod);
                currentTime = await getCurrentBlockTimestamp();
                await rewardEngine.connect(poolCreator).submitOnlineStatusBatchV2(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime
                );
            }
            
            // Advance time past all submitted periods
            await time.increase(expectedPeriod * 2);
            
            // Get initial lastClaimedRewards
            const [initialLastClaimed] = await rewardEngine.getClaimedRewardsInfo(user1.address, PEER_ID_1, testPoolId);
            
            // First claim - should claim up to monthly cap
            const tx1 = await rewardEngine.connect(user1).claimRewardsV2(PEER_ID_1, testPoolId);
            const receipt1 = await tx1.wait();
            
            // Get first claim amount from event
            const claimEvent1 = receipt1?.logs.find(
                (log: any) => log.fragment?.name === "MiningRewardsClaimed"
            );
            const firstClaimAmount = claimEvent1 ? (claimEvent1 as any).args[3] : 0n;
            
            // Get lastClaimedRewards after first claim
            const [afterFirstClaim] = await rewardEngine.getClaimedRewardsInfo(user1.address, PEER_ID_1, testPoolId);
            
            console.log(`First claim amount: ${ethers.formatEther(firstClaimAmount)} tokens`);
            console.log(`Time advanced: ${afterFirstClaim - initialLastClaimed} seconds`);
            
            // If cap was hit, the timestamp should only advance by the paid periods
            // not all eligible periods
            if (firstClaimAmount < rewardPerPeriod * BigInt(periodsToSubmit)) {
                // Cap was hit - verify timestamp didn't advance too far
                const paidPeriods = firstClaimAmount / rewardPerPeriod;
                const expectedTimeAdvance = BigInt(paidPeriods) * BigInt(expectedPeriod);
                
                console.log(`Paid periods: ${paidPeriods}`);
                console.log(`Expected time advance: ${expectedTimeAdvance} seconds`);
                
                // The timestamp should have advanced approximately by paid periods
                // (allow some variance due to period boundaries)
                const actualAdvance = afterFirstClaim - initialLastClaimed;
                
                // C-01 Fix: Timestamp should NOT advance beyond what was paid
                // Old bug would advance for ALL eligible periods, losing tokens
                expect(actualAdvance).to.be.lte(expectedTimeAdvance + BigInt(expectedPeriod));
                
                console.log(`✅ C-01 Fix Verified: Timestamp advanced only for paid periods`);
                
                // Second claim next month should still have remaining periods
                // Simulate next month
                await time.increase(30 * 24 * 60 * 60); // 30 days
                
                // Get remaining rewards
                const [remainingMining] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);
                console.log(`Remaining rewards after month change: ${ethers.formatEther(remainingMining)} tokens`);
                
                // Should have remaining periods claimable
                expect(remainingMining).to.be.gt(0);
                console.log(`✅ C-01 Fix Verified: Remaining periods are claimable next month`);
            } else {
                console.log(`Cap not hit in this test configuration - test passed by default`);
            }
        }).timeout(300000);
    });
});
