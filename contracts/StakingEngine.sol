// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "./StorageToken.sol";
import "./interfaces/IStakingEngine.sol";

contract StakingEngine is IStakingEngine, ERC20Upgradeable, OwnableUpgradeable, ERC20PermitUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    uint32 public constant LOCK_PERIOD_1 = 90 days;
    uint32 public constant LOCK_PERIOD_2 = 180 days;
    uint32 public constant LOCK_PERIOD_3 = 365 days;

    uint256 public constant FIXED_APY_90_DAYS = 2; // 2% for 90 days
    uint256 public constant FIXED_APY_180_DAYS = 6; // 9% for 180 days
    uint256 public constant FIXED_APY_365_DAYS = 15; // 23% for 365 days

    struct StakeInfo {
        uint256 amount;
        uint256 rewardDebt; // Tracks user's share of accumulated rewards
        uint256 lockPeriod;
        uint256 startTime; // Track when the stake was created
    }

    mapping(address => StakeInfo[]) public stakes;
    uint256 public totalStaked;
    uint256 public lastUpdateTime;

    StorageToken public token;

    address public rewardPoolAddress; // Address holding reward pool tokens
    address public stakingPoolAddress; // Address holding staked tokens

    uint256 public accRewardPerToken90Days;
    uint256 public accRewardPerToken180Days;
    uint256 public accRewardPerToken365Days;

    uint256 totalStaked90Days;
    uint256 totalStaked180Days;
    uint256 totalStaked365Days;

    event RewardsAdded(uint256 amount);
    event Staked(address indexed user, uint256 amount, uint256 lockPeriod);
    event Unstaked(address indexed user, uint256 amount, uint256 distributedReward, uint256 penalty);
    event MissedRewards(address indexed user, uint256 amount);
    event RewardDistributionLog(
        address indexed user,
        uint256 amount,
        uint256 pendingRewards,
        uint256 penalty,
        uint256 rewardPoolBalance,
        uint256 lockPeriod,
        uint256 elapsedTime
    );
    event UnableToDistributeRewards(address indexed user, uint256 rewardPoolBalance, uint256 stakedAmount, uint256 finalRewards, uint256 lockPeriod);

    error TotalStakedTooLow(uint256 totalStaked, uint256 required);
    error APYCannotBeSatisfied(uint8 stakingPeriod, uint256 projectedAPY, uint256 minimumAPY);

    function initialize(
        address _token,
        address _rewardPoolAddress,
        address _stakingPoolAddress,
        address initialOwner
    ) public reinitializer(1) {
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        require(_token != address(0), "Invalid StorageToken address");

        token = StorageToken(_token);
        rewardPoolAddress = _rewardPoolAddress;
        stakingPoolAddress = _stakingPoolAddress;

        lastUpdateTime = block.timestamp;

        // Approve staking contract to spend tokens
        require(
            token.approve(address(this), type(uint256).max),
            "Initial approval failed"
        );
    }

    function addToRewardPoolFromContract(uint256 _value) external onlyOwner {
        require(token.transferFrom(address(this), rewardPoolAddress, _value), "Transfer failed");
    }

    function emergencyPauseRewardDistribution() external onlyOwner {
        _pause();
        emit EmergencyAction("Rewards Distribution paused", block.timestamp);
    }

    function emergencyUnpauseRewardDistribution() external onlyOwner {
        _unpause();
        emit EmergencyAction("Rewards Distribution unpaused", block.timestamp);
    }

    function getUserStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }

    function stakeToken(uint256 amount, uint256 lockPeriod) external whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(
            lockPeriod == 90 days || lockPeriod == 180 days || lockPeriod == 365 days,
            "Invalid lock period"
        );

        // Update rewards before processing the stake
        updateRewards();

        // Calculate projected APY after adding this stake
        uint256 projectedAPY = calculateProjectedAPY(amount, lockPeriod);
        if (
            lockPeriod == 90 days && projectedAPY < FIXED_APY_90_DAYS
        ) {
            revert APYCannotBeSatisfied(1, projectedAPY, FIXED_APY_90_DAYS);
        }
        if (
            lockPeriod == 180 days && projectedAPY < FIXED_APY_180_DAYS
        ) {
            revert APYCannotBeSatisfied(2, projectedAPY, FIXED_APY_180_DAYS);
        }
        if (
            lockPeriod == 365 days && projectedAPY < FIXED_APY_365_DAYS
        ) {
            revert APYCannotBeSatisfied(3, projectedAPY, FIXED_APY_365_DAYS);
        }

        // Calculate pending rewards for all existing stakes of the user
        uint256 pendingRewards = calculatePendingRewards(msg.sender);
        if (pendingRewards > 0) {
            require(
                token.transferFrom(rewardPoolAddress, msg.sender, pendingRewards),
                "Reward transfer failed"
            );
        }

        // Transfer staked tokens to staking pool
        require(
            token.transferFrom(msg.sender, stakingPoolAddress, amount),
            "Stake transfer failed"
        );
        // Add new stake entry for this user
        stakes[msg.sender].push(
            StakeInfo({
                amount: amount,
                rewardDebt: calculateRewardDebt(amount, lockPeriod), // Updated reward debt calculation
                lockPeriod: lockPeriod,
                startTime: block.timestamp
            })
        );

        // Update total staked for the specific lock period
        if (lockPeriod == 90 days) {
            totalStaked90Days += amount;
        } else if (lockPeriod == 180 days) {
            totalStaked180Days += amount;
        } else if (lockPeriod == 365 days) {
            totalStaked365Days += amount;
        }

        // Update global total staked
        totalStaked += amount;

        emit Staked(msg.sender, amount, lockPeriod);
    }

    function calculateElapsedRewards(
        uint256 stakedAmount,
        uint256 fixedAPY,
        uint256 timeElapsed
    ) internal pure returns (uint256) {
        if (stakedAmount == 0) {
            return 0; // No rewards if nothing is staked
        }

        // Calculate annualized rewards based on fixed APY
        uint256 annualRewards = (stakedAmount * fixedAPY) / 100;

        // Adjust rewards proportionally to elapsed time (in seconds)
        return (annualRewards * timeElapsed) / 365 days;
    }


    function calculateRewardDebt(uint256 amount, uint256 lockPeriod) internal view returns (uint256) {
        if (lockPeriod == 90 days) {
            return (amount * accRewardPerToken90Days) / 1e18;
        } else if (lockPeriod == 180 days) {
            return (amount * accRewardPerToken180Days) / 1e18;
        } else if (lockPeriod == 365 days) {
            return (amount * accRewardPerToken365Days) / 1e18;
        }
        return 0; // Default case; should never occur due to earlier validation
    }
    function getAccRewardPerTokenForLockPeriod(uint256 lockPeriod) internal view returns (uint256) {
        if (lockPeriod == 90 days) {
            return accRewardPerToken90Days;
        } else if (lockPeriod == 180 days) {
            return accRewardPerToken180Days;
        } else if (lockPeriod == 365 days) {
            return accRewardPerToken365Days;
        }
        return 0; // Default case; should never occur due to earlier validation
    }


    function unstakeToken(uint256 index) external whenNotPaused {
        require(index < stakes[msg.sender].length, "Invalid stake index");

        // Fetch the specific stake to be unstaked
        StakeInfo storage stake = stakes[msg.sender][index];
        uint256 stakedAmount = stake.amount;
        uint256 lockPeriod = stake.lockPeriod;
        require(stakedAmount > 0, "No active stake");

        // Update rewards before processing unstaking
        updateRewards();

        // Calculate pending rewards for this specific stake
        uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(lockPeriod);
        uint256 pendingRewards = (stakedAmount * accRewardPerToken) / 1e18 - stake.rewardDebt;

        // Apply penalty if unstaking early
        uint256 elapsedTime = block.timestamp - stake.startTime;
        uint256 penalty = calculatePenalty(lockPeriod, elapsedTime, stakedAmount);

        // Ensure penalties only apply to pending rewards
        uint256 finalRewards = 0;
        uint256 distributedReward = 0;
        if (pendingRewards > penalty) {
            finalRewards = pendingRewards - penalty;
        }

        // Update state: reduce total staked amounts
        if (totalStaked < stakedAmount) {
            revert TotalStakedTooLow(totalStaked, stakedAmount);
        }

        totalStaked -= stakedAmount;
        if (lockPeriod == 90 days) {
            if (totalStaked90Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked90Days, stakedAmount);
            }
            totalStaked90Days -= stakedAmount;
        } else if (lockPeriod == 180 days) {
            if (totalStaked180Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked180Days, stakedAmount);
            }
            totalStaked180Days -= stakedAmount;
        } else if (lockPeriod == 365 days) {
            if (totalStaked365Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked365Days, stakedAmount);
            }
            totalStaked365Days -= stakedAmount;
        }

        // Remove this specific stake by replacing it with the last element in the array
        uint256 lastIndex = stakes[msg.sender].length - 1;
        if (index != lastIndex) {
            stakes[msg.sender][index] = stakes[msg.sender][lastIndex];
        }
        stakes[msg.sender].pop(); // Remove the last element

        emit RewardDistributionLog(
            msg.sender,
            stakedAmount,
            pendingRewards,
            penalty,
            token.balanceOf(rewardPoolAddress),
            lockPeriod,
            elapsedTime
        );

        // Transfer staked tokens (principal) back to user from staking pool
        if (token.balanceOf(stakingPoolAddress) < stakedAmount) {
            revert TotalStakedTooLow(token.balanceOf(stakingPoolAddress), stakedAmount);
        }
        require(
            token.allowance(stakingPoolAddress, address(this)) >= stakedAmount,
            "Insufficient allowance for stakingPoolAddress"
        );
        require(
            token.transferFrom(stakingPoolAddress, msg.sender, stakedAmount),
            "Unstake transfer failed"
        );

        // Transfer final rewards from distribution address to user if available
        if (finalRewards > 0) {
            uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);

            if (rewardPoolBalance < finalRewards) {
                emit UnableToDistributeRewards(msg.sender, rewardPoolBalance, stakedAmount, finalRewards, lockPeriod);
            } else {
                require(
                    token.allowance(rewardPoolAddress, address(this)) >= finalRewards,
                    "Insufficient allowance for rewardPoolAddress"
                );
                require(
                    token.transferFrom(rewardPoolAddress, msg.sender, finalRewards),
                    "Reward transfer failed"
                );
                distributedReward = finalRewards;
            }
        } else {
            emit MissedRewards(msg.sender, penalty); // Log missed rewards due to penalties
        }

        emit Unstaked(msg.sender, stakedAmount, distributedReward, penalty);
    }

    function updateRewards() internal {
        if (totalStaked > 0) {
            uint256 timeElapsed = block.timestamp - lastUpdateTime;

            // Fetch current reward pool balance
            uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);

            // Calculate rewards for each lock period using centralized logic
            uint256 rewardsFor90Days = calculateElapsedRewards(
                totalStaked90Days,
                FIXED_APY_90_DAYS,
                timeElapsed
            );
            uint256 rewardsFor180Days = calculateElapsedRewards(
                totalStaked180Days,
                FIXED_APY_180_DAYS,
                timeElapsed
            );
            uint256 rewardsFor365Days = calculateElapsedRewards(
                totalStaked365Days,
                FIXED_APY_365_DAYS,
                timeElapsed
            );

            // Total new rewards to distribute across all stakes
            uint256 newRewards = rewardsFor90Days + rewardsFor180Days + rewardsFor365Days;

            // Ensure we do not exceed available reward pool balance
            if (newRewards > rewardPoolBalance) {
                newRewards = rewardPoolBalance;
            }

            // Update accumulated rewards per token for each lock period
            if (totalStaked90Days > 0) {
                accRewardPerToken90Days += (rewardsFor90Days * 1e18) / totalStaked90Days;
            }
            if (totalStaked180Days > 0) {
                accRewardPerToken180Days += (rewardsFor180Days * 1e18) / totalStaked180Days;
            }
            if (totalStaked365Days > 0) {
                accRewardPerToken365Days += (rewardsFor365Days * 1e18) / totalStaked365Days;
            }

            lastUpdateTime = block.timestamp; // Update last update timestamp
        }
    }

    function calculateRewardsForPeriod(
        uint256 stakedAmount,
        uint256 fixedAPY,
        uint256 timeElapsed,
        uint256 rewardPoolBalance
    ) public pure returns (uint256) {
        if (rewardPoolBalance == 0) {
            return 0; // No rewards if reward pool is empty
        }

        return calculateElapsedRewards(stakedAmount, fixedAPY, timeElapsed);
    }


    function calculatePendingRewards(address user) public view returns (uint256) {
        uint256 pendingRewards = 0;

        // Iterate through all stakes for the user
        for (uint256 i = 0; i < stakes[user].length; i++) {
            StakeInfo memory stake = stakes[user][i];

            // Get accumulated rewards per token for the stake's lock period
            uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(stake.lockPeriod);

            // Calculate pending rewards for this specific stake
            pendingRewards += (stake.amount * accRewardPerToken) / 1e18 - stake.rewardDebt;
        }

        return pendingRewards;
    }



    function calculateProjectedAPY(uint256 additionalStake, uint256 lockPeriod)
        public
        view
        returns (uint256)
    {
        uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);
        if (rewardPoolBalance == 0 || totalStaked + additionalStake == 0) {
            return 0; // No rewards available if reward pool or total staked is zero
        }

        // Define reward multipliers based on lock periods
        uint256 fixedAPY;
        if (lockPeriod == 90 days) {
            fixedAPY = FIXED_APY_90_DAYS; // 2%
        } else if (lockPeriod == 180 days) {
            fixedAPY = FIXED_APY_180_DAYS; // 9%
        } else if (lockPeriod == 365 days) {
            fixedAPY = FIXED_APY_365_DAYS; // 23%
        } else {
            revert("Invalid lock period");
        }

        // Calculate projected APY as a percentage
        uint256 neededNewRewards = calculateElapsedRewards(additionalStake, fixedAPY, lockPeriod);
        uint256 neededCurrentRewards1 = calculateElapsedRewards(totalStaked90Days, fixedAPY, LOCK_PERIOD_1);
        uint256 neededCurrentRewards2 = calculateElapsedRewards(totalStaked180Days, fixedAPY, LOCK_PERIOD_2);
        uint256 neededCurrentRewards3 = calculateElapsedRewards(totalStaked365Days, fixedAPY, LOCK_PERIOD_3);
        if (neededNewRewards + neededCurrentRewards1 + neededCurrentRewards2 + neededCurrentRewards3 <= token.balanceOf(rewardPoolAddress) ) {
            return fixedAPY;
        } else {
            return 0;
        }
    }


    function calculatePenalty(uint256 lockPeriod, uint256 elapsedTime, uint256 stakedAmount) internal pure returns (uint256) {
        // If the full lock period has elapsed, no penalty applies
        if (elapsedTime >= lockPeriod) return 0;

        // Calculate the percentage of time remaining in the lock period
        uint256 remainingPercentage = ((lockPeriod - elapsedTime) * 1e18) / lockPeriod;

        // Apply a dynamic penalty scaling based on how early unstaking occurs
        uint256 penaltyRate;
        if (remainingPercentage > 75 * 1e16) { // >75% time remaining
            penaltyRate = 50; // 50% penalty on staked amount
        } else if (remainingPercentage > 50 * 1e16) { // >50% time remaining
            penaltyRate = 30; // 30% penalty on staked amount
        } else if (remainingPercentage > 25 * 1e16) { // >25% time remaining
            penaltyRate = 15; // 15% penalty on staked amount
        } else {
            penaltyRate = 5; // Minimal penalty for near-completion
        }

        // Calculate the penalty as a percentage of the staked amount
        uint256 penalty = (stakedAmount * penaltyRate) / 100;

        return penalty;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
