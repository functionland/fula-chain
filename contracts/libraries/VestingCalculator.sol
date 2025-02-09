// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VestingTypes.sol";

library VestingCalculator {
    function calculateDueTokens(
        VestingTypes.VestingCap memory cap,
        VestingTypes.SubstrateRewards memory rewards,
        VestingTypes.VestingWalletInfo memory walletInfo,
        uint256 currentTime
    ) internal pure returns (uint256) {
        if(rewards.amount == 0) return 0;
        if(currentTime < cap.startDate + cap.cliff * 1 days) return 0;

        uint256 monthsSinceStart = (currentTime - cap.startDate) / 30 days;
        if(monthsSinceStart == walletInfo.lastClaimMonth) return 0;

        uint256 dueAmount = rewards.amount / cap.ratio;
        if(dueAmount > cap.maxRewardsPerMonth) {
            dueAmount = cap.maxRewardsPerMonth;
        }

        return dueAmount;
    }

    function removeWalletFromCap(
        VestingTypes.VestingCap memory cap,
        address wallet
    ) internal pure returns (VestingTypes.VestingCap memory, uint256) {
        address[] memory newWallets = new address[](cap.wallets.length - 1);
        uint256 walletIndex = type(uint256).max;
        
        for (uint256 i = 0; i < cap.wallets.length; i++) {
            if (cap.wallets[i] == wallet) {
                walletIndex = i;
                break;
            }
        }

        if (walletIndex != type(uint256).max) {
            // Copy all elements except the one to remove
            uint256 j = 0;
            for (uint256 i = 0; i < cap.wallets.length; i++) {
                if (i != walletIndex) {
                    newWallets[j] = cap.wallets[i];
                    j++;
                }
            }
            cap.wallets = newWallets;
        }

        return (cap, walletIndex);
    }
}
