// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStoragePool {
    struct Pool {
        string name;
        uint256 id;
        string region;
        address creator;
        mapping(address => Member) members;
        address[] memberList;
        Criteria criteria;
        uint256 requiredTokens; // Required tokens locked to join a pool
        uint256 maxChallengeResponsePeriod; // Maximum time allowed for challenge response (in seconds)
    }

    struct Member {
        uint256 joinDate;
        string peerId;
        address accountId;
        uint16 reputationScore;
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

    event DataPoolCreated(uint256 indexed poolId, string name, address creator);
    event DataPoolDeleted(uint256 indexed poolId, address creator);
    event MemberJoined(uint256 indexed poolId, address member);
    event MemberLeft(uint256 indexed poolId, address member);
    event MemberRemoved(uint32 indexed poolId, address member, address removedBy);
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId, address member);
    event JoinRequestCanceled(uint256 indexed poolId, address requester);
    event JoinRequestRejected(uint32 poolId, address indexed accountId);
    event TokensLocked(address user, uint256 amount);
    event TokensUnlocked(address user, uint256 amount);
    event PoolCreationRequirementUpdated(uint256 newAmount);
    event PoolEmergencyAction(string action, uint256 timestamp);
    event StorageCostSet(uint32 indexed poolId, uint256 costPerTBYear);
    event ProviderAdded(
        address indexed provider,
        uint256 storageSize,
        bool isLargeProvider
    );

    function getStorageCost(uint32 poolId) external view returns (uint256);
    function isProviderActive(address provider) external view returns (bool);
    function getProviderCounts() external view returns (uint256 smallProviders, uint256 largeProviders);
    function isLargeProviderActive(address provider) external view returns (bool);
}
