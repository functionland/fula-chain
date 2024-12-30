// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IStakingEngine {
    event StakingParametersUpdated(
        uint256 newMinStakeAmount,
        uint256 newMaxStakeAmount,
        uint256 totalTiers
    );

    event RewardDistributionRatesUpdated(
        uint256 preMintedRate,
        uint256 transactionFeeRate,
        uint256 revenueSharingRate,
        uint256 liquidityMiningRate
    );

    event Staked(address indexed user, uint256 amount, uint256 duration);
    event Unstaked(address indexed user, uint256 amount, bool early);
    event StakingRewardsClaimed(address indexed user, uint256 amount);
    event StakingRewardPoolUpdated(uint256 totalRewards);
    event RewardsDistributed(address indexed staker, uint256 amount);
    event EmergencyAction(string action, uint256 timestamp);
}