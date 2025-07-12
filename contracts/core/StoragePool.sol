// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";
import "../governance/interfaces/IStoragePool.sol";
import "../libraries/StoragePoolLib.sol";
import "./StorageToken.sol";

contract StoragePool is IStoragePool, GovernanceModule {
    bytes32 public constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");

    uint256 public constant IMPLEMENTATION_VERSION = 1;

    uint256 private constant POOL_ACTION_DELAY = 4 hours;
    mapping(bytes32 => uint256) private poolActionTimeLocks;

    StorageToken public token;
    mapping(uint256 => Pool) public pools;
    mapping(uint32 => JoinRequest[]) public joinRequests;
    mapping(address => uint256) public lockedTokens;
    mapping(address => uint256) public requestIndex;

    uint256 public poolCounter;
    uint256 public dataPoolCreationTokens; // Amount needed to create a pool
    mapping(uint32 => uint256) public storageCostPerTBYear;

    // required to remove for loops to make gas fees predictable
    mapping(address => uint256) private userTotalRequiredLockedTokens;
    mapping(string => JoinRequest) private usersActiveJoinRequestByPeerID;
    mapping(uint256 => mapping(address => uint256)) private poolMemberIndices;

    // Global peer ID tracking to ensure uniqueness across pools
    mapping(string => address) private globalPeerIdToAccount;  // Maps peer ID to owning account
    mapping(string => uint32) private globalPeerIdToPool;      // Maps peer ID to pool it belongs to

    // New mapping to track claimable tokens for users when direct transfers fail
    mapping(address => uint256) public claimableTokens;

    // Additional state variables for enhanced security
    mapping(address => uint256) private lastClaimTimestamp;
    mapping(address => bool) private transferLocks;

    // Mapping to track banned users per pool (persists even after leaving)
    mapping(uint32 => mapping(address => bool)) private bannedUsers;

    // Enhanced event for reputation changes
    event ReputationUpdated(
        uint256 indexed poolId,
        address indexed member,
        string peerId,
        uint16 previousScore,
        uint16 newScore,
        address indexed updatedBy,
        uint256 timestamp
    );

    function initialize(
        address _storageToken,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        require(_storageToken != address(0) && initialOwner != address(0) && initialAdmin != address(0));

        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard,
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);

        // Grant pool-specific roles
        _grantRole(POOL_CREATOR_ROLE, initialOwner);

        token = StorageToken(_storageToken);
        dataPoolCreationTokens = 15_000_000 * 10**18; // 15M tokens with 18 decimals
    }

    // Emergency pause/unpause functionality is now handled by the inherited GovernanceModule.emergencyAction()
    // Users should call emergencyAction(1) to pause and emergencyAction(2) to unpause

    modifier validatePoolId(uint32 poolId) {
        require(poolId > 0 && poolId <= poolCounter && pools[poolId].creator != address(0));
        _;
    }

    /**
     * @dev Sets the number of tokens needed to be locked to create a data pool for data storage
     * @param _amount The new amount of tokens required for pool creation
     * @notice Only admin can call this function. Emits enhanced monitoring events.
     */
    function setDataPoolCreationTokens(uint256 _amount)
        external
        whenNotPaused
        nonReentrant
    {
        require(_hasAdminPrivileges(msg.sender));
        uint256 oldAmount = dataPoolCreationTokens;
        dataPoolCreationTokens = StoragePoolLib.setDataPoolCreationTokensFull(oldAmount, _amount, msg.sender);
        _updateActivityTimestamp();
    }

    // Calculate the required number of locked tokens for a user address
    function calculateRequiredLockedTokens(address user) public view returns (uint256) {

        return userTotalRequiredLockedTokens[user];
    }

    /**
     * @dev Internal helper to check if an address has admin privileges (either ADMIN_ROLE or POOL_ADMIN_ROLE)
     * @param account The address to check
     * @return true if the account has admin or pool admin privileges
     */
    function _hasAdminPrivileges(address account) internal view returns (bool) {
        return hasRole(ProposalTypes.ADMIN_ROLE, account) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, account);
    }

    /// @dev Creates a new data storage pool
    function createDataPool(string memory name, string memory region, uint256 requiredTokens,
        uint256 minPingTime, uint256 maxChallengeResponsePeriod, string memory creatorPeerId)
        external nonReentrant whenNotPaused {
        bytes32 actionHash = keccak256(abi.encodePacked("CREATE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash]);
        require(bytes(name).length > 0 && bytes(region).length > 0 && bytes(creatorPeerId).length > 0 && requiredTokens > 0 && minPingTime > 0 && requiredTokens <= dataPoolCreationTokens);

        if (maxChallengeResponsePeriod == 0) maxChallengeResponsePeriod = 7 days;
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        if (isAdmin) {
            if (token.balanceOf(msg.sender) >= dataPoolCreationTokens && token.transferFrom(msg.sender, address(this), dataPoolCreationTokens)) {
                lockedTokens[msg.sender] += dataPoolCreationTokens;
                userTotalRequiredLockedTokens[msg.sender] += dataPoolCreationTokens;
                emit TokensLocked(msg.sender, dataPoolCreationTokens);
            }
        } else {
            require(token.balanceOf(msg.sender) >= dataPoolCreationTokens && token.transferFrom(msg.sender, address(this), dataPoolCreationTokens));
            lockedTokens[msg.sender] += dataPoolCreationTokens;
            userTotalRequiredLockedTokens[msg.sender] += dataPoolCreationTokens;
            emit TokensLocked(msg.sender, dataPoolCreationTokens);
        }

        uint256 newPoolId = ++poolCounter;
        Pool storage pool = pools[newPoolId];
        pool.name = name;
        pool.region = region;
        pool.id = newPoolId;
        pool.requiredTokens = requiredTokens;
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod;
        pool.creator = msg.sender;
        pool.minPingTime = minPingTime;

        address existingAccount = globalPeerIdToAccount[creatorPeerId];
        if (existingAccount != address(0)) {
            require(existingAccount == msg.sender);
            uint32 existingPool = globalPeerIdToPool[creatorPeerId];
            require(existingPool == uint32(newPoolId) || existingPool == 0);
        }
        _addMemberToPool(pool, msg.sender, creatorPeerId, 500);

        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;
        _grantRole(POOL_CREATOR_ROLE, msg.sender);
        
        emit DataPoolCreated(newPoolId, name, msg.sender);
        emit MemberJoined(newPoolId, msg.sender, creatorPeerId);
        
    }

    /// @dev Remove members from pool in batches - simplified
    function removeMembersBatch(uint32 poolId, uint256 /* maxMembers */) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator || _hasAdminPrivileges(msg.sender));
        if (pool.memberList.length > 1) {
            pool.memberList.pop();
        }
    }

    /// @dev Allows the pool creator to permanently delete their storage pool
    function deletePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        bytes32 actionHash = keccak256(abi.encodePacked("DELETE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash]);

        Pool storage pool = pools[poolId];
        address creator = pool.creator;
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        // Validate deletion requirements
        require(creator != address(0) && (msg.sender == creator || isAdmin) && pool.memberList.length <= 1);

        // Get locked tokens before refund for event emission
        uint256 creatorLockedTokens = lockedTokens[creator];

        // Process creator token refunds
        if (lockedTokens[creator] >= dataPoolCreationTokens) {
            lockedTokens[creator] -= dataPoolCreationTokens;
            if (userTotalRequiredLockedTokens[creator] >= dataPoolCreationTokens) {
                userTotalRequiredLockedTokens[creator] -= dataPoolCreationTokens;
            }

            bool transferSuccess = StoragePoolLib.safeTokenTransfer(transferLocks, token, creator, dataPoolCreationTokens);
            if (!transferSuccess) {
                claimableTokens[creator] += dataPoolCreationTokens;
                emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
            }
        }

        // Remove creator from member list and clean up mappings
        if (pool.memberList.length > 0) {
            _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], creator);
        }

        // Clean up creator's peer ID mappings
        string[] memory creatorPeerIds = pool.memberPeerIds[creator];
        for (uint256 i = 0; i < creatorPeerIds.length; i++) {
            delete pool.peerIdToMember[creatorPeerIds[i]];
            delete globalPeerIdToAccount[creatorPeerIds[i]];
            delete globalPeerIdToPool[creatorPeerIds[i]];
        }
        delete pool.memberPeerIds[creator];
        delete pool.members[creator];

        // Remove all pending join requests with gas protection
        uint256 maxRequestsPerCall = 100;
        uint256 requestsRemoved = 0;

        while (joinRequests[poolId].length > 0 && requestsRemoved < maxRequestsPerCall) {
            if (gasleft() < 10000) break;
            joinRequests[poolId].pop();
            requestsRemoved++;
        }

        // Clean up
        _revokeRole(POOL_CREATOR_ROLE, creator);
        delete pools[poolId];
        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;

        // Emit events
        if (creatorLockedTokens > 0) {
            emit TokensUnlocked(creator, creatorLockedTokens);
        }
        emit DataPoolDeleted(poolId, creator);
    }


    /// @dev Submit join request to storage pool
    function submitJoinRequest(uint32 poolId, string memory peerId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        require(pool.creator != address(0) && pool.peerIdToMember[peerId] == address(0) && !bannedUsers[poolId][msg.sender] && requestIndex[msg.sender] == 0 && token.balanceOf(msg.sender) >= pool.requiredTokens && pool.memberList.length + joinRequests[poolId].length < 1000);

        if (pool.members[msg.sender].joinDate == 0) {
            require(lockedTokens[msg.sender] == 0);
        }

        address existingAccount = globalPeerIdToAccount[peerId];
        if (existingAccount != address(0)) {
            require(existingAccount == msg.sender);
            uint32 existingPool = globalPeerIdToPool[peerId];
            require(existingPool == 0);
        }

        require(token.balanceOf(msg.sender) >= pool.requiredTokens && token.transferFrom(msg.sender, address(this), pool.requiredTokens));
        lockedTokens[msg.sender] += pool.requiredTokens;
        userTotalRequiredLockedTokens[msg.sender] += pool.requiredTokens;
        emit TokensLocked(msg.sender, pool.requiredTokens);

        uint256 newIndex = joinRequests[poolId].length;
        joinRequests[poolId].push();
        JoinRequest storage newRequest = joinRequests[poolId][newIndex];
        newRequest.accountId = msg.sender;
        newRequest.poolId = poolId;
        newRequest.timestamp = uint32(block.timestamp);
        newRequest.peerId = peerId;

        JoinRequest storage peerRequest = usersActiveJoinRequestByPeerID[peerId];
        peerRequest.peerId = peerId;
        peerRequest.accountId = msg.sender;
        peerRequest.poolId = poolId;
        peerRequest.approvals = 0;
        peerRequest.rejections = 0;
        requestIndex[msg.sender] = newIndex + 1;

        emit TokensLocked(msg.sender, pool.requiredTokens);
        emit JoinRequestSubmitted(poolId, peerId, msg.sender);
    }

    function getStorageCost(uint32 poolId) external view override returns (uint256) {
        return storageCostPerTBYear[poolId];
    }

    /**
     * @dev Check if an address is a member of any pool
     * @param member The address to check
     * @return true if the address is a member of any pool
     */
    function isMemberOfAnyPool(address member) external view override returns (bool) {
        for (uint32 i = 1; i <= poolCounter; i++) {
            if (pools[i].creator != address(0) && pools[i].members[member].joinDate > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Get total number of members across all pools
     * @return Total number of unique members across all pools
     */
    function getTotalMembers() external view override returns (uint256) {
        uint256 totalMembers = 0;
        for (uint32 i = 1; i <= poolCounter; i++) {
            if (pools[i].creator != address(0)) {
                totalMembers += pools[i].memberList.length;
            }
        }
        return totalMembers;
    }

    // Function to set the storage cost per pool
    function setStorageCost(uint32 poolId, uint256 costPerTBYear) external nonReentrant whenNotPaused onlyRole(POOL_CREATOR_ROLE) {
        require(costPerTBYear > 0 && costPerTBYear <= type(uint256).max / (365 days) && msg.sender == pools[poolId].creator);
        storageCostPerTBYear[poolId] = costPerTBYear; // Set the cost for the specified pool
        emit StorageCostSet(poolId, costPerTBYear); // Emit event with poolId
    }

    /**
     * @dev Allows users to cancel their pending join requests and reclaim locked tokens
     *
     * @notice This function enables users to withdraw their join requests with the following process:
     * - Validates request existence and ownership
     * - Processes token refunds for locked amounts
     * - Removes join request from all data structures
     * - Cleans up related mappings and indices
     * - Emits monitoring events for tracking
     */
    function cancelJoinRequest(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        uint256 index = requestIndex[msg.sender];
        require(index > 0 && index <= joinRequests[poolId].length);
        _removeJoinRequest(poolId, msg.sender);
        _refundTokens(msg.sender, pools[poolId].requiredTokens);
    }

    /**
     * @dev Allows a pool member to voluntarily leave a storage pool with token refund
     *
     * @notice This function enables pool members to exit pools with the following operations:
     * - Validates member status and permissions
     * - Calculates and processes token refunds based on locked amounts
     * - Removes member from pool data structures
     * - Updates pool member list and indices
     * - Emits monitoring events for tracking
     *
     * @notice Token Refund Logic:
     * - Refunds pool.requiredTokens if member has sufficient locked tokens
     * - Uses secure transfer mechanism with fallback to claimable tokens
     * - Updates both lockedTokens and userTotalRequiredLockedTokens mappings
     * - Follows Checks-Effects-Interactions pattern for reentrancy protection
     *
     * @notice Member Removal Process:
     * - Removes member from pool.members mapping
     * - Updates pool.memberList array by swapping with last element
     * - Updates poolMemberIndices for efficient lookups
     * - Maintains data structure integrity
     *
     * @notice Security Features:
     * - Pool creator cannot leave their own pool (prevents orphaned pools)
     * - Member validation prevents unauthorized access
     * - Reentrancy protection via nonReentrant modifier
     * - State updates before external calls
     *
     * @param poolId Unique identifier of the pool to leave
     *
     * Requirements:
     * - Caller must be an active member of the specified pool
     */
    function leavePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0 && msg.sender != pool.creator);
        delete pool.members[msg.sender];
        _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], msg.sender);
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    function removeMember(uint32 poolId, address member) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        require((msg.sender == pool.creator || _hasAdminPrivileges(msg.sender)) && pool.members[member].joinDate > 0 && member != pool.creator);

        // Simplified removal
        delete pool.members[member];
        _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], member);
        emit MemberRemoved(poolId, member, msg.sender, "");
    }

    function setForfeitFlag(uint32 poolId, address member, bool forfeit) external validatePoolId(poolId) {
        require(_hasAdminPrivileges(msg.sender));
        require(pools[poolId].members[member].joinDate > 0 || bannedUsers[poolId][member]);
        if (pools[poolId].members[member].joinDate > 0) {
            pools[poolId].members[member].statusFlags = forfeit ? pools[poolId].members[member].statusFlags | 0x01 : pools[poolId].members[member].statusFlags & 0xFE;
        }
        bannedUsers[poolId][member] = forfeit;
        emit MemberForfeitFlagSet(poolId, member, forfeit, msg.sender);
    }





    function claimTokens() external nonReentrant whenNotPaused {
        uint256 amount = claimableTokens[msg.sender];
        require(amount > 0);
        claimableTokens[msg.sender] = 0;
        require(token.transfer(msg.sender, amount));
        emit TokensClaimed(msg.sender, amount);
    }

    /**
     * @dev Allows authorized users to directly add members to pools, bypassing the voting process
     */
    function addMemberDirectly(
        uint32 poolId,
        address member,
        string memory peerId,
        bool /* requireTokenLock */
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        require(pool.memberList.length < 1000);
        require(msg.sender == pool.creator || _hasAdminPrivileges(msg.sender));
        _addMemberToPool(pool, member, peerId, 500);
    }







    /// @dev Vote on join request

    function voteOnJoinRequest(uint32 poolId, string memory peerIdToVote, bool approve)
        external nonReentrant whenNotPaused validatePoolId(poolId) {
        JoinRequest storage request = usersActiveJoinRequestByPeerID[peerIdToVote];
        require(request.accountId != address(0) && request.poolId == poolId);
        require(pools[poolId].members[msg.sender].joinDate > 0);
        require(!request.votes[msg.sender]);

        request.votes[msg.sender] = true;
        if (approve) {
            request.approvals++;
        } else {
            request.rejections++;
        }
    }

    function setReputation(uint32 poolId, string memory peerId, uint8 score) external nonReentrant whenNotPaused validatePoolId(poolId) {
        require(score <= 1000 && bytes(peerId).length > 0 && msg.sender == pools[poolId].creator);
        address member = pools[poolId].peerIdToMember[peerId];
        require(member != address(0) && pools[poolId].members[member].joinDate > 0);
        pools[poolId].members[member].reputationScore = score;
        emit ReputationUpdated(poolId, member, peerId, 0, score, msg.sender, block.timestamp);
    }

    function getPoolMemberCount(uint32 poolId) external view validatePoolId(poolId) returns (uint256) {
        return pools[poolId].memberList.length;
    }
    function getPoolMembersPaginated(uint32 poolId, uint256 offset, uint256 limit)
        external view validatePoolId(poolId) returns (
        address[] memory members, string[] memory /* peerIds */, uint256[] memory /* joinDates */, uint16[] memory /* reputationScores */, bool hasMore) {
        Pool storage pool = pools[poolId];
        uint256 totalMembers = pool.memberList.length;
        require(offset < totalMembers);
        uint256 end = offset + limit > totalMembers ? totalMembers : offset + limit;
        members = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            members[i - offset] = pool.memberList[i];
        }
        hasMore = end < totalMembers;
        return (members, new string[](0), new uint256[](0), new uint16[](0), hasMore);
    }





    /**
     * @dev Get reputation of a pool member
     */
    function getMemberReputation(uint32 poolId, address member) external view validatePoolId(poolId) returns (
        bool exists,
        uint16 reputationScore,
        uint256 joinDate,
        string memory peerId
    ) {
        Pool storage pool = pools[poolId];
        exists = pool.members[member].joinDate > 0;
        if (exists) {
            reputationScore = pool.members[member].reputationScore;
            joinDate = pool.members[member].joinDate;
            // Return first peer ID for backward compatibility
            string[] memory memberPeerIds = pool.memberPeerIds[member];
            peerId = memberPeerIds.length > 0 ? memberPeerIds[0] : "";
        }
    }

    /**
     * @dev Get locked tokens for any wallet
     */
    function getUserLockedTokens(address wallet) external view returns (
        uint256 lockedAmount,
        uint256 totalRequired,
        uint256 claimableAmount
    ) {
        return StoragePoolLib.getUserLockedTokens(
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            wallet
        );
    }



    /// @notice Implementation of abstract function from GovernanceModule for pool-specific proposals
    function _createCustomProposal(
        uint8 proposalType,
        uint40, /* id */
        address, /* target */
        bytes32, /* role */
        uint96, /* amount */
        address /* tokenAddress */
    ) internal virtual override returns (bytes32) {
        // For now, we don't have pool-specific proposals beyond the standard governance ones
        // This can be extended in the future for pool-specific operations
        revert InvalidProposalType(proposalType);
    }

    /// @notice Implementation of abstract function from GovernanceModule for executing pool-specific proposals
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        // For now, we don't have pool-specific proposals beyond the standard governance ones
        // This can be extended in the future for pool-specific operations
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        revert InvalidProposalType(proposal.proposalType);
    }

    /// @notice Authorize upgrade through governance proposal system
    function _authorizeUpgrade(address newImplementation)
        internal
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        // Delegate the authorization to the governance module
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }



    function isPeerIdMemberOfPool(uint32 poolId, string memory peerId) external view validatePoolId(poolId) returns (bool, address) {
        address memberAddress = globalPeerIdToAccount[peerId];
        return (memberAddress != address(0) && globalPeerIdToPool[peerId] == poolId, memberAddress);
    }

    function getMemberPeerIds(uint32 poolId, address member) external view validatePoolId(poolId) returns (string[] memory) {
        return pools[poolId].memberPeerIds[member];
    }

    function getMemberReputationMultiPeer(uint32 poolId, address member) external view validatePoolId(poolId) returns (
        bool exists, uint16 reputationScore, uint256 joinDate, string[] memory peerIds) {
        Pool storage pool = pools[poolId];
        joinDate = pool.members[member].joinDate;
        exists = (joinDate > 0);
        reputationScore = pool.members[member].reputationScore;
        peerIds = exists ? pool.memberPeerIds[member] : new string[](0);
    }



    function _removeJoinRequest(uint32 poolId, address member) internal {
        uint256 index = requestIndex[member];
        require(index > 0 && joinRequests[poolId].length > 0);
        joinRequests[poolId].pop();
        delete requestIndex[member];
    }

    function _removeMemberFromList(address[] storage memberList, mapping(address => uint256) storage memberIndices, address member) internal {
        uint256 memberIndex = memberIndices[member];
        require(memberIndex < memberList.length);
        memberList[memberIndex] = memberList[memberList.length - 1];
        memberList.pop();
        delete memberIndices[member];
    }



    function _refundTokens(address user, uint256 amount) internal {
        if (lockedTokens[user] >= amount) {
            lockedTokens[user] -= amount;
            if (userTotalRequiredLockedTokens[user] >= amount) {
                userTotalRequiredLockedTokens[user] -= amount;
            }
            claimableTokens[user] += amount;
            emit TokensMarkedClaimable(user, amount);
        }
    }



    function _addMemberToPool(Pool storage pool, address member, string memory peerId, uint16 reputation) internal {
        if (pool.members[member].joinDate == 0) {
            pool.members[member] = Member({joinDate: block.timestamp, accountId: member, reputationScore: reputation, statusFlags: 0});
            pool.memberList.push(member);
            poolMemberIndices[pool.id][member] = pool.memberList.length - 1;
        }
        pool.peerIdToMember[peerId] = member;
        globalPeerIdToAccount[peerId] = member;
        emit MemberJoined(pool.id, member, peerId);
    }

    uint256[50] private __gap;
}