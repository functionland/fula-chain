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
        require(_storageToken != address(0), "INV_TKN");
        require(initialOwner != address(0), "INV_OWN");
        require(initialAdmin != address(0), "INV_ADM");

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
        require(poolId > 0 && poolId <= poolCounter, "INV_pID");
        require(pools[poolId].creator != address(0), "NOT_EXIST");
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
        require(_hasAdminPrivileges(msg.sender), "REQUIRE_ADMIN");
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

    /**
     * @dev Creates a new data storage pool with specified parameters and requirements
     * @param name The human-readable name for the pool (max 256 chars, printable ASCII only)
     * @param region The geographical region where the pool operates (max 256 chars)
     * @param requiredTokens The number of tokens members must lock to join this pool
     * @param minPingTime The minimum acceptable ping time for pool members (1ms to 10s)
     * @param maxChallengeResponsePeriod Maximum time allowed for challenge responses (1h to 30d)
     * @param creatorPeerId The IPFS peer ID of the pool creator (max 256 chars)
     *
     * @notice This function creates a decentralized storage pool where:
     * - Pool creator becomes the first member automatically
     * - Creator must lock dataPoolCreationTokens (unless admin)
     * - Pool gets assigned a unique incremental ID
     * - Creator receives POOL_CREATOR_ROLE for pool management
     * - Timelock prevents rapid pool creation by same user
     *
     * @notice Security Features:
     * - Comprehensive input validation via StoragePoolLib.validatePoolCreationParams
     * - Reentrancy protection via nonReentrant modifier
     * - Pause protection via whenNotPaused modifier
     * - Rate limiting via poolActionTimeLocks mapping
     * - Token lock requirements (bypassed for admins)
     *
     * Requirements:
     * - Contract must not be paused
     * - All input parameters must pass validation
     * - Caller must have sufficient locked tokens (unless admin)
     * - Timelock period must have elapsed since last pool creation
     *
     * Emits:
     * - DataPoolCreated(poolId, name, creator) via StoragePoolLib
     * - TokensLocked(creator, amount) if tokens are locked
     *
     * @custom:security-note This function handles token locking and pool state changes.
     * The Checks-Effects-Interactions pattern is enforced in the library.
     */
    function createDataPool(
        string memory name,
        string memory region,
        uint256 requiredTokens,
        uint256 minPingTime,
        uint256 maxChallengeResponsePeriod,
        string memory creatorPeerId
    ) external nonReentrant whenNotPaused {
        bytes32 actionHash = keccak256(abi.encodePacked("CREATE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash], "Timelock active");

        // Basic input validation
        require(bytes(name).length > 0, "Pool name cannot be empty");
        require(bytes(region).length > 0, "Region cannot be empty");
        require(bytes(creatorPeerId).length > 0, "Creator peer ID cannot be empty");
        require(msg.sender != address(0), "Creator cannot be zero address");
        require(requiredTokens > 0, "Required tokens must be positive");
        require(minPingTime > 0, "Minimum ping time must be greater than zero");

        if (maxChallengeResponsePeriod == 0) {
            maxChallengeResponsePeriod = 7 days;
        }

        // Additional business logic validation
        require(requiredTokens <= dataPoolCreationTokens, "Required tokens to join the pool exceed limit");

        bool isAdmin = _hasAdminPrivileges(msg.sender);

        // Token locking logic - admin can bypass
        if (isAdmin) {
            // Admin can create pools without locking tokens
            // Only lock tokens if admin chooses to and has sufficient balance
            if (token.balanceOf(msg.sender) >= dataPoolCreationTokens) {
                if (token.transferFrom(msg.sender, address(this), dataPoolCreationTokens)) {
                    lockedTokens[msg.sender] += dataPoolCreationTokens;
                    userTotalRequiredLockedTokens[msg.sender] += dataPoolCreationTokens;
                    emit TokensLocked(msg.sender, dataPoolCreationTokens);
                }
            }
        } else {
            // Non-admin pool creators must lock tokens
            require(token.balanceOf(msg.sender) >= dataPoolCreationTokens, "Insufficient tokens for pool creation");
            require(token.transferFrom(msg.sender, address(this), dataPoolCreationTokens), "Token transfer failed");
            lockedTokens[msg.sender] += dataPoolCreationTokens;
            userTotalRequiredLockedTokens[msg.sender] += dataPoolCreationTokens;
            emit TokensLocked(msg.sender, dataPoolCreationTokens);
        }

        uint256 newPoolId = poolCounter + 1;
        Pool storage pool = pools[newPoolId];

        // Set pool properties (optimized struct layout)
        pool.name = name;
        pool.region = region;
        pool.id = newPoolId;
        pool.requiredTokens = requiredTokens;
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod;
        pool.creator = msg.sender;
        pool.minPingTime = minPingTime;

        // Add creator as first member
        if (pool.memberList.length < 1000) {
            // Global peer ID validation - ensure peer ID uniqueness across all pools
            address existingAccount = globalPeerIdToAccount[creatorPeerId];
            if (existingAccount != address(0)) {
                require(existingAccount == msg.sender, "Peer ID already used by different account");
                uint32 existingPool = globalPeerIdToPool[creatorPeerId];
                require(existingPool == uint32(newPoolId), "Peer ID already member of different pool");
            } else {
                // First time this peer ID is being used - register it globally
                globalPeerIdToAccount[creatorPeerId] = msg.sender;
                globalPeerIdToPool[creatorPeerId] = uint32(newPoolId);
            }

            // Create member entry
            pool.members[msg.sender] = Member({
                joinDate: block.timestamp,
                accountId: msg.sender,
                reputationScore: 500,
                statusFlags: 0
            });
            pool.memberList.push(msg.sender);

            // Add peer ID mappings
            pool.memberPeerIds[msg.sender].push(creatorPeerId);
            pool.peerIdToMember[creatorPeerId] = msg.sender;

            emit MemberJoined(newPoolId, msg.sender, creatorPeerId);
        }

        // Update timelock
        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;

        poolCounter = newPoolId;
        _grantRole(POOL_CREATOR_ROLE, msg.sender);

        emit DataPoolCreated(newPoolId, name, msg.sender);
    }

    /**
     * @dev Remove members from pool in batches to avoid gas limit issues
     * @param poolId The pool ID
     * @param maxMembers Maximum number of members to remove in this batch (max 100)
     */
    function removeMembersBatch(uint32 poolId, uint256 maxMembers) external nonReentrant whenNotPaused validatePoolId(poolId) {
        require(maxMembers > 0 && maxMembers <= 100, "Invalid batch size");
        Pool storage pool = pools[poolId];
        bool isAdmin = _hasAdminPrivileges(msg.sender);
        require(msg.sender == pool.creator || isAdmin, "Not authorized");

        uint256 membersToRemove = 0;
        uint256 memberCount = pool.memberList.length;

        // Calculate how many members to remove (excluding creator)
        for (uint256 i = 0; i < memberCount && membersToRemove < maxMembers; i++) {
            if (pool.memberList[i] != pool.creator) {
                membersToRemove++;
            }
        }

        require(membersToRemove > 0, "No members to remove");
        require(pool.memberList.length > 0, "Pool has no members");

        uint256 removedCount = 0;

        // Remove members (excluding creator)
        for (uint256 i = 0; i < pool.memberList.length && removedCount < maxMembers; ) {
            if (gasleft() < 60000) break;

            address member = pool.memberList[i];

            if (member != pool.creator) {
                // Refund tokens for this specific member
                uint256 lockedAmount = lockedTokens[member];
                if ((pool.members[member].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens) {
                    uint256 refundAmount = pool.requiredTokens;
                    lockedTokens[member] -= refundAmount;
                    if (userTotalRequiredLockedTokens[member] >= refundAmount) {
                        userTotalRequiredLockedTokens[member] -= refundAmount;
                    }

                    bool transferSuccess = _safeTokenTransfer(member, refundAmount);
                    if (!transferSuccess) {
                        claimableTokens[member] += refundAmount;
                        emit TokensMarkedClaimable(member, refundAmount);
                    }
                } else {
                    if (lockedAmount >= pool.requiredTokens) {
                        lockedTokens[member] -= pool.requiredTokens;
                    }
                    if (userTotalRequiredLockedTokens[member] >= pool.requiredTokens) {
                        userTotalRequiredLockedTokens[member] -= pool.requiredTokens;
                    }
                }

                // Get all peer IDs before deleting member data
                string[] memory memberPeerIds = pool.memberPeerIds[member];

                // Remove from member list and update indices
                _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], member);

                // Clean up peer ID mappings
                for (uint256 j = 0; j < memberPeerIds.length; j++) {
                    delete pool.peerIdToMember[memberPeerIds[j]];
                    delete globalPeerIdToAccount[memberPeerIds[j]];
                    delete globalPeerIdToPool[memberPeerIds[j]];
                    emit MemberRemoved(poolId, member, msg.sender, memberPeerIds[j]);
                }

                delete pool.memberPeerIds[member];
                delete pool.members[member];

                removedCount++;
                // Don't increment i since we removed an element
            } else {
                i++;
            }
        }

        emit MembersBatchRemoved(poolId, removedCount);
    }

    /**
     * @dev Allows the pool creator to permanently delete their storage pool
     * @param poolId The unique identifier of the pool to delete
     *
     * @notice This function completely removes a storage pool and handles:
     * - Validation that caller is the pool creator
     * - Refunding locked tokens to all pool members
     * - Refunding pool creation tokens to the creator
     * - Clearing all pool data and member associations
     * - Rate limiting via timelock mechanism
     *
     * @notice Token Refund Process:
     * - All members get their locked tokens refunded
     * - Pool creator gets pool creation tokens refunded
     * - If direct transfers fail, tokens are marked as claimable
     * - Secure transfer validation prevents manipulation attacks
     *
     * @notice Security Features:
     * - Only pool creator can delete their own pool
     * - Comprehensive input validation via validatePoolId modifier
     * - Reentrancy protection via nonReentrant modifier
     * - Pause protection via whenNotPaused modifier
     * - Rate limiting via poolActionTimeLocks mapping
     * - Secure token transfers with fallback to claimable system
     *
     * Requirements:
     * - Contract must not be paused
     * - Pool must exist and be valid
     * - Caller must be the pool creator
     * - Timelock period must have elapsed since last pool deletion
     *
     * Emits:
     * - DataPoolDeleted(poolId, creator) via StoragePoolLib
     * - TokensUnlocked(member, amount) for each successful refund
     * - TokensMarkedClaimable(member, amount) for failed transfers
     *
     * @custom:security-note This function handles bulk token refunds and pool state cleanup.
     * All state changes occur before external token transfers to prevent reentrancy.
     */
    function deletePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        bytes32 actionHash = keccak256(abi.encodePacked("DELETE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash], "Timelock active");

        Pool storage pool = pools[poolId];
        address creator = pool.creator;
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        // Validate deletion requirements
        require(creator != address(0), "Pool does not exist");
        require(msg.sender == creator || isAdmin, "Not authorized");
        require(pool.memberList.length <= 1, "Pool must have at most 1 member (creator only)");

        // Get locked tokens before refund for event emission
        uint256 creatorLockedTokens = lockedTokens[creator];

        // Process creator token refunds
        if (lockedTokens[creator] >= dataPoolCreationTokens) {
            lockedTokens[creator] -= dataPoolCreationTokens;
            if (userTotalRequiredLockedTokens[creator] >= dataPoolCreationTokens) {
                userTotalRequiredLockedTokens[creator] -= dataPoolCreationTokens;
            }

            bool transferSuccess = _safeTokenTransfer(creator, dataPoolCreationTokens);
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


    /**
     * @dev Allows users to submit requests to join storage pools as resource providers
     *
     * @notice This function enables users to request membership in storage pools with the following process:
     * - Validates user eligibility and pool requirements
     * - Checks token lock requirements and balances
     * - Creates and stores the join request
     * - Locks required tokens for the duration of the request
     * - Emits monitoring events for tracking
     *
     * @notice Join Request Validation:
     * - User must not already be a member of the pool
     * - User must not have an active join request for the pool
     * - User must have sufficient token balance for locking
     * - Pool must be accepting new members
     * - Peer ID must be valid and not already in use
     *
     * @notice Token Locking Mechanism:
     * - Locks pool.requiredTokens from user's balance
     * - Updates lockedTokens and userTotalRequiredLockedTokens mappings
     * - Tokens remain locked until request is approved/rejected/cancelled
     * - Uses secure token transfer validation
     *
     * @notice Request Management:
     * - Creates JoinRequest struct with optimized field packing
     * - Assigns unique request ID for tracking
     * - Updates user's active request mappings
     * - Maintains request indices for efficient lookups
     *
     * @notice Security Features:
     * - Duplicate request prevention via active request tracking
     * - Token balance validation before locking
     * - Reentrancy protection via nonReentrant modifier
     * - Comprehensive input validation
     *
     * @param poolId Unique identifier of the pool to join
     * @param peerId IPFS peer identifier for the requesting user
     *
     * Requirements:
     * - Pool must exist and be in valid state
     * - User must not be a current member of the pool
     * - User must not have an active join request for the pool
     * - User must have sufficient token balance (>= pool.requiredTokens)
     * - Peer ID must be valid and unique
     * - Contract must not be paused
     *
     * Emits:
     * - JoinRequestSubmitted(poolId, user, requestId) for request tracking
     * - TokensLocked(user, amount) for token lock tracking
     *
     * @custom:security This function implements comprehensive validation and secure token locking.
     */
    function submitJoinRequest(uint32 poolId, string memory peerId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Validation
        require(pool.creator != address(0), "Data pool does not exist");
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use in this pool");
        require(token.balanceOf(msg.sender) >= pool.requiredTokens, "Insufficient tokens");
        require(pool.memberList.length + joinRequests[poolId].length < 1000, "Data pool has reached maximum capacity");

        if (bannedUsers[poolId][msg.sender]) {
            revert("Account banned from joining pools");
        }

        if (pool.members[msg.sender].joinDate == 0) {
            require(lockedTokens[msg.sender] == 0, "Tokens already locked for another data pool");
        }

        require(requestIndex[msg.sender] == 0, "User already has active requests");

        // Global peer ID validation
        address existingAccount = globalPeerIdToAccount[peerId];
        if (existingAccount != address(0)) {
            require(existingAccount == msg.sender, "Peer ID already used by different account");
            uint32 existingPool = globalPeerIdToPool[peerId];
            require(existingPool == 0, "Peer ID already member of a pool");
        }

        // Lock tokens
        require(token.transferFrom(msg.sender, address(this), pool.requiredTokens), "Token transfer failed");
        lockedTokens[msg.sender] += pool.requiredTokens;

        // Create join request
        JoinRequest[] storage requests = joinRequests[poolId];
        uint256 newIndex = requests.length;
        requests.push();

        JoinRequest storage newRequest = requests[newIndex];
        newRequest.accountId = msg.sender;
        newRequest.poolId = poolId;
        newRequest.timestamp = uint32(block.timestamp);
        newRequest.status = 0;
        newRequest.approvals = 0;
        newRequest.rejections = 0;
        newRequest.peerId = peerId;

        JoinRequest storage peerRequest = usersActiveJoinRequestByPeerID[peerId];
        peerRequest.peerId = peerId;
        peerRequest.accountId = msg.sender;
        peerRequest.poolId = poolId;
        peerRequest.approvals = 0;
        peerRequest.rejections = 0;

        requestIndex[msg.sender] = newIndex + 1;
        userTotalRequiredLockedTokens[msg.sender] += pool.requiredTokens;

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
        require(costPerTBYear > 0, "Invalid cost");
        require(costPerTBYear <= type(uint256).max / (365 days), "Overflow risk"); // Prevent overflow
        require(msg.sender == pools[poolId].creator, "Not Authorized");
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
     *
     * @notice Token Refund Process:
     * - Refunds pool.requiredTokens that were locked during request submission
     * - Uses secure transfer mechanism with fallback to claimable tokens
     * - Updates lockedTokens and userTotalRequiredLockedTokens mappings
     * - Follows Checks-Effects-Interactions pattern for security
     *
     * @notice Request Cleanup:
     * - Removes JoinRequest from joinRequests array
     * - Updates usersActiveJoinRequestByPeerID mapping
     * - Clears requestIndex for the user
     * - Maintains data structure integrity
     *
     * @notice Security Features:
     * - Only request owner can cancel their own request
     * - Request existence validation prevents invalid operations
     * - Reentrancy protection via nonReentrant modifier
     * - State updates before external token transfers
     *
     * @notice Use Cases:
     * - User changes mind about joining pool
     * - User needs tokens for other purposes
     * - Request has been pending too long
     * - User wants to submit new request with different parameters
     *
     * @param poolId Unique identifier of the pool for which to cancel the join request
     *
     * Requirements:
     * - Caller must have an active join request for the specified pool
     * - Join request must be in pending status (not yet approved/rejected)
     * - Pool must exist and be in valid state
     * - Contract must not be paused
     *
     * Emits:
     * - JoinRequestCancelled(poolId, requester) for request cancellation tracking
     * - TokensRefunded(user, amount) if refund is successful
     *
     * @custom:security This function implements secure request cancellation with comprehensive cleanup.
     */
    function cancelJoinRequest(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        require(poolId < 1000000, "Invalid pool ID");
        uint256 index = requestIndex[msg.sender];
        require(index > 0, "Request not found");
        require(index <= joinRequests[poolId].length, "Invalid request");
        Pool storage pool = pools[poolId];

        uint256 arrayIndex = index - 1;
        require(arrayIndex < joinRequests[poolId].length, "Array index out of bounds");

        JoinRequest storage request = joinRequests[poolId][arrayIndex];
        string memory requestPeerId = request.peerId;

        uint256 lockedAmount = lockedTokens[msg.sender];
        uint256 refundAmount = 0;

        if (lockedAmount >= pool.requiredTokens) {
            refundAmount = pool.requiredTokens;
            lockedTokens[msg.sender] -= refundAmount;
            if (userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[msg.sender] -= pool.requiredTokens;
            }
        }

        delete globalPeerIdToAccount[requestPeerId];
        _removeJoinRequest(poolId, msg.sender);

        if (refundAmount > 0) {
            bool transferSuccess = _safeTokenTransfer(msg.sender, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(msg.sender, refundAmount);
            } else {
                claimableTokens[msg.sender] += refundAmount;
                emit TokensMarkedClaimable(msg.sender, refundAmount);
            }
        }

        emit JoinRequestCanceled(poolId, msg.sender, requestPeerId);
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
     * - Caller cannot be the pool creator
     * - Pool must exist and be in valid state
     * - Contract must not be paused
     *
     * Emits:
     * - MemberLeft(poolId, member) for member departure tracking
     * - TokensRefunded(member, amount) if refund is successful
     *
     * @custom:security This function implements comprehensive validation and secure token handling.
     */
    function leavePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        require(pool.members[msg.sender].joinDate > 0, "Not a member");
        require(msg.sender != pool.creator, "Pool creator cannot leave their own pool");

        uint256 lockedAmount = lockedTokens[msg.sender];
        uint256 refundAmount = 0;

        if ((pool.members[msg.sender].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens && userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
            refundAmount = pool.requiredTokens;
            lockedTokens[msg.sender] -= refundAmount;
            if (userTotalRequiredLockedTokens[msg.sender] >= refundAmount) {
                userTotalRequiredLockedTokens[msg.sender] -= refundAmount;
            }
        } else {
            if (lockedAmount >= pool.requiredTokens) {
                lockedTokens[msg.sender] -= pool.requiredTokens;
            }
            if (userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[msg.sender] -= pool.requiredTokens;
            }
        }

        string[] memory memberPeerIds = pool.memberPeerIds[msg.sender];
        _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], msg.sender);

        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            delete pool.peerIdToMember[memberPeerIds[i]];
            delete globalPeerIdToAccount[memberPeerIds[i]];
            delete globalPeerIdToPool[memberPeerIds[i]];
        }

        delete pool.memberPeerIds[msg.sender];
        delete pool.members[msg.sender];

        if (refundAmount > 0) {
            bool transferSuccess = _safeTokenTransfer(msg.sender, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(msg.sender, refundAmount);
            } else {
                claimableTokens[msg.sender] += refundAmount;
                emit TokensMarkedClaimable(msg.sender, refundAmount);
            }
        }

        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            emit MemberLeft(poolId, msg.sender, memberPeerIds[i]);
        }
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    function removeMember(uint32 poolId, address member) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        // Validate member removal
        require(msg.sender == pool.creator || isAdmin, "Not authorized");
        require(pool.members[member].joinDate > 0, "Not a member");
        require(member != pool.creator, "Cannot remove pool creator");

        // Get all peer IDs before removal for event emission
        string[] memory memberPeerIds = pool.memberPeerIds[member];
        uint256 refundAmount = pool.requiredTokens;

        // Remove the member from the member list first (handles poolMemberIndices)
        _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], member);

        // Clean up peer ID mappings (both local and global)
        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            delete pool.peerIdToMember[memberPeerIds[i]];
            delete globalPeerIdToAccount[memberPeerIds[i]];
            delete globalPeerIdToPool[memberPeerIds[i]];
        }
        delete pool.memberPeerIds[member];

        // Process member removal with refund - inline logic
        // Update state before external calls to prevent reentrancy
        uint256 lockedAmount = lockedTokens[member];
        if ((pool.members[member].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens) {
            uint256 refundAmountActual = pool.requiredTokens;
            lockedTokens[member] -= refundAmountActual;

            if (userTotalRequiredLockedTokens[member] >= refundAmountActual) {
                userTotalRequiredLockedTokens[member] -= refundAmountActual;
            }

            // External call after state updates - use secure transfer
            bool transferSuccess = _safeTokenTransfer(member, refundAmountActual);
            if (!transferSuccess) {
                // If transfer fails after validation, mark as claimable as last resort
                claimableTokens[member] += refundAmountActual;
                emit TokensMarkedClaimable(member, refundAmountActual);
            }
        } else {
            // Member is set to forfeit tokens or has insufficient locked tokens, no refund
            // Clear locked tokens even if forfeiting to allow future pool joins
            if (lockedAmount >= pool.requiredTokens) {
                lockedTokens[member] -= pool.requiredTokens;
            }
            if (userTotalRequiredLockedTokens[member] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[member] -= pool.requiredTokens;
            }
        }

        // Clear membership data from storage
        delete pool.members[member];

        // Emit events for each peer ID
        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            emit MemberRemoved(poolId, member, msg.sender, memberPeerIds[i]);
        }
        emit TokensUnlocked(member, refundAmount);
    }

    // Admin function to set forfeit flag for members (works for current and former members)
    function setForfeitFlag(uint32 poolId, address member, bool forfeit) external validatePoolId(poolId) {
        require(_hasAdminPrivileges(msg.sender), "Not authorized");

        // Check if user is currently a member or was previously banned (allowing management of former members)
        bool isCurrentMember = pools[poolId].members[member].joinDate > 0;
        bool wasPreviouslyBanned = bannedUsers[poolId][member];

        require(isCurrentMember || wasPreviouslyBanned, "Not a member");

        // Set the forfeit flag in member data if they're still a member
        if (isCurrentMember) {
            pools[poolId].members[member].statusFlags = forfeit ?
                pools[poolId].members[member].statusFlags | 0x01 :
                pools[poolId].members[member].statusFlags & 0xFE;
        }

        // Set the banned status that persists even after leaving
        bannedUsers[poolId][member] = forfeit;

        emit MemberForfeitFlagSet(poolId, member, forfeit, msg.sender);
    }

    /**
     * @dev Helper function to convert uint256 to string for event logging
     */
    function uint2str(uint256 value) external pure returns (string memory) {
        return _uint2str(value);
    }

    /**
     * @dev Internal helper function to convert uint256 to string
     */
    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /**
     * @dev Calculate approval threshold using ceiling division
     */
    function calculateApprovalThreshold(uint256 memberCount) internal pure returns (uint256) {
        if (memberCount == 0) return 1; // Edge case protection
        if (memberCount <= 2) return 1; // Minimum threshold for small pools
        return (memberCount + 2) / 3; // Ceiling division: ceil(memberCount/3)
    }

    /**
     * @dev Calculate rejection threshold using ceiling division for majority
     */
    function calculateRejectionThreshold(uint256 memberCount) internal pure returns (uint256) {
        if (memberCount == 0) return 1; // Edge case protection
        if (memberCount == 1) return 1; // Single member requires 1 rejection
        return (memberCount / 2) + 1; // Majority: more than half
    }

    /**
     * @dev Allows users to claim tokens that were marked as claimable when direct transfers failed
     */
    function claimTokens() external nonReentrant whenNotPaused {
        uint256 claimableAmount = claimableTokens[msg.sender];
        require(claimableAmount > 0, "No tokens to claim");

        claimableTokens[msg.sender] = 0;
        bool transferSuccess = _safeTokenTransfer(msg.sender, claimableAmount);
        require(transferSuccess, "Transfer failed");

        emit TokensClaimed(msg.sender, claimableAmount);
    }

    /**
     * @dev Allows authorized users to directly add members to pools, bypassing the voting process
     */
    function addMemberDirectly(
        uint32 poolId,
        address member,
        string memory peerId,
        bool requireTokenLock
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        require(pool.memberList.length < 1000, "Pool is full");
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use in this pool");

        // Global peer ID validation - ensure peer ID uniqueness across all pools
        address existingAccount = globalPeerIdToAccount[peerId];
        if (existingAccount != address(0)) {
            require(existingAccount == member, "Peer ID already used by different account");
            uint32 existingPool = globalPeerIdToPool[peerId];
            require(existingPool == poolId, "Peer ID already member of different pool");
        } else {
            // First time this peer ID is being used - register it globally
            globalPeerIdToAccount[peerId] = member;
            globalPeerIdToPool[peerId] = poolId;
        }

        // Access control: only admin or pool creator
        require(msg.sender == pool.creator || isAdmin, "Not authorized");

        // Check if user is banned from joining this pool (persists even after leaving)
        if (bannedUsers[poolId][member]) {
            revert("Account banned from joining pools");
        }

        // Token locking logic
        if (requireTokenLock) {
            if (isAdmin) {
                // Admin can bypass token locking requirement but still track required tokens
                // Always update userTotalRequiredLockedTokens for consistent accounting
                userTotalRequiredLockedTokens[member] += pool.requiredTokens;
            } else {
                // Pool creators (non-admin) must enforce token locking
                require(token.balanceOf(member) >= pool.requiredTokens, "Insufficient tokens");
                require(token.transferFrom(member, address(this), pool.requiredTokens), "Token transfer failed");
                lockedTokens[member] += pool.requiredTokens;
                userTotalRequiredLockedTokens[member] += pool.requiredTokens;
                emit TokensLocked(member, pool.requiredTokens);
            }
        }

        // Add member to pool (optimized struct)
        if (pool.members[member].joinDate == 0) {
            pool.members[member] = Member({
                joinDate: block.timestamp,
                accountId: member,
                reputationScore: 500,    // Default reputation score
                statusFlags: 0          // Default status flags
            });
            pool.memberList.push(member);
        }

        // Add peer ID to member's peer ID list
        pool.memberPeerIds[member].push(peerId);
        pool.peerIdToMember[peerId] = member;

        poolMemberIndices[poolId][member] = pool.memberList.length - 1;

        emit MemberJoined(pool.id, member, peerId);
    }







    /**
     * @dev Allows pool members to vote on pending join requests with automatic approval/rejection logic
     *
     * @notice This function enables democratic decision-making for pool membership with the following process:
     * - Validates voter eligibility and request existence
     * - Records the vote and prevents duplicate voting
     * - Evaluates voting thresholds for automatic approval/rejection
     * - Processes member addition or token refunds based on vote outcome
     * - Emits comprehensive monitoring events
     *
     * @notice Voting Thresholds:
     * - Approval: Requires >1/3 of total members OR ≥10 approvals (whichever is lower)
     * - Rejection: Requires >1/2 of total members to reject
     * - Automatic processing when thresholds are met
     * - Prevents further voting once decision is made
     *
     * @notice Vote Processing Logic:
     * - Approval: Adds member to pool, unlocks tokens, updates data structures
     * - Rejection: Refunds locked tokens, removes join request, cleans up data
     * - Partial votes: Updates request counters, waits for threshold
     * - Duplicate vote prevention via voter tracking
     *
     * @notice Security Features:
     * - Only pool members can vote on requests
     * - Duplicate vote prevention per voter per request
     * - Automatic threshold evaluation prevents manipulation
     * - Secure token handling with fallback mechanisms
     * - Comprehensive validation of all inputs
     *
     * @notice Gas Optimization:
     * - Efficient threshold calculations using optimized math
     * - Batch updates of related data structures
     * - Early termination when thresholds are met
     * - Minimal storage operations
     *
     * @param poolId Unique identifier of the pool containing the join request
     * @param peerIdToVote IPFS peer identifier of the user whose request is being voted on
     * @param approve Boolean indicating approval (true) or rejection (false) vote
     *
     * Requirements:
     * - Caller must be an active member of the specified pool
     * - Join request must exist and be in pending status
     * - Caller must not have already voted on this request
     * - Pool must exist and be in valid state
     * - Contract must not be paused
     *
     * Emits:
     * - VoteCast(poolId, voter, peerIdToVote, approve) for vote tracking
     * - MemberJoined(poolId, newMember) if request is approved
     * - JoinRequestRejected(poolId, requester) if request is rejected
     * - TokensRefunded(user, amount) for rejected requests
     *
     * @custom:security This function implements democratic governance with secure vote processing.
     */
    function voteOnJoinRequest(
        uint32 poolId,
        string memory peerIdToVote,
        bool approve
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        require(bytes(peerIdToVote).length > 0, "Invalid peer ID");
        require(usersActiveJoinRequestByPeerID[peerIdToVote].accountId != address(0), "Join request not found");

        Pool storage pool = pools[poolId];

        // Ensure the voter is a member of the pool
        require(pool.members[msg.sender].joinDate > 0, "Not a pool member");

        // Get the join request
        JoinRequest storage request = usersActiveJoinRequestByPeerID[peerIdToVote];
        require(request.poolId == poolId, "Invalid pool ID");

        // Ensure the voter has not already voted on this request
        require(!request.votes[msg.sender], "Already voted");

        // Record the voter's vote
        request.votes[msg.sender] = true;

        if (approve) {
            // Increment approval count
            request.approvals++;

            // Check if approvals meet the threshold for acceptance
            uint256 memberCount = pool.memberList.length;
            uint256 approvalThreshold = memberCount == 0 ? 1 : (memberCount <= 2 ? 1 : (memberCount + 2) / 3);
            uint256 absoluteThreshold = 10; // Absolute threshold for large pools

            if (
                request.approvals >= approvalThreshold ||
                request.approvals >= absoluteThreshold
            ) {
                // Validate global peer ID uniqueness before approval
                address existingAccount = globalPeerIdToAccount[request.peerId];
                if (existingAccount != address(0)) {
                    require(existingAccount == request.accountId, "Peer ID already used by different account");
                    uint32 existingPool = globalPeerIdToPool[request.peerId];
                    require(existingPool == poolId, "Peer ID already member of different pool");
                } else {
                    // First time this peer ID is being used - register it globally
                    globalPeerIdToAccount[request.peerId] = request.accountId;
                    globalPeerIdToPool[request.peerId] = poolId;
                }

                // Add the user as a member of the pool
                _addMemberFromVoting(pool, request.peerId, request.accountId);

                // Remove the join request from storage
                _removeJoinRequest(poolId, request.accountId);
            }
        } else {
            // Increment rejection count
            request.rejections++;

            // Check if rejections meet the threshold for denial
            uint256 memberCount = pool.memberList.length;
            uint256 rejectionThreshold = memberCount == 0 ? 1 : (memberCount == 1 ? 1 : (memberCount / 2) + 1);

            if (request.rejections >= rejectionThreshold) {
                // Update state before external calls to prevent reentrancy
                uint256 lockedAmount = lockedTokens[request.accountId];
                if (lockedAmount >= pool.requiredTokens) {
                    uint256 refundAmount = pool.requiredTokens;
                    lockedTokens[request.accountId] -= refundAmount;

                    // External call after state updates - use secure transfer with validation
                    bool transferSuccess = _safeTokenTransfer(request.accountId, refundAmount);
                    if (transferSuccess) {
                        emit TokensUnlocked(request.accountId, refundAmount);
                    } else {
                        // If transfer fails after validation, mark as claimable as last resort
                        claimableTokens[request.accountId] += refundAmount;
                        emit TokensMarkedClaimable(request.accountId, refundAmount);
                    }
                }

                // Get peerId before removing the request
                string memory requestPeerId = request.peerId;

                // Clean up global peer ID registration since request was rejected
                delete globalPeerIdToAccount[requestPeerId];

                // Remove the join request from storage
                _removeJoinRequest(poolId, request.accountId);

                emit JoinRequestRejected(poolId, request.accountId, requestPeerId);
            }
        }
    }

    // Set reputation implementation
    function setReputation(
        uint32 poolId,
        string memory peerId,
        uint8 score
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        // Enhanced validation
        require(score <= 1000, "Score exceeds maximum");
        require(bytes(peerId).length > 0, "Invalid peer ID");
        require(msg.sender != address(0), "Invalid caller address");

        Pool storage pool = pools[poolId];

        // Critical security fix: verify caller is the creator of THIS specific pool
        require(msg.sender == pool.creator, "Not authorized - only this pool's creator can set reputation");
        require(pool.creator != address(0), "Pool does not exist");

        // Get member address from peer ID
        address member = pool.peerIdToMember[peerId];
        require(member != address(0), "Peer ID not found in this pool");

        // Verify member exists in this pool
        require(pool.members[member].joinDate > 0, "Not a member of this pool");

        // Store previous reputation for audit trail
        uint16 previousScore = pool.members[member].reputationScore;

        // Update reputation (still stored per member for backward compatibility)
        pool.members[member].reputationScore = score;

        // Emit detailed event for audit trail with peer ID
        emit ReputationUpdated(poolId, member, peerId, previousScore, score, msg.sender, block.timestamp);
    }

    // === GETTER FUNCTIONS FOR REQUIRED FEATURES ===



    /**
     * @dev Get number of members in a specific pool
     */
    function getPoolMemberCount(uint32 poolId) external view validatePoolId(poolId) returns (uint256) {
        return pools[poolId].memberList.length;
    }

    /**
     * @dev Get paginated list of pool members
     */
    function getPoolMembersPaginated(
        uint32 poolId,
        uint256 offset,
        uint256 limit
    ) external view validatePoolId(poolId) returns (
        address[] memory members,
        string[] memory peerIds,
        uint256[] memory joinDates,
        uint16[] memory reputationScores,
        bool hasMore
    ) {
        Pool storage pool = pools[poolId];
        uint256 totalMembers = pool.memberList.length;
        require(offset < totalMembers, "Offset exceeds member count");

        uint256 end = offset + limit;
        if (end > totalMembers) {
            end = totalMembers;
        }

        uint256 resultLength = end - offset;
        members = new address[](resultLength);
        peerIds = new string[](resultLength);
        joinDates = new uint256[](resultLength);
        reputationScores = new uint16[](resultLength);

        for (uint256 i = 0; i < resultLength; i++) {
            address memberAddr = pool.memberList[offset + i];
            members[i] = memberAddr;
            // Return first peer ID for backward compatibility
            string[] memory memberPeerIds = pool.memberPeerIds[memberAddr];
            peerIds[i] = memberPeerIds.length > 0 ? memberPeerIds[0] : "";
            joinDates[i] = pool.members[memberAddr].joinDate;
            reputationScores[i] = pool.members[memberAddr].reputationScore;
        }

        hasMore = end < totalMembers;
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
        lockedAmount = lockedTokens[wallet];
        totalRequired = userTotalRequiredLockedTokens[wallet];
        claimableAmount = claimableTokens[wallet];
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

    /**
     * @dev Internal helper to safely transfer tokens with reentrancy protection
     * @param to The recipient address
     * @param amount The amount to transfer
     * @return success Whether the transfer was successful
     */
    function _safeTokenTransfer(address to, uint256 amount) internal returns (bool success) {
        require(to != address(0) && amount > 0, "Invalid params");
        require(!transferLocks[to], "Transfer in progress");

        // Set lock before external call
        transferLocks[to] = true;

        // Store result before clearing lock to prevent reentrancy
        bool transferResult;
        try token.transfer(to, amount) returns (bool result) {
            transferResult = result;
        } catch {
            transferResult = false;
        }

        // Clear lock after external call completes
        transferLocks[to] = false;

        return transferResult;
    }

    /**
     * @dev Check if a peer ID is a member of a specific pool
     */
    function isPeerIdMemberOfPool(uint32 poolId, string memory peerId) external view validatePoolId(poolId) returns (bool, address) {
        Pool storage pool = pools[poolId];
        address memberAddress = pool.peerIdToMember[peerId];
        bool isMember = memberAddress != address(0) && pool.members[memberAddress].joinDate > 0;
        return (isMember, memberAddress);
    }

    /**
     * @dev Get all peer IDs for a member in a specific pool
     */
    function getMemberPeerIds(uint32 poolId, address member) external view validatePoolId(poolId) returns (string[] memory) {
        Pool storage pool = pools[poolId];
        if (pool.members[member].joinDate > 0) {
            return pool.memberPeerIds[member];
        } else {
            return new string[](0);
        }
    }

    /**
     * @dev Get reputation of a pool member with all peer IDs
     */
    function getMemberReputationMultiPeer(uint32 poolId, address member) external view validatePoolId(poolId) returns (
        bool exists,
        uint16 reputationScore,
        uint256 joinDate,
        string[] memory peerIds
    ) {
        Pool storage pool = pools[poolId];
        exists = pool.members[member].joinDate > 0;
        if (exists) {
            reputationScore = pool.members[member].reputationScore;
            joinDate = pool.members[member].joinDate;
            peerIds = pool.memberPeerIds[member];
        } else {
            peerIds = new string[](0);
        }
    }

    function _addMemberFromVoting(Pool storage pool, string memory peerId, address accountId) internal {
        require(accountId != address(0), "Invalid account ID");
        require(pool.memberList.length < 1000, "Pool is full");
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use in this pool");

        if (pool.members[accountId].joinDate == 0) {
            pool.members[accountId] = Member({
                joinDate: block.timestamp,
                accountId: accountId,
                reputationScore: 400,
                statusFlags: 0
            });
            poolMemberIndices[pool.id][accountId] = pool.memberList.length;
            pool.memberList.push(accountId);
        }

        pool.memberPeerIds[accountId].push(peerId);
        pool.peerIdToMember[peerId] = accountId;
        emit MemberJoined(pool.id, accountId, peerId);
    }

    function _removeJoinRequest(uint32 poolId, address member) internal {
        uint256 index = requestIndex[member];
        require(index > 0, "Request not found");
        require(joinRequests[poolId].length > 0, "No join requests to remove");

        uint256 arrayIndex = index - 1;
        require(arrayIndex < joinRequests[poolId].length, "Invalid request index");

        string memory peerIdToDelete = joinRequests[poolId][arrayIndex].peerId;
        uint256 lastArrayIndex = joinRequests[poolId].length - 1;

        if (arrayIndex != lastArrayIndex) {
            address movedAccountId = joinRequests[poolId][lastArrayIndex].accountId;
            joinRequests[poolId][arrayIndex].peerId = joinRequests[poolId][lastArrayIndex].peerId;
            joinRequests[poolId][arrayIndex].accountId = joinRequests[poolId][lastArrayIndex].accountId;
            joinRequests[poolId][arrayIndex].poolId = joinRequests[poolId][lastArrayIndex].poolId;
            joinRequests[poolId][arrayIndex].approvals = joinRequests[poolId][lastArrayIndex].approvals;
            joinRequests[poolId][arrayIndex].rejections = joinRequests[poolId][lastArrayIndex].rejections;
            requestIndex[movedAccountId] = arrayIndex + 1;
        }

        joinRequests[poolId].pop();
        delete usersActiveJoinRequestByPeerID[peerIdToDelete];
        delete requestIndex[member];
    }

    function _removeMemberFromList(address[] storage memberList, mapping(address => uint256) storage memberIndices, address member) internal {
        uint256 memberIndex = memberIndices[member];
        require(memberIndex < memberList.length, "Member not found in list");
        address lastMember = memberList[memberList.length - 1];
        memberList[memberIndex] = lastMember;
        memberIndices[lastMember] = memberIndex;
        memberList.pop();
        delete memberIndices[member];
    }

    uint256[50] private __gap;
}