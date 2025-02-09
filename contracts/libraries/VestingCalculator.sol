// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VestingTypes.sol";

library VestingCalculator {
    function calculateDueTokens(
        VestingTypes.VestingCap storage cap,
        VestingTypes.SubstrateRewards storage rewards,
        VestingTypes.VestingWalletInfo storage walletInfo,
        uint256 currentTime
    ) external view returns (uint256) {
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
        VestingTypes.VestingCap storage cap,
        VestingTypes.VestingWalletInfo storage walletInfo,
        address wallet
    ) external {
        if (cap.allocatedToWallets >= walletInfo.amount) {
            cap.allocatedToWallets -= walletInfo.amount;
        }

        uint256 walletIndex = type(uint256).max;
        for (uint256 i = 0; i < cap.wallets.length; i++) {
            if (cap.wallets[i] == wallet) {
                walletIndex = i;
                break;
            }
        }

        if (walletIndex != type(uint256).max) {
            cap.wallets[walletIndex] = cap.wallets[cap.wallets.length - 1];
            cap.wallets.pop();
        }
    }
}
