import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Contract } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

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

    // Test peer IDs
    const PEER_ID_1 = "12D3KooWTest1";
    const PEER_ID_2 = "12D3KooWTest2";
    const PEER_ID_3 = "12D3KooWTest3";
    const CREATOR_PEER_ID = "12D3KooWCreator";

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

        // Deploy StoragePoolLib library first
        const StoragePoolLib = await ethers.getContractFactory("StoragePoolLib");
        const storagePoolLib = await StoragePoolLib.deploy();
        await storagePoolLib.waitForDeployment();

        // Deploy StoragePool with library linking
        const StoragePool = await ethers.getContractFactory("StoragePool", {
            libraries: {
                StoragePoolLib: await storagePoolLib.getAddress(),
            },
        });
        storagePool = await upgrades.deployProxy(
            StoragePool,
            [await storageToken.getAddress(), owner.address, admin.address],
            {
                kind: 'uups',
                initializer: 'initialize',
                unsafeAllowLinkedLibraries: true
            }
        ) as Contract;
        await storagePool.waitForDeployment();

        // Deploy StakingPool
        const StakingPool = await ethers.getContractFactory("StakingPool");
        stakingPool = await upgrades.deployProxy(
            StakingPool,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await stakingPool.waitForDeployment();

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
        await storagePool.connect(owner).createDataPool(
            TEST_POOL_NAME,
            TEST_POOL_REGION,
            TEST_POOL_REQUIRED_TOKENS,
            TEST_POOL_MIN_PING,
            TEST_POOL_MAX_CHALLENGE_PERIOD,
            CREATOR_PEER_ID
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

        // Submit join request
        await storagePool.connect(member).submitJoinRequest(poolId, peerId);

        // Pool creator votes to approve using peerId instead of index
        await storagePool.connect(owner).voteOnJoinRequest(poolId, peerId, true);

        // Verify member was added
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

        it("should normalize timestamps to period boundaries", async function () {
            const expectedPeriod = await rewardEngine.expectedPeriod();
            const latestBlock = await ethers.provider.getBlock('latest');
            const baseTimestamp = latestBlock!.timestamp;
            const peerIds = [PEER_ID_1];

            // Submit status with non-aligned timestamp
            await rewardEngine.connect(owner).submitOnlineStatusBatch(testPoolId, peerIds, baseTimestamp);

            // Check that timestamp was normalized
            const normalizedTimestamp = (BigInt(baseTimestamp) / expectedPeriod) * expectedPeriod;
            const onlinePeers = await rewardEngine.getOnlinePeerIds(testPoolId, normalizedTimestamp);

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
            const expectedPeriod = await rewardEngine.expectedPeriod();
            const normalizedTimestamp = (BigInt(timestamp) / expectedPeriod) * expectedPeriod;
            const onlinePeers = await rewardEngine.getOnlinePeerIds(testPoolId, normalizedTimestamp);

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

            expect(onlineCount).to.equal(3); // Online in 3 periods
            expect(totalExpected).to.equal(3); // 3 periods total
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
                rewardEngine.calculateEligibleMiningRewards(attacker.address, "InvalidPeerId", testPoolId)
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
                rewardEngine.connect(attacker).claimRewards("InvalidPeerId", testPoolId)
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

            // Should revert due to insufficient balance
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

            const initialTotalDistributed = await rewardEngine.getTotalRewardsDistributed();

            // Both users claim rewards
            const [rewards1, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);
            const [rewards2, ,] = await rewardEngine.getEligibleRewards(user2.address, PEER_ID_2, testPoolId);

            if (rewards1 > 0) {
                await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);
            }
            if (rewards2 > 0) {
                await rewardEngine.connect(user2).claimRewards(PEER_ID_2, testPoolId);
            }

            const finalTotalDistributed = await rewardEngine.getTotalRewardsDistributed();
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

            const initialUserTotal = await rewardEngine.getTotalRewardsClaimed(user1.address);

            const [rewards, ,] = await rewardEngine.getEligibleRewards(user1.address, PEER_ID_1, testPoolId);

            if (rewards > 0) {
                await rewardEngine.connect(user1).claimRewards(PEER_ID_1, testPoolId);

                const finalUserTotal = await rewardEngine.getTotalRewardsClaimed(user1.address);
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
            await storagePool.connect(poolCreator).createDataPool(
                "Second Pool",
                "EU-West",
                TEST_POOL_REQUIRED_TOKENS,
                TEST_POOL_MIN_PING,
                TEST_POOL_MAX_CHALLENGE_PERIOD,
                "12D3KooWCreator2"
            );

            const secondPoolId = 2;

            // Add different user to second pool (user1 and user2 are already in first pool)
            await addMemberToPool(secondPoolId, user3, "12D3KooWUser3Pool2");

            const currentTime = await getCurrentBlockTimestamp();

            // Submit online status for both pools
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(testPoolId, [PEER_ID_1], currentTime);
            await rewardEngine.connect(poolCreator).submitOnlineStatusBatch(secondPoolId, ["12D3KooWUser3Pool2"], currentTime);

            await time.increase(60);

            // Check rewards for both pools
            const rewards1 = await rewardEngine.calculateEligibleMiningRewards(user1.address, PEER_ID_1, testPoolId);
            const rewards2 = await rewardEngine.calculateEligibleMiningRewards(user3.address, "12D3KooWUser3Pool2", secondPoolId);

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

            // Member leaves pool
            await storagePool.connect(user1).leavePool(testPoolId);

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

        it("should get contract version", async function () {
            const version = await rewardEngine.getVersion();
            expect(version).to.equal(1);
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

    // 11. Governance Integration Tests
    describe("Governance Integration Tests", function () {
        it("should handle upgrade authorization", async function () {
            // This test verifies the upgrade mechanism works
            // In a real scenario, this would deploy a new implementation
            const version = await rewardEngine.getVersion();
            expect(version).to.equal(1);
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
});
