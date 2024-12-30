// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IStorageProof {
    struct Claim {
        string[] cids;
        uint256 timestamp;
        address storer;
        uint32 poolId;
        uint256 dataSize;
    }

    struct UploadRequest {
        string[] cids;          // List of CIDs in this upload request
        uint8 replicationFactor; // Number of replications required
        uint32 poolId;           // Pool ID associated with this upload
        address uploader;        // Address of the uploader
        uint256 timestamp;       // Timestamp of when this request was created
        uint256 uploadSize;      // Size of uploaded data in bytes (estimated or reported)
        uint8 currentReplications;
    }

    struct RemovalRequest {
        string[] cids;
        address uploader;
        uint32 poolId;
        uint256 timestamp;
    }

    struct Challenge {
        uint256 challengeTimestamp; // Timestamp when the challenge was issued
        uint256 byteRangeStart;     // Start of the byte range for the challenge
        uint256 byteRangeEnd;       // End of the byte range for the challenge
        address storer;             // Address of the node being challenged
    }


    event UploadRequested(string[] cids, address uploader, uint32 indexed poolId); // index PoolId so that cluster leader can pin
    event RemovalRequested(string[] cid, address uploader, uint32 indexed poolId); // index poolId so that cluster leader can unpin
    event MiningRewardSet(uint256 rewardPerDay);
    event RewardsDistributed(uint256 amount, uint256 timestamp);
    event EmergencyAction(string action, uint256 timestamp);
    event ClaimSubmitted(string[] cids, address indexed storer, uint32 poolId);
    event VerificationFailed(address indexed storer, string indexed cid, uint32 poolId);
    event ProofSubmitted(string indexed cid, address indexed storer);
    event ChallengeIssued(address indexed storer, string[] cid, uint256 byteRangeStart, uint256 byteRangeEnd);

    function getUploadRequest(string memory cid, address uploader) external view returns (UploadRequest memory);
}
