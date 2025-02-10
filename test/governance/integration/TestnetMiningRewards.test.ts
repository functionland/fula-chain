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
        beforeEach(async function () {
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

            await rewardsContract.connect(owner).updateSubstrateRewards(
                user.address,
                SUBSTRATE_REWARDS
            );

            await time.increase(45 * 24 * 60 * 60);
        });

        it("should calculate rewards based on substrate balance and ratio", async function () {
            const expectedRewards = SUBSTRATE_REWARDS / BigInt(REWARDS_RATIO);
            const dueTokens = await rewardsContract.calculateDueTokens(
                user.address,
                SUBSTRATE_WALLET,
                1
            );
    
            expect(dueTokens).to.equal(expectedRewards);
        });

        it("should revert if substrate wallet doesn't match mapped wallet", async function () {
            const wrongSubstrateWallet = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
            await expect(
                rewardsContract.calculateDueTokens(user.address, wrongSubstrateWallet, 1)
            ).to.be.revertedWithCustomError(rewardsContract, "WalletMismatch");
        });

        it("should reset monthly claimed rewards in new month", async function () {
            await rewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
            
            // Move to next month
            await time.increase(31 * 24 * 60 * 60);
            await rewardsContract.connect(user).claimTokens(SUBSTRATE_WALLET, 1);
            
            const walletInfo = await rewardsContract.vestingWallets(user.address, 1);
            expect(walletInfo.monthlyClaimedRewards).to.be.lt(MAX_MONTHLY_REWARDS * BigInt(2));
        });

        it("should successfully remove a wallet from distribution cap", async function () {
            // Create proposal to remove the wallet
            const removeWalletType = 8; // RemoveDistributionWallet type
            const tx = await rewardsContract.connect(owner).createProposal(
                removeWalletType,
                1, // capId
                user.address, // target (wallet to remove)
                ethers.ZeroHash,
                0,
                ZeroAddress
            );

            const receipt = await tx.wait();
            const proposalId = receipt?.logs[0].topics[1];

            // Wait for execution delay
            await time.increase(24 * 60 * 60 + 1);
            
            // Admin approves the proposal
            await rewardsContract.connect(admin).approveProposal(proposalId);

            // Verify the wallet was removed by checking it can't claim rewards
            await expect(
                rewardsContract.calculateDueTokens(user.address, SUBSTRATE_WALLET, 1)
            ).to.be.revertedWithCustomError(rewardsContract, "NothingToClaim");
        });

        it("should revert when trying to remove non-existent wallet from cap", async function () {
            // Create proposal to remove a wallet that's not in the cap
            const removeWalletType = 8; // RemoveDistributionWallet type
            await expect(
                rewardsContract.connect(owner).createProposal(
                    removeWalletType,
                    1, // capId
                    otherUser.address, // target (wallet that's not in the cap)
                    ethers.ZeroHash,
                    0,
                    ZeroAddress
                )
            ).to.be.revertedWithCustomError(rewardsContract, "InvalidState");
        });
    
    });

    describe("Vesting Cap Creation and Validation", function () {
        it("should revert when creating cap with zero allocation", async function () {
            await expect(
                rewardsContract.connect(owner).addVestingCap(
                    2, // new cap ID
                    ethers.encodeBytes32String("Test Cap"),
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
