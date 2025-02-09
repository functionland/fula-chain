import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { TestnetMiningRewards, StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike, Wallet, SigningKey, getBytes, toQuantity } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAddress } from '@polkadot/util-crypto';

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
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TestnetMiningRewards;
        await rewardsContract.waitForDeployment();

        // Set up roles and permissions (same as original)
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await rewardsContract.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

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

    it("should calculate rewards based on substrate balance and ratio", async function () {
        // Set substrate rewards through admin function
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            SUBSTRATE_REWARDS
        );
        
        await time.increase(45 * 24 * 60 * 60); // Past cliff + 1 month

        const expectedRewards = SUBSTRATE_REWARDS / BigInt(REWARDS_RATIO);
        const dueTokens = await rewardsContract.calculateDueTokens(
            user.address,
            SUBSTRATE_WALLET,
            1
        );

        expect(dueTokens).to.equal(expectedRewards);
    });

    it("should respect monthly rewards limit", async function () {
        // Set high substrate rewards
        const highRewards = ethers.parseEther("20000");
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            highRewards
        );
        
        await time.increase(45 * 24 * 60 * 60);

        // Try to claim
        await rewardsContract.connect(user).claimTokens(1, 1, SUBSTRATE_WALLET);
        
        const walletInfo = await rewardsContract.vestingWallets(user.address, 1);
        expect(walletInfo.monthlyClaimedRewards).to.equal(MAX_MONTHLY_REWARDS);
    });

    it("should revert if substrate wallet doesn't match mapped wallet", async function () {
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            SUBSTRATE_REWARDS
        );
        
        await time.increase(45 * 24 * 60 * 60);

        const wrongSubstrateWallet = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
        await expect(
            rewardsContract.calculateDueTokens(user.address, wrongSubstrateWallet, 1)
        ).to.be.revertedWithCustomError(rewardsContract, "WalletMismatch");
    });

    it("should reset monthly claimed rewards in new month", async function () {
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            SUBSTRATE_REWARDS
        );
        
        await time.increase(45 * 24 * 60 * 60);
        await rewardsContract.connect(user).claimTokens(1, 1, SUBSTRATE_WALLET);
        
        // Move to next month
        await time.increase(31 * 24 * 60 * 60);
        await rewardsContract.connect(user).claimTokens(1, 1, SUBSTRATE_WALLET);
        
        const walletInfo = await rewardsContract.vestingWallets(user.address, 1);
        expect(walletInfo.monthlyClaimedRewards).to.be.lt(MAX_MONTHLY_REWARDS.mul(2));
    });

    it("should successfully remove a wallet from distribution cap", async function () {
        // First add some substrate rewards
        await rewardsContract.connect(owner).updateSubstrateRewards(
            user.address,
            SUBSTRATE_REWARDS
        );

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
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        // Execute the proposal
        await rewardsContract.connect(owner).executeProposal(proposalId);

        // Verify the wallet was removed by checking it can't claim rewards
        await expect(
            rewardsContract.calculateDueTokens(user.address, SUBSTRATE_WALLET, 1)
        ).to.be.revertedWithCustomError(rewardsContract, "NothingToClaim");
    });

    it("should revert when trying to remove non-existent wallet from cap", async function () {
        // Create proposal to remove a wallet that's not in the cap
        const removeWalletType = 8; // RemoveDistributionWallet type
        const tx = await rewardsContract.connect(owner).createProposal(
            removeWalletType,
            1, // capId
            otherUser.address, // target (wallet that's not in the cap)
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
        
        // Wait for execution delay
        await time.increase(24 * 60 * 60 + 1);
        
        // Execute the proposal should revert
        await expect(
            rewardsContract.connect(owner).executeProposal(proposalId)
        ).to.be.reverted;
    });
});
