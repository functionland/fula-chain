// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IStorageProof {
    struct Claim {
        string cid;
        uint256 timestamp;
        address storer;
        uint32 poolId;
        uint8 replicationCount;
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


    event UploadRequested(string cid, address indexed uploader, uint32 indexed poolId);
    event RemovalRequested(string[] cids, address uploader, uint32 poolId);
    event MiningRewardSet(uint256 rewardPerDay);
    event RewardsDistributed(uint256 amount, uint256 timestamp);
    event ClaimStateUpdated(
        string indexed cid,
        address indexed storer,
        uint32 poolId,
        uint256 timestamp,
        uint8 replicationCount
    );
    event EmergencyAction(string action, uint256 timestamp);
    event ClaimSubmitted(string indexed cid, address indexed storer, uint32 indexed poolId);
    event ClaimBatchProcessed(uint32 indexed poolId, address indexed storer, uint256 totalCIDs);
    event VerificationFailed(string indexed cid, address indexed storer, uint32 indexed poolId);
    event ProofSubmitted(string indexed cid, address indexed storer);
    event VerificationFailed(address indexed storer, string cid);
    event ChallengeIssued(string indexed cid, address indexed storer, uint256 byteRangeStart, uint256 byteRangeEnd);

    function getUploadRequest(string memory cid, address uploader) external view returns (UploadRequest memory);
}
