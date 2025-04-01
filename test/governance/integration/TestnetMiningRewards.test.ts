import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { TestnetMiningRewards, StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Wallet, SigningKey, getBytes, toQuantity } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAddress } from '@polkadot/util-crypto';

// Use the same value as in ProposalTypes.sol
const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));

function getMatchingAddresses() {
    // 1. Generate Ethereum key pair
    const ethPrivateKey = new ethers.SigningKey(ethers.Wallet.createRandom().privateKey).privateKey;
    const ethWallet = new ethers.Wallet(ethPrivateKey);

    // 2. Derive Sr25519 public key (mock for testing)
    // In practice, this should be derived from the same seed as the Ethereum key
    const sr25519PublicKey = ethers.randomBytes(32); // Mock Sr25519 public key

    // 3. Create Substrate address (SS58 format)
    const substrateWallet = encodeAddress(sr25519PublicKey, 42);

    return {
        ethPrivateKey,
        ethAddress: ethWallet.address,
        substrateWallet
    };
}


describe("TestnetMiningRewards", function () {
    let rewardsContract: TestnetMiningRewards;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let user: Wallet;
    let otherUser: SignerWithAddress;
    let SUBSTRATE_WALLET: string;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000");
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2);
    const REWARDS_AMOUNT = ethers.parseEther("1000000");
    const CLIFF_PERIOD = 14; // 14 days
    const VESTING_PERIOD = 6; // 6 months
    const INITIAL_RELEASE = 0;
    const MAX_MONTHLY_REWARDS = ethers.parseEther("1000");
    const REWARDS_RATIO = 10; // 10:1 ratio
    const SUBSTRATE_REWARDS = ethers.parseEther("1000"); // 1000 tokens in testnet

    beforeEach(async function () {
        [owner, admin, otherUser, otherAccount] = await ethers.getSigners();
        const { ethPrivateKey, ethAddress, substrateWallet } = getMatchingAddresses();
        SUBSTRATE_WALLET = substrateWallet;

        user = new Wallet(ethPrivateKey, ethers.provider);
        await ethers.provider.send('hardhat_setBalance', [
            ethAddress,
            toQuantity(ethers.parseEther('100'))
        ]);
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TestnetMiningRewards
        const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
        rewardsContract = await upgrades.deployProxy(
            TestnetMiningRewards, 
            [
                await storageToken.getAddress(),
                owner.address,
                admin.address
            ],
            { kind: 'uups', initializer: 'initialize' }
        );
        await rewardsContract.waitForDeployment();

        // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
        await time.increase(24 * 60 * 60 + 1);

        // Set up roles and permissions
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await rewardsContract.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        await time.increase(24 * 60 * 60 + 1);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
        
        // Whitelist contracts (same as original)
        const addWhitelistType = 5;
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await rewardsContract.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const proposalId = receipt?.logs[0].topics[1];

        await time.increase(24 * 60 * 60 + 1);
        await storageToken.connect(admin).approveProposal(proposalId);
        
        await time.increase(24 * 60 * 60 + 1);
        
        // Transfer tokens to rewards contract
        await storageToken.connect(owner).transferFromContract(
            await rewardsContract.getAddress(),
            REWARDS_AMOUNT
        );

        // Add rewards vesting cap
        await rewardsContract.connect(owner).addVestingCap(
            1,
            ethers.encodeBytes32String("Mining Rewards"),
            1, // Add startDate parameter (will be replaced by TGE timestamp)
            REWARDS_AMOUNT,
            CLIFF_PERIOD,
            VESTING_PERIOD,
            1,
            INITIAL_RELEASE,
            MAX_MONTHLY_REWARDS,
            REWARDS_RATIO
        );

        // Set TGE
        await rewardsContract.connect(owner).initiateTGE();

        // Set up wallet mappings
        await rewardsContract.connect(owner).batchAddAddresses(
            [user.address],
            [ethers.toUtf8Bytes(SUBSTRATE_WALLET)]
        );
    });

    it("should return 0 if user has no substrate rewards", async function () {
        await time.increase(15 * 24 * 60 * 60); // Past cliff

        await expect(
            rewardsContract.calculateDueTokens(user.address, SUBSTRATE_WALLET, 1)
        ).to.be.revertedWithCustomError(rewardsContract, "NothingToClaim");
    });

    it("should respect monthly rewards limit", async function () {
        // First add the wallet to the vesting cap
        const addWalletProposal = await rewardsContract.connect(owner).createProposal(
            7, // AddDistributionWallets type
            1, // capId
            user.address,
            ethers.ZeroHash,
            REWARDS_AMOUNT,
            ethers.ZeroAddress
        );

        const receipt = await addWalletProposal.wait();
        const proposalId = receipt?.logs[0].topics[1];

        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        await rewardsContract.connect(admin).approveProposal(proposalId);
        await time.increase(24 * 60 * 60 + 1);

        // Set up wallet mapping if not already done
        await rewardsContract.connect(owner).batchAddAddresses(
            [user.address],
            [ethers.toUtf8Bytes(SUBSTRATE_WALLET)]
        );
        // Set high substrate rewards
        const highRewards = ethers.parseEther("20000");
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            highRewards
        );
        
        await time.increase(45 * 24 * 60 * 60);
        const dueTokens = await rewardsContract.calculateDueTokens(
            user.address,
            SUBSTRATE_WALLET,
            1
        );

        // Try to claim
        await rewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
        
        const walletInfo = await rewardsContract.vestingWallets(user.address, 1);
        expect(walletInfo.monthlyClaimedRewards).to.equal(MAX_MONTHLY_REWARDS);
    });

    describe("TestnetMiningRewards2", function () {
        let zeroCliffRewardsContract: TestnetMiningRewards;
        
        beforeEach(async function () {
            // Deploy a fresh contract instance for this test
            const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
            zeroCliffRewardsContract = await upgrades.deployProxy(
                TestnetMiningRewards, 
                [
                    await storageToken.getAddress(),
                    owner.address,
                    admin.address
                ],
                { kind: 'uups', initializer: 'initialize' }
            );
            await zeroCliffRewardsContract.waitForDeployment();

            // Set up roles and permissions
            await zeroCliffRewardsContract.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            await time.increase(24 * 60 * 60 + 1);
            
            // Whitelist the contract
            const addWhitelistType = 5;
            const tx = await storageToken.connect(owner).createProposal(
                addWhitelistType,
                0,
                await zeroCliffRewardsContract.getAddress(),
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];
            await time.increase(24 * 60 * 60 + 1);
            await storageToken.connect(admin).approveProposal(proposalId);
            await time.increase(24 * 60 * 60 + 1);
            
            // Transfer tokens to rewards contract
            await storageToken.connect(owner).transferFromContract(
                await zeroCliffRewardsContract.getAddress(),
                REWARDS_AMOUNT
            );

            // Create a vesting cap with zero cliff
            await zeroCliffRewardsContract.connect(owner).addVestingCap(
                1, // capId
                ethers.encodeBytes32String("Zero Cliff Cap"),
                1, // startDate (will be replaced by TGE)
                REWARDS_AMOUNT,
                0, // zero cliff
                6, // 6 months vesting
                1, // monthly vesting plan
                0, // zero initial release
                MAX_MONTHLY_REWARDS,
                10 // 10:1 ratio
            );

            // Add user to the cap
            const addUserProposal = await zeroCliffRewardsContract.connect(owner).createProposal(
                7, // AddDistributionWallets type
                1, // capId
                user.address,
                ethers.ZeroHash,
                REWARDS_AMOUNT,
                ethers.ZeroAddress
            );
            const userReceipt = await addUserProposal.wait();
            const userProposalId = userReceipt?.logs[0].topics[1];
            await time.increase(24 * 60 * 60 + 1);
            await zeroCliffRewardsContract.connect(admin).approveProposal(userProposalId);
            await time.increase(24 * 60 * 60 + 1);

            // Set up wallet mapping
            await zeroCliffRewardsContract.connect(owner).batchAddAddresses(
                [user.address],
                [ethers.toUtf8Bytes(SUBSTRATE_WALLET)]
            );

            // Set substrate rewards - this is critical for the tests to pass
            await zeroCliffRewardsContract.connect(owner).updateSubstrateRewards(
                user.address,
                SUBSTRATE_REWARDS
            );

            // Initialize TGE
            await zeroCliffRewardsContract.connect(owner).initiateTGE();
        });

        it("should prevent double claiming in month 0 with zero cliff", async function () {
            // Calculate due tokens - should be able to claim in month 0 with zero cliff
            const expectedRewards = SUBSTRATE_REWARDS / BigInt(10); // 10:1 ratio
            const dueTokens = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                1
            );
            expect(dueTokens).to.equal(expectedRewards);
            
            // First claim should succeed
            await zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
            
            // Verify claim was processed
            const walletInfo = await zeroCliffRewardsContract.vestingWallets(user.address, 1);
            expect(walletInfo.claimed).to.equal(expectedRewards);
            expect(walletInfo.lastClaimMonth).to.equal(0); // Month 0
            
            // Second claim in the same month should return 0 tokens due
            const dueTokensAfterClaim = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                1
            );
            expect(dueTokensAfterClaim).to.equal(0);
            
            // Attempting to claim again should revert
            await expect(
                zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1)
            ).to.be.revertedWithCustomError(zeroCliffRewardsContract, "InvalidOperation");
        });

        it("should calculate rewards based on substrate balance and ratio", async function () {
            const expectedRewards = SUBSTRATE_REWARDS / BigInt(10); // 10:1 ratio
            const dueTokens = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                1
            );
            expect(dueTokens).to.equal(expectedRewards);
        });

        it("should revert if substrate wallet doesn't match mapped wallet", async function () {
            const wrongSubstrateWallet = "wrong_substrate_wallet";
            await expect(
                zeroCliffRewardsContract.calculateDueTokens(user.address, wrongSubstrateWallet, 1)
            ).to.be.revertedWithCustomError(zeroCliffRewardsContract, "WalletMismatch");
        });

        it("should reset monthly claimed rewards in new month", async function () {
            // First claim in month 0
            await zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
            
            // Advance time to next month
            await time.increase(31 * 24 * 60 * 60); // 31 days
            
            // Should be able to claim again in month 1
            const dueTokensMonth1 = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                1
            );
            expect(dueTokensMonth1).to.equal(SUBSTRATE_REWARDS / BigInt(10));
            
            await zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
            
            // Verify monthly claimed rewards were reset
            const walletInfo = await zeroCliffRewardsContract.vestingWallets(user.address, 1);
            expect(walletInfo.lastClaimMonth).to.equal(1); // Month 1
        });

        it("should not allow claiming more than total allocation", async function () {
            // First create a new vesting cap with specific allocation and monthly limit
            const totalAllocation = ethers.parseEther("16000");
            const monthlyLimit = ethers.parseEther("8000");
            
            await zeroCliffRewardsContract.connect(owner).addVestingCap(
                3, // new capId
                ethers.encodeBytes32String("Total Allocation Test Cap"),
                1, // startDate (will be replaced by TGE timestamp)
                totalAllocation,
                0, // zero cliff
                6, // 6 months vesting
                1, // monthly vesting plan
                0, // zero initial release
                monthlyLimit, // monthly limit of 8000 tokens
                10 // 10:1 ratio
            );

            // Add user to the cap
            const addWalletProposal = await zeroCliffRewardsContract.connect(owner).createProposal(
                7, // AddDistributionWallets type
                3, // capId
                user.address,
                ethers.ZeroHash,
                totalAllocation,
                ethers.ZeroAddress
            );

            const receipt = await addWalletProposal.wait();
            const proposalId = receipt?.logs[0].topics[1];

            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            await zeroCliffRewardsContract.connect(admin).approveProposal(proposalId);
            await time.increase(24 * 60 * 60 + 1);

            // Set substrate rewards to match total allocation with ratio
            const substrateRewards = totalAllocation * BigInt(10); // 10:1 ratio
            await zeroCliffRewardsContract.connect(owner).updateSubstrateRewards(
                user.address,
                substrateRewards
            );
            
            // First month claim (should get 8000 tokens due to monthly limit)
            const dueTokensMonth1 = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                3
            );
            
            // Due tokens should be the full amount divided by ratio, but limited by monthly cap
            const expectedDueTokens = substrateRewards / BigInt(10);
            expect(dueTokensMonth1).to.equal(expectedDueTokens);
            
            // Claim the tokens
            await zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 3);
            
            // Verify claimed amount is limited by monthly cap
            let walletInfo = await zeroCliffRewardsContract.vestingWallets(user.address, 3);
            expect(walletInfo.claimed).to.equal(monthlyLimit);
            expect(walletInfo.monthlyClaimedRewards).to.equal(monthlyLimit);
            
            // Move to next month
            await time.increase(31 * 24 * 60 * 60);
            
            // Second month claim (should get remaining 8000 tokens)
            const dueTokensMonth2 = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                3
            );
            expect(dueTokensMonth2).to.equal(expectedDueTokens);
            
            await zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 3);
            
            // Verify total claimed amount equals total allocation
            walletInfo = await zeroCliffRewardsContract.vestingWallets(user.address, 3);
            expect(walletInfo.claimed).to.equal(totalAllocation);
            
            // Move to next month
            await time.increase(31 * 24 * 60 * 60);
            
            // Third month claim (should return 0 as total allocation is exhausted)
            // This is where we test if the contract properly prevents claiming more than total allocation
            const dueTokensMonth3 = await zeroCliffRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                3
            );
            expect(dueTokensMonth3).to.equal(0);
            
            // Attempting to claim should revert with InvalidOperation(2) - Nothing due
            await expect(
                zeroCliffRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 3)
            ).to.be.revertedWithCustomError(zeroCliffRewardsContract, "InvalidOperation").withArgs(2);
        });

        it("should successfully remove a wallet from distribution cap", async function () {
            // First check the current cap allocation
            const capBefore = await zeroCliffRewardsContract.vestingCaps(1);
            console.log("Current cap allocation:", capBefore.allocatedToWallets.toString());
            console.log("Total cap allocation:", capBefore.totalAllocation.toString());
            
            // We need to create a new cap with enough space for our test
            await zeroCliffRewardsContract.connect(owner).addVestingCap(
                2, // New capId
                ethers.encodeBytes32String("Test Removal Cap"),
                1, // startDate will be replaced by TGE timestamp
                ethers.parseEther("2000000"), // Plenty of allocation
                CLIFF_PERIOD,
                VESTING_PERIOD,
                1,
                INITIAL_RELEASE,
                MAX_MONTHLY_REWARDS,
                REWARDS_RATIO
            );
            
            // First add another user to the cap
            const addUserProposal = await zeroCliffRewardsContract.connect(owner).createProposal(
                7, // AddDistributionWallets type
                2, // Use the new capId
                otherUser.address,
                ethers.ZeroHash,
                ethers.parseEther("1000"), // Small amount
                ethers.ZeroAddress
            );
            const userReceipt = await addUserProposal.wait();
            const userProposalId = userReceipt?.logs[0].topics[1];
            await time.increase(24 * 60 * 60 + 1);
            await zeroCliffRewardsContract.connect(admin).approveProposal(userProposalId);
            await time.increase(24 * 60 * 60 + 1);

            // Set up substrate wallet mapping for otherUser
            const OTHER_SUBSTRATE_WALLET = "other_substrate_wallet";
            await zeroCliffRewardsContract.connect(owner).batchAddAddresses(
                [otherUser.address],
                [ethers.toUtf8Bytes(OTHER_SUBSTRATE_WALLET)]
            );
            
            // Set substrate rewards for otherUser
            await zeroCliffRewardsContract.connect(owner).updateSubstrateRewards(
                otherUser.address,
                SUBSTRATE_REWARDS
            );
            
            // Verify the wallet was added
            const capAfter = await zeroCliffRewardsContract.vestingCaps(2);
            console.log("Cap after adding wallet:", {
                totalAllocation: capAfter.totalAllocation.toString(),
                allocatedToWallets: capAfter.allocatedToWallets.toString(),
                hasWallets: capAfter.wallets !== undefined
            });
            
            // Use getWalletsInCap function instead of directly accessing the wallets array
            const walletsInCap = await zeroCliffRewardsContract.getWalletsInCap(2);
            let walletFound = false;
            for (let i = 0; i < walletsInCap.length; i++) {
                if (walletsInCap[i].toLowerCase() === otherUser.address.toLowerCase()) {
                    walletFound = true;
                    break;
                }
            }
            expect(walletFound).to.be.true;
            
            // Now remove the user - For RemoveDistributionWallet, amount should be 0
            const removeWalletType = 8; // RemoveDistributionWallet type
            console.log("Using RemoveDistributionWallet type:", removeWalletType);
            
            // First, check if there are any pending proposals for this wallet
            try {
                const pendingProposal = await zeroCliffRewardsContract.pendingProposals(otherUser.address);
                if (pendingProposal.proposalType !== 0) {
                    console.log("Pending proposal exists, need to clear it first");
                    // We'd need to clear this, but for test purposes we'll just use a different wallet
                }
            } catch (e) {
                console.log("Error checking pending proposals:", e);
            }
            
            // Create the removal proposal
            try {
                const removeProposal = await zeroCliffRewardsContract.connect(owner).createProposal(
                    removeWalletType, // RemoveDistributionWallet type
                    2, // capId
                    otherUser.address, // wallet to remove
                    ethers.ZeroHash, // data
                    0, // amount must be 0 for removal
                    ethers.ZeroAddress // token
                );
                
                const removeReceipt = await removeProposal.wait();
                const removeProposalId = removeReceipt?.logs[0].topics[1];
                await time.increase(24 * 60 * 60 + 1);
                await zeroCliffRewardsContract.connect(admin).approveProposal(removeProposalId);
                await time.increase(24 * 60 * 60 + 1);
                
                // After removal, attempting to calculate due tokens should fail
                await expect(
                    zeroCliffRewardsContract.calculateDueTokens(otherUser.address, OTHER_SUBSTRATE_WALLET, 2)
                ).to.be.revertedWithCustomError(zeroCliffRewardsContract, "NothingToClaim");
            } catch (error) {
                console.log("Detailed error:", error);
                throw error;
            }
        });
    });

    describe("Multiple Users with Different Vesting Caps", function () {
        let user2: Wallet;
        let SUBSTRATE_WALLET_2: string;
        let localRewardsContract: TestnetMiningRewards;

        beforeEach(async function () {
            // Create second user with matching addresses
            const { ethPrivateKey, substrateWallet } = getMatchingAddresses();
            SUBSTRATE_WALLET_2 = substrateWallet;
            user2 = new Wallet(ethPrivateKey, ethers.provider);
            await ethers.provider.send('hardhat_setBalance', [
                user2.address,
                toQuantity(ethers.parseEther('100'))
            ]);

            // Deploy a fresh contract instance for this test to avoid sharing state
            const TestnetMiningRewards = await ethers.getContractFactory("TestnetMiningRewards");
            localRewardsContract = await upgrades.deployProxy(
                TestnetMiningRewards, 
                [
                    await storageToken.getAddress(),
                    owner.address,
                    admin.address
                ],
                { kind: 'uups', initializer: 'initialize' }
            );
            await localRewardsContract.waitForDeployment();

            // Wait for role change timelock to expire (ROLE_CHANGE_DELAY is 1 day)
            await time.increase(24 * 60 * 60 + 1);

            // Set up roles and permissions
            await localRewardsContract.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            
            // Whitelist the contract
            const addWhitelistType = 5;
            const tx = await storageToken.connect(owner).createProposal(
                addWhitelistType,
                0,
                await localRewardsContract.getAddress(),
                ethers.ZeroHash,
                0,
                ZeroAddress
            );
            
            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];

            await time.increase(24 * 60 * 60 + 1);
            await storageToken.connect(admin).approveProposal(proposalId);
            
            await time.increase(24 * 60 * 60 + 1);
            
            // Transfer tokens to rewards contract
            await storageToken.connect(owner).transferFromContract(
                await localRewardsContract.getAddress(),
                REWARDS_AMOUNT
            );

            // Create two vesting caps with different parameters
            // Cap 1: No cliff, 6 month vesting, 10:1 ratio
            await localRewardsContract.connect(owner).addVestingCap(
                2, // new cap ID
                ethers.encodeBytes32String("Cap1"),
                1, // Add startDate parameter (will be replaced by TGE timestamp)
                REWARDS_AMOUNT,
                0, // no cliff
                6, // 6 months vesting
                1,
                INITIAL_RELEASE,
                MAX_MONTHLY_REWARDS,
                10 // 10:1 ratio
            );

            // Cap 2: 12 month cliff, 6 month vesting, 6:1 ratio
            await localRewardsContract.connect(owner).addVestingCap(
                3, // new cap ID
                ethers.encodeBytes32String("Cap2"),
                1, // Add startDate parameter (will be replaced by TGE timestamp)
                REWARDS_AMOUNT,
                365, // 12 months cliff
                6, // 6 months vesting
                1,
                INITIAL_RELEASE,
                MAX_MONTHLY_REWARDS,
                6 // 6:1 ratio
            );

            // Add users to their respective caps
            // User 1 -> Cap 2
            const addUser1Proposal = await localRewardsContract.connect(owner).createProposal(
                7, // AddDistributionWallets type
                2, // capId
                user.address,
                ethers.ZeroHash,
                REWARDS_AMOUNT,
                ethers.ZeroAddress
            );
            let propReceipt = await addUser1Proposal.wait();
            let propId = propReceipt?.logs[0].topics[1];
            await time.increase(24 * 60 * 60 + 1);
            await localRewardsContract.connect(admin).approveProposal(propId);
            await time.increase(24 * 60 * 60 + 1);

            // User 2 -> Cap 3
            const addUser2Proposal = await localRewardsContract.connect(owner).createProposal(
                7, // AddDistributionWallets type
                3, // capId
                user2.address,
                ethers.ZeroHash,
                REWARDS_AMOUNT,
                ethers.ZeroAddress
            );
            propReceipt = await addUser2Proposal.wait();
            propId = propReceipt?.logs[0].topics[1];
            await time.increase(24 * 60 * 60 + 1);
            await localRewardsContract.connect(admin).approveProposal(propId);
            await time.increase(24 * 60 * 60 + 1);

            // Set up wallet mappings
            await localRewardsContract.connect(owner).batchAddAddresses(
                [user.address, user2.address],
                [ethers.toUtf8Bytes(SUBSTRATE_WALLET), ethers.toUtf8Bytes(SUBSTRATE_WALLET_2)]
            );

            // Set substrate rewards for both users
            await localRewardsContract.connect(owner).updateSubstrateRewards(
                user.address,
                SUBSTRATE_REWARDS
            );
            await localRewardsContract.connect(owner).updateSubstrateRewards(
                user2.address,
                SUBSTRATE_REWARDS
            );

            // Initialize TGE
            await localRewardsContract.connect(owner).initiateTGE();
            
            // Verify that vesting cap start dates are set to TGE timestamp
            const tgeTimestamp = await localRewardsContract.tgeTimestamp();
            const cap2After = await localRewardsContract.vestingCaps(2);
            const cap3After = await localRewardsContract.vestingCaps(3);
            expect(cap2After.startDate).to.equal(tgeTimestamp);
            expect(cap3After.startDate).to.equal(tgeTimestamp);
        });

        it("should correctly calculate and distribute rewards based on different ratios and cliffs", async function () {
            // Increase time by 30 days - this should be within the cliff period for user2
            await time.increase(30 * 24 * 60 * 60 + 1);
            
            // User 1 should be able to claim immediately (no cliff)
            const expectedUser1Rewards = SUBSTRATE_REWARDS / BigInt(10); // 10:1 ratio
            const dueTokens1 = await localRewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                2
            );
            expect(dueTokens1).to.equal(expectedUser1Rewards);

            // User 2 should not be able to claim yet (12 month cliff)
            const amount = await localRewardsContract.calculateDueTokens(user2.address, SUBSTRATE_WALLET_2, 3);
            expect(amount).to.equal(0n);

            // Move forward 13 months to pass the cliff for user2
            await time.increase(395 * 24 * 60 * 60); // Past cliff for both users

            // User 2 should now be able to claim
            const expectedUser2Rewards = SUBSTRATE_REWARDS / BigInt(6); // 6:1 ratio
            const dueTokens2 = await localRewardsContract.calculateDueTokens(
                user2.address,
                SUBSTRATE_WALLET_2,
                3
            );
            expect(dueTokens2).to.equal(expectedUser2Rewards);

            // Both users claim
            await localRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 2);
            await localRewardsContract.connect(user2).claimTokens(SUBSTRATE_WALLET_2, 3);

            // Verify claimed amounts
            const walletInfo1 = await localRewardsContract.vestingWallets(user.address, 2);
            const walletInfo2 = await localRewardsContract.vestingWallets(user2.address, 3);

            expect(walletInfo1.claimed).to.equal(expectedUser1Rewards);
            expect(walletInfo2.claimed).to.equal(expectedUser2Rewards);

            // Move forward another month
            await time.increase(30 * 24 * 60 * 60);

            // Both users should be able to claim again
            await localRewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 2);
            await localRewardsContract.connect(user2).claimTokens(SUBSTRATE_WALLET_2, 3);

            // Verify new claimed amounts
            const walletInfo1After = await localRewardsContract.vestingWallets(user.address, 2);
            const walletInfo2After = await localRewardsContract.vestingWallets(user2.address, 3);

            expect(walletInfo1After.claimed).to.equal(expectedUser1Rewards * BigInt(2));
            expect(walletInfo2After.claimed).to.equal(expectedUser2Rewards * BigInt(2));
        });
    });

    describe("Vesting Cap Creation and Validation", function () {
        it("should revert when creating cap with zero allocation", async function () {
            await expect(
                rewardsContract.connect(owner).addVestingCap(
                    2, // new cap ID
                    ethers.encodeBytes32String("Test Cap"),
                    1, // Add startDate parameter (will be replaced by TGE timestamp)
                    0, // zero allocation
                    CLIFF_PERIOD,
                    VESTING_PERIOD,
                    1,
                    INITIAL_RELEASE,
                    MAX_MONTHLY_REWARDS,
                    REWARDS_RATIO
                )
            ).to.be.revertedWithCustomError(rewardsContract, "InvalidParameter");
        });

        it("should revert when creating cap with invalid ratio", async function () {
            await expect(
                rewardsContract.connect(owner).addVestingCap(
                    2, // new cap ID
                    ethers.encodeBytes32String("Test Cap"),
                    1, // Add startDate parameter (will be replaced by TGE timestamp)
                    REWARDS_AMOUNT,
                    CLIFF_PERIOD,
                    VESTING_PERIOD,
                    1,
                    INITIAL_RELEASE,
                    MAX_MONTHLY_REWARDS,
                    0 // invalid ratio
                )
            ).to.be.revertedWithCustomError(rewardsContract, "InvalidParameter");
        });

        it("should create cap with valid parameters", async function () {
            const capId = 2; // new cap ID
            await rewardsContract.connect(owner).addVestingCap(
                capId,
                ethers.encodeBytes32String("Test Cap"),
                1, // Add startDate parameter (will be replaced by TGE timestamp)
                REWARDS_AMOUNT,
                CLIFF_PERIOD,
                VESTING_PERIOD,
                1,
                INITIAL_RELEASE,
                MAX_MONTHLY_REWARDS,
                REWARDS_RATIO
            );

            const cap = await rewardsContract.vestingCaps(capId);
            expect(cap.totalAllocation).to.equal(REWARDS_AMOUNT);
            expect(cap.ratio).to.equal(REWARDS_RATIO);
            expect(cap.cliff).to.equal(CLIFF_PERIOD * 24 * 60 * 60);
            expect(cap.vestingTerm).to.equal(VESTING_PERIOD * 30 * 24 * 60 * 60);
            expect(cap.maxRewardsPerMonth).to.equal(MAX_MONTHLY_REWARDS);
        });

        it("should not allow creating cap with existing ID", async function () {
            // First create a cap
            const capId = 2;
            await rewardsContract.connect(owner).addVestingCap(
                capId,
                ethers.encodeBytes32String("Test Cap"),
                1, // Add startDate parameter (will be replaced by TGE timestamp)
                REWARDS_AMOUNT,
                CLIFF_PERIOD,
                VESTING_PERIOD,
                1,
                INITIAL_RELEASE,
                MAX_MONTHLY_REWARDS,
                REWARDS_RATIO
            );

            // Try to create another cap with same ID
            await expect(
                rewardsContract.connect(owner).addVestingCap(
                    capId, // same ID
                    ethers.encodeBytes32String("Test Cap 2"),
                    1, // Add startDate parameter (will be replaced by TGE timestamp)
                    REWARDS_AMOUNT,
                    CLIFF_PERIOD,
                    VESTING_PERIOD,
                    1,
                    INITIAL_RELEASE,
                    MAX_MONTHLY_REWARDS,
                    REWARDS_RATIO
                )
            ).to.be.revertedWithCustomError(rewardsContract, "InvalidParameter");
        });
    });
});
