// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IStoragePool {
    struct Pool {
        string name;
        uint256 id;
        string region;
        address creator;
        mapping(address => Member) members;
        address[] memberList;
        Criteria criteria;
    }

    struct Member {
        uint256 joinDate;
        string peerId;
        address accountId;
        uint256 reputationScore;
    }

    struct Criteria {
        uint256 minPingTime;
    }

    struct JoinRequest {
        string peerId;
        address accountId;
        uint256 poolId;
        mapping(address => bool) votes;
        uint256 approvals;
        uint256 rejections;
    }

    struct UploadRequest {
        string[] cids;
        uint256 replicationFactor;
        uint256 poolId;
        address uploader;
        uint256 timestamp;
        uint256 currentReplications;
    }

    event PoolCreated(uint256 indexed poolId, string name, address creator);
    event MemberJoined(uint256 indexed poolId, address member);
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId);
}
