// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Interface defining administrative actions callable by the Governance contract
interface IStakingEngineAdminActions {
    /**
     * @notice Pauses the staking contract.
     * @dev Should only be callable by the authorized governance contract.
     */
    function pause() external;

    /**
     * @notice Unpauses the staking contract.
     * @dev Should only be callable by the authorized governance contract.
     */
    function unpause() external;

    /**
     * @notice Allows the governance contract to add rewards to the reward pool.
     * @param amount The amount of reward tokens to add.
     * @dev Assumes governance contract holds or receives tokens to be added.
     */
    function addRewardsToPool(uint256 amount) external;

    // Add other administrative functions from StakingEngineLinear if they need governance control
    // Example:
    // function updateReferralPercentage(uint256 lockPeriod, uint256 newPercentage) external;

    /**
     * @notice Authorizes an upgrade to a new implementation contract (UUPS).
     * @param newImplementation The address of the new implementation contract.
     * @dev Should only be callable by the authorized governance contract.
     */
    function authorizeUpgrade(address newImplementation) external;
}

