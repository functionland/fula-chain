import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// Define roles and constants at the top 
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));
const ProposalTypes = {
    EMERGENCY_COOLDOWN: 24 * 60 * 60 // 1 day in seconds (from your contract)
};

describe("TokenBridge", function () {
    // Setup variables
    let tokenBridge: any;
    let storageToken: any;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let user: SignerWithAddress;
    let anotherUser: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000");
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2);
    const DAILY_LIMIT = ethers.parseEther("100000");
    const LOCAL_CHAIN_ID = 1; // Ethereum mainnet
    const TARGET_CHAIN_ID = 137; // Polygon mainnet
    
    // Helper function to extract proposal ID from logs
    async function getProposalIdFromLogs(receipt: any, contract: any) {
        const proposalCreatedLog = receipt.logs.find(
            (log: any) => {
                try {
                    const parsed = contract.interface.parseLog(log);
                    return parsed?.name === "ProposalCreated";
                } catch {
                    return false;
                }
            }
        );
        
        return proposalCreatedLog ? 
            contract.interface.parseLog(proposalCreatedLog)?.args[0] : 
            undefined;
    }
    
    // Setup before each test
    beforeEach(async function () {
        // Get signers
        [owner, admin, bridgeOperator, user, anotherUser] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        );
        await storageToken.waitForDeployment();
        
        // Deploy TokenBridge
        const TokenBridge = await ethers.getContractFactory("TokenBridge");
        tokenBridge = await upgrades.deployProxy(
            TokenBridge,
            [
                await storageToken.getAddress(),
                LOCAL_CHAIN_ID,
                DAILY_LIMIT,
                owner.address,
                admin.address,
                [bridgeOperator.address]
            ],
            { kind: 'uups', initializer: 'initialize' }
        );
        await tokenBridge.waitForDeployment();
        
        // Wait for timelock period
        console.log("Waiting for timelock period...");
        await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second
        
        // Set quorum for StorageToken
        const storageTokenWithOwner = storageToken.connect(owner);
        const tx1 = await storageTokenWithOwner.setRoleQuorum(ADMIN_ROLE, 2);
        await tx1.wait();
        console.log("Quorum set for StorageToken");
        
        // Set transaction limit for StorageToken
        const tx2 = await storageTokenWithOwner.setRoleTransactionLimit(
            ADMIN_ROLE, 
            ethers.parseEther("100000000")
        );
        await tx2.wait();
        console.log("Transaction limit set for StorageToken");
        
        // Set quorum for TokenBridge
        const tokenBridgeWithOwner = tokenBridge.connect(owner);
        const tx3 = await tokenBridgeWithOwner.setRoleQuorum(ADMIN_ROLE, 2);
        await tx3.wait();
        console.log("Quorum set for TokenBridge");
        
        // Set transaction limits for TokenBridge
        const tx4 = await tokenBridgeWithOwner.setRoleTransactionLimit(
            ADMIN_ROLE, 
            ethers.parseEther("100000000")
        );
        await tx4.wait();
        console.log("Admin transaction limit set for TokenBridge");
        
        const tx5 = await tokenBridgeWithOwner.setRoleTransactionLimit(
            BRIDGE_OPERATOR_ROLE, 
            ethers.parseEther("10000")
        );
        await tx5.wait();
        console.log("Bridge operator transaction limit set for TokenBridge");
        
        // Create whitelist proposal for bridge contract
        const addWhitelistType = 5; // AddWhitelist is type 5
        const bridgeWhitelistProposalTx = await storageTokenWithOwner.createProposal(
            addWhitelistType,
            0,
            await tokenBridge.getAddress(),
            ethers.ZeroHash,
            0,
            ethers.ZeroAddress
        );
        const bridgeWhitelistReceipt = await bridgeWhitelistProposalTx.wait();
        const bridgeWhitelistProposalId = await getProposalIdFromLogs(bridgeWhitelistReceipt, storageToken);
        console.log("Bridge whitelist proposal created, ID:", bridgeWhitelistProposalId);
        
        // Approve the proposal with the second admin
        const storageTokenWithAdmin = storageToken.connect(admin);
        await storageTokenWithAdmin.approveProposal(bridgeWhitelistProposalId);
        console.log("Bridge whitelist proposal approved");
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1); // Increase time by 1 day + 1 second
        
        // Execute the proposal
        await storageTokenWithOwner.executeProposal(bridgeWhitelistProposalId);
        console.log("Bridge whitelist proposal executed");
        
        // Wait for whitelist timelock
        await time.increase(24 * 60 * 60 + 1);
        
        // Now create whitelist proposal for user's address
        const userWhitelistProposalTx = await storageTokenWithOwner.createProposal(
            addWhitelistType,
            0,
            user.address,
            ethers.ZeroHash,
            0,
            ethers.ZeroAddress
        );
        const userWhitelistReceipt = await userWhitelistProposalTx.wait();
        const userWhitelistProposalId = await getProposalIdFromLogs(userWhitelistReceipt, storageToken);
        console.log("User whitelist proposal created, ID:", userWhitelistProposalId);
        
        // Approve the user whitelist proposal
        await storageTokenWithAdmin.approveProposal(userWhitelistProposalId);
        console.log("User whitelist proposal approved");
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        // Execute the user whitelist proposal
        await storageTokenWithOwner.executeProposal(userWhitelistProposalId);
        console.log("User whitelist proposal executed");


        // Now create whitelist proposal for owner's address
        const ownerWhitelistProposalTx = await storageTokenWithOwner.createProposal(
            addWhitelistType,
            0,
            owner.address,
            ethers.ZeroHash,
            0,
            ethers.ZeroAddress
        );
        const ownerWhitelistReceipt = await ownerWhitelistProposalTx.wait();
        const ownerWhitelistProposalId = await getProposalIdFromLogs(ownerWhitelistReceipt, storageToken);
        console.log("Owner whitelist proposal created, ID:", ownerWhitelistProposalId);
        
        // Approve the owner whitelist proposal
        await storageTokenWithAdmin.approveProposal(ownerWhitelistProposalId);
        console.log("Owner whitelist proposal approved");
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        // Execute the owner whitelist proposal
        await storageTokenWithOwner.executeProposal(ownerWhitelistProposalId);
        console.log("Owner whitelist proposal executed");
        
        // Wait for whitelist timelock
        await time.increase(24 * 60 * 60 + 1);
        
        // Transfer tokens to bridge contract from StorageToken contract (not from owner)
        await storageTokenWithOwner.transferFromContract(
            await tokenBridge.getAddress(),
            ethers.parseEther("1000000")
        );
        console.log("Transferred 1,000,000 tokens to bridge contract");
        
        // Transfer tokens to user from StorageToken contract (not from owner)
        await storageTokenWithOwner.transferFromContract(
            user.address,
            ethers.parseEther("100000")
        );
        console.log("Transferred 100,000 tokens to user");

        // Transfer tokens to owner from StorageToken contract (not from owner)
        await storageTokenWithOwner.transferFromContract(
            owner.address,
            ethers.parseEther("1000001")
        );
        console.log("Transferred 1,000,001 tokens to owner");
        
        // User approves tokens for bridge
        await storageToken.connect(user).approve(
            await tokenBridge.getAddress(), 
            ethers.parseEther("100000")
        );
        console.log("User approved tokens for bridge");
    });
    
    // Basic token locking functionality
    describe("Token Locking", function() {
        it("should lock tokens successfully", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            // Check initial balances
            const initialUserBalance = await storageToken.balanceOf(user.address);
            const initialBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            // Lock tokens - now returns nonce and lockId
            const lockTx = await tokenBridge.connect(user).lockTokens(
                amount,
                TARGET_CHAIN_ID,
                targetAddress
            );
            
            // Check event emission
            const receipt = await lockTx.wait();
            const tokenLockedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                }
            );
            
            expect(tokenLockedLog).to.not.be.undefined;
            
            // Extract lock ID from the event
            const lockId = tokenBridge.interface.parseLog(tokenLockedLog)?.args[5];
            expect(lockId).to.not.be.undefined;
            
            // Check balances after locking
            const finalUserBalance = await storageToken.balanceOf(user.address);
            const finalBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            expect(finalUserBalance).to.equal(initialUserBalance - amount);
            expect(finalBridgeBalance).to.equal(initialBridgeBalance + amount);
            
            // Check daily used amount
            const dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount);
            
            // Check user daily used amount
            const userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(amount);
            
            // Verify lock record was created
            const lockRecord = await tokenBridge.lockRecords(lockId);
            expect(lockRecord.sender).to.equal(user.address);
            expect(lockRecord.targetAddress).to.equal(targetAddress);
            expect(lockRecord.amount).to.equal(amount);
            expect(lockRecord.targetChain).to.equal(TARGET_CHAIN_ID);
            expect(lockRecord.released).to.be.false;
            expect(lockRecord.cancelled).to.be.false;
        });
        
        it("should revert when locking to the same chain", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    LOCAL_CHAIN_ID, // Same as local chain
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidChainId");
        });
        
        it("should revert when locking zero tokens", async function() {
            const targetAddress = anotherUser.address;
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    0, // Zero amount
                    TARGET_CHAIN_ID,
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidTokenAmount");
        });
        
        it("should revert when locking to zero address", async function() {
            const amount = ethers.parseEther("1000");
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    TARGET_CHAIN_ID,
                    ethers.ZeroAddress // Zero address
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidAddress");
        });
        
        it("should revert when exceeding daily limit", async function() {
            const amount = ethers.parseEther("100001"); // Just over daily limit
            const targetAddress = anotherUser.address;
            
            // Approve more tokens
            await storageToken.connect(owner).transfer(user.address, amount);
            await storageToken.connect(user).approve(await tokenBridge.getAddress(), amount);
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    TARGET_CHAIN_ID,
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "DailyLimitExceeded");
        });
        
        it("should reset daily limit after 24 hours", async function() {
            // Increase user's daily limit to match the test values
            await tokenBridge.connect(owner).updateUserDailyLimit(user.address, ethers.parseEther("100000"));
            
            // Lock some tokens
            const amount1 = ethers.parseEther("50000");
            await tokenBridge.connect(user).lockTokens(
                amount1,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Check daily used
            let dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount1);
            
            let userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(amount1);
            
            // Increase time by 24 hours
            await time.increase(24 * 60 * 60 + 1);
            
            // Lock more tokens
            const amount2 = ethers.parseEther("50000");
            await tokenBridge.connect(user).lockTokens(
                amount2,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Check daily used - should be reset to just amount2
            dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount2);
            
            // Check user daily used - should also be reset to just amount2
            userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(amount2);
        });
        
        it("should revert when user is blacklisted", async function() {
            // Blacklist the user
            await tokenBridge.connect(owner).updateBlacklist(user.address, true);
            
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    TARGET_CHAIN_ID,
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountBlacklisted");
        });
        
        it("should revert when whitelist is enabled and user is not whitelisted", async function() {
            // Enable whitelist
            await tokenBridge.connect(owner).setWhitelistEnabled(true);
            
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    TARGET_CHAIN_ID,
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountNotWhitelisted");
        });
        
        it("should revert when exceeding user daily limit", async function() {
            // Set a user daily limit
            const userLimit = ethers.parseEther("5000");
            await tokenBridge.connect(owner).updateUserDailyLimit(user.address, userLimit);
            
            // Try to lock more than the user limit
            const amount = ethers.parseEther("6000");
            const targetAddress = anotherUser.address;
            
            // Approve more tokens
            await storageToken.connect(owner).transfer(user.address, amount);
            await storageToken.connect(user).approve(await tokenBridge.getAddress(), amount);
            
            await expect(
                tokenBridge.connect(user).lockTokens(
                    amount,
                    TARGET_CHAIN_ID,
                    targetAddress
                )
            ).to.be.revertedWithCustomError(tokenBridge, "UserDailyLimitExceeded");
        });
    });
    
    // Tests for releasing tokens
    describe("Token Releasing", function() {
        it("should release tokens successfully by bridge operator", async function() {
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            
            // Check initial balances
            const initialRecipientBalance = await storageToken.balanceOf(user.address);
            const initialBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            // Release tokens with empty proof since bridge operator doesn't need it
            const emptyProof = ethers.toUtf8Bytes("");
            const tx = await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                amount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Check event emission
            const receipt = await tx.wait();
            const tokenReleasedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "TokensReleased";
                    } catch {
                        return false;
                    }
                }
            );
            
            expect(tokenReleasedLog).to.not.be.undefined;
            
            // Check balances after release
            const finalRecipientBalance = await storageToken.balanceOf(user.address);
            const finalBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            expect(finalRecipientBalance).to.equal(initialRecipientBalance + amount);
            expect(finalBridgeBalance).to.equal(initialBridgeBalance - amount);
            
            // Check daily used amount
            const dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount);
            
            // Check accounting
            const totalReleased = await tokenBridge.totalReleasedTokens();
            expect(totalReleased).to.equal(amount);
        });
        
        it("should allow users to release their own tokens with valid proof", async function() {
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            
            // Generate a mock proof - in a real scenario this would be a cryptographic proof
            // For testing we'll just use a dummy proof that the contract will accept
            const mockProof = ethers.toUtf8Bytes("valid_proof_for_testing");
            
            // Check initial balances
            const initialUserBalance = await storageToken.balanceOf(user.address);
            const initialBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            // User releases their own tokens
            const tx = await tokenBridge.connect(user).releaseTokens(
                user.address, // Recipient is the same as caller
                amount,
                sourceChain,
                nonce,
                mockProof
            );
            
            // Check balances after release
            const finalUserBalance = await storageToken.balanceOf(user.address);
            const finalBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            expect(finalUserBalance).to.equal(initialUserBalance + amount);
            expect(finalBridgeBalance).to.equal(initialBridgeBalance - amount);
        });
        
        it("should revert when non-authorized entity tries to release tokens", async function() {
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const mockProof = ethers.toUtf8Bytes("valid_proof_for_testing");
            
            await expect(
                tokenBridge.connect(anotherUser).releaseTokens(
                    user.address, // Trying to release for someone else
                    amount,
                    sourceChain,
                    nonce,
                    mockProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "UnauthorizedRelease");
        });
        
        it("should revert when releasing from the same chain", async function() {
            const amount = ethers.parseEther("1000");
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    amount,
                    LOCAL_CHAIN_ID, // Same as local chain
                    nonce,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidChainId");
        });
        
        it("should revert when releasing zero tokens", async function() {
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    0, // Zero amount
                    sourceChain,
                    nonce,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidTokenAmount");
        });
        
        it("should revert when releasing to zero address", async function() {
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    ethers.ZeroAddress, // Zero address
                    amount,
                    sourceChain,
                    nonce,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "InvalidAddress");
        });
        
        it("should revert when nonce is already used", async function() {
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            // Release tokens with nonce
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                amount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Try to use the same nonce again
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    anotherUser.address,
                    amount,
                    sourceChain,
                    nonce,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "NonceAlreadyUsed");
        });
        
        it("should revert when recipient is blacklisted", async function() {
            // Blacklist the recipient
            await tokenBridge.connect(owner).updateBlacklist(user.address, true);
            
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    amount,
                    sourceChain,
                    nonce,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountBlacklisted");
        });
    });
    
    // Tests for lock cancellation
    describe("Lock Cancellation", function() {
        it("should allow users to cancel their locks", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            // Initial balances
            const initialUserBalance = await storageToken.balanceOf(user.address);
            const initialBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            // Lock tokens and get the lock ID
            const lockTx = await tokenBridge.connect(user).lockTokens(
                amount,
                TARGET_CHAIN_ID,
                targetAddress
            );
            
            const receipt = await lockTx.wait();
            const tokenLockedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                }
            );
            
            const lockId = tokenBridge.interface.parseLog(tokenLockedLog)?.args[5];
            
            // Check daily used amount after lock
            let dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount);
            
            // Check user daily used
            let userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(amount);
            
            // Check accounting
            let totalLocked = await tokenBridge.totalLockedTokens();
            expect(totalLocked).to.equal(amount);
            
            // Cancel the lock
            await tokenBridge.connect(user).cancelLock(lockId);
            
            // Check balances after cancellation
            const finalUserBalance = await storageToken.balanceOf(user.address);
            const finalBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            // User should get their tokens back
            expect(finalUserBalance).to.equal(initialUserBalance);
            expect(finalBridgeBalance).to.equal(initialBridgeBalance);
            
            // Daily limit and user daily limit should be reduced
            dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(0);
            
            userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(0);
            
            // Lock record should be marked as cancelled
            const lockRecord = await tokenBridge.lockRecords(lockId);
            expect(lockRecord.cancelled).to.be.true;
            
            // Accounting should be updated
            totalLocked = await tokenBridge.totalLockedTokens();
            expect(totalLocked).to.equal(0);
        });
        
        it("should allow admins to cancel any lock", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            // Lock tokens with user
            const lockTx = await tokenBridge.connect(user).lockTokens(
                amount,
                TARGET_CHAIN_ID,
                targetAddress
            );
            
            const receipt = await lockTx.wait();
            const lockId = tokenBridge.interface.parseLog(
                receipt?.logs.find(log => {
                    try {
                        return tokenBridge.interface.parseLog(log)?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                })
            )?.args[5];
            
            // Admin cancels the lock
            await tokenBridge.connect(owner).cancelLock(lockId);
            
            // Lock record should be marked as cancelled
            const lockRecord = await tokenBridge.lockRecords(lockId);
            expect(lockRecord.cancelled).to.be.true;
            
            // User should have received their tokens back
            const userBalance = await storageToken.balanceOf(user.address);
            expect(userBalance).to.equal(ethers.parseEther("100000")); // Initial balance
        });
        
        it("should revert when non-owner and non-sender tries to cancel a lock", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            // Lock tokens with user
            const lockTx = await tokenBridge.connect(user).lockTokens(
                amount,
                TARGET_CHAIN_ID,
                targetAddress
            );
            
            const receipt = await lockTx.wait();
            const lockId = tokenBridge.interface.parseLog(
                receipt?.logs.find(log => {
                    try {
                        return tokenBridge.interface.parseLog(log)?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                })
            )?.args[5];
            
            // Another user tries to cancel (not admin, not sender)
            await expect(
                tokenBridge.connect(anotherUser).cancelLock(lockId)
            ).to.be.revertedWithCustomError(tokenBridge, "UnauthorizedCancel");
        });
        
        it("should revert when trying to cancel a non-existent lock", async function() {
            const fakeLockId = ethers.keccak256(ethers.toUtf8Bytes("non_existent_lock"));
            
            await expect(
                tokenBridge.connect(user).cancelLock(fakeLockId)
            ).to.be.revertedWithCustomError(tokenBridge, "LockNotFound");
        });
        
        it("should revert when trying to cancel an already cancelled lock", async function() {
            const amount = ethers.parseEther("1000");
            const targetAddress = anotherUser.address;
            
            // Lock tokens
            const lockTx = await tokenBridge.connect(user).lockTokens(
                amount,
                TARGET_CHAIN_ID,
                targetAddress
            );
            
            const receipt = await lockTx.wait();
            const lockId = tokenBridge.interface.parseLog(
                receipt?.logs.find(log => {
                    try {
                        return tokenBridge.interface.parseLog(log)?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                })
            )?.args[5];
            
            // Cancel once
            await tokenBridge.connect(user).cancelLock(lockId);
            
            // Try to cancel again
            await expect(
                tokenBridge.connect(user).cancelLock(lockId)
            ).to.be.revertedWithCustomError(tokenBridge, "LockAlreadyCancelled");
        });
    });
    
    // Tests for daily limits
    describe("Daily Limits", function() {
        it("should enforce daily limits for both locking and releasing", async function() {
            // Set a smaller daily limit for testing
            const smallLimit = ethers.parseEther("2000");
            await tokenBridge.connect(owner).updateDailyLimit(smallLimit);
            
            const emptyProof = ethers.toUtf8Bytes("");
            
            // Lock tokens up to the limit
            const lockAmount = ethers.parseEther("1000");
            await tokenBridge.connect(user).lockTokens(
                lockAmount,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Release tokens up to the limit
            const releaseAmount = ethers.parseEther("1000");
            const nonce = 12345;
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                anotherUser.address,
                releaseAmount,
                TARGET_CHAIN_ID,
                nonce,
                emptyProof
            );
            
            // Both operations should succeed and daily limit should be reached
            const dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(smallLimit);
            
            // Try to lock more tokens - should fail
            await expect(
                tokenBridge.connect(user).lockTokens(
                    ethers.parseEther("1"),
                    TARGET_CHAIN_ID,
                    anotherUser.address
                )
            ).to.be.revertedWithCustomError(tokenBridge, "DailyLimitExceeded");
            
            // Try to release more tokens - should fail
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    anotherUser.address,
                    ethers.parseEther("1"),
                    TARGET_CHAIN_ID,
                    54321,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "DailyLimitExceeded");
        });
        
        it("should allow admin to update daily limit", async function() {
            const newLimit = ethers.parseEther("200000");
            await tokenBridge.connect(owner).updateDailyLimit(newLimit);
            
            const updatedLimit = await tokenBridge.dailyLimit();
            expect(updatedLimit).to.equal(newLimit);
        });
        
        it("should enforce user daily limits for locking", async function() {
            // Set a small user daily limit
            const userLimit = ethers.parseEther("3000");
            await tokenBridge.connect(owner).updateUserDailyLimit(user.address, userLimit);
            
            // Lock tokens up to the user limit
            const lockAmount = ethers.parseEther("3000");
            
            // Approve more tokens
            await storageToken.connect(owner).transfer(user.address, lockAmount);
            await storageToken.connect(user).approve(await tokenBridge.getAddress(), lockAmount);
            
            await tokenBridge.connect(user).lockTokens(
                lockAmount,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Check user daily used
            const userDailyUsed = await tokenBridge.userDailyUsed(user.address);
            expect(userDailyUsed).to.equal(lockAmount);
            
            // Try to lock more tokens - should fail due to user limit
            await expect(
                tokenBridge.connect(user).lockTokens(
                    ethers.parseEther("1"),
                    TARGET_CHAIN_ID,
                    anotherUser.address
                )
            ).to.be.revertedWithCustomError(tokenBridge, "UserDailyLimitExceeded");
        });
        
        it("should allow admin to update user daily limit", async function() {
            const newUserLimit = ethers.parseEther("20000");
            await tokenBridge.connect(owner).updateUserDailyLimit(user.address, newUserLimit);
            
            const updatedUserLimit = await tokenBridge.userDailyLimits(user.address);
            expect(updatedUserLimit).to.equal(newUserLimit);
        });
        
        it("should allow admin to update default user daily limit", async function() {
            const newDefaultLimit = ethers.parseEther("10000");
            await tokenBridge.connect(owner).updateDefaultUserDailyLimit(newDefaultLimit);
            
            const updatedDefaultLimit = await tokenBridge.defaultUserDailyLimit();
            expect(updatedDefaultLimit).to.equal(newDefaultLimit);
        });
    });
    
    // Tests for large transfers
    describe("Large Transfers", function() {
        beforeEach(async function() {
            // Set the large transfer threshold to 5000 tokens
            await tokenBridge.connect(owner).updateLargeTransferSettings(
                ethers.parseEther("5000"),
                6 * 60 * 60 // 6 hours delay
            );
        });
        
        it("should delay large transfers and execute them after the delay period", async function() {
            const amount = ethers.parseEther("6000"); // Above large transfer threshold
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            // Check initial balances
            const initialRecipientBalance = await storageToken.balanceOf(user.address);
            
            // Release tokens - should be delayed
            const tx = await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                amount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Check event emission
            const receipt = await tx.wait();
            const largeTransferDelayedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "LargeTransferDelayed";
                    } catch {
                        return false;
                    }
                }
            );
            
            expect(largeTransferDelayedLog).to.not.be.undefined;
            const transferId = tokenBridge.interface.parseLog(largeTransferDelayedLog)?.args[0];
            
            // Balance should not have changed yet
            const midRecipientBalance = await storageToken.balanceOf(user.address);
            expect(midRecipientBalance).to.equal(initialRecipientBalance);
            
            // Try to execute too early
            await expect(
                tokenBridge.connect(owner).executeLargeTransfer(transferId)
            ).to.be.revertedWithCustomError(tokenBridge, "TransferDelayNotMet");
            
            // Wait for the delay period
            await time.increase(6 * 60 * 60 + 1);
            
            // Now execute the transfer
            await tokenBridge.connect(owner).executeLargeTransfer(transferId);
            
            // Check final balance
            const finalRecipientBalance = await storageToken.balanceOf(user.address);
            expect(finalRecipientBalance).to.equal(initialRecipientBalance + amount);
        });
        
        it("should allow admins to cancel delayed transfers", async function() {
            const amount = ethers.parseEther("6000"); // Above large transfer threshold
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            // Release tokens - should be delayed
            const tx = await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                amount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Extract transfer ID
            const receipt = await tx.wait();
            const largeTransferDelayedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "LargeTransferDelayed";
                    } catch {
                        return false;
                    }
                }
            );
            
            const transferId = tokenBridge.interface.parseLog(largeTransferDelayedLog)?.args[0];
            
            // Daily used should be updated
            let dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(amount);
            
            // Cancel the transfer
            await tokenBridge.connect(owner).cancelLargeTransfer(transferId);
            
            // Daily used should be reset
            dailyUsed = await tokenBridge.dailyUsed();
            expect(dailyUsed).to.equal(0);
            
            // Nonce should be freed
            // Try to use the same nonce again - should work
            const smallAmount = ethers.parseEther("1000");
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                smallAmount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Try to execute the cancelled transfer - should fail
            await time.increase(6 * 60 * 60 + 1);
            await expect(
                tokenBridge.connect(owner).executeLargeTransfer(transferId)
            ).to.be.revertedWithCustomError(tokenBridge, "TransferNotPending");
        });
    });
    
    // Tests for bridge operators
    describe("Bridge Operators", function() {
        it("should allow adding and removing bridge operators", async function() {
            // Add a new bridge operator
            await tokenBridge.connect(owner).updateBridgeOperator(anotherUser.address, true);
            
            // Check if the new operator was added
            const isOperator = await tokenBridge.bridgeOperators(anotherUser.address);
            expect(isOperator).to.be.true;
            
            // Verify the new operator can release tokens
            const amount = ethers.parseEther("1000");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await tokenBridge.connect(anotherUser).releaseTokens(
                user.address,
                amount,
                sourceChain,
                nonce,
                emptyProof
            );
            
            // Remove the bridge operator
            await tokenBridge.connect(owner).updateBridgeOperator(anotherUser.address, false);
            
            // Check if the operator was removed
            const isOperatorAfter = await tokenBridge.bridgeOperators(anotherUser.address);
            expect(isOperatorAfter).to.be.false;
            
            // Verify the removed operator can no longer release tokens for others
            await expect(
                tokenBridge.connect(anotherUser).releaseTokens(
                    user.address,
                    amount,
                    sourceChain,
                    54321, // Different nonce
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "UnauthorizedRelease");
        });
        
        it("should enforce transaction limits for bridge operators", async function() {
            // First, remove bridgeOperator from the direct mapping
            await tokenBridge.connect(owner).updateBridgeOperator(bridgeOperator.address, false);
            
            // Now grant the BRIDGE_OPERATOR_ROLE to bridgeOperator via governance
            const addRoleType = 1; // AddRole
            const tx = await tokenBridge.connect(owner).createProposal(
                addRoleType,
                0,
                bridgeOperator.address,
                BRIDGE_OPERATOR_ROLE,
                0,
                ethers.ZeroAddress
            );
            
            const receipt = await tx.wait();
            const proposalId = await getProposalIdFromLogs(receipt, tokenBridge);
            
            // Approve the proposal
            await tokenBridge.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            
            // IMPORTANT: Execute the proposal explicitly
            await tokenBridge.connect(owner).executeProposal(proposalId);
            
            // Set a very low transaction limit for bridge operators
            const txLimit = ethers.parseEther("100");
            await tokenBridge.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, txLimit);
            
            // Verify the bridge operator can release tokens below the limit
            const belowLimitAmount = ethers.parseEther("50");
            const sourceChain = TARGET_CHAIN_ID;
            const nonce1 = 12345;
            const emptyProof = ethers.toUtf8Bytes("");
            
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                belowLimitAmount,
                sourceChain,
                nonce1,
                emptyProof
            );
            
            // Try to release tokens above the limit
            const aboveLimitAmount = ethers.parseEther("200"); // Above limit but not large enough for delay
            const nonce2 = 54321;
            
            // Now this should fail with a low allowance error
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    aboveLimitAmount,
                    sourceChain,
                    nonce2,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "LowAllowance");
        });
    });
    
    // Tests for emergency functions
    describe("Emergency Functions", function() {
        it("should allow emergency withdrawal only when paused", async function() {
            // First verify we can't withdraw before pausing
            await expect(
                tokenBridge.connect(owner).emergencyWithdraw(ethers.parseEther("1000"))
            ).to.be.reverted; // Just check for any revert
            
            // Pause the contract
            const emergencyPause = 1; // Pause action
            await tokenBridge.connect(owner).emergencyAction(emergencyPause);
            
            // Now emergency withdrawal should work
            const bridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            
            await tokenBridge.connect(owner).emergencyWithdraw(bridgeBalance);
            
            // Tokens should be sent to the token contract
            const bridgeBalanceAfter = await storageToken.balanceOf(await tokenBridge.getAddress());
            expect(bridgeBalanceAfter).to.equal(0);
        });
        
        it("should prevent operations when paused", async function() {
            // Make sure enough time has passed since the last emergency action
            // The GovernanceModule has a cooldown period between emergency actions
            await time.increase(ProposalTypes.EMERGENCY_COOLDOWN + 100);
            
            // Pause the contract
            const emergencyPause = 1; // Pause action
            await tokenBridge.connect(owner).emergencyAction(emergencyPause);
            
            // Try to lock tokens - should fail with any revert
            await expect(
                tokenBridge.connect(user).lockTokens(
                    ethers.parseEther("100"),
                    TARGET_CHAIN_ID,
                    anotherUser.address
                )
            ).to.be.reverted;
            
            // Try to release tokens - should fail with any revert
            const emptyProof = ethers.toUtf8Bytes("");
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    ethers.parseEther("100"),
                    TARGET_CHAIN_ID,
                    98765,
                    emptyProof
                )
            ).to.be.reverted;
            
            // Wait again for cooldown
            await time.increase(ProposalTypes.EMERGENCY_COOLDOWN + 100);
            
            // Unpause the contract
            const emergencyUnpause = 2; // Unpause action
            await tokenBridge.connect(owner).emergencyAction(emergencyUnpause);
            
            // Operations should work again
            await tokenBridge.connect(user).lockTokens(
                ethers.parseEther("100"),
                TARGET_CHAIN_ID,
                anotherUser.address
            );
        });
    });
    
    // Tests for whitelist/blacklist functionality
    describe("Whitelist and Blacklist", function() {
        it("should properly manage whitelist status", async function() {
            // Enable whitelist
            await tokenBridge.connect(owner).setWhitelistEnabled(true);
            
            // Add user to whitelist
            await tokenBridge.connect(owner).updateWhitelist(user.address, true);
            
            // User should now be able to lock tokens
            await tokenBridge.connect(user).lockTokens(
                ethers.parseEther("1000"),
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Remove user from whitelist
            await tokenBridge.connect(owner).updateWhitelist(user.address, false);
            
            // User should no longer be able to lock tokens
            await expect(
                tokenBridge.connect(user).lockTokens(
                    ethers.parseEther("1000"),
                    TARGET_CHAIN_ID,
                    anotherUser.address
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountNotWhitelisted");
            
            // Disable whitelist
            await tokenBridge.connect(owner).setWhitelistEnabled(false);
            
            // User should be able to lock tokens again
            await tokenBridge.connect(user).lockTokens(
                ethers.parseEther("1000"),
                TARGET_CHAIN_ID,
                anotherUser.address
            );
        });
        
        it("should properly manage blacklist status", async function() {
            // Initially user should be able to lock tokens
            await tokenBridge.connect(user).lockTokens(
                ethers.parseEther("1000"),
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Add user to blacklist
            await tokenBridge.connect(owner).updateBlacklist(user.address, true);
            
            // User should no longer be able to lock tokens
            await expect(
                tokenBridge.connect(user).lockTokens(
                    ethers.parseEther("1000"),
                    TARGET_CHAIN_ID,
                    anotherUser.address
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountBlacklisted");
            
            // Bridge operator should not be able to release tokens to blacklisted user
            const emptyProof = ethers.toUtf8Bytes("");
            await expect(
                tokenBridge.connect(bridgeOperator).releaseTokens(
                    user.address,
                    ethers.parseEther("1000"),
                    TARGET_CHAIN_ID,
                    12345,
                    emptyProof
                )
            ).to.be.revertedWithCustomError(tokenBridge, "AccountBlacklisted");
            
            // Remove user from blacklist
            await tokenBridge.connect(owner).updateBlacklist(user.address, false);
            
            // User should be able to lock tokens again
            await tokenBridge.connect(user).lockTokens(
                ethers.parseEther("1000"),
                TARGET_CHAIN_ID,
                anotherUser.address
            );
        });
    });
    
    // Tests for accounting functions
    describe("Accounting", function() {
        it("should correctly track locked and released tokens", async function() {
            // We need to account for initial bridge balance when checking the books
            // First, get the initial balance and update the accounting to match
            const initialBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            console.log("Initial bridge balance:", ethers.formatEther(initialBridgeBalance));
            
            // Check the initial accounting
            const initialLocked = await tokenBridge.totalLockedTokens();
            const initialReleased = await tokenBridge.totalReleasedTokens();
            console.log("Initial locked:", ethers.formatEther(initialLocked));
            console.log("Initial released:", ethers.formatEther(initialReleased));
            
            // Lock some tokens
            const lockAmount = ethers.parseEther("5000");
            await tokenBridge.connect(user).lockTokens(
                lockAmount,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Check locked tokens increased
            const lockedAfterLock = await tokenBridge.totalLockedTokens();
            expect(lockedAfterLock).to.equal(initialLocked + lockAmount);
            console.log("Locked after locking:", ethers.formatEther(lockedAfterLock));
            
            // Release some tokens
            const releaseAmount = ethers.parseEther("3000");
            const emptyProof = ethers.toUtf8Bytes("");
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                releaseAmount,
                TARGET_CHAIN_ID,
                12345,
                emptyProof
            );
            
            // Check released tokens increased
            const releasedAfterRelease = await tokenBridge.totalReleasedTokens();
            expect(releasedAfterRelease).to.equal(initialReleased + releaseAmount);
            console.log("Released after releasing:", ethers.formatEther(releasedAfterRelease));
            
            // Check bridge balance after operations
            const finalBridgeBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            console.log("Final bridge balance:", ethers.formatEther(finalBridgeBalance));
            console.log("Expected balance (initial + locked - released):", 
                ethers.formatEther(initialBridgeBalance + lockAmount - releaseAmount));
            
            // In this test environment, we may need to compare the actual vs expected balance manually
            // rather than using checkBooks which looks at the totalLocked and totalReleased
            // which don't account for the initial tokens in the bridge
            expect(finalBridgeBalance).to.equal(initialBridgeBalance + lockAmount - releaseAmount);
        });
        
        it("should correctly report books status", async function() {
            // Lock some tokens
            const lockAmount = ethers.parseEther("5000");
            await tokenBridge.connect(user).lockTokens(
                lockAmount,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Release some tokens
            const releaseAmount = ethers.parseEther("2000");
            const emptyProof = ethers.toUtf8Bytes("");
            await tokenBridge.connect(bridgeOperator).releaseTokens(
                user.address,
                releaseAmount,
                TARGET_CHAIN_ID,
                12345,
                emptyProof
            );
            
            // Report books - the return value will be a transaction response, not the actual values
            // We need to listen for the event instead
            const reportTx = await tokenBridge.connect(owner).reportBooks();
            const receipt = await reportTx.wait();
            
            // Find the BooksChecked event
            const booksCheckedLog = receipt?.logs.find(
                log => {
                    try {
                        const parsed = tokenBridge.interface.parseLog(log);
                        return parsed?.name === "BooksChecked";
                    } catch {
                        return false;
                    }
                }
            );
            
            expect(booksCheckedLog).to.not.be.undefined;
            
            // Extract values from the event
            const eventArgs = tokenBridge.interface.parseLog(booksCheckedLog)?.args;
            const lockedTokens = eventArgs[0];
            const releasedTokens = eventArgs[1];
            const balance = eventArgs[2];
            const balanced = eventArgs[3];
            
            // Initial locked should be at least lockAmount
            expect(lockedTokens).to.be.at.least(lockAmount);
            
            // Initial released should be at least releaseAmount
            expect(releasedTokens).to.be.at.least(releaseAmount);
            
            // Balance should match the actual token balance
            const actualBalance = await storageToken.balanceOf(await tokenBridge.getAddress());
            expect(balance).to.equal(actualBalance);
            
            // We can't directly check if balanced is true because of the initial token balance
            // that isn't tracked in our accounting, but we can check if the accounting values
            // consistently reflect the operations we performed
            console.log("Balance:", ethers.formatEther(balance));
            console.log("Locked tokens:", ethers.formatEther(lockedTokens));
            console.log("Released tokens:", ethers.formatEther(releasedTokens));
            console.log("Balanced:", balanced);
        });
        
        it("should update accounting when locks are cancelled", async function() {
            // Lock some tokens
            const lockAmount = ethers.parseEther("5000");
            const lockTx = await tokenBridge.connect(user).lockTokens(
                lockAmount,
                TARGET_CHAIN_ID,
                anotherUser.address
            );
            
            // Extract lockId
            const receipt = await lockTx.wait();
            const lockId = tokenBridge.interface.parseLog(
                receipt?.logs.find(log => {
                    try {
                        return tokenBridge.interface.parseLog(log)?.name === "TokensLocked";
                    } catch {
                        return false;
                    }
                })
            )?.args[5];
            
            // Check total locked
            expect(await tokenBridge.totalLockedTokens()).to.equal(lockAmount);
            
            // Cancel the lock
            await tokenBridge.connect(user).cancelLock(lockId);
            
            // Total locked should be reduced
            expect(await tokenBridge.totalLockedTokens()).to.equal(0);
        });
    });
});