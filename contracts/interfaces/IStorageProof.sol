// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IStorageProof {
    struct Proof {
        string cid;
        uint256 timestamp;
        address storer;
        uint256 poolId;
        uint256 replicationCount;
    }

    struct UploadRequest {
        string[] cids;
        uint256 replicationFactor;
        uint256 poolId;
        address uploader;
        uint256 timestamp;
        uint256 currentReplications;
    }

    struct RemovalRequest {
        string[] cids;
        address uploader;
        uint256 poolId;
        uint256 timestamp;
    }

    event ProofSubmitted(string cid, address storer, uint256 poolId);
    event UploadRequested(string[] cids, address uploader, uint256 poolId);
    event RemovalRequested(string[] cids, address uploader, uint256 poolId);
    event StorageCostSet(uint256 costPerTBYear);
    event MiningRewardSet(uint256 rewardPerDay);
    event RewardsDistributed(uint256 amount, uint256 timestamp);
}
