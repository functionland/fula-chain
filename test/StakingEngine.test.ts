import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { 
    StakingEngine,
    StorageToken,
    StakingEngine__factory,
    StorageToken__factory
} from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("StakingEngine", function () {
    let stakingEngine: StakingEngine;
    let token: StorageToken;
    let owner: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let users: SignerWithAddress[];

    const INITIAL_SUPPLY = ethers.utils.parseEther("1000000000"); // 1 billion tokens
    const DAY = 24 * 60 * 60;
    const SIXTY_DAYS = 60 * DAY;
    const HUNDRED_EIGHTY_DAYS = 180 * DAY;
    const THREE_SIXTY_DAYS = 360 * DAY;

    beforeEach(async function () {
        [owner, user1, user2, ...users] = await ethers.getSigners();

        // Deploy token
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await StorageToken.deploy(INITIAL_SUPPLY);
        await token.deployed();

        // Deploy StakingEngine
        const StakingEngine = await ethers.getContractFactory("StakingEngine");
        stakingEngine = await upgrades.deployProxy(StakingEngine, [token.address, owner.address]);
        await stakingEngine.deployed();

        // Transfer tokens to users for testing
        await token.transfer(user1.address, ethers.utils.parseEther("1000000"));
        await token.transfer(user2.address, ethers.utils.parseEther("1000000"));
    });

    describe("Initialization", function () {
        it("Should initialize with correct token address and owner", async function () {
            expect(await stakingEngine.token()).to.equal(token.address);
            expect(await stakingEngine.owner()).to.equal(owner.address);
        });

        it("Should set default penalty rate", async function () {
            expect(await stakingEngine.penaltyForEarlyUnstake()).to.equal(25);
        });
    });

    describe("Staking", function () {
        const stakeAmount = ethers.utils.parseEther("100000");

        beforeEach(async function () {
            await token.connect(user1).approve(stakingEngine.address, stakeAmount);
        });

        it("Should allow staking with valid duration", async function () {
            await expect(stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS))
                .to.emit(stakingEngine, "Staked")
                .withArgs(user1.address, stakeAmount, SIXTY_DAYS);

            const userStake = (await stakingEngine.stakes(user1.address, 0));
            expect(userStake.amount).to.equal(stakeAmount);
            expect(userStake.duration).to.equal(SIXTY_DAYS);
        });

        it("Should reject staking with invalid duration", async function () {
            await expect(
                stakingEngine.connect(user1).stake(stakeAmount, 30 * DAY)
            ).to.be.revertedWith("Invalid duration");
        });

        it("Should reject staking zero amount", async function () {
            await expect(
                stakingEngine.connect(user1).stake(0, SIXTY_DAYS)
            ).to.be.revertedWith("Cannot stake 0");
        });

        it("Should update total staked amount", async function () {
            await stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS);
            expect(await stakingEngine.totalStaked()).to.equal(stakeAmount);
        });
    });

    describe("Reward Calculation", function () {
        const stakeAmount = ethers.utils.parseEther("100000");
        
        beforeEach(async function () {
            // Setup reward pool
            await stakingEngine.connect(owner).updateStakingRewardPool(
                ethers.utils.parseEther("1000000"),
                ethers.utils.parseEther("500000"),
                ethers.utils.parseEther("300000"),
                ethers.utils.parseEther("200000")
            );
        });

        it("Should calculate different rates for different tiers", async function () {
            const rate1 = await stakingEngine.calculateRewardRate(
                ethers.utils.parseEther("10000"),
                SIXTY_DAYS
            );
            const rate2 = await stakingEngine.calculateRewardRate(
                ethers.utils.parseEther("1000000"),
                HUNDRED_EIGHTY_DAYS
            );
            
            expect(rate2).to.be.gt(rate1);
        });

        it("Should return zero rate when no rewards available", async function () {
            await stakingEngine.connect(owner).updateStakingRewardPool(0, 0, 0, 0);
            const rate = await stakingEngine.calculateRewardRate(stakeAmount, SIXTY_DAYS);
            expect(rate).to.equal(0);
        });
    });

    describe("Claiming Rewards", function () {
        const stakeAmount = ethers.utils.parseEther("100000");

        beforeEach(async function () {
            await token.connect(user1).approve(stakingEngine.address, stakeAmount);
            await stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS);
            
            await stakingEngine.connect(owner).updateStakingRewardPool(
                ethers.utils.parseEther("1000000"),
                ethers.utils.parseEther("500000"),
                ethers.utils.parseEther("300000"),
                ethers.utils.parseEther("200000")
            );
        });

        it("Should allow claiming rewards after time passes", async function () {
            await time.increase(30 * DAY);
            
            const balanceBefore = await token.balanceOf(user1.address);
            await stakingEngine.connect(user1).claimStakingRewards();
            const balanceAfter = await token.balanceOf(user1.address);
            
            expect(balanceAfter).to.be.gt(balanceBefore);
        });

        it("Should not allow claiming if no rewards available", async function () {
            await expect(
                stakingEngine.connect(user1).claimStakingRewards()
            ).to.be.revertedWith("No rewards available");
        });
    });

    describe("Unstaking", function () {
        const stakeAmount = ethers.utils.parseEther("100000");

        beforeEach(async function () {
            await token.connect(user1).approve(stakingEngine.address, stakeAmount);
            await stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS);
        });

        it("Should allow unstaking after duration", async function () {
            await time.increase(SIXTY_DAYS);
            
            const balanceBefore = await token.balanceOf(user1.address);
            await stakingEngine.connect(user1).unstake(0);
            const balanceAfter = await token.balanceOf(user1.address);
            
            expect(balanceAfter.sub(balanceBefore)).to.equal(stakeAmount);
        });

        it("Should apply penalty for early unstaking", async function () {
            const balanceBefore = await token.balanceOf(user1.address);
            await stakingEngine.connect(user1).unstake(0);
            const balanceAfter = await token.balanceOf(user1.address);
            
            const expectedPenalty = stakeAmount.mul(25).div(100);
            expect(balanceBefore.sub(balanceAfter)).to.equal(expectedPenalty);
        });
    });

    describe("Projected Rewards", function () {
        const stakeAmount = ethers.utils.parseEther("100000");

        beforeEach(async function () {
            await token.connect(user1).approve(stakingEngine.address, stakeAmount);
            await stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS);
            
            await stakingEngine.connect(owner).updateStakingRewardPool(
                ethers.utils.parseEther("1000000"),
                ethers.utils.parseEther("500000"),
                ethers.utils.parseEther("300000"),
                ethers.utils.parseEther("200000")
            );
        });

        it("Should calculate projected rewards correctly", async function () {
            await time.increase(30 * DAY);
            
            const [totalRewards, rewardsPerStake] = await stakingEngine.getProjectedRewards(user1.address);
            expect(totalRewards).to.be.gt(0);
            expect(rewardsPerStake[0]).to.be.gt(0);
        });

        it("Should match claimed rewards at end of period", async function () {
            await time.increase(SIXTY_DAYS);
            
            const [projectedTotal] = await stakingEngine.getProjectedRewards(user1.address);
            
            const balanceBefore = await token.balanceOf(user1.address);
            await stakingEngine.connect(user1).claimStakingRewards();
            const balanceAfter = await token.balanceOf(user1.address);
            
            expect(balanceAfter.sub(balanceBefore)).to.equal(projectedTotal);
        });
    });

    describe("Unstake Penalty Calculation", function () {
        const stakeAmount = ethers.utils.parseEther("100000");

        beforeEach(async function () {
            await token.connect(user1).approve(stakingEngine.address, stakeAmount);
            await stakingEngine.connect(user1).stake(stakeAmount, SIXTY_DAYS);
        });

        it("Should calculate correct penalty for early unstake", async function () {
            const [penalty, netAmount, isEarly, remainingTime] = 
                await stakingEngine.calculateUnstakePenalty(user1.address, 0);
            
            expect(isEarly).to.be.true;
            expect(penalty).to.equal(stakeAmount.mul(25).div(100));
            expect(netAmount).to.equal(stakeAmount.sub(penalty));
            expect(remainingTime).to.be.gt(0);
        });

        it("Should show zero penalty after staking period", async function () {
            await time.increase(SIXTY_DAYS);
            
            const [penalty, netAmount, isEarly, remainingTime] = 
                await stakingEngine.calculateUnstakePenalty(user1.address, 0);
            
            expect(isEarly).to.be.false;
            expect(penalty).to.equal(0);
            expect(netAmount).to.equal(stakeAmount);
            expect(remainingTime).to.equal(0);
        });
    });
});
