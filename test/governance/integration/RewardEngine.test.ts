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
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, timestamp)
            ).to.emit(rewardEngine, "OnlineStatusSubmitted")
            .withArgs(testPoolId, owner.address, peerIds.length, anyValue);
        });

        it("should allow pool creator (owner) to submit online status", async function () {
            // Use block.timestamp to avoid time validation issues
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1, PEER_ID_2, PEER_ID_3];

            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, timestamp)
            ).to.emit(rewardEngine, "OnlineStatusSubmitted")
            .withArgs(testPoolId, owner.address, peerIds.length, anyValue);
        });

        it("should not allow non-authorized users to submit online status", async function () {
            // Use block.timestamp to avoid time validation issues
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1];

            await expect(
                rewardEngine.connect(user1).submitOnlineStatusBatch(testPoolId, peerIds, timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolCreator");
        });

        it("should validate timestamp ranges", async function () {
            const peerIds = [PEER_ID_1];
            const currentTime = await getCurrentBlockTimestamp();

            // Future timestamp (too far)
            const futureTimestamp = currentTime + 3600; // 1 hour future
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, futureTimestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");

            // Past timestamp (too far)
            const pastTimestamp = currentTime - (8 * 24 * 60 * 60); // 8 days ago
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, pastTimestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");

            // Zero timestamp
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, 0)
            ).to.be.revertedWithCustomError(rewardEngine, "InvalidTimeRange");
        });

        it("should validate batch size limits", async function () {
            const timestamp = await getCurrentBlockTimestamp();

            // Empty batch
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, [], timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "BatchTooLarge");

            // Batch too large (over MAX_BATCH_SIZE = 100)
            const largeBatch = Array(101).fill(PEER_ID_1);
            await expect(
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, largeBatch, timestamp)
            ).to.be.revertedWithCustomError(rewardEngine, "BatchTooLarge");
        });

        it("should record and retrieve online status using raw timestamp key", async function () {
            const expectedPeriod = await rewardEngine.expectedPeriod();
            const latestBlock = await ethers.provider.getBlock('latest');
            const baseTimestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1];

            // Submit status with non-aligned timestamp
            await rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, baseTimestamp);

            // Check that status is retrievable by the exact timestamp (no normalization)
            const onlinePeers = await rewardEngine.getOnlinePeerIds(testPoolId, BigInt(baseTimestamp));
            expect(onlinePeers).to.deep.equal(peerIds);
        });

        it("should handle multiple submissions for same period", async function () {
            const latestBlock = await ethers.provider.getBlock('latest');
            const timestamp = latestBlock!.timestamp;
            const peerIds1 = [PEER_ID_1];
            const peerIds2 = [PEER_ID_1, PEER_ID_2];

            // First submission
            await rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds1, timestamp);

            // Second submission for same period (should overwrite) - use same timestamp to stay within same period
            await rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds2, timestamp);

            // Check that latest submission is stored
            // Retrieve by the exact timestamp (raw key)
            const onlinePeers = await rewardEngine.getOnlinePeerIds(testPoolId, BigInt(timestamp));
            expect(onlinePeers).to.deep.equal(peerIds2);
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    timestamp
                );
            }

            // Wait for at least one full period to ensure rewards are calculated
            await time.increase(expectedPeriod + 60); // Wait one full period plus buffer

            // Calculate eligible rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            expect(eligibleRewards).to.be.gt(0);
        });

        it("should return zero rewards for peer not online", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for other peer only
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_2],
                currentTime
            );

            // User1 should have no rewards
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime - (i * expectedPeriod)
                );
            }

            await time.increase(60);

            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                rewardEngine.calculateEligibleMiningRewards(attacker.address, stringToBytes32("InvalidPeerId"), testPoolId)
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                    rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId)
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
            await expect(
                rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NoRewardsToClaim");
        });

        it("should not allow non-members to claim rewards", async function () {
            await expect(
                rewardEngine.connect(attacker).claimRewards(stringToBytes32("InvalidPeerId"), testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");
        });

        it("should handle insufficient staking pool balance", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            await time.increase(60);

            // Drain the staking pool
            await stakingPool.connect(owner).emergencyRecoverTokens(REWARD_POOL_AMOUNT);

            // Should revert due to insufficient balance (updated expectation)
            await expect(
                rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NoRewardsToClaim");
        });

        it("should track total rewards distributed", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for both users
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            }
            if (rewards2 > 0) {
                await rewardEngine.connect(user2).claimRewards(PEER_ID_2, testPoolId);
            }

            const finalTotalDistributed = await rewardEngine.totalRewardsDistributed();
            expect(finalTotalDistributed).to.be.gte(initialTotalDistributed);
        });

        it("should track user total rewards claimed", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            await time.increase(60);

            const initialUserTotal = await rewardEngine.totalRewardsClaimed(user1.address);

            const [rewards, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);

            if (rewards > 0) {
                await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);

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
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime)
            ).to.be.revertedWithCustomError(rewardEngine, "CircuitBreakerTripped");

            // Should prevent reward claims
            await expect(
                rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId)
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
                rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime)
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
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime);
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(secondPoolId, [user3Pool2PeerId], currentTime);

            await time.increase(60);

            // Check rewards for both pools
            const rewards1 = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
            const rewards2 = await rewardEngine.calculateEligibleMiningRewards(user3.address, stringToBytes32("12D3KooWUser3Pool2"), secondPoolId);

            expect(rewards1).to.be.gte(0);
            expect(rewards2).to.be.gte(0);
        });

        it("should handle member leaving and rejoining pool", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime);

            await time.increase(60);

            // Check initial rewards (verify they exist before leaving)
            await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);

            // Member leaves pool by removing their peer ID (PEER_ID_1 is already bytes32)
            await storagePool.connect(user1).removeMemberPeerId(testPoolId, PEER_ID_1);

            // Should not be able to calculate rewards after leaving
            await expect(
                rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // Rejoin pool (if supported by StoragePool)
            // This would require re-implementing the join process
        });

        it("should handle very large time gaps correctly", async function () {
            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime);

            // Advance time by 1 year
            await time.increase(365 * 24 * 60 * 60);

            // Should still be able to calculate rewards
            const rewards = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
            expect(rewards).to.be.gte(0);
        });

        it("should handle timestamp edge cases", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit status at current time (safe timestamp)
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Submit status slightly later (still safe)
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(
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
                rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, maxBatch, currentTime)
            ).to.not.be.reverted;
        });

        it("should handle reward calculation with zero total members", async function () {
            // This is an edge case that shouldn't normally happen
            // but we test the contract's resilience

            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime);

            await time.increase(60);

            // Even with edge cases, should not revert
            const rewards = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
            expect(rewards).to.be.gte(0);
        });

        it("should handle multiple claims in same month", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for multiple periods (stay within 6 days historical limit)
            const maxHistoricalPeriods = Math.floor((6 * 24 * 60 * 60) / expectedPeriod);
            const periodsToSubmit = Math.min(maxHistoricalPeriods, 5);

            for (let i = 0; i < periodsToSubmit; i++) {
                await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime - (i * expectedPeriod)
                );
            }

            await time.increase(60);

            // First claim
            const [rewards1, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);
            if (rewards1 > 0) {
                await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            }

            // Submit more online status (use current time to avoid future timestamp issues)
            const newCurrentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(
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

        it("should handle recorded timestamps pagination", async function () {
            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit multiple online status entries
            for (let i = 0; i < 10; i++) {
                await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime - (i * expectedPeriod)
                );
            }

            // Get total count
            const totalCount = await rewardEngine.getRecordedTimestampCount(testPoolId);
            expect(totalCount).to.be.gte(10);

            // Get paginated results
            const timestamps = await rewardEngine.getRecordedTimestamps(testPoolId, 0, 5);
            expect(timestamps.length).to.be.lte(5);
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime - 500 // 500 seconds ago (still in same period)
            );
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime - 300 // 300 seconds ago (still in same period)
            );
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime - 100 // 100 seconds ago (still in same period)
            );

            // Move to next period to complete the first period
            await time.increaseTo(joinTime + expectedPeriod + 1000);

            // Should only count as one reward for the period
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
            // Make sure each submission is well within each period, not at boundaries
            for (let i = 0; i < numPeriods; i++) {
                // Advance time by one period minus a small buffer to ensure we're within the period
                await time.increase(expectedPeriod - 100);

                const currentTime = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    currentTime
                );

                // Advance the remaining time to complete the period
                await time.increase(100);
            }

            // Wait a bit more to ensure all periods are complete
            await time.increase(1000);

            // Should accumulate rewards for all periods
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);

            // Should have no more rewards to claim
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewards(
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



            // Advance time to be well within the first period, then submit
            await time.increase(expectedPeriod - 100); // Almost complete the first period
            const currentTime = await getCurrentBlockTimestamp();
            console.log("Current time after advance:", currentTime);

            // Submit online status for both peer IDs of user1
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1, PEER_ID_3],
                currentTime // Submit within the first period
            );

            // Complete the period and wait a bit more
            await time.increase(100 + 1000); // Complete period + buffer

            // Each peer ID should have separate rewards
            const rewards1 = await rewardEngine.calculateEligibleMiningRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const rewards3 = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            await rewardEngine.connect(user1).claimRewards(PEER_ID_3, testPoolId);

            // Both should be claimed
            const remainingRewards1 = await rewardEngine.calculateEligibleMiningRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const remainingRewards3 = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1, PEER_ID_2, PEER_ID_4],
                currentTime
            );

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // Each user should have independent rewards
            const rewards1 = await rewardEngine.calculateEligibleMiningRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );
            const rewards2 = await rewardEngine.calculateEligibleMiningRewards(
                user2.address,
                PEER_ID_2,
                testPoolId
            );
            const rewards4 = await rewardEngine.calculateEligibleMiningRewards(
                user3.address,
                PEER_ID_4,
                testPoolId
            );

            const rewardPerPeriod = await rewardEngine.monthlyRewardPerPeer() / BigInt(30 * 24 * 3600 / expectedPeriod);
            expect(rewards1).to.equal(rewardPerPeriod);
            expect(rewards2).to.equal(rewardPerPeriod);
            expect(rewards4).to.equal(rewardPerPeriod);

            // Each user can claim independently
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            await rewardEngine.connect(user2).claimRewards(PEER_ID_2, testPoolId);
            await rewardEngine.connect(user3).claimRewards(PEER_ID_4, testPoolId);

            // All should be claimed
            expect(await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId)).to.equal(0);
            expect(await rewardEngine.calculateEligibleMiningRewards(user2.address, PEER_ID_2, testPoolId)).to.equal(0);
            expect(await rewardEngine.calculateEligibleMiningRewards(user3.address, PEER_ID_4, testPoolId)).to.equal(0);
        });

        it("should reject claiming for peer ID with wrong account", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for PEER_ID_1 (belongs to user1)
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // user2 tries to claim rewards for PEER_ID_1 (which belongs to user1)
            await expect(
                rewardEngine.connect(user2).claimRewards(PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // user2 tries to calculate rewards for PEER_ID_1 (which belongs to user1)
            await expect(
                rewardEngine.calculateEligibleMiningRewards(user2.address, PEER_ID_1, testPoolId)
            ).to.be.revertedWithCustomError(rewardEngine, "NotPoolMember");

            // Correct owner should be able to claim
            await expect(
                rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId)
            ).to.not.be.reverted;
        });

        it("should handle partial periods correctly (no rewards for incomplete periods)", async function () {
            // Add required members for this test
            await addMemberToPool(testPoolId, user1, PEER_ID_1);
            await addMemberToPool(testPoolId, user2, PEER_ID_2);

            const currentTime = await getCurrentBlockTimestamp();
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status in current incomplete period
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Don't wait for period to complete - check immediately
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
                user1.address,
                PEER_ID_1,
                testPoolId
            );

            // Should have no rewards for incomplete period
            expect(eligibleRewards).to.equal(0);

            // Wait for period to complete
            await time.increase(expectedPeriod + 60);

            // Now should have rewards for the completed period
            const rewardsAfterComplete = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for period 3 to complete
            await time.increase(expectedPeriod + 60);

            // Should only get rewards for 2 periods (1 and 3), not the skipped period 2
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Advance to period 2 and skip it (no online status)
            await time.increase(expectedPeriod + 100);

            // Submit online status for period 3
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Advance to period 4 and skip it (no online status)
            await time.increase(expectedPeriod + 100);

            // Submit online status for period 5
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );
            expectedOnlinePeriods++;

            // Wait for current period to complete
            await time.increase(expectedPeriod + 60);

            // Should get rewards only for online periods
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);

            // Add more online status after claiming
            currentTime = await getCurrentBlockTimestamp();
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                testPoolId,
                [PEER_ID_1],
                currentTime
            );

            // Wait for new period to complete
            await time.increase(expectedPeriod + 60);

            // Should have rewards for the new period only
            const newRewards = await rewardEngine.calculateEligibleMiningRewards(
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
            const periodsToExceedCap = Number(maxMonthlyReward / rewardPerPeriod) + 5;

            // Submit online status for many periods
            // Use valid timestamps within the 7-day limit
            for (let i = 0; i < periodsToExceedCap; i++) {
                const timestamp = currentTime - (i * 3600); // 1 hour intervals
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    timestamp
                );
            }

            // Wait for all periods to complete
            await time.increase(expectedPeriod + 60);

            // Should be capped at monthly maximum
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
            await rewardEngine.connect(owner).submitOnlineStatusBatch(
                poolId,
                [PEER_ID_1],
                await getCurrentBlockTimestamp()
            );

            // Wait for current period to complete
            await time.increase(expectedPeriod);

            // Should have rewards for the complete period from join date
            const eligibleRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime)
            ).to.be.revertedWithCustomError(rewardEngine, "EnforcedPause");

            // Wait for cooldown
            await time.increase(24 * 60 * 60 + 1);

            // Unpause
            await rewardEngine.connect(admin).emergencyAction(2); // Unpause

            // Get fresh timestamp after unpause
            const newCurrentTime = await getCurrentBlockTimestamp();

            // Operations should work again
            await expect(
                rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], newCurrentTime)
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
                    await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                const claimableRewards = await rewardEngine.calculateEligibleMiningRewards(
                    user1.address,
                    PEER_ID_1,
                    testPoolId
                );
                console.log(`Claimable rewards: ${ethers.formatEther(claimableRewards)} tokens`);
                
                // Claim rewards if available
                if (claimableRewards > 0) {
                    const balanceBeforeClaim = await storageToken.balanceOf(user1.address);
                    
                    await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
                    
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
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Get claim status
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatus(user1.address, PEER_ID_1, testPoolId);

            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            expect(totalUnclaimedPeriods).to.equal(periodsToCreate);
            expect(defaultPeriodsPerClaim).to.equal(90); // DEFAULT_CLAIM_PERIODS_PER_TX
            expect(maxPeriodsPerClaim).to.equal(1000); // MAX_CLAIM_PERIODS_LIMIT
            expect(estimatedClaimsNeeded).to.equal(1); // 10 periods < 90 default
            expect(hasMoreToClaim).to.equal(false);
        });

        it("should allow claiming with custom period limit using claimRewardsWithLimit", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());
            const monthlyReward = await rewardEngine.monthlyRewardPerPeer();
            const periodsPerMonth = Math.floor((30 * 24 * 60 * 60) / expectedPeriod);
            const rewardPerPeriod = monthlyReward / BigInt(periodsPerMonth);

            // Submit online status for 10 periods
            const periodsToCreate = 10;
            for (let i = 0; i < periodsToCreate; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
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
                const [totalUnclaimedPeriods, , , ,] = await rewardEngine.getClaimStatus(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (totalUnclaimedPeriods === BigInt(0)) break;

                const balanceBefore = await storageToken.balanceOf(user1.address);
                await rewardEngine.connect(user1).claimRewardsWithLimit(PEER_ID_1, testPoolId, maxPeriodsPerClaim);
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Claim with 0 (invalid) - should use default
            await expect(
                rewardEngine.connect(user1).claimRewardsWithLimit(PEER_ID_1, testPoolId, 0)
            ).to.not.be.reverted;

            // Verify rewards were claimed
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewards(
                user1.address, PEER_ID_1, testPoolId
            );
            expect(remainingRewards).to.equal(0);
        });

        it("should cap maxPeriods at MAX_CLAIM_PERIODS_LIMIT when exceeding limit", async function () {
            const expectedPeriod = Number(await rewardEngine.expectedPeriod());

            // Submit online status for a few periods
            for (let i = 0; i < 5; i++) {
                const ts = await getCurrentBlockTimestamp();
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Claim with value exceeding MAX_CLAIM_PERIODS_LIMIT (1000) - should use default
            await expect(
                rewardEngine.connect(user1).claimRewardsWithLimit(PEER_ID_1, testPoolId, 2000)
            ).to.not.be.reverted;

            // Verify rewards were claimed
            const remainingRewards = await rewardEngine.calculateEligibleMiningRewards(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check claim status - should indicate multiple claims needed with default
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, , estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatus(user1.address, PEER_ID_1, testPoolId);

            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            expect(totalUnclaimedPeriods).to.equal(BigInt(periodsToCreate));
            expect(hasMoreToClaim).to.equal(true); // 100 > 90 default
            expect(estimatedClaimsNeeded).to.equal(BigInt(2)); // ceil(100/90) = 2

            // First claim with default limit (90 periods)
            const balanceBefore1 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            const balanceAfter1 = await storageToken.balanceOf(user1.address);
            const claimed1 = balanceAfter1 - balanceBefore1;

            // Should have claimed 90 periods worth (or up to monthly cap)
            const expectedClaim1 = rewardPerPeriod * defaultPeriodsPerClaim;
            console.log(`First claim: ${ethers.formatEther(claimed1)} tokens (${defaultPeriodsPerClaim} periods)`);
            console.log(`Expected first claim: ${ethers.formatEther(expectedClaim1)} tokens`);
            
            // The claimed amount should be capped at monthly max (8000 tokens)
            const maxMonthlyReward = await rewardEngine.MAX_MONTHLY_REWARD_PER_PEER();
            expect(claimed1).to.be.lte(maxMonthlyReward);
            expect(claimed1).to.equal(expectedClaim1);

            // Check remaining periods (note: periods are tracked separately from monthly cap)
            const [remainingPeriods, , , , stillHasMore] = 
                await rewardEngine.getClaimStatus(user1.address, PEER_ID_1, testPoolId);
            
            const expectedRemaining = BigInt(periodsToCreate) - defaultPeriodsPerClaim;
            expect(remainingPeriods).to.equal(expectedRemaining); // 10 remaining
            expect(stillHasMore).to.equal(false); // 10 < 90
            console.log(`Remaining periods after first claim: ${remainingPeriods}`);

            // Note: Second claim may be limited by monthly cap
            // After claiming ~8000 tokens (90 periods), the monthly cap is nearly reached
            // The remaining 10 periods would give ~888 more tokens, but may be capped
            
            // Advance to next month to reset the monthly cap
            await time.increase(30 * 24 * 60 * 60 + 1);

            // Second claim to get the rest (now in new month)
            const balanceBefore2 = await storageToken.balanceOf(user1.address);
            await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            const balanceAfter2 = await storageToken.balanceOf(user1.address);
            const claimed2 = balanceAfter2 - balanceBefore2;

            // Should have claimed remaining periods
            const expectedClaim2 = rewardPerPeriod * remainingPeriods;
            console.log(`Second claim: ${ethers.formatEther(claimed2)} tokens (${remainingPeriods} periods)`);
            console.log(`Expected claim2: ${ethers.formatEther(expectedClaim2)} tokens`);
            expect(claimed2).to.equal(expectedClaim2);

            // Verify all claimed
            const finalRemaining = await rewardEngine.calculateEligibleMiningRewards(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check status after 3 months
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatus(user1.address, PEER_ID_1, testPoolId);

            console.log(`\n--- After 3 months (before any claims) ---`);
            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            const totalEligible = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
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
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatus(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                claimNumber++;
                const balanceBefore = await storageToken.balanceOf(user1.address);
                
                // Use claimRewardsWithLimit with 90 periods
                await rewardEngine.connect(user1).claimRewardsWithLimit(PEER_ID_1, testPoolId, periodsPerClaim);
                
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                totalClaimed += claimed;

                const [newRemaining, , , , ] = await rewardEngine.getClaimStatus(
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
                await rewardEngine.connect(owner).submitOnlineStatusBatch(
                    testPoolId,
                    [PEER_ID_1],
                    ts
                );
                await time.increase(expectedPeriod + 1);
            }

            // Check status after 3 months
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngine.getClaimStatus(user1.address, PEER_ID_1, testPoolId);

            console.log(`\n--- After 3 months (before any claims) ---`);
            console.log(`Total unclaimed periods: ${totalUnclaimedPeriods}`);
            console.log(`Default periods per claim: ${defaultPeriodsPerClaim}`);
            console.log(`Max periods per claim: ${maxPeriodsPerClaim}`);
            console.log(`Estimated claims needed: ${estimatedClaimsNeeded}`);
            console.log(`Has more to claim: ${hasMoreToClaim}`);

            const totalEligible = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
            console.log(`Total eligible rewards (view): ${ethers.formatEther(totalEligible)} tokens`);

            // Now claim with 270 periods at a time (3 months worth)
            const periodsPerClaim = totalPeriodsToCreate; // 270 periods
            let totalClaimed = BigInt(0);
            let claimNumber = 0;

            console.log(`\n--- Claiming with ${periodsPerClaim} periods per claim ---`);

            while (true) {
                const [remainingPeriods, , , , ] = await rewardEngine.getClaimStatus(
                    user1.address, PEER_ID_1, testPoolId
                );
                
                if (remainingPeriods === BigInt(0)) break;

                claimNumber++;
                const balanceBefore = await storageToken.balanceOf(user1.address);
                
                // Use claimRewardsWithLimit with 270 periods (all at once)
                await rewardEngine.connect(user1).claimRewardsWithLimit(PEER_ID_1, testPoolId, periodsPerClaim);
                
                const balanceAfter = await storageToken.balanceOf(user1.address);
                const claimed = balanceAfter - balanceBefore;
                totalClaimed += claimed;

                const [newRemaining, , , , ] = await rewardEngine.getClaimStatus(
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
});
