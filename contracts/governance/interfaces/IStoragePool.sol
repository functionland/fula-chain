// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPool {
    function transferTokens(uint256 amount) external returns (bool);
    function receiveTokens(address from, uint256 amount) external returns (bool);
}

interface IStoragePool {
    // Structs
    struct Pool {
        // Pack small fields together for storage optimization - fits in 2 slots
        address creator;                    // 20 bytes
        uint32 id;                         // 4 bytes
        uint32 maxChallengeResponsePeriod; // 4 bytes
        uint32 memberCount;                // 4 bytes - total 32 bytes (slot 1)
        uint32 maxMembers;                 // 4 bytes
        uint256 requiredTokens;            // 32 bytes (slot 2)
        uint256 minPingTime;               // 32 bytes (slot 3)
        string name;
        string region;
        address[] memberList;
        mapping(address => uint256) memberIndex;
        mapping(address => string[]) memberPeerIds;
        mapping(string => address) peerIdToMember;
        mapping(string => uint256) lockedTokens;
    }

    struct JoinRequest {
        // Pack small fields together for storage optimization - fits in 2 slots
        address account;        // 20 bytes
        uint32 poolId;         // 4 bytes
        uint32 timestamp;      // 4 bytes
        uint32 index;          // 4 bytes - total 32 bytes (slot 1)
        uint128 approvals;     // 16 bytes
        uint128 rejections;    // 16 bytes - total 32 bytes (slot 2)
        uint8 status;          // 1 byte - Initialize to 1 instead of 0
        string peerId;
        mapping(string => bool) votes;
    }

    // Events
    event PoolCreated(uint32 indexed poolId, address indexed creator, string name, string region, uint256 requiredTokens, uint32 maxMembers);
    event JoinRequestSubmitted(uint32 indexed poolId, address indexed account, string peerId);
    event JoinRequestResolved(uint32 indexed poolId, address indexed account, string peerId, bool approved, bool tokensForfeited);
    event MemberAdded(uint32 indexed poolId, address indexed account, string peerId, address indexed addedBy);
    event MemberRemoved(uint32 indexed poolId, address indexed account, string peerId, bool tokensForfeited, address removedBy);
    event ForfeitFlagSet(address indexed account);
    event ForfeitFlagCleared(address indexed account);
    event PoolParametersUpdated(uint32 indexed poolId, uint256 requiredTokens, uint32 maxMembers);
    event EmergencyTokensRecovered(uint256 amount);
    event TokensMarkedClaimable(string indexed peerId, uint256 amount);
    event TokensClaimed(string indexed peerId, uint256 amount);

    // Custom Errors
    error PNF(); // PoolNotFound
    error AIP(); // AlreadyInPool
    error ARQ(); // AlreadyRequested
    error PNF2(); // PeerNotFound
    error CR(); // CapacityReached
    error UF(); // UserFlagged
    error NM(); // NotMember
    error AV(); // AlreadyVoted
    error NAR(); // NoActiveRequest
    error OCA(); // OnlyCreatorOrAdmin
    error PNE(); // PoolNotEmpty
    error PRE(); // PendingRequestsExist
    error ITA(); // InvalidTokenAmount
    error IA(); // InsufficientAllowance

    // External Functions
    function initialize(address _storageToken, address _tokenPool, address initialOwner, address initialAdmin) external;
    function createPool(string calldata name, string calldata region, uint256 requiredTokens, uint32 maxChallengeResponsePeriod, uint256 minPingTime, uint32 maxMembers, string calldata peerId) external;
    function joinPoolRequest(uint32 poolId, string calldata peerId) external;
    function voteOnJoinRequest(uint32 poolId, string calldata peerId, string calldata voterPeerId, bool approve) external;
    function cancelJoinRequest(uint32 poolId, string calldata peerId) external;
    function approveJoinRequest(uint32 poolId, string calldata peerId) external;
    function addMember(uint32 poolId, address account, string calldata peerId) external;
    function removeMemberPeerId(uint32 poolId, string calldata peerId) external;
    function removeMembersBatch(uint32 poolId, uint256 count) external;
    function deletePool(uint32 poolId) external;
    function setMaxMembers(uint32 poolId, uint32 newMax) external;
    function setRequiredTokens(uint32 poolId, uint256 newRequired) external;
    function setForfeitFlag(address account, bool flag) external;
    function emergencyRecoverTokens(uint256 amount) external;
    function claimTokens(string calldata peerId) external;
}
