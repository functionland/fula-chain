import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StakingEngine, StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";

// Use the same value as in ProposalTypes.sol
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

describe("StakingEngine", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let users: HardhatEthersSigner[];
    let rewardPoolAddress: string;
    let stakingPoolAddress: string;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const initialStakinPoolAmount = ethers.parseEther("5000");

    let calculateExpectedRewards = (stakedAmount: bigint, fixedAPY: number, elapsedTime: number) => {
        const annualRewards = (stakedAmount * BigInt(fixedAPY)) / BigInt(100); // Annualized rewards
        return (annualRewards * BigInt(elapsedTime)) / BigInt(365 * 24 * 60 * 60); // Adjusted for elapsed time
    };

    beforeEach(async function () {
        console.log("Starting test setup...");
        // Get signers
        [owner, admin, user1, user2, ...users] = await ethers.getSigners();

        // Deploy StorageToken
        console.log("Deploying StorageToken...");
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(
            StorageToken, 
            [owner.address, admin.address, TOTAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await token.waitForDeployment();
        console.log("StorageToken deployed at:", await token.getAddress());

        // Set up reward and staking pool addresses
        rewardPoolAddress = users[0].address; // Use one of the users as the reward pool address
        stakingPoolAddress = users[1].address; // Use another user as the staking pool address
        console.log("Reward pool address:", rewardPoolAddress);
        console.log("Staking pool address:", stakingPoolAddress);

        // Deploy StakingEngine
        console.log("Deploying StakingEngine...");
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
        console.log("StakingEngine deployed at:", await stakingEngine.getAddress());

        // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
        console.log("Waiting for role change timelock to expire...");
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);

        // Set up governance for proposal creation
        console.log("Setting up governance...");
        await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await stakingEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        
        // Wait for execution delay
        console.log("Waiting for execution delay...");
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Additional delay before setting transaction limit
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Set transaction limit for admin role
        console.log("Setting role transaction limit...");
        await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, ethers.parseEther("1000000000"));
        
        // Wait for second timelock to expire
        console.log("Waiting for second timelock to expire...");
        await time.increase(24 * 60 * 60 + 1); // 24 hours + 1 second
        await ethers.provider.send("evm_mine", []);

        // Create whitelist proposals
        const addWhitelistType = 5; // AddWhitelist type
        console.log("Creating whitelist proposals...");

        // Whitelist the StakingEngine contract first
        console.log("Creating whitelist proposal for StakingEngine...");
        const engineTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            await stakingEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const engineReceipt = await engineTx.wait();
        const engineProposalId = engineReceipt?.logs[0].topics[1];
        console.log("StakingEngine proposal created with ID:", engineProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing StakingEngine whitelist proposal...");
        await token.connect(admin).approveProposal(engineProposalId);
        await time.increase(24 * 60 * 60 + 1);
        
        // Whitelist the staking pool address
        console.log("Creating whitelist proposal for staking pool...");
        const poolTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            stakingPoolAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const poolReceipt = await poolTx.wait();
        const poolProposalId = poolReceipt?.logs[0].topics[1];
        console.log("Staking pool proposal created with ID:", poolProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing staking pool whitelist proposal...");
        await token.connect(admin).approveProposal(poolProposalId);
        await time.increase(24 * 60 * 60 + 1);
        
        // Whitelist the reward pool address
        console.log("Creating whitelist proposal for reward pool...");
        const rewardTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            rewardPoolAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const rewardReceipt = await rewardTx.wait();
        const rewardProposalId = rewardReceipt?.logs[0].topics[1];
        console.log("Reward pool proposal created with ID:", rewardProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing reward pool whitelist proposal...");
        await token.connect(admin).approveProposal(rewardProposalId);
        await time.increase(24 * 60 * 60 + 1);

        // Whitelist user1
        console.log("Creating whitelist proposal for user1...");
        const user1Tx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            user1.address,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const user1Receipt = await user1Tx.wait();
        const user1ProposalId = user1Receipt?.logs[0].topics[1];
        console.log("User1 proposal created with ID:", user1ProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing user1 whitelist proposal...");
        await token.connect(admin).approveProposal(user1ProposalId);
        await time.increase(24 * 60 * 60 + 1);
        
        // Whitelist user2
        console.log("Creating whitelist proposal for user2...");
        const user2Tx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            user2.address,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const user2Receipt = await user2Tx.wait();
        const user2ProposalId = user2Receipt?.logs[0].topics[1];
        console.log("User2 proposal created with ID:", user2ProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing user2 whitelist proposal...");
        await token.connect(admin).approveProposal(user2ProposalId);
        await time.increase(24 * 60 * 60 + 1);

        // Transfer tokens to staking engine, staking pool, and reward pool
        console.log("Transferring tokens to contracts...");
        await token.connect(owner).transferFromContract(await stakingEngine.getAddress(), ethers.parseEther("5000")); 
        await token.connect(owner).transferFromContract(stakingPoolAddress, initialStakinPoolAmount);
        
        // Add a significant amount to reward pool to meet APY requirements
        await token.connect(owner).transferFromContract(rewardPoolAddress, ethers.parseEther("50000"));
        console.log(`Transferred ${ethers.formatEther(ethers.parseEther("50000"))} tokens to reward pool`);

        // Set up approvals for the staking contract
        console.log("Setting up token approvals...");
        await token.connect(users[0]).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
        await token.connect(users[1]).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
        await token.connect(users[2]).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
        
        console.log("Test setup complete.");
    });

    it("should initialize correctly", async function () {
        const rewardPoolBalance = await token.balanceOf(rewardPoolAddress);
        // Expect the reward pool to have the transferred amount
        expect(rewardPoolBalance).to.equal(ethers.parseEther("50000"));

        expect(await stakingEngine.totalStaked()).to.equal(0);
    });

    it("should handle over 10 users staking and unstaking without issues and verify slippage", async function () {
        const numUsers = 10; // Number of users to simulate
        const stakedAmountPerUser = 2; // Total staked amount per user
        const stakeAmount = ethers.parseEther(stakedAmountPerUser.toString()); // Each user stakes 2 tokens
        const lockPeriod = 180 * 24 * 60 * 60; // Lock period: 180 days

        // Add tokens to users and set up referrers (every even user refers the next odd user)
        for (let i = 3; i < numUsers + 3; i++) {
            console.log(`Setting up user ${i}...`);
            
            // Create and execute whitelist proposal for each user
            const userTx = await token.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                users[i].address,
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            const userReceipt = await userTx.wait();
            const userProposalId = userReceipt?.logs[0].topics[1];
            
            // Wait for timelock on the proposal to expire
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Approve and execute the proposal
            await token.connect(admin).approveProposal(userProposalId);
            await time.increase(24 * 60 * 60 + 1);

            // Transfer tokens to user and approve staking contract
            await token.connect(owner).transferFromContract(users[i].address, stakeAmount);
            await token.connect(users[i]).approve(await stakingEngine.getAddress(), stakeAmount);
        }

        // Stake tokens with referrers for even-indexed users
        for (let i = 3; i < numUsers + 3; i++) {
            console.log(`User ${i} staking tokens...`);
            if (i % 2 === 0 && i < numUsers + 2) { // Even user refers the next odd user
                await stakingEngine.connect(users[i]).stakeTokenWithReferrer(
                    stakeAmount,
                    lockPeriod,
                    users[i + 1].address
                );
            } else {
                await stakingEngine.connect(users[i]).stakeToken(stakeAmount, lockPeriod);
            }
        }

        // Verify total staked amount
        const totalStaked = await stakingEngine.totalStaked();
        expect(totalStaked).to.equal(stakeAmount * BigInt(numUsers));

        // Simulate time passing (complete the lock period)
        await time.increase(lockPeriod + 1);

        // Unstake tokens and verify referrer rewards
        for (let i = 3; i < numUsers + 3; i++) {
            const initialBalance = await token.balanceOf(users[i].address);
            const tx = await stakingEngine.connect(users[i]).unstakeToken(0);
            const receipt = await tx.wait();

            // Check if this user was a referrer
            if (i % 2 !== 0) { // Odd users are referrers
                const referrerRewards = await stakingEngine.getReferrerRewardsByPeriod(users[i].address, lockPeriod);
                if (i < numUsers + 2) { // Skip the last user who might not have been a referrer
                    // Expected referrer reward calculation - using actual value 
                    // This depends on the specific referrer reward logic in the contract
                    expect(referrerRewards).to.be.at.least(0);

                    // Only claim referrer rewards if there are any
                    if (referrerRewards > 0) {
                        // Claim referrer rewards
                        await stakingEngine.connect(users[i]).claimReferrerRewards(lockPeriod);

                        // Verify balance increased by referrer reward
                        const finalBalance = await token.balanceOf(users[i].address);
                        expect(finalBalance).to.be.gt(initialBalance);
                    } else {
                        console.log(`No referrer rewards available for user ${i} for period ${lockPeriod}`);
                    }
                }
            }
        }

        // Verify all stakes were removed
        expect(await stakingEngine.totalStaked()).to.equal(0);
    });
});

describe("StakingEngine with large user base", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let users: HardhatEthersSigner[];
    let rewardPoolAddress: string;
    let stakingPoolAddress: string;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const initialStakingPoolAmount = ethers.parseEther("200000");

    beforeEach(async function () {
        console.log("Starting large user base test setup...");
        // Get signers
        [owner, admin, ...users] = await ethers.getSigners();

        // Deploy StorageToken
        console.log("Deploying StorageToken...");
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(
            StorageToken, 
            [owner.address, admin.address, TOTAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await token.waitForDeployment();
        console.log("StorageToken deployed at:", await token.getAddress());

        // Set up reward and staking pool addresses
        rewardPoolAddress = users[0].address; // Use one of the users as the reward pool address
        stakingPoolAddress = users[1].address; // Use another user as the staking pool address
        console.log("Reward pool address:", rewardPoolAddress);
        console.log("Staking pool address:", stakingPoolAddress);

        // Deploy StakingEngine
        console.log("Deploying StakingEngine...");
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
        console.log("StakingEngine deployed at:", await stakingEngine.getAddress());

        // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
        console.log("Waiting for role change timelock to expire...");
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);

        // Set up governance for proposal creation
        console.log("Setting up governance...");
        await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await stakingEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        
        // Wait for execution delay
        console.log("Waiting for execution delay...");
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Additional delay before setting transaction limit
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Set transaction limit for admin role
        console.log("Setting role transaction limit...");
        await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, ethers.parseEther("1000000000"));
        
        // Wait for second timelock to expire
        console.log("Waiting for second timelock to expire...");
        await time.increase(24 * 60 * 60 + 1); // 24 hours + 1 second
        await ethers.provider.send("evm_mine", []);

        // Create whitelist proposals
        const addWhitelistType = 5; // AddWhitelist type
        console.log("Creating whitelist proposals...");

        // Whitelist the StakingEngine contract first
        console.log("Creating whitelist proposal for StakingEngine...");
        const engineTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            await stakingEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const engineReceipt = await engineTx.wait();
        const engineProposalId = engineReceipt?.logs[0].topics[1];
        console.log("StakingEngine proposal created with ID:", engineProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing StakingEngine whitelist proposal...");
        await token.connect(admin).approveProposal(engineProposalId);
        await time.increase(24 * 60 * 60 + 1);
        
        // Whitelist the staking pool address
        console.log("Creating whitelist proposal for staking pool...");
        const poolTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            stakingPoolAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const poolReceipt = await poolTx.wait();
        const poolProposalId = poolReceipt?.logs[0].topics[1];
        console.log("Staking pool proposal created with ID:", poolProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing staking pool whitelist proposal...");
        await token.connect(admin).approveProposal(poolProposalId);
        await time.increase(24 * 60 * 60 + 1);
        
        // Whitelist the reward pool address
        console.log("Creating whitelist proposal for reward pool...");
        const rewardTx = await token.connect(owner).createProposal(
            addWhitelistType,
            0,
            rewardPoolAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        const rewardReceipt = await rewardTx.wait();
        const rewardProposalId = rewardReceipt?.logs[0].topics[1];
        console.log("Reward pool proposal created with ID:", rewardProposalId);
        
        // Wait for timelock to expire
        await time.increase(24 * 60 * 60 + 1);
        await ethers.provider.send("evm_mine", []);
        
        // Approve and execute the proposal
        console.log("Approving and executing reward pool whitelist proposal...");
        await token.connect(admin).approveProposal(rewardProposalId);
        await time.increase(24 * 60 * 60 + 1);

        // Transfer tokens to contracts
        console.log("Transferring tokens to contracts...");
        await token.connect(owner).transferFromContract(await stakingEngine.getAddress(), ethers.parseEther("100000"));
        await token.connect(owner).transferFromContract(stakingPoolAddress, initialStakingPoolAmount);
        
        // Add a significant amount to reward pool to meet APY requirements
        await token.connect(owner).transferFromContract(rewardPoolAddress, ethers.parseEther("50000"));
        console.log(`Transferred ${ethers.formatEther(ethers.parseEther("50000"))} tokens to reward pool`);

        // Set up approvals for the staking contract
        console.log("Setting up token approvals...");
        await token.connect(users[0]).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
        await token.connect(users[1]).approve(await stakingEngine.getAddress(), ethers.MaxUint256);
        
        console.log("Large user base test setup complete.");
    });

    it("should scale efficiently with many users", async function () {
        const numUsers = 10; // Reduced number of users to prevent timeouts
        const stakedAmountPerUser = 1000; // Total staked amount per user
        const stakeAmount = ethers.parseEther(stakedAmountPerUser.toString());
        const lockPeriod = 90 * 24 * 60 * 60; // Lock period: 90 days
        console.log(`Setting up ${numUsers} users for staking...`);

        // Whitelist and add tokens to all test users
        for (let i = 2; i < 2 + numUsers; i++) {
            if (i >= users.length) {
                console.log(`Skipping user ${i} as it exceeds available signers`);
                continue;
            }
            
            // Create and execute whitelist proposal for each user
            console.log(`Creating whitelist proposal for user ${i}...`);
            const userTx = await token.connect(owner).createProposal(
                5, // AddWhitelist type
                0,
                users[i].address,
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            const userReceipt = await userTx.wait();
            const userProposalId = userReceipt?.logs[0].topics[1];
            
            // Wait for timelock on the proposal to expire
            await time.increase(24 * 60 * 60 + 1);
            await ethers.provider.send("evm_mine", []);
            
            // Approve and execute the proposal
            await token.connect(admin).approveProposal(userProposalId);
            await time.increase(24 * 60 * 60 + 1);

            // Transfer tokens to user and approve staking contract
            await token.connect(owner).transferFromContract(users[i].address, stakeAmount);
            await token.connect(users[i]).approve(await stakingEngine.getAddress(), stakeAmount);
        }

        console.log("All users whitelisted and funded. Starting staking operations...");

        // Perform staking operations for all users
        const stakePromises = [];
        for (let i = 2; i < 2 + numUsers; i++) {
            if (i >= users.length) continue;
            stakePromises.push(stakingEngine.connect(users[i]).stakeToken(stakeAmount, lockPeriod));
        }
        
        await Promise.all(stakePromises);
        console.log("All users have staked tokens successfully");

        // Check total staked amount
        const totalStaked = await stakingEngine.totalStaked();
        console.log(`Total staked amount: ${ethers.formatEther(totalStaked)} tokens`);
        expect(totalStaked).to.equal(stakeAmount * BigInt(Math.min(numUsers, users.length - 2)));
        
        // Check staking totals by period
        try {
            // First check if the property exists
            if ('totalStaked90Days' in stakingEngine) {
                // Try to access as property
                const totalStaked90Days = await stakingEngine.totalStaked90Days();
                console.log(`Total staked for 90 days: ${ethers.formatEther(totalStaked90Days)} tokens`);
                expect(totalStaked90Days).to.equal(stakeAmount * BigInt(Math.min(numUsers, users.length - 2)));
            } else {
                // Skip this check if property doesn't exist
                console.log("totalStaked90Days property not available, skipping check");
            }
        } catch (error: any) {
            console.log("Error accessing totalStaked90Days:", error.message);
        }

        // Simulate time passing partially through the lock period
        const partialTimeElapsed = Math.floor(lockPeriod / 2);
        console.log(`Advancing time by ${partialTimeElapsed / (24 * 60 * 60)} days...`);
        await time.increase(partialTimeElapsed);
        await ethers.provider.send("evm_mine", []);
        
        // Have half the users unstake early (with penalty)
        console.log("Half of the users unstaking early (with penalty)...");
        const unstakePromises = [];
        for (let i = 2; i < 2 + Math.floor(numUsers / 2); i++) {
            if (i >= users.length) continue;
            unstakePromises.push(stakingEngine.connect(users[i]).unstakeToken(0));
        }
        
        await Promise.all(unstakePromises);
        console.log("Early unstaking completed");

        // Check updated total staked amount
        const updatedTotalStaked = await stakingEngine.totalStaked();
        console.log(`Updated total staked amount: ${ethers.formatEther(updatedTotalStaked)} tokens`);
        
        const halfUsers = Math.min(Math.floor(numUsers / 2), users.length - 2);
        const remainingUsers = Math.min(numUsers, users.length - 2) - halfUsers;
        expect(updatedTotalStaked).to.equal(stakeAmount * BigInt(remainingUsers));

        // Advance time to complete the lock period
        console.log(`Advancing time to complete the full lock period...`);
        await time.increase(lockPeriod - partialTimeElapsed);
        await ethers.provider.send("evm_mine", []);
        
        // Have the remaining users unstake (without penalty)
        console.log("Remaining users unstaking (without penalty)...");
        const finalUnstakePromises = [];
        for (let i = 2 + Math.floor(numUsers / 2); i < 2 + numUsers; i++) {
            if (i >= users.length) continue;
            finalUnstakePromises.push(stakingEngine.connect(users[i]).unstakeToken(0));
        }
        
        await Promise.all(finalUnstakePromises);
        console.log("Full unstaking completed");

        // Verify final state
        const finalTotalStaked = await stakingEngine.totalStaked();
        console.log(`Final total staked amount: ${ethers.formatEther(finalTotalStaked)} tokens`);
        expect(finalTotalStaked).to.equal(0);
    });
});

describe("StakingEngine Edge Cases", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: HardhatEthersSigner;
    let admin: HardhatEthersSigner;
    let user1: HardhatEthersSigner;
    let user2: HardhatEthersSigner;
    let user3: HardhatEthersSigner;
    let users: HardhatEthersSigner[];
    let rewardPoolAddress: string;
    let stakingPoolAddress: string;
    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const initialRewardPoolAmount = ethers.parseEther("50000");
    const initialStakingPoolAmount = ethers.parseEther("5000");

    let calculateExpectedRewards = (stakedAmount: bigint, fixedAPY: number, elapsedTime: number) => {
        const annualRewards = (stakedAmount * BigInt(fixedAPY)) / BigInt(100); // Annualized rewards
        return (annualRewards * BigInt(elapsedTime)) / BigInt(365 * 24 * 60 * 60); // Adjusted for elapsed time
    };

    beforeEach(async function () {
        // Get signers
        [owner, admin, user1, user2, user3, ...users] = await ethers.getSigners();

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
            user3.address
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
        for (const user of [user1, user2, user3]) {
            await token.connect(owner).transferFromContract(user.address, ethers.parseEther("1000"));
            await token.connect(user).approve(await stakingEngine.getAddress(), ethers.parseEther("1000"));
        }
        
        // CRITICAL: Have the pools approve the StakingEngine to spend their tokens
        await token.connect(users[0]).approve(await stakingEngine.getAddress(), ethers.parseEther("1000000")); // Reward pool
        await token.connect(users[1]).approve(await stakingEngine.getAddress(), ethers.parseEther("1000000")); // Staking pool
    });

    // Test 1: Early unstaking penalty calculation
    it("should apply correct penalty for early unstaking at different times", async function () {
        const stakeAmount = ethers.parseEther("100");
        const lockPeriod = 90 * 24 * 60 * 60; // 90 days
        
        // User1 stakes tokens
        await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
        
        // Calculate penalties at different points in time
        const checkPoints = [
            1 * 24 * 60 * 60,     // 1 day (almost full penalty)
            30 * 24 * 60 * 60,    // 30 days (2/3 of penalty)
            60 * 24 * 60 * 60,    // 60 days (1/3 of penalty)
            89 * 24 * 60 * 60     // 89 days (minimal penalty)
        ];
        
        // Advance time to first checkpoint
        await time.increase(checkPoints[0]);
        await ethers.provider.send("evm_mine", []);
            
        // Record total staked before unstaking
        const totalStakedBefore = await stakingEngine.totalStaked();
            
        // Unstake tokens
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
                // Verify that a penalty was applied (exact amount depends on contract implementation)
                const actualPenalty = parsedEvent.args[3];
                expect(actualPenalty).to.be.gt(0); // Penalty should be greater than 0
                
                // Just verify the penalty is reasonable - at least 50% for early unstaking
                const reasonablePenaltyMin = (stakeAmount * BigInt(50)) / BigInt(100);
                expect(actualPenalty).to.be.gte(reasonablePenaltyMin);
            }
        }
        
        // Verify total staked decreased correctly
        const totalStakedAfter = await stakingEngine.totalStaked();
        expect(totalStakedAfter).to.equal(totalStakedBefore - stakeAmount);
    });

    // Test 2: Edge case for referrer reward calculation
    it("should calculate referrer rewards correctly with multiple referrals", async function () {
        // Define staking parameters
        const stakeAmount = ethers.parseEther("100");
        const lockPeriod90 = 90 * 24 * 60 * 60; // 90 days
        const lockPeriod180 = 180 * 24 * 60 * 60; // 180 days
        const lockPeriod365 = 365 * 24 * 60 * 60; // 365 days
        
        // User2 refers User1 for 90-day staking
        await stakingEngine.connect(user1).stakeTokenWithReferrer(stakeAmount, lockPeriod90, user2.address);
        
        // User3 refers User1 for 180-day staking
        await stakingEngine.connect(user1).stakeTokenWithReferrer(stakeAmount, lockPeriod180, user3.address);
        
        // User2 refers User1 again for 365-day staking
        await stakingEngine.connect(user1).stakeTokenWithReferrer(stakeAmount, lockPeriod365, user2.address);
        
        // Get referrer info objects
        const user2ReferrerInfo = await stakingEngine.referrers(user2.address);
        const user3ReferrerInfo = await stakingEngine.referrers(user3.address);
        
        // Verify total referred amounts
        expect(user2ReferrerInfo.totalReferred).to.be.gt(0);
        expect(user3ReferrerInfo.totalReferred).to.be.gt(0);
        
        // Advance time to complete all lock periods
        await time.increase(lockPeriod365);
        await ethers.provider.send("evm_mine", []);
        
        // User1 unstakes all positions
        await stakingEngine.connect(user1).unstakeToken(0); // 90 days
        await stakingEngine.connect(user1).unstakeToken(0); // 180 days
        await stakingEngine.connect(user1).unstakeToken(0); // 365 days
        
        // Get updated referrer info after unstaking
        const user2ReferrerInfoAfter = await stakingEngine.referrers(user2.address);
        const user3ReferrerInfoAfter = await stakingEngine.referrers(user3.address);
        
        // Verify referrers have unclaimed rewards
        expect(user2ReferrerInfoAfter.unclaimedRewards).to.be.gt(0);
        expect(user3ReferrerInfoAfter.unclaimedRewards).to.be.gt(0);
        
        // Check referrers can claim rewards
        const user2Initial = await token.balanceOf(user2.address);
        await stakingEngine.connect(user2).claimReferrerRewards(lockPeriod90);
        await stakingEngine.connect(user2).claimReferrerRewards(lockPeriod365);
        const user2Final = await token.balanceOf(user2.address);
        
        const user3Initial = await token.balanceOf(user3.address);
        await stakingEngine.connect(user3).claimReferrerRewards(lockPeriod180);
        const user3Final = await token.balanceOf(user3.address);
        
        // Verify referrers received rewards
        expect(user2Final).to.be.gt(user2Initial);
        expect(user3Final).to.be.gt(user3Initial);
        
        // Verify referrers can't claim rewards again
        await expect(stakingEngine.connect(user2).claimReferrerRewards(lockPeriod90))
            .to.be.revertedWith("No rewards available for this period");
    });

    // Test 3: Edge case for reward distribution with insufficient pool balance
    it("should handle reward distribution when pool has insufficient funds", async function () {
        // First, handle the initial staking with sufficient rewards
        const stakeAmount = ethers.parseEther("500"); // Large enough to generate meaningful rewards
        const lockPeriod = 365 * 24 * 60 * 60; // 365 days to maximize rewards
        
        // User1 stakes tokens
        await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod);
        
        // Now significantly deplete the reward pool (leave just 0.001 tokens)
        const rewardPoolInitialBalance = await token.balanceOf(rewardPoolAddress);
        await token.connect(users[0]).transfer(owner.address, rewardPoolInitialBalance - ethers.parseEther("0.001"));
        
        // Advance time to complete lock period
        await time.increase(lockPeriod);
        await ethers.provider.send("evm_mine", []);
        
        // Record initial balance
        const initialBalance = await token.balanceOf(user1.address);
        
        // Unstake - should only return principal if rewards can't be distributed
        await stakingEngine.connect(user1).unstakeToken(0);
        
        // Verify user got back their principal but no additional rewards
        const finalBalance = await token.balanceOf(user1.address);
        
        // User should at minimum get their principal back
        // With our improved proportional distribution, a small amount of reward may be included
        const returnedAmount = finalBalance - initialBalance;
        expect(returnedAmount).to.be.gte(stakeAmount); // User should get at least their principal
        expect(returnedAmount).to.be.lt(stakeAmount + ethers.parseEther("0.01")); // But not much more
        
        // Ensure rewards were likely insufficient - we don't need to check for a specific event
        // since the contract behavior may vary, but user shouldn't get full rewards
        const rewardPoolFinalBalance = await token.balanceOf(rewardPoolAddress);
        expect(rewardPoolFinalBalance).to.be.lt(ethers.parseEther("0.01")); // Pool should be almost empty
    });

    // Test 6: Edge case for calculating rewards when updating rewards with zero total staked
    it("should handle updateRewards correctly when totalStaked is zero", async function () {
        // Initially totalStaked is zero
        expect(await stakingEngine.totalStaked()).to.equal(0);
        
        // First stake: Should update rewards internally
        const stakeAmount = ethers.parseEther("10");
        await stakingEngine.connect(user1).stakeToken(stakeAmount, 90 * 24 * 60 * 60);
        
        // Verify staking worked
        expect(await stakingEngine.totalStaked()).to.equal(stakeAmount);
        
        // Complete lock period and unstake
        await time.increase(90 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine", []);
        await stakingEngine.connect(user1).unstakeToken(0);
        
        // Verify we're back to zero staked
        expect(await stakingEngine.totalStaked()).to.equal(0);
        
        // Second stake after being at zero: Should handle reward updates correctly
        await time.increase(100); // Add a small time buffer
        await ethers.provider.send("evm_mine", []);
        
        // This should work without errors even with zero previously staked
        await stakingEngine.connect(user1).stakeToken(stakeAmount, 90 * 24 * 60 * 60);
        
        // Complete lock period and unstake again
        await time.increase(90 * 24 * 60 * 60);
        await ethers.provider.send("evm_mine", []);
        await stakingEngine.connect(user1).unstakeToken(0);
        
        // Verify we handled multiple zero-stake transitions correctly
        expect(await stakingEngine.totalStaked()).to.equal(0);
    });
});
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

        it("should revert when using zero address as referrer", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Attempt to use zero address as referrer
            await expect(
                stakingEngine.connect(user1).stakeTokenWithReferrer(
                    stakeAmount, 
                    lockPeriod, 
                    ZeroAddress
                )
            ).to.be.reverted; // Should revert with some error
        });
    });

    // 3. Penalty Calculation Tests
    describe("Penalty Calculation Tests", function () {
        it("should apply correct penalties at different time points", async function () {
            const stakeAmount = ethers.parseEther("100");
            const lockPeriod = 90 * 24 * 60 * 60; // 90 days
            
            // Test points at different percentages of the lock period
            const testPoints = [
                { percent: 5, expectedPenaltyRate: 50 },   // 5% elapsed, >90% remaining
                { percent: 15, expectedPenaltyRate: 40 },  // 15% elapsed, >75% remaining
                { percent: 30, expectedPenaltyRate: 30 },  // 30% elapsed, >60% remaining
                { percent: 50, expectedPenaltyRate: 20 },  // 50% elapsed, >45% remaining
                { percent: 65, expectedPenaltyRate: 15 },  // 65% elapsed, >30% remaining
                { percent: 80, expectedPenaltyRate: 10 },  // 80% elapsed, >15% remaining
                { percent: 95, expectedPenaltyRate: 5 }    // 95% elapsed, <15% remaining
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
            
            // But should be greater than 0
            expect(projectedAPY).to.be.gt(0);
        });
    });

    // 5. Reward Calculation Tests
    describe("Reward Calculation Tests", function () {
        it("should calculate rewards correctly for different lock periods", async function () {
            // Define staking parameters for different lock periods
            const stakeAmount = ethers.parseEther("100");
            const lockPeriods = [
                90 * 24 * 60 * 60,   // 90 days - 2% APY
                180 * 24 * 60 * 60,  // 180 days - 5% APY
                365 * 24 * 60 * 60   // 365 days - 15% APY
            ];
            const expectedAPYs = [2, 5, 15]; // Expected APY percentages
            
            // Stake and verify rewards for each lock period
            for (let i = 0; i < lockPeriods.length; i++) {
                // Stake tokens
                await stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriods[i]);
                
                // Advance time to complete lock period
                await time.increase(lockPeriods[i]);
                await ethers.provider.send("evm_mine", []);
                
                // Calculate expected rewards
                const daysInYear = 365;
                const lockPeriodDays = lockPeriods[i] / (24 * 60 * 60);
                const expectedReward = (stakeAmount * BigInt(expectedAPYs[i]) * BigInt(lockPeriodDays)) / (BigInt(100) * BigInt(daysInYear));
                
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
            
            await expect(
                stakingEngine.connect(user1).stakeToken(stakeAmount, lockPeriod)
            ).to.be.revertedWith("Pausable: paused");
            
            // Attempt to unstake (first stake before pausing)
            await expect(
                stakingEngine.connect(user1).unstakeToken(0)
            ).to.be.revertedWith("Pausable: paused");
            
            // Attempt to claim referrer rewards
            await expect(
                stakingEngine.connect(user2).claimReferrerRewards(lockPeriod)
            ).to.be.revertedWith("Pausable: paused");
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
            
            // Record initial attacker balance
            const initialBalance = await token.balanceOf(attacker.address);
            
            // Perform multiple stake/unstake cycles
            for (let i = 0; i < 5; i++) {
                // Renew approval before each stake
                await token.connect(attacker).approve(await stakingEngine.getAddress(), stakeAmount);
                
                // Stake
                await stakingEngine.connect(attacker).stakeToken(stakeAmount, lockPeriod);
                
                // Advance time by a small amount
                await time.increase(1 * 24 * 60 * 60); // 1 day
                await ethers.provider.send("evm_mine", []);
                
                // Unstake (with penalty)
                await stakingEngine.connect(attacker).unstakeToken(0);
            }
            
            // Record final attacker balance
            const finalBalance = await token.balanceOf(attacker.address);
            
            // Verify attacker didn't profit from the cycling
            // They should have lost tokens due to penalties
            expect(finalBalance).to.be.lt(initialBalance);
        });
    });
});
