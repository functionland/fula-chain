// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRewardEngine {
    function distributeRewards(string[] memory cid, uint256 totalStoredSize, address storer, uint32 poolId) external;
    function penalizeStorer(string memory cid, address storer) external;
}