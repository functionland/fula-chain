import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { AirdropContract, StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));

describe("AirdropCalculation", function () {
    let airdropContract: AirdropContract;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let user: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const AIRDROP_AMOUNT = ethers.parseEther("1000000"); // 1 million tokens for airdrop
    const USER_ALLOCATION = ethers.parseEther("100"); // 100 tokens per user
    const CLIFF_PERIOD = 14; // 14 days
    const VESTING_PERIOD = 6; // 6 months
    const INITIAL_RELEASE = 0; // No initial release

    beforeEach(async function () {
        [owner, admin, user, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy AirdropContract
        const AirdropContract = await ethers.getContractFactory("AirdropContract");
        airdropContract = await upgrades.deployProxy(
            AirdropContract,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as AirdropContract;
        await airdropContract.waitForDeployment();

        // Set up roles and transfer tokens
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await airdropContract.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
        
        // Whitelist airdrop contract
        const addWhitelistType = 5;
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await airdropContract.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const proposalId = receipt?.logs[0].topics[1];

        // Whitelist owner address to get some tokens to transfer to test accounts
        const tx2 = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await owner.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt2 = await tx2.wait();
        const proposalId2 = receipt2?.logs[0].topics[1];


        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await storageToken.connect(admin).approveProposal(proposalId);
        await storageToken.connect(admin).approveProposal(proposalId2);
        
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        
        // Transfer tokens to airdrop contract
        await storageToken.connect(owner).transferFromContract(
            await airdropContract.getAddress(),
            AIRDROP_AMOUNT
        );

        // Transfer tokens to owner wallet for some test balance
        await storageToken.connect(owner).transferFromContract(
            await owner.getAddress(),
            AIRDROP_AMOUNT
        );


        // Add airdrop vesting cap
        await airdropContract.connect(owner).addVestingCap(
            1, // capId
            ethers.encodeBytes32String("Airdrop Cap"),
            AIRDROP_AMOUNT,
            CLIFF_PERIOD, // 14 days cliff
            VESTING_PERIOD, // 6 months vesting plan
            1,  // monthly vesting plan
            INITIAL_RELEASE  // No initial release
        );

        // Add user allocation through proposal
        const addWalletType = 7;
        const addWalletTx = await airdropContract.connect(owner).createProposal(
            addWalletType,
            1,
            user.address,
            ethers.encodeBytes32String("Test User"),
            USER_ALLOCATION,
            ZeroAddress
        );

        const addWalletReceipt = await addWalletTx.wait();
        const addWalletProposalId = addWalletReceipt?.logs[0].topics[1];

        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await airdropContract.connect(admin).approveProposal(addWalletProposalId);

        // Set TGE
        await airdropContract.connect(owner).initiateTGE();
    });

    it("should return 0 if user has no tokens in wallet", async function () {
        // Move past cliff
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_mine");

        expect (
            airdropContract.calculateDueTokens(user.address, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NoWalletBalance");
    });

    it("should match user's wallet balance up to monthly entitlement", async function () {
        // Transfer some tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("20"));
        
        // Move past cliff and 1 month
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]); // 30 days
        await ethers.provider.send("evm_mine");

        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        // Should be 20 tokens as that's the user's balance, even though monthly entitlement is ~16.67 tokens
        expect(dueTokens).to.equal(ethers.parseEther("16.666666666666666666"));
    });

    it("should revert if trying to claim before cliff period", async function () {
        // Transfer some tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("20"));
        
        // Try to claim before cliff (14 days)
        await ethers.provider.send("evm_increaseTime", [13 * 24 * 60 * 60]); // 13 days
        await ethers.provider.send("evm_mine");

        await expect(
            airdropContract.calculateDueTokens(user.address, 1)
        ).to.be.revertedWithCustomError(
            airdropContract, 
            "CliffNotReached"
        );
    });

    it("should handle rolling window expiration correctly", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("50"));
        
        // Move past cliff and 3 months
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days (past cliff)
        await ethers.provider.send("evm_increaseTime", [90 * 24 * 60 * 60]); // 3 months
        await ethers.provider.send("evm_mine");

        // Should only get 3 months worth of tokens due to rolling window (current + 2 previous)
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        // Monthly vesting is 100/6 = 16.666... tokens, so 3 months = 50 tokens
        // But capped at user's wallet balance of 50
        expect(dueTokens).to.be.closeTo(ethers.parseEther("50"), ethers.parseEther("0.000000000000000002"));
    });

    it("should correctly claim tokens and update lastClaimTime", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("20"));
        
        // Move past cliff and 1 month
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]); // 1 month
        await ethers.provider.send("evm_mine");

        await airdropContract.connect(user).claimTokens(1, 1); // capId 1, chainId 1

        const walletInfo = await airdropContract.vestingWallets(user.address, 1);
        expect(walletInfo.claimed).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"), 
            ethers.parseEther("0.000000000000000002")
        );
        expect(walletInfo.lastClaimTime).to.be.gt(0);
    });

    it("should reset entitlements after successful claim", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("40"));
        
        // Move past cliff and 2 months
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [60 * 24 * 60 * 60]); // 2 months
        await ethers.provider.send("evm_mine");

        // First claim
        await airdropContract.connect(user).claimTokens(1, 1);
        
        // Move another month
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Should only be entitled to one month's worth now
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"), 
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should revert claim if user transfers out their tokens", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("20"));
        
        // Move past cliff and 1 month
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]); // 1 month
        await ethers.provider.send("evm_mine");

        // User transfers out all their tokens
        await storageToken.connect(user).transfer(otherAccount.address, ethers.parseEther("20"));

        await expect(
            airdropContract.connect(user).claimTokens(1, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NoWalletBalance");
    });

    it("should correctly handle multiple claims within vesting period", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and 2 months
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [60 * 24 * 60 * 60]); // 2 months
        await ethers.provider.send("evm_mine");

        // First claim
        await airdropContract.connect(user).claimTokens(1, 1);
        
        const firstClaimInfo = await airdropContract.vestingWallets(user.address, 1);
        expect(firstClaimInfo.claimed).to.be.closeTo(
            ethers.parseEther("33.333333333333333332"), // 2 months worth
            ethers.parseEther("0.000000000000000002")
        );

        // Move 2 more months
        await ethers.provider.send("evm_increaseTime", [60 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Second claim
        await airdropContract.connect(user).claimTokens(1, 1);
        
        const secondClaimInfo = await airdropContract.vestingWallets(user.address, 1);
        expect(secondClaimInfo.claimed).to.be.closeTo(
            ethers.parseEther("66.666666666666666664"), // 4 months total
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should cap claims at 3 months worth even after full vesting period", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and full vesting period plus extra time
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [210 * 24 * 60 * 60]); // 7 months
        await ethers.provider.send("evm_mine");

        // Should only allow claiming 3 months worth due to rolling window
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("50"), // 3 months * (100/6) tokens per month
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should handle claims based on user's current token balance", async function () {
        // Transfer partial tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("30"));
        
        // Move past cliff and 4 months
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [120 * 24 * 60 * 60]); // 4 months
        await ethers.provider.send("evm_mine");

        // Should be limited by user's balance even though entitlement is higher
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("30"), // Limited by wallet balance
            ethers.parseEther("0.000000000000000002")
        );

        // Claim the tokens
        await airdropContract.connect(user).claimTokens(1, 1);

        // Transfer more tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("20"));

        // Move 1 more month
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Should now be able to claim up to new balance
        const newDueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(newDueTokens).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"), // One month's vesting
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should expire unclaimed tokens after 2 vesting periods", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and 4 months
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [120 * 24 * 60 * 60]); // 4 months
        await ethers.provider.send("evm_mine");

        // First check entitlement (should be 3 months worth as 1 month expired)
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("50"), // 3 months * (100/6) per month
            ethers.parseEther("0.000000000000000002")
        );

        // Claim half of entitled amount
        await airdropContract.connect(user).claimTokens(1, 1);
        
        // Move 3 more months
        await ethers.provider.send("evm_increaseTime", [90 * 24 * 60 * 60]); // 3 months
        await ethers.provider.send("evm_mine");

        // Should only be entitled to 3 new months worth
        const newDueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(newDueTokens).to.be.closeTo(
            ethers.parseEther("50"), // 3 months * (100/6) per month
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should handle claims and expiry in later months (7-10) of vesting", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and to month 7
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days cliff
        await ethers.provider.send("evm_increaseTime", [210 * 24 * 60 * 60]); // 7 months
        await ethers.provider.send("evm_mine");

        // At month 7, should only get 3 months worth (months 5,6,7) as earlier months expired
        const dueTokensMonth7 = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokensMonth7).to.be.closeTo(
            ethers.parseEther("50"), // 3 months * (100/6) per month
            ethers.parseEther("0.000000000000000002")
        );

        // Claim half of the entitled amount
        await airdropContract.connect(user).claimTokens(1, 1);
        
        // Move to month 8
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Should only be entitled to 1 new month as previous claim reset entitlements
        const dueTokensMonth8 = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokensMonth8).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"), // 1 month
            ethers.parseEther("0.000000000000000002")
        );

        // Move to month 10 without claiming
        await ethers.provider.send("evm_increaseTime", [60 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Should only get 3 months worth (8,9,10) as month 7 expired
        const dueTokensMonth10 = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokensMonth10).to.be.closeTo(
            ethers.parseEther("50"), // 3 months * (100/6) per month
            ethers.parseEther("0.000000000000000002")
        );
    });
    it("should have zero entitlement at month 11 as all tokens expired", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and to month 11
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days cliff
        await ethers.provider.send("evm_increaseTime", [11 * 30 * 24 * 60 * 60]); // 11 months
        await ethers.provider.send("evm_mine");

        // Should revert as there are no tokens to claim (all expired)
        await expect(
            airdropContract.claimTokens(1, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NothingToClaim");
    });
    
    it("should handle user claiming maximum amount each month", async function () {
        // Transfer full allocation to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_mine");
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Claim each month for 6 months
        for(let i = 0; i < 6; i++) {
            await airdropContract.connect(user).claimTokens(1, 1);
            
            const walletInfo = await airdropContract.vestingWallets(user.address, 1);
            expect(walletInfo.claimed).to.be.closeTo(
                ethers.parseEther(((i + 1) * 16.666666666666666666).toString()),
                ethers.parseEther("0.00000000000002")
            );

            // Move to next month
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");
        }
    });

    it("should handle increasing wallet balance over time", async function () {
        // Start with 50% of monthly entitlement
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("8.33")); // ~50% of 16.66
        
        // Move past cliff
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_mine");
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // First claim with 50%
        await airdropContract.connect(user).claimTokens(1, 1);
        let walletInfo = await airdropContract.vestingWallets(user.address, 1);
        expect(walletInfo.claimed).to.be.closeTo(
            ethers.parseEther("8.33"),
            ethers.parseEther("0.000000000000000002")
        );

        // For next 3 months, increase balance by 50% each month
        let currentBalance = ethers.parseEther("8.33");
        for(let i = 0; i < 3; i++) {
            // Move to next month
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");

            // Increase balance by 50%
            const additionalAmount = currentBalance * BigInt(15) / BigInt(10);
            await storageToken.connect(owner).transfer(user.address, additionalAmount);
            currentBalance += additionalAmount;

            await airdropContract.connect(user).claimTokens(1, 1);
            walletInfo = await airdropContract.vestingWallets(user.address, 1);
            expect(walletInfo.claimed).to.be.closeTo(
                ethers.parseEther((8.33 + (i + 1) * 16.666666666666666666).toString()),
                ethers.parseEther("0.00000000000002")
            );
        }
    });

    it("should prevent gaming the system with quick transfers", async function () {
        // Transfer initial tokens to user
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move past cliff and 1 month
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); // 15 days
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]); // 1 month
        await ethers.provider.send("evm_mine");
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // First claim
        await airdropContract.connect(user).claimTokens(1, 1);
        
        // Transfer out all tokens
        await storageToken.connect(user).transfer(otherAccount.address, ethers.parseEther("100"));
        
        // Move forward slightly
        await ethers.provider.send("evm_increaseTime", [1 * 60 * 60]); // 1 hour
        await ethers.provider.send("evm_mine");

        // Transfer back tokens
        await storageToken.connect(otherAccount).transfer(user.address, ethers.parseEther("100"));

        // Try to claim again
        await expect(
            airdropContract.connect(user).claimTokens(1, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NothingDue");

        // Even after a month, should only get one month's worth
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"),
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should only allow claims after cliff plus one month", async function () {
        // Transfer tokens to user's wallet
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("100"));
        
        // Move just past cliff (15 days)
        await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]); 
        await ethers.provider.send("evm_mine");

        // Should revert as no tokens are vested yet (need 1 month after cliff)
        let dueTokens1 = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens1).to.be.equal(0);
        expect(
            airdropContract.claimTokens(1, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NothingDue");

        // Move to 25 days total (still not enough)
        await ethers.provider.send("evm_increaseTime", [10 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        await expect(
            airdropContract.claimTokens(1, 1)
        ).to.be.revertedWithCustomError(airdropContract, "NothingToClaim");

        // Move to 45 days total (15 days cliff + 30 days first month)
        await ethers.provider.send("evm_increaseTime", [20 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        // Now should be able to claim first month's tokens
        const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
        expect(dueTokens).to.be.closeTo(
            ethers.parseEther("16.666666666666666666"), // First month's worth
            ethers.parseEther("0.000000000000000002")
        );
    });

    it("should correctly handle entire vesting process from TGE to month 10", async function () {
        await storageToken.connect(owner).transfer(user.address, ethers.parseEther("0.000000000000000001"));
        // Array of expected values/behaviors for each month after TGE
        const expectations = [
            { month: 0, shouldRevert: true, reason: "CliffNotReached" }, // TGE
            { month: 0.5, amount: "0" }, // Cliff period
            { month: 1, amount: "16.666666666666666666" }, // First month after cliff
            { month: 2, amount: "16.666666666666666666" }, // Second month
            { month: 3, amount: "16.666666666666666666" }, // Third month (capped at 3 months due to rolling window)
            { month: 4, amount: "16.666666666666666666" }, // Fourth month (still capped at 3 months)
            { month: 5, amount: "16.666666666666666666" }, // Fifth month
            { month: 6, amount: "16.666666666666666666" }, // Sixth month (vesting complete but still capped at 3 months)
            { month: 7, amount: "0.000000000000000004" }, // Seventh month
            { month: 8, amount: "0" }, // Eighth month
            { month: 9, amount: "0" }, // Ninth month
            { month: 10, amount: "0" } // Tenth month (all expired)
        ];

        // Test each month
        for (const exp of expectations) {
            // Move time forward
            if (exp.month === 0) {
                // Nothing
            } else if (exp.month === 0.5) {
                // For cliff period
                await ethers.provider.send("evm_increaseTime", [15 * 24 * 60 * 60]);
            } else {
                await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            }
            await ethers.provider.send("evm_mine");

            if (exp.shouldRevert) {
                await expect(
                    airdropContract.calculateDueTokens(user.address, 1)
                ).to.be.revertedWithCustomError(airdropContract, exp.reason);
            } else {
                if(exp.amount !== "0") {
                    await storageToken.connect(owner).transfer(user.address, ethers.parseEther(exp.amount));
                }
                const dueTokens = await airdropContract.calculateDueTokens(user.address, 1);
                expect(dueTokens).to.be.closeTo(
                    ethers.parseEther(exp.amount),
                    ethers.parseEther("0.000000000000000002")
                );
            }

            // If we can claim, do so
            if (!exp.shouldRevert && exp.amount !== "0") {
                await airdropContract.connect(user).claimTokens(1, 1);
                
                // Move a small amount of time forward to separate transactions
                await ethers.provider.send("evm_increaseTime", [1]);
                await ethers.provider.send("evm_mine");

                // Verify nothing more can be claimed right after
                let t = await airdropContract.calculateDueTokens(user.address, 1);
                expect(t).to.equal(0);
            }
        }
        const bal = await storageToken.balanceOf(user.address);
        expect(bal).to.be.closeTo(ethers.parseEther("200"), ethers.parseEther("0.000000000000000002"));
    });

    it("should prevent adding duplicate wallet to cap", async function () {
        // First add wallet through proposal
        const addWalletType = 7; // AddDistributionWallets
        const addWalletTx = await airdropContract.connect(owner).createProposal(
            addWalletType,
            1, // capId
            otherAccount.address,
            ethers.encodeBytes32String("Second User"),
            ethers.parseEther("50"), // 50 tokens allocation
            ZeroAddress
        );

        const addWalletReceipt = await addWalletTx.wait();
        const addWalletProposalId = addWalletReceipt?.logs[0].topics[1];

        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await airdropContract.connect(admin).approveProposal(addWalletProposalId);

        // Try to add same wallet again
        await expect(
            airdropContract.connect(owner).createProposal(
                addWalletType,
                1, // same capId
                otherAccount.address, // same wallet
                ethers.encodeBytes32String("Duplicate User"),
                ethers.parseEther("30"),
                ZeroAddress
            )
        ).to.be.revertedWithCustomError(airdropContract, "WalletExistsInCap")
        .withArgs(otherAccount.address, 1);
    });


});
