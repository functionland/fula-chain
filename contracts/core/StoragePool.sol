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

    uint256 private constant POOL_ACTION_DELAY = 8 hours;
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
        dataPoolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
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
        uint256 newPoolId = StoragePoolLib.createPoolFull(
            pools,
            lockedTokens,
            userTotalRequiredLockedTokens,
            poolActionTimeLocks,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            poolCounter,
            dataPoolCreationTokens,
            POOL_ACTION_DELAY,
            name,
            region,
            requiredTokens,
            minPingTime,
            maxChallengeResponsePeriod,
            creatorPeerId,
            msg.sender,
            _hasAdminPrivileges(msg.sender)
        );

        poolCounter = newPoolId;
        _grantRole(POOL_CREATOR_ROLE, msg.sender);
    }

    /**
     * @dev Remove members from pool in batches to avoid gas limit issues
     * @param poolId The pool ID
     * @param maxMembers Maximum number of members to remove in this batch (max 100)
     */
    function removeMembersBatch(uint32 poolId, uint256 maxMembers) external nonReentrant whenNotPaused validatePoolId(poolId) {
        uint256 removedCount = StoragePoolLib.removeMembersBatchFull(
            pools[poolId],
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            poolMemberIndices[poolId],
            token,
            msg.sender,
            _hasAdminPrivileges(msg.sender),
            maxMembers,
            poolId
        );

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

        (address creator, uint256 creatorLockedTokens) = StoragePoolLib.deletePoolFull(
            pools[poolId],
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            poolMemberIndices[poolId],
            joinRequests[poolId],
            token,
            msg.sender,
            _hasAdminPrivileges(msg.sender),
            dataPoolCreationTokens
        );

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

        // Validate join request using library
        StoragePoolLib.validateJoinRequest(
            pool,
            lockedTokens,
            joinRequests,
            requestIndex,
            token,
            msg.sender,
            poolId,
            peerId
        );

        // Create join request using library
        StoragePoolLib.createJoinRequest(
            joinRequests,
            usersActiveJoinRequestByPeerID,
            requestIndex,
            lockedTokens,
            userTotalRequiredLockedTokens,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            poolId,
            peerId,
            msg.sender,
            pool.requiredTokens
        );

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
        return StoragePoolLib.isMemberOfAnyPool(pools, poolCounter, member);
    }

    /**
     * @dev Get total number of members across all pools
     * @return Total number of unique members across all pools
     */
    function getTotalMembers() external view override returns (uint256) {
        return StoragePoolLib.getTotalMembers(pools, poolCounter);
    }

    // Function to set the storage cost per pool
    function setStorageCost(uint32 poolId, uint256 costPerTBYear) external nonReentrant whenNotPaused onlyRole(POOL_CREATOR_ROLE) {
        StoragePoolLib.setStorageCost(pools[poolId], storageCostPerTBYear, msg.sender, poolId, costPerTBYear);
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
        StoragePoolLib.cancelJoinRequest(
            pools,
            joinRequests,
            usersActiveJoinRequestByPeerID,
            requestIndex,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            poolId,
            msg.sender
        );
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
        StoragePoolLib.leavePoolFull(
            pools[poolId],
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            poolMemberIndices[poolId],
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            msg.sender,
            poolId
        );
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    function removeMember(uint32 poolId, address member) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        bool isAdmin = _hasAdminPrivileges(msg.sender);

        StoragePoolLib.removeMemberFull(
            pool,
            poolMemberIndices,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            poolId,
            member,
            msg.sender,
            isAdmin
        );
    }

    /**
     * @dev Allows users to claim tokens that were marked as claimable when direct transfers failed
     */
    function claimTokens() external nonReentrant whenNotPaused {
        StoragePoolLib.claimTokens(claimableTokens, lastClaimTimestamp, transferLocks, token, msg.sender);
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

        StoragePoolLib.addMemberToPoolWithTokens(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            peerId,
            member,
            msg.sender,
            isAdmin,
            requireTokenLock,
            poolId
        );

        poolMemberIndices[poolId][member] = pool.memberList.length - 1;
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
        StoragePoolLib.voteOnJoinRequest(
            pools,
            joinRequests,
            usersActiveJoinRequestByPeerID,
            requestIndex,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            poolMemberIndices,
            globalPeerIdToAccount,
            globalPeerIdToPool,
            token,
            poolId,
            peerIdToVote,
            approve,
            msg.sender
        );
    }

    // Set reputation implementation
    function setReputation(
        uint32 poolId,
        string memory peerId,
        uint8 score
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        StoragePoolLib.setReputation(pools[poolId], msg.sender, peerId, score);
    }

    // === GETTER FUNCTIONS FOR REQUIRED FEATURES ===

    /**
     * @dev Get all pools with their details and creators
     */
    function getAllPools() external view returns (
        uint256[] memory poolIds,
        string[] memory names,
        string[] memory regions,
        address[] memory creators,
        uint256[] memory requiredTokens
    ) {
        return StoragePoolLib.getAllPools(pools, poolCounter);
    }

    /**
     * @dev Get number of members in a specific pool
     */
    function getPoolMemberCount(uint32 poolId) external view validatePoolId(poolId) returns (uint256) {
        return StoragePoolLib.getPoolMemberCount(pools[poolId]);
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
        return StoragePoolLib.getPoolMembersPaginated(pools[poolId], offset, limit);
    }

    /**
     * @dev Get join requests for a specific user
     */
    function getUserJoinRequests(address user) external view returns (
        uint32[] memory poolIds,
        string[] memory peerIds,
        uint32[] memory timestamps,
        uint8[] memory statuses
    ) {
        return StoragePoolLib.getUserJoinRequests(joinRequests, requestIndex, user, poolCounter);
    }

    /**
     * @dev Get vote status and counts for a join request
     */
    function getJoinRequestVoteStatus(string memory peerId) external view returns (
        bool exists,
        uint32 poolId,
        address accountId,
        uint128 approvals,
        uint128 rejections,
        uint8 status
    ) {
        return StoragePoolLib.getJoinRequestVoteStatus(usersActiveJoinRequestByPeerID, peerId);
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
        return StoragePoolLib.getMemberReputation(pools[poolId], member);
    }

    /**
     * @dev Get locked tokens for any wallet
     */
    function getUserLockedTokens(address wallet) external view returns (
        uint256 lockedAmount,
        uint256 totalRequired,
        uint256 claimableAmount
    ) {
        return StoragePoolLib.getUserLockedTokens(lockedTokens, userTotalRequiredLockedTokens, claimableTokens, wallet);
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
     * @dev Internal helper to safely transfer tokens using the library's secure transfer function
     * @param to The recipient address
     * @param amount The amount to transfer
     * @return success Whether the transfer was successful
     */
    function _safeTokenTransfer(address to, uint256 amount) internal returns (bool success) {
        return StoragePoolLib.safeTokenTransfer(transferLocks, token, to, amount);
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

    uint256[50] private __gap;
}