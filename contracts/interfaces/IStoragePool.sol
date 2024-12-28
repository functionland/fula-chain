// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IStoragePool {
    struct Pool {
        string name;
        uint256 id;
        string region;
        address creator;
        mapping(address => Member) members;
        address[] memberList;
        Criteria criteria;
        uint256 requiredTokens;
    }

    struct Member {
        uint256 joinDate;
        string peerId;
        address accountId;
        uint8 reputationScore;
    }

    struct Criteria {
        uint256 minPingTime;
    }

    struct JoinRequest {
        string peerId;
        address accountId;
        uint32 poolId;
        mapping(address => bool) votes;
        uint256 approvals;
        uint256 rejections;
    }

    struct UploadRequest {
        string[] cids;
        uint8 replicationFactor;
        uint32 poolId;
        address uploader;
        uint256 timestamp;
        uint8 currentReplications;
    }

    event DataPoolCreated(uint256 indexed poolId, string name, address creator);
    event DataPoolDeleted(uint256 indexed poolId, address creator);
    event MemberJoined(uint256 indexed poolId, address member);
    event MemberLeft(uint256 indexed poolId, address indexed member);
    event MemberRemoved(uint32 indexed poolId, address indexed member, address indexed removedBy);
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId, address indexed member);
    event JoinRequestCanceled(uint256 indexed poolId, address indexed requester);
    event JoinRequestRejected(uint32 indexed poolId, address indexed accountId);
    event TokensLocked(address indexed user, uint256 amount);
    event TokensUnlocked(address indexed user, uint256 amount);
    event PoolCreationRequirementUpdated(uint256 newAmount);
    event PoolStateChanged(
        uint32 indexed poolId,
        address indexed creator,
        uint256 requiredTokens,
        uint256 memberCount
    );
    event PoolEmergencyAction(string action, uint256 timestamp);
}
