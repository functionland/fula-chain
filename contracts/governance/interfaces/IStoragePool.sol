// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStoragePool {
    /**
     * @dev Pool struct optimized for gas efficiency through strategic field ordering
     * @notice Fields are ordered to minimize storage slots:
     * - Slot 0: name (string)
     * - Slot 1: region (string)
     * - Slot 2: id (uint256)
     * - Slot 3: requiredTokens (uint256)
     * - Slot 4: maxChallengeResponsePeriod (uint256)
     * - Slot 5: creator (address) + criteria.minPingTime (uint256) - packed together
     * - Slot 6+: members mapping
     * - Slot 7+: memberList array
     */
    struct Pool {
        string name;                              // Slot 0: Dynamic string
        string region;                            // Slot 1: Dynamic string
        uint256 id;                              // Slot 2: Pool identifier
        uint256 requiredTokens;                  // Slot 3: Required tokens to join pool
        uint256 maxChallengeResponsePeriod;      // Slot 4: Max challenge response time (seconds)
        address creator;                         // Slot 5: Pool creator (20 bytes)
        // Note: Criteria is inlined for gas optimization
        uint256 minPingTime;                     // Slot 6: Minimum ping time requirement
        mapping(address => Member) members;       // Slot 7+: Member data mapping
        address[] memberList;                    // Slot 8+: Array of member addresses
    }

    /**
     * @dev Member struct optimized for gas efficiency
     * @notice Fields ordered to minimize storage slots:
     * - Slot 0: joinDate (uint256) - 32 bytes
     * - Slot 1: accountId (address, 20 bytes) + reputationScore (uint16, 2 bytes) + status flags (uint8, 1 byte) = 23 bytes in one slot
     * - Slot 2+: peerId (string) - dynamic
     */
    struct Member {
        uint256 joinDate;                        // Slot 0: Timestamp when member joined (32 bytes)
        address accountId;                       // Slot 1: Member's address (20 bytes)
        uint16 reputationScore;                  // Slot 1: Reputation score 0-1000 (2 bytes)
        uint8 statusFlags;                       // Slot 1: Status flags for future use (1 byte)
        // 9 bytes remaining in slot 1 for future expansion
        string peerId;                           // Slot 2+: IPFS peer identifier (dynamic)
    }

    /**
     * @dev Criteria struct - removed as it's inlined into Pool for gas optimization
     * @notice minPingTime is now directly in Pool struct
     */
    struct Criteria {
        uint256 minPingTime;                     // Kept for backward compatibility
    }

    /**
     * @dev JoinRequest struct optimized for gas efficiency
     * @notice Fields ordered to minimize storage slots:
     * - Slot 0: accountId (address, 20 bytes) + poolId (uint32, 4 bytes) + timestamp (uint32, 4 bytes) + status (uint8, 1 byte) = 29 bytes
     * - Slot 1: approvals (uint128, 16 bytes) + rejections (uint128, 16 bytes) = 32 bytes
     * - Slot 2+: peerId (string) - dynamic
     * - Slot 3+: votes mapping
     */
    struct JoinRequest {
        address accountId;                       // Slot 0: Requester's address (20 bytes)
        uint32 poolId;                          // Slot 0: Target pool ID (4 bytes)
        uint32 timestamp;                       // Slot 0: Request creation timestamp (4 bytes)
        uint8 status;                           // Slot 0: Request status (1 byte) - 0: pending, 1: approved, 2: rejected
        // 3 bytes remaining in slot 0
        uint128 approvals;                      // Slot 1: Number of approval votes (16 bytes)
        uint128 rejections;                     // Slot 1: Number of rejection votes (16 bytes)
        string peerId;                          // Slot 2+: IPFS peer identifier (dynamic)
        mapping(address => bool) votes;         // Slot 3+: Voting record mapping
    }

    // === Core Pool Events ===
    event DataPoolCreated(uint256 indexed poolId, string name, address creator);
    event DataPoolDeleted(uint256 indexed poolId, address creator);

    // === Member Management Events ===
    event MemberJoined(uint256 indexed poolId, address member);
    event MemberLeft(uint256 indexed poolId, address member);
    event MemberRemoved(uint32 indexed poolId, address member, address removedBy);
    event MembersBatchRemoved(uint32 indexed poolId, uint256 count);

    // === Join Request Events ===
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId, address member);
    event JoinRequestCanceled(uint256 indexed poolId, address requester);
    event JoinRequestRejected(uint32 poolId, address indexed accountId);

    // === Token Management Events ===
    event TokensLocked(address user, uint256 amount);
    event TokensUnlocked(address user, uint256 amount);
    event TokensMarkedClaimable(address user, uint256 amount);
    event TokensClaimed(address user, uint256 amount);

    // === Configuration Events ===
    event PoolCreationRequirementUpdated(uint256 newAmount);
    event StorageCostSet(uint32 indexed poolId, uint256 costPerTBYear);



    // === Enhanced Admin Monitoring Events ===
    event AdminActionExecuted(
        address indexed admin,
        string indexed actionType,
        uint256 indexed targetId,
        address targetAddress,
        uint256 value,
        string details,
        uint256 timestamp
    );

    event RoleManagementAction(
        address indexed admin,
        address indexed target,
        bytes32 indexed role,
        bool granted,
        string reason,
        uint256 timestamp
    );

    event SecurityParameterChanged(
        address indexed admin,
        string indexed parameterName,
        uint256 oldValue,
        uint256 newValue,
        string reason,
        uint256 timestamp
    );

    event EmergencyActionDetailed(
        address indexed admin,
        string indexed actionType,
        uint256 indexed poolId,
        address[] affectedAddresses,
        uint256[] values,
        string reason,
        uint256 timestamp
    );

    event GovernanceActionExecuted(
        address indexed executor,
        uint256 indexed proposalId,
        string actionType,
        bytes data,
        uint256 timestamp
    );

    // === Legacy Events (kept for backward compatibility) ===
    event PoolEmergencyAction(string action, uint256 timestamp);

    function getStorageCost(uint32 poolId) external view returns (uint256);
    function addMemberDirectly(uint32 poolId, address member, string memory peerId, bool requireTokenLock) external;
    function isMemberOfAnyPool(address member) external view returns (bool);
    function getTotalMembers() external view returns (uint256);
}
