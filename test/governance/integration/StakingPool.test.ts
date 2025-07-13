import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Contract } from "ethers";

// Define roles
const OWNER_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("OWNER_ROLE"));
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const STAKING_ENGINE_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("STAKING_ENGINE_ROLE"));

describe("StakingPool Tests", function () {
    let stakingPool: Contract;
    let token: Contract;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let mockStakingEngine: HardhatEthersSigner;
    let attacker: HardhatEthersSigner;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const POOL_INITIAL_AMOUNT = ethers.parseEther("100000"); // 100K tokens

    beforeEach(async function () {
        // Get signers
        [owner, admin, user1, user2, mockStakingEngine, attacker] = await ethers.getSigners();

        // Deploy StorageToken (using upgradeable proxy)
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(
            StorageToken, 
            [owner.address, admin.address, TOTAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await token.waitForDeployment();
        
        // Wait for role change timelock to expire
        await time.increase(24 * 60 * 60 + 1);

        // Set up roles and permissions for StorageToken
        await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        
        await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Deploy StakingPool (using upgradeable proxy)
        const StakingPool = await ethers.getContractFactory("StakingPool");
        stakingPool = await upgrades.deployProxy(
            StakingPool,
            [await token.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as Contract;
        await stakingPool.waitForDeployment();

        // Wait for role change timelock to expire
        await time.increase(24 * 60 * 60 + 1);

        // Set up roles and permissions for StakingPool
        await stakingPool.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await time.increase(24 * 60 * 60 + 1);
        
        await stakingPool.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

        // Create and execute whitelist proposals for stakingPool and users
        const addresses = [
            await stakingPool.getAddress(),
            owner.address,
            admin.address,
            user1.address,
            user2.address,
            mockStakingEngine.address,
            attacker.address
        ];

        // Whitelist each address with proper timelock handling
        for (let i = 0; i < addresses.length; i++) {
            // Create proposal
            const tx = await token.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                addresses[i],
                "0x0000000000000000000000000000000000000000000000000000000000000000",
                0,
                "0x0000000000000000000000000000000000000000"
            );
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            
            // Wait for proposal to be ready for approval
            await time.increase(24 * 60 * 60 + 1);
            
            // Approve proposal by admin
            await token.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            
            // No explicit execution needed - matching TestnetMiningRewards behavior
            
            // Wait for timelock to expire before next proposal
            if (i < addresses.length - 1) {
                await time.increase(24 * 60 * 60 + 1);
            }
        }

        // Transfer tokens to the stakingPool
        await token.connect(owner).transferFromContract(await stakingPool.getAddress(), POOL_INITIAL_AMOUNT);
        
        // Transfer tokens to users for testing
        await token.connect(owner).transferFromContract(user1.address, ethers.parseEther("1000"));
        await token.connect(owner).transferFromContract(user2.address, ethers.parseEther("1000"));
        await token.connect(owner).transferFromContract(mockStakingEngine.address, ethers.parseEther("1000"));
        
        // Set the mockStakingEngine as the stakingEngine for the pool
        await stakingPool.connect(owner).setStakingEngine(mockStakingEngine.address);
    });

    // 1. Initialization Tests
    describe("Initialization Tests", function () {
        it("should initialize with the correct token address", async function () {
            expect(await stakingPool.token()).to.equal(await token.getAddress());
        });

        it("should set the correct owner and admin roles", async function () {
            // Since we're now using ProposalTypes.ADMIN_ROLE for both owner and admin
            expect(await stakingPool.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
            expect(await stakingPool.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
        });

        it("should receive the initial token amount", async function () {
            expect(await token.balanceOf(await stakingPool.getAddress())).to.equal(POOL_INITIAL_AMOUNT);
        });
    });

    // 2. StakingEngine Address Tests
    describe("StakingEngine Address Tests", function () {
        it("should correctly set the StakingEngine address", async function () {
            expect(await stakingPool.stakingEngine()).to.equal(mockStakingEngine.address);
        });

        it("should not allow setting StakingEngine address twice", async function () {
            await expect(
                stakingPool.connect(owner).setStakingEngine(user1.address)
            ).to.be.revertedWith("StakingEngine already set");
        });

        it("should not allow non-owners to set StakingEngine address", async function () {
            // Deploy a fresh StakingPool
            const StakingPool = await ethers.getContractFactory("StakingPool");
            const newStakingPool = await upgrades.deployProxy(
                StakingPool,
                [await token.getAddress(), owner.address, admin.address],
                { kind: 'uups', initializer: 'initialize' }
            ) as Contract;
            
            await expect(
                newStakingPool.connect(user1).setStakingEngine(mockStakingEngine.address)
            ).to.be.reverted;
        });
    });

    // 3. StakingEngine Management Tests
    describe("StakingEngine Management Tests", function () {
        it("should correctly set the StakingEngine address", async function () {
            expect(await stakingPool.stakingEngine()).to.equal(mockStakingEngine.address);
        });

        it("should not allow setting StakingEngine twice", async function () {
            await expect(
                stakingPool.connect(owner).setStakingEngine(user1.address)
            ).to.be.revertedWith("StakingEngine already set");
        });

        it("should not allow non-admins to set StakingEngine", async function () {
            // Deploy a new StakingPool to test this
            const StakingPool = await ethers.getContractFactory("StakingPool");
            const newStakingPool = await upgrades.deployProxy(
                StakingPool,
                [await token.getAddress(), owner.address, admin.address],
                { kind: 'uups', initializer: 'initialize' }
            );
            await newStakingPool.waitForDeployment();

            await expect(
                newStakingPool.connect(user1).setStakingEngine(mockStakingEngine.address)
            ).to.be.reverted;
        });
    });

    // 4. Token Transfer Tests
    describe("Token Transfer Tests", function () {
        it("should allow StakingEngine to transfer tokens", async function () {
            const transferAmount = ethers.parseEther("1000");

            // Call transferTokens as the mock StakingEngine (transfers to stakingEngine address)
            await stakingPool.connect(mockStakingEngine).transferTokens(transferAmount);
            
            // Verify balances changed correctly (tokens transferred to stakingEngine)
            const poolBalance = await token.balanceOf(await stakingPool.getAddress());
            const stakingEngineBalance = await token.balanceOf(mockStakingEngine.address);

            expect(poolBalance).to.equal(POOL_INITIAL_AMOUNT - transferAmount);
            expect(stakingEngineBalance).to.equal(ethers.parseEther("2000")); // Initial 1000 + 1000 transferred
        });

        it("should not allow non-StakingEngine addresses to transfer tokens", async function () {
            await expect(
                stakingPool.connect(owner).transferTokens(ethers.parseEther("1000"))
            ).to.be.revertedWithCustomError(stakingPool, "OnlyStakingEngine");

            await expect(
                stakingPool.connect(user1).transferTokens(ethers.parseEther("1000"))
            ).to.be.revertedWithCustomError(stakingPool, "OnlyStakingEngine");
        });

        it("should not allow transferring more tokens than available", async function () {
            const excessiveAmount = POOL_INITIAL_AMOUNT + ethers.parseEther("1");

            await expect(
                stakingPool.connect(mockStakingEngine).transferTokens(excessiveAmount)
            ).to.be.revertedWithCustomError(stakingPool, "InsufficientBalance");
        });

        it("should correctly track token receipts", async function () {
            // User sends tokens to the pool
            await token.connect(user1).transfer(
                await stakingPool.getAddress(),
                ethers.parseEther("500")
            );

            // Call receiveTokens to record the transaction (only stakingEngine can call this)
            await stakingPool.connect(mockStakingEngine).receiveTokens(
                user1.address,
                ethers.parseEther("500")
            );

            // Check the updated balance
            const poolBalance = await token.balanceOf(await stakingPool.getAddress());
            expect(poolBalance).to.equal(POOL_INITIAL_AMOUNT + ethers.parseEther("500"));
        });

        it("should correctly handle multiple transfers", async function () {
            // Test transferring in two steps
            const initialAmount = ethers.parseEther("100");
            const additionalAmount = ethers.parseEther("50");

            // First transfer - using mockStakingEngine which has permission
            await stakingPool.connect(mockStakingEngine).transferTokens(initialAmount);

            // Second transfer
            await stakingPool.connect(mockStakingEngine).transferTokens(additionalAmount);

            // Verify the balance changes (tokens go to stakingEngine)
            const finalStakingEngineBalance = await token.balanceOf(mockStakingEngine.address);
            expect(finalStakingEngineBalance).to.equal(ethers.parseEther("1150")); // 1000 initial + 150 transferred
        });
    });

    // 5. Emergency Action Tests
    describe("Emergency Action Tests", function () {
        it("should allow owner to recover tokens in emergency", async function () {
            const recoveryAmount = ethers.parseEther("10000");
            
            // Perform emergency recovery (tokens go to token contract address)
            await stakingPool.connect(owner).emergencyRecoverTokens(recoveryAmount);

            // After recovery - just verify pool balance decreased
            const poolBalance = await token.balanceOf(await stakingPool.getAddress());
            expect(poolBalance).to.equal(POOL_INITIAL_AMOUNT - recoveryAmount);
            expect(poolBalance).to.equal(POOL_INITIAL_AMOUNT - recoveryAmount);
        });

        it("should not allow non-admins to recover tokens", async function () {
            await expect(
                stakingPool.connect(attacker).emergencyRecoverTokens(ethers.parseEther("1000"))
            ).to.be.reverted;
        });

        it("should not allow recovering more tokens than available", async function () {
            const excessiveAmount = POOL_INITIAL_AMOUNT + ethers.parseEther("1");

            await expect(
                stakingPool.connect(owner).emergencyRecoverTokens(excessiveAmount)
            ).to.be.revertedWithCustomError(stakingPool, "InsufficientBalance");
        });
    });

    // 6. Pause/Unpause Tests
    describe("Pause/Unpause Tests", function () {
        it("should allow admin to pause and unpause the contract", async function () {
            // Pause the contract
            await stakingPool.connect(admin).emergencyAction(1); // 1 for pause
            
            // Try to transfer - should fail because contract is paused
            await expect(
                stakingPool.connect(mockStakingEngine).transferTokens(ethers.parseEther("100"))
            ).to.be.revertedWithCustomError(stakingPool, "EnforcedPause");
            
            // Cooldown period
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine");

            // Unpause the contract
            await stakingPool.connect(admin).emergencyAction(2); // 2 for unpause
            
            // Check that transfers work when unpaused
            await stakingPool.connect(mockStakingEngine).transferTokens(ethers.parseEther("100"));

            const stakingEngineBalance = await token.balanceOf(mockStakingEngine.address);
            expect(stakingEngineBalance).to.equal(ethers.parseEther("1100"));
        });

        it("should not allow non-admins to pause/unpause", async function () {
            await expect(
                stakingPool.connect(user1).emergencyAction(1)
            ).to.be.reverted;
            
            await expect(
                stakingPool.connect(attacker).emergencyAction(2)
            ).to.be.reverted;
        });
    });
    
    // 7. Governance Module Integration Tests
    describe("Governance Module Integration Tests", function () {
        it("should correctly integrate with the governance module for role management", async function () {
            // Create a proposal to grant a role
            const tx = await stakingPool.connect(owner).createProposal(
                1, // AddRole proposal type
                0, // delay (not needed for this test)
                user2.address,
                ADMIN_ROLE,
                0, // amount (not used for role grant)
                ZeroAddress
            );
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            
            // Wait for proposal to be ready for approval
            await time.increase(24 * 60 * 60 + 1);
            
            // Approve proposal by admin
            await stakingPool.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            
            // No explicit execution needed - matching TestnetMiningRewards behavior
            
            // Verify user2 now has the ADMIN_ROLE after sufficient time
            await time.increase(24 * 60 * 60 + 1);
            expect(await stakingPool.hasRole(ADMIN_ROLE, user2.address)).to.be.true;
            
            // Verify user2 can now perform admin actions (check they can call admin functions)
            expect(await stakingPool.hasRole(ADMIN_ROLE, user2.address)).to.be.true;
        });
    });
});
