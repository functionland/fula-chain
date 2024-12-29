// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRewardEngine {
    function distributeRewards(string memory cid, address storer, uint32 poolId) external;
    function penalizeStorer(string memory cid, address storer) external;
}