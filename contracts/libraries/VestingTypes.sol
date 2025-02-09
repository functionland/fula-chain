// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library VestingTypes {
    struct VestingWalletInfo {
        uint256 capId;
        bytes32 name;
        uint256 amount;
        uint256 claimed;
        uint256 monthlyClaimedRewards;
        uint256 lastClaimMonth;
    }

    struct VestingCap {
        uint256 totalAllocation;
        bytes32 name;
        uint256 cliff;
        uint256 vestingTerm;
        uint256 vestingPlan;
        uint256 initialRelease;
        uint256 startDate;
        uint256 allocatedToWallets;
        address[] wallets;
        uint256 maxRewardsPerMonth;
        uint256 ratio;
    }

    struct SubstrateRewards {
        uint256 lastUpdate;
        uint256 amount;
    }
}
