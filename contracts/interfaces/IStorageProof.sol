// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IStorageProof {
    struct Proof {
        string cid;
        uint256 timestamp;
        address storer;
        uint32 poolId;
        uint8 replicationCount;
    }

    struct UploadRequest {
        string[] cids;
        uint8 replicationFactor;
        uint32 poolId;
        address uploader;
        uint256 timestamp;
        uint8 currentReplications;
    }

    struct RemovalRequest {
        string[] cids;
        address uploader;
        uint32 poolId;
        uint256 timestamp;
    }

    event ProofSubmitted(string cid, address storer, uint32 poolId);
    event UploadRequested(string[] cids, address uploader, uint32 poolId);
    event RemovalRequested(string[] cids, address uploader, uint32 poolId);
    event StorageCostSet(uint256 costPerTBYear);
    event MiningRewardSet(uint256 rewardPerDay);
    event RewardsDistributed(uint256 amount, uint256 timestamp);
    event ProofStateUpdated(
        string indexed cid,
        address indexed storer,
        uint32 poolId,
        uint256 timestamp,
        uint8 replicationCount
    );
}
