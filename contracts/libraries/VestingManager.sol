// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VestingTypes.sol";
import "./VestingCalculator.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library VestingManager {
    using SafeERC20 for ERC20Upgradeable;

    event VestingCapAction(uint256 id, bytes32 name, uint8 action);
    event DistributionWalletAdded(address indexed beneficiary, uint256 amount, uint256 startTime, uint256 cliffPeriod, uint256 vestingPeriod);
    event DistributionWalletRemoved(address indexed wallet, uint256 indexed capId);

    function createCap(
        mapping(uint256 => VestingTypes.VestingCap) storage vestingCaps,
        uint256 capId,
        bytes32 name,
        uint256 startDate,
        uint256 cliff,
        uint256 vestingTerm,
        uint256 maxRewardsPerMonth,
        uint256 ratio
    ) external {
        require(startDate > 0, "Invalid date");
        require(cliff > 0 && vestingTerm > 0, "Invalid period");
        require(maxRewardsPerMonth > 0, "Invalid rewards");
        require(ratio > 0, "Invalid ratio");

        vestingCaps[capId] = VestingTypes.VestingCap({
            totalAllocation: 0, // Initial total allocation
            name: name,
            cliff: cliff,
            vestingTerm: vestingTerm,
            vestingPlan: 0, // Default vesting plan
            initialRelease: 0, // Default initial release
            startDate: startDate,
            allocatedToWallets: 0,
            wallets: new address[](0),
            maxRewardsPerMonth: maxRewardsPerMonth,
            ratio: ratio
        });

        emit VestingCapAction(capId, name, 1); // 1 = Created
    }

    function addWalletToCap(
        mapping(uint256 => VestingTypes.VestingCap) storage vestingCaps,
        mapping(address => mapping(uint256 => VestingTypes.VestingWalletInfo)) storage vestingWallets,
        uint256 capId,
        address wallet,
        bytes32 name,
        uint256 amount
    ) external {
        require(wallet != address(0), "Invalid wallet");
        require(amount > 0, "Invalid amount");

        VestingTypes.VestingCap storage cap = vestingCaps[capId];
        require(cap.startDate > 0, "Cap not found");

        vestingWallets[wallet][capId] = VestingTypes.VestingWalletInfo({
            capId: capId,
            name: name,
            amount: amount,
            claimed: 0,
            monthlyClaimedRewards: 0,
            lastClaimMonth: 0
        });

        cap.wallets.push(wallet);
        cap.allocatedToWallets += amount;

        emit DistributionWalletAdded(
            wallet,
            amount,
            cap.startDate,
            cap.cliff,
            cap.vestingTerm
        );
    }

    function processRewards(
        mapping(address => VestingTypes.SubstrateRewards) storage substrateRewardInfo,
        address wallet,
        uint256 amount
    ) external {
        require(amount > 0, "Invalid amount");
        
        VestingTypes.SubstrateRewards storage rewards = substrateRewardInfo[wallet];
        rewards.amount = amount;
        rewards.lastUpdate = block.timestamp;
    }

    function claimTokens(
        mapping(uint256 => VestingTypes.VestingCap) storage vestingCaps,
        mapping(address => mapping(uint256 => VestingTypes.VestingWalletInfo)) storage vestingWallets,
        mapping(address => VestingTypes.SubstrateRewards) storage substrateRewardInfo,
        ERC20Upgradeable storageToken,
        address wallet,
        uint256 capId,
        uint256 dueTokens
    ) external {
        VestingTypes.VestingWalletInfo storage walletInfo = vestingWallets[wallet][capId];
        walletInfo.claimed += dueTokens;
        walletInfo.lastClaimMonth = (block.timestamp - vestingCaps[capId].startDate) / 30 days;

        storageToken.safeTransfer(wallet, dueTokens);
    }
}
