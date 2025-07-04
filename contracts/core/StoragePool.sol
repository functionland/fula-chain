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
    uint32 private constant MAX_MEMBERS = 1000;
    uint256 private constant MAX_REQUIRED_TOKENS = 10_000_000 * 10**18; // 10M tokens max
    mapping(uint32 => uint256) public storageCostPerTBYear;

    // required to remove for loops to make gas fees predictable
    mapping(address => uint256) private userTotalRequiredLockedTokens;
    mapping(string => JoinRequest) private usersActiveJoinRequestByPeerID;
    mapping(uint256 => mapping(address => uint256)) private poolMemberIndices;

    // New mapping to track claimable tokens for users when direct transfers fail
    mapping(address => uint256) public claimableTokens;

    function initialize(address _token, address initialOwner) public reinitializer(1) {
        require(_token != address(0), "Invalid token address");
        require(initialOwner != address(0), "Invalid owner address");

        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard,
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialOwner);

        // Grant pool-specific roles
        _grantRole(POOL_CREATOR_ROLE, initialOwner);

        token = StorageToken(_token);
        dataPoolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
    }

    // Emergency pause/unpause functionality is now handled by the inherited GovernanceModule.emergencyAction()
    // Users should call emergencyAction(1) to pause and emergencyAction(2) to unpause

    modifier validatePoolId(uint32 poolId) {
        require(poolId > 0 && poolId <= poolCounter, "Invalid pool ID");
        require(pools[poolId].creator != address(0), "Pool does not exist");
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
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        // Enhanced validation
        require(_amount > 0, "Amount must be positive");
        require(_amount <= MAX_REQUIRED_TOKENS, "Amount exceeds maximum limit");

        uint256 oldAmount = dataPoolCreationTokens;
        dataPoolCreationTokens = _amount;
        _updateActivityTimestamp();

        // Enhanced monitoring events
        emit AdminActionExecuted(
            msg.sender,
            "SET_POOL_CREATION_TOKENS",
            0, // no specific target ID
            address(0), // no specific target address
            _amount,
            string(abi.encodePacked("Changed from ", _uint2str(oldAmount), " to ", _uint2str(_amount))),
            block.timestamp
        );

        emit SecurityParameterChanged(
            msg.sender,
            "dataPoolCreationTokens",
            oldAmount,
            _amount,
            "Admin updated pool creation token requirement",
            block.timestamp
        );
    }

    // Calculate the required number of locked tokens for a user address
    function calculateRequiredLockedTokens(address user) public view returns (uint256) {

        return userTotalRequiredLockedTokens[user];
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

        // Validate inputs
        require(bytes(name).length > 0, "Pool name cannot be empty");
        require(bytes(region).length > 0, "Region cannot be empty");
        require(minPingTime > 0, "Minimum ping time must be greater than zero");

        if (maxChallengeResponsePeriod == 0) {
            maxChallengeResponsePeriod = 7 days;
        }

        // Check if caller is admin or has pool creator role
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);

        // Use library to create the pool
        uint256 newPoolId = StoragePoolLib.createPool(
            pools,
            lockedTokens,
            userTotalRequiredLockedTokens,
            token,
            poolCounter,
            dataPoolCreationTokens,
            name,
            region,
            requiredTokens,
            minPingTime,
            maxChallengeResponsePeriod,
            creatorPeerId,
            msg.sender,
            isAdmin
        );

        poolCounter = newPoolId;
        _grantRole(POOL_CREATOR_ROLE, msg.sender);
        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;
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
            poolMemberIndices[poolId],
            token,
            msg.sender,
            hasRole(ProposalTypes.ADMIN_ROLE, msg.sender),
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
            poolMemberIndices[poolId],
            joinRequests[poolId],
            token,
            msg.sender,
            hasRole(ProposalTypes.ADMIN_ROLE, msg.sender),
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
            poolId
        );

        // Create join request using library
        StoragePoolLib.createJoinRequest(
            joinRequests,
            usersActiveJoinRequestByPeerID,
            requestIndex,
            lockedTokens,
            userTotalRequiredLockedTokens,
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
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Not Authorized");
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
        StoragePoolLib.cancelJoinRequest(
            pools,
            joinRequests,
            usersActiveJoinRequestByPeerID,
            requestIndex,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
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
        Pool storage pool = pools[poolId];

        // Ensure the caller is a member of the pool
        require(pool.members[msg.sender].joinDate > 0, "Not a member");

        // Prevent the pool creator from leaving their own pool
        require(msg.sender != pool.creator, "Pool creator cannot leave their own pool");

        // Calculate refund amount based on actual locked tokens
        uint256 lockedAmount = lockedTokens[msg.sender];
        uint256 refundAmount = 0;

        // Only refund if user has tokens locked for this pool
        if (lockedAmount >= pool.requiredTokens && userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
            refundAmount = pool.requiredTokens;

            // Update state before external calls to prevent reentrancy
            lockedTokens[msg.sender] -= refundAmount;
            userTotalRequiredLockedTokens[msg.sender] -= refundAmount;
        } else {
            // User joined without locking tokens (e.g., added by admin), no refund
            if (userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[msg.sender] -= pool.requiredTokens;
            }
        }

        // Remove the user from the member list efficiently (handles poolMemberIndices)
        _removeMemberFromList(pool.memberList, msg.sender, poolId);

        // Delete the user's membership data from storage
        delete pool.members[msg.sender];

        // External call after state updates - only if there's a refund amount
        if (refundAmount > 0) {
            bool transferSuccess = _safeTokenTransfer(msg.sender, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(msg.sender, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                claimableTokens[msg.sender] += refundAmount;
                emit TokensMarkedClaimable(msg.sender, refundAmount);
            }
        }

        // Emit an event to log that the user has left the pool
        emit MemberLeft(poolId, msg.sender);
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    function removeMember(uint32 poolId, address member) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);

        // Validate member removal using library
        StoragePoolLib.validateMemberRemoval(pool, member, msg.sender, isAdmin);

        // Get locked tokens before removal for event emission
        uint256 refundAmount = pool.requiredTokens;

        // Remove the member from the member list first (handles poolMemberIndices)
        _removeMemberFromList(pool.memberList, member, poolId);

        // Process member removal with refund using library (handles tokens and pool.members)
        StoragePoolLib.removeMemberWithRefund(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            token,
            member
        );

        emit MemberRemoved(poolId, member, msg.sender);
        emit TokensUnlocked(member, refundAmount);
    }

    /**
     * @dev Allows users to claim tokens that were marked as claimable when direct transfers failed
     *
     * @notice This function provides a secure fallback mechanism for token recovery with the following features:
     * - Enables users to claim tokens when direct transfers fail
     * - Protects against malicious token contract manipulation
     * - Implements secure transfer validation with retry mechanism
     * - Clears claimable amounts to prevent double-claiming
     * - Emits monitoring events for tracking
     *
     * @notice Claimable Token Mechanism:
     * - Tokens become claimable when direct transfers fail during refunds
     * - Prevents loss of user funds due to token contract issues
     * - Maintains user ownership of tokens even with transfer failures
     * - Provides alternative recovery path for stuck tokens
     *
     * @notice Security Features:
     * - Validates claimable amount before processing
     * - Clears claimable balance before transfer (prevents reentrancy)
     * - Uses secure transfer validation to ensure success
     * - Reentrancy protection via nonReentrant modifier
     * - Comprehensive error handling for edge cases
     *
     * @notice Transfer Validation:
     * - Checks token contract balance before and after transfer
     * - Validates exact transfer amount was processed
     * - Prevents manipulation by malicious token contracts
     * - Ensures atomic claim operations
     *
     * @notice Use Cases:
     * - Recovery from failed refund transfers
     * - Claiming tokens after pool deletion
     * - Retrieving tokens after rejected join requests
     * - Emergency token recovery scenarios
     *
     * Requirements:
     * - Caller must have claimable tokens (amount > 0)
     * - Token contract must be functional for transfers
     * - Contract must not be paused
     *
     * Emits:
     * - TokensClaimed(user, amount) for successful claims
     *
     * @custom:security This function implements secure token claiming with comprehensive validation.
     */
    function claimTokens() external nonReentrant whenNotPaused {
        StoragePoolLib.claimTokens(claimableTokens, token, msg.sender);
    }

    /**
     * @dev Allows authorized users to directly add members to pools, bypassing the voting process
     *
     * @notice This function provides administrative control for pool membership with the following features:
     * - Admin and pool creator can add members without voting
     * - Flexible token lock requirements based on caller privileges
     * - Comprehensive validation of member eligibility
     * - Automatic member data structure updates
     * - Monitoring events for audit trails
     *
     * @notice Access Control Logic:
     * - Admin: Can bypass all token lock requirements if requireTokenLock=false
     * - Pool Creator: Must enforce token lock requirements (cannot bypass)
     * - Other users: Not authorized to use this function
     * - Prevents unauthorized member additions
     *
     * @notice Token Lock Management:
     * - requireTokenLock=true: Enforces standard token locking for all callers
     * - requireTokenLock=false: Only admins can bypass token requirements
     * - Pool creators cannot bypass token locks (prevents abuse)
     * - Maintains economic incentives for pool participation
     *
     * @notice Member Addition Process:
     * - Validates member is not already in pool
     * - Checks token balance and lock requirements
     * - Creates optimized Member struct with gas-efficient packing
     * - Updates pool.members mapping and memberList array
     * - Maintains poolMemberIndices for efficient lookups
     *
     * @notice Security Features:
     * - Role-based access control prevents unauthorized additions
     * - Duplicate member prevention via membership checks
     * - Token balance validation when locks are required
     * - Comprehensive input validation for all parameters
     * - Reentrancy protection via nonReentrant modifier
     *
     * @notice Use Cases:
     * - Emergency member addition by admin
     * - Pool creator adding trusted members
     * - Bulk member onboarding with proper authorization
     * - Recovery from failed voting processes
     *
     * @param poolId Unique identifier of the target pool
     * @param member Ethereum address of the user to add as a member
     * @param peerId IPFS peer identifier for the new member
     * @param requireTokenLock Whether to enforce token locking (admin can bypass, creator cannot)
     *
     * Requirements:
     * - Caller must be admin or pool creator
     * - Pool must exist and be in valid state
     * - Member must not already be in the pool
     * - If requireTokenLock=true, member must have sufficient token balance
     * - Peer ID must be valid and not already in use
     * - Contract must not be paused
     *
     * Emits:
     * - MemberAddedDirectly(poolId, member, addedBy) for direct addition tracking
     * - TokensLocked(member, amount) if tokens are locked
     *
     * @custom:security This function implements role-based access control with flexible token requirements.
     */
    function addMemberDirectly(
        uint32 poolId,
        address member,
        string memory peerId,
        bool requireTokenLock
    ) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);

        // Use library function with proper access control and token management
        StoragePoolLib.addMemberToPoolWithTokens(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            token,
            peerId,
            member,
            msg.sender,
            isAdmin,
            requireTokenLock
        );

        // Update member indices
        poolMemberIndices[poolId][member] = pool.memberList.length - 1;
    }

    // Internal function to efficiently remove a member from the member list.
    // This function swaps the target member with the last member in the list and then pops it.
    function _removeMemberFromList(address[] storage memberList, address member, uint32 poolId) internal {
        uint256 index = poolMemberIndices[poolId][member];
        uint256 lastIndex = memberList.length - 1;
        
        if (index != lastIndex) {
            address lastMember = memberList[lastIndex];
            memberList[index] = lastMember;
            poolMemberIndices[poolId][lastMember] = index;
        }
        
        memberList.pop();
        delete poolMemberIndices[poolId][member];
    }

    function _addMember(
        uint32 poolId,
        string memory peerId,
        address accountId
    ) internal {
        require(accountId != address(0), "Invalid account ID");
        Pool storage pool = pools[poolId];
        require(pool.memberList.length < MAX_MEMBERS, "Pool is full");

        // Update member data
        Member storage newMember = pool.members[accountId];
        newMember.joinDate = block.timestamp;
        newMember.peerId = peerId;
        newMember.accountId = accountId;
        newMember.reputationScore = 400;

        // Update member list and indices
        poolMemberIndices[poolId][accountId] = pool.memberList.length;
        pool.memberList.push(accountId);

        // Only update userTotalRequiredLockedTokens if user actually has tokens locked
        // This is for the voting mechanism where tokens are already locked during join request
        if (lockedTokens[accountId] >= pool.requiredTokens) {
            userTotalRequiredLockedTokens[accountId] += pool.requiredTokens;
        }

        emit MemberJoined(poolId, accountId);
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
            poolMemberIndices,
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
        address member,
        uint8 score
    ) external nonReentrant whenNotPaused onlyRole(POOL_CREATOR_ROLE) validatePoolId(poolId) {
        require(score <= 1000, "Score exceeds maximum");
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Not authorized - only pool creator can set reputation");
        require(pool.members[member].joinDate > 0, "Not a member");
        pool.members[member].reputationScore = score;
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
        return StoragePoolLib.safeTokenTransfer(token, to, amount);
    }

    /**
     * @dev Helper function to convert uint256 to string for event logging
     * @param value The uint256 value to convert
     * @return The string representation of the value
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

    uint256[50] private __gap;
}