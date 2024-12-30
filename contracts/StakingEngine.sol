// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "./StorageToken.sol";
import "./interfaces/IStakingEngine.sol";

library Math {
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}

abstract contract StakingEngine is IStakingEngine, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    using Math for uint256;

    uint256 private constant PRECISION_FACTOR = 1e24;
    uint256 public monthlyEcosystemTokens = 9_354_167;
    uint256 private constant TOTAL_RATE_BASIS = 10000; // 100% = 10000 basis points
    StorageToken public token;

    // Constants for utilization curve parameters
    uint256 private constant OPTIMAL_UTILIZATION = 80 * PRECISION_FACTOR / 100;    // 80% optimal utilization
    uint256 private constant MIN_MULTIPLIER = PRECISION_FACTOR / 2;                // 0.5x minimum multiplier
    uint256 private constant MAX_MULTIPLIER = 3 * PRECISION_FACTOR;                // 3x maximum multiplier
    uint256 private constant SLOPE_PRECISION = PRECISION_FACTOR;                   // Precision for slope calculations

    struct TierInfo {
        uint256 minAmount;
        uint256 duration;
        uint256 rewardMultiplier;
        uint256 penaltyRate;
    }
    mapping(uint256 => TierInfo) public stakingTiers;
    uint256 public totalTiers;

    struct Stake {
        uint256 amount; // Amount of tokens staked
        uint256 startTime; // Timestamp when staking started
        uint256 duration; // Staking duration in seconds
        uint256 rewardClaimed; // Total rewards claimed so far
    }

    struct RewardPool {
        uint256 preMintedTokens; // Tokens from pre-minted allocation
        uint256 transactionFees; // Tokens collected from transaction fees
        uint256 revenueSharing; // Tokens allocated from revenue sharing
        uint256 liquidityMining; // Tokens allocated for liquidity mining
    }

    mapping(address => Stake[]) public stakes; // Tracks stakes for each user
    RewardPool public rewardPool; // Tracks available reward pools

    uint256 public totalStaked; // Total tokens staked across all users
    uint256 public totalRewardsDistributed; // Total rewards distributed

    uint256 public penaltyForEarlyUnstake; // Penalty percentage for early unstaking (e.g., 25%)

    function initialize(address _token, address initialOwner) public reinitializer(1) {
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        token = StorageToken(_token);
        penaltyForEarlyUnstake = 25; // Default penalty for early unstaking (25%)
    }

    function emergencyPauseRewardDistribution() external onlyOwner {
        _pause();
        emit EmergencyAction("Rewards Distribution paused", block.timestamp);
    }

    function emergencyUnpauseRewardDistribution() external onlyOwner {
        _unpause();
        emit EmergencyAction("Rewards Distribution unpaused", block.timestamp);
    }

    function adjustStakingParameters(
        uint256 newMinStakeAmount,
        uint256 newMaxStakeAmount,
        uint256[] calldata durations,
        uint256[] calldata multipliers
    ) external onlyOwner {
        require(durations.length == multipliers.length, "Length mismatch");
        require(durations.length > 0, "Empty arrays");
        require(newMaxStakeAmount >= newMinStakeAmount, "Invalid amounts");
        
        // Clear existing tiers
        totalTiers = 0;
        
        // Set new tiers
        for (uint256 i = 0; i < durations.length; i++) {
            require(durations[i] >= 60 days, "Duration too short");
            require(multipliers[i] > 0, "Invalid multiplier");
            
            stakingTiers[totalTiers] = TierInfo({
                minAmount: i == 0 ? newMinStakeAmount : stakingTiers[totalTiers - 1].minAmount * 2,
                duration: durations[i],
                rewardMultiplier: multipliers[i],
                penaltyRate: 25 // Default penalty rate
            });
            
            totalTiers++;
        }
        
        emit StakingParametersUpdated(newMinStakeAmount, newMaxStakeAmount, totalTiers);
    }

    function updateRewardDistributionRates(
        uint256 preMintedRate,
        uint256 transactionFeeRate,
        uint256 revenueSharingRate,
        uint256 liquidityMiningRate
    ) external onlyOwner {
        require(
            preMintedRate + transactionFeeRate + revenueSharingRate + liquidityMiningRate == TOTAL_RATE_BASIS,
            "Invalid rates"
        );
        
        // Update the distribution rates for each reward pool
        rewardPool.preMintedTokens = (rewardPool.preMintedTokens * preMintedRate) / TOTAL_RATE_BASIS;
        rewardPool.transactionFees = (rewardPool.transactionFees * transactionFeeRate) / TOTAL_RATE_BASIS;
        rewardPool.revenueSharing = (rewardPool.revenueSharing * revenueSharingRate) / TOTAL_RATE_BASIS;
        rewardPool.liquidityMining = (rewardPool.liquidityMining * liquidityMiningRate) / TOTAL_RATE_BASIS;
        
        emit RewardDistributionRatesUpdated(
            preMintedRate,
            transactionFeeRate,
            revenueSharingRate,
            liquidityMiningRate
        );
    }

    // Function to set the value
    function setMonthlyEcosystemTokens(uint256 _value) external onlyOwner {
        monthlyEcosystemTokens = _value;
    }

    // Function to get the value (optional, since the variable is public)
    function getMonthlyEcosystemTokens() external view returns (uint256) {
        return monthlyEcosystemTokens;
    }

    function stake(uint256 amount, uint256 duration) external nonReentrant {
        require(amount > 0, "Cannot stake 0");
        require(duration == 60 days || duration == 180 days || duration == 360 days, "Invalid duration");

        token.transferFrom(msg.sender, address(this), amount);

        stakes[msg.sender].push(Stake({
            amount: amount,
            startTime: block.timestamp,
            duration: duration,
            rewardClaimed: 0
        }));

        totalStaked += amount;

        emit Staked(msg.sender, amount, duration);
    }

    function claimStakingRewards() external nonReentrant {
        Stake[] storage userStakes = stakes[msg.sender];
        require(userStakes.length > 0, "No active stakes");

        uint256 totalRewards = 0;

        for (uint256 i = 0; i < userStakes.length; i++) {
            Stake storage currentStake = userStakes[i];
            if (block.timestamp > currentStake.startTime) {
                uint256 elapsedTime = block.timestamp - currentStake.startTime;
                uint256 rewardRate = calculateRewardRate(currentStake.amount, currentStake.duration);
                uint256 reward = (currentStake.amount * rewardRate * elapsedTime) / (365 days * 100); // APY calculation

                if (reward > currentStake.rewardClaimed) {
                    uint256 claimableReward = reward - currentStake.rewardClaimed;
                    currentStake.rewardClaimed += claimableReward;
                    totalRewards += claimableReward;
                }
            }
        }

        require(totalRewards > 0, "No rewards available");
        
        _distributeStakingRewards(msg.sender, totalRewards);

        emit StakingRewardsClaimed(msg.sender, totalRewards);
    }

    function getProjectedRewards(address staker) external view returns (
        uint256 totalProjectedRewards,
        uint256[] memory rewardsPerStake
    ) {
        Stake[] storage userStakes = stakes[staker];
        require(userStakes.length > 0, "No active stakes");
        
        rewardsPerStake = new uint256[](userStakes.length);
        totalProjectedRewards = 0;
        
        for (uint256 i = 0; i < userStakes.length; i++) {
            Stake storage currentStake = userStakes[i];
            if (block.timestamp > currentStake.startTime) {
                uint256 elapsedTime = block.timestamp - currentStake.startTime;
                uint256 rewardRate = calculateRewardRate(currentStake.amount, currentStake.duration);
                
                // Calculate projected rewards using the same formula as claimStakingRewards
                uint256 projectedReward = (currentStake.amount * rewardRate * elapsedTime) / (365 days * 100);
                
                // Subtract already claimed rewards
                if (projectedReward > currentStake.rewardClaimed) {
                    rewardsPerStake[i] = projectedReward - currentStake.rewardClaimed;
                    totalProjectedRewards += rewardsPerStake[i];
                }
            }
        }
        
        return (totalProjectedRewards, rewardsPerStake);
    }

    function calculateUnstakePenalty(address staker, uint256 stakeIndex) external view returns (
        uint256 penaltyAmount,
        uint256 netAmount,
        bool isEarlyUnstake,
        uint256 remainingTime
    ) {
        Stake[] storage userStakes = stakes[staker];
        require(stakeIndex < userStakes.length, "Invalid stake index");
        
        Stake storage currentStake = userStakes[stakeIndex];
        uint256 endTime = currentStake.startTime + currentStake.duration;
        
        isEarlyUnstake = block.timestamp < endTime;
        remainingTime = isEarlyUnstake ? endTime - block.timestamp : 0;
        
        if (isEarlyUnstake) {
            // Calculate penalty based on remaining time and stake amount
            penaltyAmount = (currentStake.amount * penaltyForEarlyUnstake) / 100;
            
            // Additional penalty scaling based on how early the unstake is
            uint256 timeRatio = ((currentStake.duration - remainingTime) * PRECISION_FACTOR) / currentStake.duration;
            penaltyAmount = (penaltyAmount * (PRECISION_FACTOR - timeRatio)) / PRECISION_FACTOR;
        } else {
            penaltyAmount = 0;
        }
        
        netAmount = currentStake.amount - penaltyAmount;
        
        return (penaltyAmount, netAmount, isEarlyUnstake, remainingTime);
    }

    function unstake(uint256 index) external nonReentrant {
        Stake[] storage userStakes = stakes[msg.sender];
        require(index < userStakes.length, "Invalid stake index");

        Stake memory currentStake = userStakes[index];
        
        bool earlyUnstake = block.timestamp < currentStake.startTime + currentStake.duration;

        uint256 penalty = earlyUnstake ? (currentStake.amount * penaltyForEarlyUnstake) / 100 : 0;
        
        uint256 amountToReturn = currentStake.amount - penalty;

        totalStaked -= currentStake.amount;

        _removeStake(msg.sender, index);

        token.transfer(msg.sender, amountToReturn);

        emit Unstaked(msg.sender, currentStake.amount, earlyUnstake);
    }

    function calculateRewardRate(uint256 amount, uint256 duration) public view returns (uint256) {
        require(totalStaked > 0, "No staked tokens");
        
        // Calculate total available rewards across all pools
        uint256 totalAvailableRewards = _calculateTotalAvailableRewards();
        
        if (totalAvailableRewards == 0) return 0;
        
        // Calculate base APY considering all reward sources
        uint256 baseAPY = _calculateBaseAPY(totalAvailableRewards);
        
        // Get tier-specific multiplier
        uint256 tierMultiplier = _getTierMultiplier(amount, duration);
        
        // Calculate final reward rate with non-linear scaling
        return (baseAPY * tierMultiplier) / PRECISION_FACTOR;
    }

    function _calculateTotalAvailableRewards() internal view returns (uint256) {
        // Pre-minted allocation (30% of monthly Treasury allocation)
        uint256 monthlyTreasuryAllocation = monthlyEcosystemTokens * token.tokenUnit();
        uint256 preMintedRewards = (monthlyTreasuryAllocation * 30) / 100;
        
        // Add transaction fees (75% of collected fees)
        uint256 transactionFeeRewards = (rewardPool.transactionFees * 75) / 100;
        
        // Add revenue sharing allocation
        uint256 revenueShareRewards = rewardPool.revenueSharing;
        
        // Add liquidity mining rewards
        uint256 liquidityMiningRewards = rewardPool.liquidityMining;
        
        return preMintedRewards + transactionFeeRewards + revenueShareRewards + liquidityMiningRewards;
    }


    function _calculateUtilizationMultiplier(uint256 utilizationRate) internal pure returns (uint256) {
        // If utilization is below optimal, incentivize more staking
        if (utilizationRate <= OPTIMAL_UTILIZATION) {
            return _calculateLowUtilizationMultiplier(utilizationRate);
        }
        // If utilization is above optimal, reduce incentives to prevent over-concentration
        return _calculateHighUtilizationMultiplier(utilizationRate);
    }

    function _calculateLowUtilizationMultiplier(uint256 utilizationRate) internal pure returns (uint256) {
        // Calculate slope for the curve below optimal utilization
        uint256 slope = (PRECISION_FACTOR - MIN_MULTIPLIER) * SLOPE_PRECISION / OPTIMAL_UTILIZATION;
        
        // Linear increase from MIN_MULTIPLIER to PRECISION_FACTOR
        uint256 multiplier = MIN_MULTIPLIER + (slope * utilizationRate / SLOPE_PRECISION);
        
        return Math.min(multiplier, PRECISION_FACTOR);
    }

    function _calculateHighUtilizationMultiplier(uint256 utilizationRate) internal pure returns (uint256) {
        // Calculate how far we are above optimal utilization
        uint256 excessUtilization = utilizationRate - OPTIMAL_UTILIZATION;
        
        // Calculate slope for the curve above optimal utilization
        uint256 slope = (MAX_MULTIPLIER - PRECISION_FACTOR) * SLOPE_PRECISION / 
                        (PRECISION_FACTOR - OPTIMAL_UTILIZATION);
        
        // Exponential increase from PRECISION_FACTOR to MAX_MULTIPLIER
        uint256 multiplier = PRECISION_FACTOR + (slope * excessUtilization / SLOPE_PRECISION);
        
        // Apply exponential dampening to prevent excessive rewards
        multiplier = multiplier * (PRECISION_FACTOR - (excessUtilization / 2)) / PRECISION_FACTOR;
        
        return Math.min(multiplier, MAX_MULTIPLIER);
    }

    function _applyUtilizationCap(uint256 multiplier, uint256 utilizationRate) internal pure returns (uint256) {
        // Additional safety cap based on total utilization
        if (utilizationRate > 95 * PRECISION_FACTOR / 100) { // Over 95% utilization
            return Math.min(multiplier, PRECISION_FACTOR); // Cap at 1x
        }
        return multiplier;
    }


    function _calculateBaseAPY(uint256 totalAvailableRewards) internal view returns (uint256) {
        // Implement non-linear APY calculation based on total staked amount
        uint256 utilizationRate = (totalStaked * PRECISION_FACTOR) / token.totalSupply();
        
        // Apply diminishing returns as total staked amount increases
        uint256 baseRate = (totalAvailableRewards * PRECISION_FACTOR) / totalStaked;
        return (baseRate * _calculateUtilizationMultiplier(utilizationRate)) / PRECISION_FACTOR;
    }

    function _getTierMultiplier(uint256 amount, uint256 duration) internal view returns (uint256) {
        // Special case for 1M+ tokens
        if (amount >= 1_000_000 * token.tokenUnit() && duration >= 180 days) {
            return (PRECISION_FACTOR * 2) / 3; // Divide by 1.5
        }

        return _calculateAmountMultiplier(amount) * _calculateDurationMultiplier(duration) / PRECISION_FACTOR;
    }

    function _calculateAmountMultiplier(uint256 amount) internal view returns (uint256) {
        if (amount >= 200_000 * token.tokenUnit()) {
            return PRECISION_FACTOR; // No reduction
        } else if (amount >= 100_000 * token.tokenUnit()) {
            return (PRECISION_FACTOR * 95) / 100; // 5% reduction
        } else if (amount >= 50_000 * token.tokenUnit()) {
            return (PRECISION_FACTOR * 85) / 100; // 15% reduction
        } else if (amount >= 10_000 * token.tokenUnit()) {
            return (PRECISION_FACTOR * 75) / 100; // 25% reduction
        } else {
            return (PRECISION_FACTOR * 50) / 100; // 50% reduction for smallest tier
        }
    }

    function _calculateDurationMultiplier(uint256 duration) internal pure returns (uint256) {
        if (duration >= 360 days) {
            return PRECISION_FACTOR; // No reduction for longest duration
        } else if (duration >= 180 days) {
            return (PRECISION_FACTOR * 50) / 100; // Divide by 2
        } else if (duration >= 60 days) {
            return (PRECISION_FACTOR * 167) / 1000; // Divide by 6 (approximately)
        } else {
            return 0; // Invalid duration
        }
    }

    function updateStakingRewardPool(uint256 preMintedTokens, uint256 transactionFees, uint256 revenueSharing, uint256 liquidityMining) external onlyOwner {
        // Update the reward pool with new allocations
        rewardPool.preMintedTokens += preMintedTokens;
        rewardPool.transactionFees += transactionFees;
        rewardPool.revenueSharing += revenueSharing;
        rewardPool.liquidityMining += liquidityMining;

        emit StakingRewardPoolUpdated(rewardPool.preMintedTokens + rewardPool.transactionFees + rewardPool.revenueSharing + rewardPool.liquidityMining);
    }

    function _distributeStakingRewards(address staker, uint256 amount) internal {
        // Ensure there are sufficient rewards available in the reward pool
        uint256 totalAvailableRewards = rewardPool.preMintedTokens + rewardPool.transactionFees + rewardPool.revenueSharing + rewardPool.liquidityMining;
        require(totalAvailableRewards >= amount, "Insufficient rewards in the pool");

        // Deduct rewards from the appropriate pools in order of priority
        if (rewardPool.preMintedTokens >= amount) {
            rewardPool.preMintedTokens -= amount;
        } else if (rewardPool.transactionFees >= amount) {
            rewardPool.transactionFees -= amount;
        } else if (rewardPool.revenueSharing >= amount) {
            rewardPool.revenueSharing -= amount;
        } else if (rewardPool.liquidityMining >= amount) {
            rewardPool.liquidityMining -= amount;
        } else {
            revert("Unable to allocate rewards from any pool");
        }

        // Transfer rewards to the staker
        token.transfer(staker, amount);

        // Update total rewards distributed
        totalRewardsDistributed += amount;

        emit RewardsDistributed(staker, amount);
    }

    function _removeStake(address user, uint256 index) internal {
        Stake[] storage userStakes = stakes[user];
        
        // Efficiently remove the stake by swapping with the last element and popping
        userStakes[index] = userStakes[userStakes.length - 1];
        userStakes.pop();
    }
}
