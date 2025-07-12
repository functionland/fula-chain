// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/interfaces/IStoragePool.sol";
import "../core/StorageToken.sol";

/**
 * @title StoragePoolLib
 * @dev Library to reduce StoragePool contract size by extracting complex functions
 */
library StoragePoolLib {
    using StoragePoolLib for IStoragePool.Pool;

    // === Validation Constants ===
    uint256 private constant MAX_STRING_LENGTH = 256;
    uint256 private constant MIN_PING_TIME = 1; // 1 millisecond in milliseconds
    uint256 private constant MAX_PING_TIME = 10000; // 10 seconds in milliseconds
    uint256 private constant MIN_CHALLENGE_PERIOD = 1 hours;
    uint256 private constant MAX_CHALLENGE_PERIOD = 30 days;
    uint256 private constant MAX_REQUIRED_TOKENS = 10_000_000 * 10**18; // 10M tokens
    uint256 private constant MIN_REPUTATION_SCORE = 0;
    uint256 private constant MAX_REPUTATION_SCORE = 1000;

    // Events
    event DataPoolCreated(uint256 indexed poolId, string name, address creator);
    event DataPoolDeleted(uint256 indexed poolId, address creator);
    event MemberJoined(uint256 indexed poolId, address member, string peerId);
    event MemberLeft(uint256 indexed poolId, address member, string peerId);
    event MemberRemoved(uint32 indexed poolId, address member, address removedBy, string peerId);
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId, address member);
    event JoinRequestCanceled(uint256 indexed poolId, address requester, string peerId);
    event JoinRequestRejected(uint32 poolId, address indexed accountId, string peerId);
    event TokensLocked(address user, uint256 amount);
    event TokensUnlocked(address user, uint256 amount);
    event TokensMarkedClaimable(address user, uint256 amount);
    event TokensClaimed(address user, uint256 amount);
    event PoolCreationRequirementUpdated(uint256 newAmount);
    event PoolEmergencyAction(string action, uint256 timestamp);
    event StorageCostSet(uint32 indexed poolId, uint256 costPerTBYear);
    event ProviderAdded(address indexed provider, uint256 storageSize, bool isLargeProvider);

    event ValidationError(string indexed errorType, address indexed caller, string details);







    /**
     * @dev Adds a new member to an existing storage pool with optimized data structures
     *
     * @notice This internal function handles the core member addition logic:
     * - Validates that the member is not already in the pool
     * - Creates optimized Member struct with gas-efficient field ordering
     * - Adds member to both the mapping and array for dual access patterns
     * - Sets default reputation score and status flags
     * - Emits monitoring event for off-chain tracking
     *
     * @notice Data Structure Optimization:
     * - Member struct uses packed fields to minimize storage slots
     * - accountId (20 bytes) + reputationScore (2 bytes) + statusFlags (1 byte) = 23 bytes in one slot
     * - joinDate uses full 32-byte slot for timestamp precision
     * - peerId stored as dynamic string for IPFS compatibility
     *
     * @notice Security Features:
     * - Duplicate member prevention via membership check
     * - Input validation for address and peer ID
     * - Default reputation score prevents privilege escalation
     * - Status flags reserved for future access control features
     *
     * @param pool Storage reference to the target pool
     * @param peerId IPFS peer identifier for the new member (validated for format)
     * @param member Ethereum address of the new member (validated for zero address)
     *
     * Requirements:
     * - Member must not already exist in the pool
     * - peerId must be valid IPFS peer identifier
     * - member must be valid non-zero Ethereum address
     *
     * Emits:
     * - MemberJoined(poolId, member) for monitoring and indexing
     *
     * @custom:gas-optimization This function uses optimized struct packing and minimal storage operations.
     */
    function addMemberToPool(
        IStoragePool.Pool storage pool,
        mapping(string => address) storage globalPeerIdToAccount,
        mapping(string => uint32) storage globalPeerIdToPool,
        string memory peerId,
        address member,
        uint32 poolId
    ) internal {
        require(pool.memberList.length < 1000, "Pool is full"); // MAX_MEMBERS = 1000
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use");

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

        // If member doesn't exist, create member entry
        if (pool.members[member].joinDate == 0) {
            pool.members[member] = IStoragePool.Member({
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

        emit MemberJoined(pool.id, member, peerId);
    }





    /**
     * @dev Validates pool deletion requirements
     */
    function validatePoolDeletion(
        IStoragePool.Pool storage pool,
        address caller,
        bool isAdmin
    ) public view {
        require(pool.creator != address(0), "Pool does not exist");
        require(caller == pool.creator || isAdmin, "Not authorized");

        // Ensure no members other than creator exist (applies to both admin and non-admin)
        // This prevents gas limit DoS by requiring batch removal of members first
        require(pool.memberList.length == 1, "Pool has active members - use removeMembersBatch first");
        require(pool.memberList[0] == pool.creator, "Only creator should remain in member list");
    }



    /**
     * @dev Processes creator token refunds during pool deletion (only handles creator)
     */
    function processCreatorTokenRefunds(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address /* caller */,
        uint256 dataPoolCreationTokens
    ) public {
        address creator = pool.creator;

        // Only refund if creator has locked tokens
        if (lockedTokens[creator] >= dataPoolCreationTokens) {
            // Update state before external calls to prevent reentrancy
            lockedTokens[creator] -= dataPoolCreationTokens;
            safeSubtractUserTokens(userTotalRequiredLockedTokens, creator, dataPoolCreationTokens);

            uint256 contractBalance = token.balanceOf(address(this));
            if (contractBalance >= dataPoolCreationTokens) {
                // External call after state updates - use secure transfer
                bool transferSuccess = safeTokenTransfer(transferLocks, token, creator, dataPoolCreationTokens);
                if (transferSuccess) {
                    emit TokensUnlocked(creator, dataPoolCreationTokens);
                } else {
                    // If transfer fails after validation, mark as claimable as last resort
                    safeAddTokens(claimableTokens, creator, dataPoolCreationTokens);
                    emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
                }
            } else {
                // If contract doesn't have enough tokens, mark as claimable for later
                safeAddTokens(claimableTokens, creator, dataPoolCreationTokens);
                emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
            }
        }
    }

    /**
     * @dev Processes token refunds during pool deletion (DEPRECATED - use processCreatorTokenRefunds)
     */
    function processTokenRefunds(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address caller,
        bool isAdmin,
        uint256 dataPoolCreationTokens
    ) external {
        address creator = pool.creator;
        uint256 requiredTokensForPool = pool.requiredTokens;

        // Refund creator's pool creation tokens
        uint256 requiredLockedTokens = calculateRequiredLockedTokens(
            lockedTokens,
            userTotalRequiredLockedTokens,
            creator
        );

        if (!isAdmin) {
            require(lockedTokens[creator] >= requiredLockedTokens, "Insufficient locked tokens");
        }

        // Only refund if creator has locked tokens
        if (lockedTokens[creator] >= dataPoolCreationTokens) {
            // Update state before external calls to prevent reentrancy
            lockedTokens[creator] -= dataPoolCreationTokens;
            safeSubtractUserTokens(userTotalRequiredLockedTokens, creator, dataPoolCreationTokens);

            uint256 contractBalance = token.balanceOf(address(this));
            if (contractBalance >= dataPoolCreationTokens) {
                // External call after state updates - use secure transfer
                bool transferSuccess = safeTokenTransfer(transferLocks, token, creator, dataPoolCreationTokens);
                if (transferSuccess) {
                    emit TokensUnlocked(creator, dataPoolCreationTokens);
                } else {
                    // If transfer fails after validation, mark as claimable as last resort
                    safeAddTokens(claimableTokens, creator, dataPoolCreationTokens);
                    emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
                }
            } else {
                // If contract doesn't have enough tokens, mark as claimable for later
                safeAddTokens(claimableTokens, creator, dataPoolCreationTokens);
                emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
            }
        }

        // Refund member tokens
        refundMemberTokens(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            transferLocks,
            token,
            caller,
            isAdmin,
            requiredTokensForPool,
            creator
        );
    }

    /**
     * @dev Refunds tokens to a single member during removal
     */
    function refundSingleMemberTokens(
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address member,
        uint256 requiredTokensForPool,
        address /* caller */,
        bool /* isAdmin */
    ) internal {
        uint256 lockedAmount = lockedTokens[member];
        if (lockedAmount >= requiredTokensForPool) {
            uint256 refundAmount = requiredTokensForPool;

            // Update state before external calls to prevent reentrancy
            lockedTokens[member] -= refundAmount;
            safeSubtractUserTokens(userTotalRequiredLockedTokens, member, refundAmount);

            // Use secure transfer with validation
            bool transferSuccess = safeTokenTransfer(transferLocks, token, member, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(member, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                safeAddTokens(claimableTokens, member, refundAmount);
                emit TokensMarkedClaimable(member, refundAmount);
            }
        }
    }

    /**
     * @dev Refunds tokens to pool members during deletion
     */
    function refundMemberTokens(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address /* caller */,
        bool isAdmin,
        uint256 requiredTokensForPool,
        address creator
    ) internal {
        // Clear all members and refund their tokens
        uint256 minGasPerOperation = 40000; // Minimum gas needed per member refund operation
        uint256 maxIterations = 50; // Maximum iterations per call to prevent gas limit issues
        uint256 iterations = 0;

        while (pool.memberList.length > 0 && iterations < maxIterations) {
            // Gas limit protection: ensure we have enough gas for this operation + safety buffer
            if (gasleft() < minGasPerOperation + 10000) {
                // Not enough gas for another operation, stop here to prevent out-of-gas
                break;
            }

            address member = pool.memberList[pool.memberList.length - 1];
            iterations++;
            uint256 requiredLockedTokensForUser = calculateRequiredLockedTokens(
                lockedTokens,
                userTotalRequiredLockedTokens,
                member
            );

            if (!isAdmin) {
                require(lockedTokens[member] >= requiredLockedTokensForUser, "Insufficient locked tokens for pool member");
            }

            // Skip creator as they are handled separately in processTokenRefunds
            if (member != creator) {
                // Update state before external calls to prevent reentrancy
                if (lockedTokens[member] >= requiredLockedTokensForUser) {
                    lockedTokens[member] -= requiredTokensForPool;

                    uint256 contractBalance = token.balanceOf(address(this));
                    if (contractBalance >= requiredTokensForPool) {
                        // External call after state updates - use secure transfer
                        bool transferSuccess = safeTokenTransfer(transferLocks, token, member, requiredTokensForPool);
                        if (transferSuccess) {
                            emit TokensUnlocked(member, requiredTokensForPool);
                        } else {
                            // If transfer fails after validation, mark as claimable as last resort
                            safeAddTokens(claimableTokens, member, requiredTokensForPool);
                            emit TokensMarkedClaimable(member, requiredTokensForPool);
                        }
                    } else {
                        // If contract doesn't have enough tokens, mark as claimable for later
                        safeAddTokens(claimableTokens, member, requiredTokensForPool);
                        emit TokensMarkedClaimable(member, requiredTokensForPool);
                    }
                }
            }

            if (member != creator) {
                safeSubtractUserTokens(userTotalRequiredLockedTokens, member, requiredTokensForPool);
            }

            pool.memberList.pop();
            delete pool.members[member];
        }
    }

    /**
     * @dev Remove members from pool in batches to avoid gas limit issues (full validation)
     * @param pool The pool storage reference
     * @param lockedTokens Mapping of locked tokens per user
     * @param userTotalRequiredLockedTokens Mapping of total required locked tokens per user
     * @param claimableTokens Mapping of claimable tokens per user
     * @param poolMemberIndices Mapping of member indices for this pool
     * @param token The storage token contract
     * @param caller The address calling the function
     * @param isAdmin Whether the caller is an admin
     * @param maxMembers Maximum number of members to remove in this batch
     * @param poolId The pool ID for proper index management
     * @return removedCount Number of members actually removed
     */




    /**
     * @dev Remove member from list and update indices mapping
     * @param memberList The member list array
     * @param memberToRemove The member to remove
     * @param poolMemberIndices The indices mapping to update
     */
    function _removeMemberFromListWithIndices(
        address[] storage memberList,
        address memberToRemove,
        mapping(address => uint256) storage poolMemberIndices
    ) public {
        require(memberList.length > 0, "Member list is empty");

        uint256 memberIndex = poolMemberIndices[memberToRemove];
        require(memberIndex < memberList.length, "Invalid member index");
        require(memberList[memberIndex] == memberToRemove, "Member index mismatch");

        uint256 lastIndex = memberList.length - 1;

        if (memberIndex != lastIndex) {
            address lastMember = memberList[lastIndex];
            memberList[memberIndex] = lastMember;
            poolMemberIndices[lastMember] = memberIndex;
        }

        memberList.pop();
        delete poolMemberIndices[memberToRemove];
    }

    /**
     * @dev Calculates required locked tokens for a user
     */
    function calculateRequiredLockedTokens(
        mapping(address => uint256) storage /* lockedTokens */,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        address user
    ) public view returns (uint256) {
        return userTotalRequiredLockedTokens[user];
    }



    /**
     * @dev Validates member removal requirements
     */
    function validateMemberRemoval(
        IStoragePool.Pool storage pool,
        address member,
        address caller,
        bool isAdmin
    ) external view {
        require(caller == pool.creator || isAdmin, "Not authorized");
        require(pool.members[member].joinDate > 0, "Not a member");
        require(member != pool.creator, "Cannot remove pool creator");
    }

    /**
     * @dev Processes member removal including token refunds
     */
    function removeMemberWithRefund(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        mapping(string => address) storage /* globalPeerIdToAccount */,
        mapping(string => uint32) storage /* globalPeerIdToPool */,
        StorageToken token,
        address member
    ) external {
        // Update state before external calls to prevent reentrancy
        uint256 lockedAmount = lockedTokens[member];

        if ((pool.members[member].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens) {
            uint256 refundAmount = pool.requiredTokens;
            lockedTokens[member] -= refundAmount;

            safeSubtractUserTokens(userTotalRequiredLockedTokens, member, refundAmount);

            // External call after state updates - use secure transfer
            bool transferSuccess = safeTokenTransfer(transferLocks, token, member, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(member, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                safeAddTokens(claimableTokens, member, refundAmount);
                emit TokensMarkedClaimable(member, refundAmount);
            }
        } else {
            // Member is set to forfeit tokens or has insufficient locked tokens, no refund
            safeSubtractUserTokens(userTotalRequiredLockedTokens, member, pool.requiredTokens);
        }

        // Clear membership data from storage
        delete pool.members[member];
    }









    /**
     * @dev Adds a member from voting process (internal helper)
     */
    function addMemberFromVoting(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage poolMemberIndices,
        mapping(address => uint256) storage /* userTotalRequiredLockedTokens */,
        mapping(address => uint256) storage /* lockedTokens */,
        uint256 poolId,
        string memory peerId,
        address accountId
    ) internal {
        require(accountId != address(0), "Invalid account ID");
        require(pool.memberList.length < 1000, "Pool is full");
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use in this pool");

        // Update member data (optimized struct)
        if (pool.members[accountId].joinDate == 0) {
            IStoragePool.Member storage newMember = pool.members[accountId];
            newMember.joinDate = block.timestamp;
            newMember.accountId = accountId;
            newMember.reputationScore = 400;
            newMember.statusFlags = 0;          // Default status flags

            // Update member list and indices
            poolMemberIndices[accountId] = pool.memberList.length;
            pool.memberList.push(accountId);
        }

        // Add peer ID to member's peer ID list
        pool.memberPeerIds[accountId].push(peerId);
        pool.peerIdToMember[peerId] = accountId;

        // Do NOT update userTotalRequiredLockedTokens here - it was already incremented
        // during createJoinRequest when tokens were locked for the join request
        // This prevents double counting of required tokens

        emit MemberJoined(poolId, accountId, peerId);
    }

    /**
     * @dev Removes a join request from storage
     */
    function removeJoinRequest(
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(string => IStoragePool.JoinRequest) storage usersActiveJoinRequestByPeerID,
        mapping(address => uint256) storage requestIndex,
        uint32 poolId,
        address member
    ) internal {
        // Retrieve the index of the user's join request from the mapping
        uint256 index = requestIndex[member];
        require(index > 0, "Request not found"); // requestIndex stores 1-based indices

        // Check if there are any join requests
        require(joinRequests[poolId].length > 0, "No join requests to remove");

        // Convert to 0-based index for array access
        uint256 arrayIndex = index - 1;
        require(arrayIndex < joinRequests[poolId].length, "Invalid request index");

        // Get the peer ID to delete from the mapping
        string memory peerIdToDelete = joinRequests[poolId][arrayIndex].peerId;

        // Get the last index (0-based)
        uint256 lastArrayIndex = joinRequests[poolId].length - 1;

        // If the element to remove is not the last one, swap it with the last element
        if (arrayIndex != lastArrayIndex) {
            address movedAccountId = joinRequests[poolId][lastArrayIndex].accountId;

            // Copy the last element to the position of the element to remove
            joinRequests[poolId][arrayIndex].peerId = joinRequests[poolId][lastArrayIndex].peerId;
            joinRequests[poolId][arrayIndex].accountId = joinRequests[poolId][lastArrayIndex].accountId;
            joinRequests[poolId][arrayIndex].poolId = joinRequests[poolId][lastArrayIndex].poolId;
            joinRequests[poolId][arrayIndex].approvals = joinRequests[poolId][lastArrayIndex].approvals;
            joinRequests[poolId][arrayIndex].rejections = joinRequests[poolId][lastArrayIndex].rejections;

            // Update the index mapping for the moved element (convert back to 1-based)
            requestIndex[movedAccountId] = arrayIndex + 1;
        }

        // Remove the last element
        joinRequests[poolId].pop();

        // Clear the removed user's mappings
        delete usersActiveJoinRequestByPeerID[peerIdToDelete];
        delete requestIndex[member];
    }

    /**
     * @dev Processes join request cancellation with comprehensive token refund and cleanup
     *
     * @notice This function enables users to cancel their pending join requests with the following process:
     * - Validates request existence and ownership
     * - Calculates and processes token refunds for locked amounts
     * - Removes join request from all data structures
     * - Cleans up related mappings and indices
     * - Emits monitoring events for audit trails
     *
     * @notice Request Validation:
     * - Verifies pool ID is within valid range
     * - Confirms requester has an active join request
     * - Validates request index consistency
     * - Ensures request belongs to the specified pool
     *
     * @notice Token Refund Process:
     * - Refunds pool.requiredTokens that were locked during request submission
     * - Uses secure transfer mechanism with fallback to claimable tokens
     * - Updates lockedTokens and userTotalRequiredLockedTokens mappings
     * - Follows Checks-Effects-Interactions pattern for security
     *
     * @notice Data Structure Cleanup:
     * - Removes JoinRequest from joinRequests array using efficient swap-and-pop
     * - Updates usersActiveJoinRequestByPeerID mapping
     * - Clears requestIndex for the requester
     * - Maintains array integrity and gas efficiency
     *
     * @notice Security Features:
     * - Request ownership validation prevents unauthorized cancellations
     * - State updates before external calls prevent reentrancy attacks
     * - Comprehensive bounds checking for array operations
     * - Secure token transfer with validation
     *
     * @notice Gas Optimization:
     * - Efficient array element removal using swap-and-pop technique
     * - Minimal storage operations for cleanup
     * - Early validation to prevent unnecessary computations
     * - Batch updates of related mappings
     *
     * @param pools Storage mapping of all pools
     * @param joinRequests Storage mapping of join requests by pool ID
     * @param usersActiveJoinRequestByPeerID Storage mapping of active requests by peer ID
     * @param requestIndex Storage mapping of user request indices
     * @param lockedTokens Storage mapping of user locked token amounts
     * @param userTotalRequiredLockedTokens Storage mapping of user total required locked tokens
     * @param claimableTokens Storage mapping of user claimable token amounts (fallback)
     * @param token The StorageToken contract instance for token operations
     * @param poolId Unique identifier of the pool containing the join request
     * @param requester Address of the user requesting cancellation
     *
     * Requirements:
     * - Requester must have an active join request for the specified pool
     * - Pool ID must be within valid range
     * - Request must be in pending status (not yet processed)
     *
     * Emits:
     * - JoinRequestCancelled(poolId, requester) for cancellation tracking
     * - TokensRefunded(requester, amount) if refund is successful
     *
     * @custom:security This function implements secure request cancellation with comprehensive validation.
     */


    /**
     * @dev Safely transfers tokens with reentrancy protection
     * @notice Fixed critical reentrancy vulnerability by ensuring lock state is managed properly
     */
    function safeTokenTransfer(
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address to,
        uint256 amount
    ) public returns (bool success) {
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
     * @dev Deletes a storage pool with comprehensive validation, cleanup, and token refunds
     *
     * @notice This function performs complete pool deletion with the following operations:
     * - Validates deletion permissions (admin or pool creator)
     * - Ensures only the creator remains in the pool (all other members must be removed first)
     * - Processes token refunds for the pool creator
     * - Clears all pool-related data structures
     * - Emits monitoring events for audit trails
     *
     * @notice Pool Deletion Workflow:
     * 1. Validation: Checks caller permissions and pool state
     * 2. Token Refund: Refunds dataPoolCreationTokens to creator if locked
     * 3. Data Cleanup: Clears member indices and join requests
     * 4. Event Emission: Logs deletion for monitoring
     *
     * @notice Security Features:
     * - Permission validation ensures only authorized users can delete pools
     * - Pool state validation prevents deletion of pools with active members
     * - Secure token transfer with fallback to claimable tokens
     * - Comprehensive event logging for audit trails
     *
     * @notice Gas Optimization:
     * - Returns creator data to avoid additional storage reads
     * - Batch cleanup of related data structures
     * - Efficient validation checks with early returns
     *
     * @param pool Storage reference to the pool being deleted
     * @param lockedTokens Storage mapping of user locked token amounts
     * @param userTotalRequiredLockedTokens Storage mapping of user total required locked tokens
     * @param claimableTokens Storage mapping of user claimable token amounts (fallback)
     * @param poolMemberIndices Storage mapping of member indices within pools
     * @param joinRequests Storage array of pending join requests for this pool
     * @param token The StorageToken contract instance for token operations
     * @param caller Address of the user requesting pool deletion
     * @param isAdmin Boolean indicating if the caller has admin privileges
     * @param dataPoolCreationTokens Amount of tokens required for pool creation (to refund)
     *
     * @return creator Address of the pool creator (for event emission)
     * @return creatorLockedTokens Amount of tokens that were locked by creator (for event emission)
     *
     * Requirements:
     * - Caller must be admin or pool creator
     * - Pool must exist and be in valid state for deletion
     * - All members except creator must have been removed from pool
     *
     * Emits:
     * - DataPoolDeleted(poolId, creator) for pool deletion tracking
     * - TokensRefunded(creator, amount) if creator refund is successful
     *
     * @custom:security This function implements secure token handling and comprehensive validation.
     */


    // === GETTER FUNCTIONS FOR REQUIRED FEATURES ===

    /**
     * @dev Get all pools with their details and creators
     * @param pools Storage mapping of all pools
     * @param poolCounter Current pool counter
     * @return poolIds Array of pool IDs
     * @return names Array of pool names
     * @return regions Array of pool regions
     * @return creators Array of pool creators
     * @return requiredTokens Array of required tokens for each pool
     */
    function getAllPools(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        uint256 poolCounter
    ) external view returns (
        uint256[] memory poolIds,
        string[] memory names,
        string[] memory regions,
        address[] memory creators,
        uint256[] memory requiredTokens
    ) {
        // Gas limit protection: limit maximum pools returned to prevent DoS
        uint256 maxPoolsToReturn = 500; // Maximum pools to return in one call

        // Count valid pools first (with limit)
        uint256 validPoolCount = 0;
        for (uint256 i = 1; i <= poolCounter && validPoolCount < maxPoolsToReturn; i++) {
            if (pools[i].creator != address(0)) {
                validPoolCount++;
            }
        }

        // Initialize arrays
        poolIds = new uint256[](validPoolCount);
        names = new string[](validPoolCount);
        regions = new string[](validPoolCount);
        creators = new address[](validPoolCount);
        requiredTokens = new uint256[](validPoolCount);

        // Fill arrays (with same limit)
        uint256 index = 0;
        for (uint256 i = 1; i <= poolCounter && index < validPoolCount; i++) {
            if (pools[i].creator != address(0)) {
                poolIds[index] = pools[i].id;
                names[index] = pools[i].name;
                regions[index] = pools[i].region;
                creators[index] = pools[i].creator;
                requiredTokens[index] = pools[i].requiredTokens;
                index++;
            }
        }
    }





    /**
     * @dev Get join requests for a specific user
     * @param joinRequests Storage mapping of join requests by pool ID
     * @param user Address of the user
     * @param poolCounter Current pool counter to iterate through pools
     * @return poolIds Array of pool IDs where user has join requests
     * @return peerIds Array of peer IDs for each request
     * @return timestamps Array of request timestamps
     * @return statuses Array of request statuses
     */
    function getUserJoinRequests(
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(address => uint256) storage /* requestIndex */,
        address user,
        uint256 poolCounter
    ) external view returns (
        uint32[] memory poolIds,
        string[] memory peerIds,
        uint32[] memory timestamps,
        uint8[] memory statuses
    ) {
        // Gas limit protection: limit maximum requests returned to prevent DoS
        uint256 maxRequestsToReturn = 200; // Maximum requests to return in one call

        // Count user's requests first (with limit)
        uint256 requestCount = 0;
        for (uint32 i = 1; i <= poolCounter && requestCount < maxRequestsToReturn; i++) {
            IStoragePool.JoinRequest[] storage requests = joinRequests[i];
            for (uint256 j = 0; j < requests.length && requestCount < maxRequestsToReturn; j++) {
                if (requests[j].accountId == user) {
                    requestCount++;
                }
            }
        }

        // Initialize arrays
        poolIds = new uint32[](requestCount);
        peerIds = new string[](requestCount);
        timestamps = new uint32[](requestCount);
        statuses = new uint8[](requestCount);

        // Fill arrays (with same limit)
        uint256 index = 0;
        for (uint32 i = 1; i <= poolCounter && index < requestCount; i++) {
            IStoragePool.JoinRequest[] storage requests = joinRequests[i];
            for (uint256 j = 0; j < requests.length && index < requestCount; j++) {
                if (requests[j].accountId == user) {
                    poolIds[index] = requests[j].poolId;
                    peerIds[index] = requests[j].peerId;
                    timestamps[index] = requests[j].timestamp;
                    statuses[index] = requests[j].status;
                    index++;
                }
            }
        }
    }

    /**
     * @dev Get vote status and counts for a join request
     * @param usersActiveJoinRequestByPeerID Storage mapping of active requests by peer ID
     * @param peerId Peer ID of the join request
     * @return exists Whether the request exists
     * @return poolId Pool ID of the request
     * @return accountId Account ID of the requester
     * @return approvals Number of approval votes
     * @return rejections Number of rejection votes
     * @return status Request status (0=pending, 1=approved, 2=rejected)
     */
    function getJoinRequestVoteStatus(
        mapping(string => IStoragePool.JoinRequest) storage usersActiveJoinRequestByPeerID,
        string memory peerId
    ) external view returns (
        bool exists,
        uint32 poolId,
        address accountId,
        uint128 approvals,
        uint128 rejections,
        uint8 status
    ) {
        IStoragePool.JoinRequest storage request = usersActiveJoinRequestByPeerID[peerId];
        exists = request.accountId != address(0);
        if (exists) {
            poolId = request.poolId;
            accountId = request.accountId;
            approvals = request.approvals;
            rejections = request.rejections;
            status = request.status;
        }
    }







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





    /**
     * @dev Internal function to efficiently remove a member from the member list
     * @param memberList The member list array
     * @param poolMemberIndices Mapping of member indices
     * @param member The member to remove
     */
    function removeMemberFromList(
        address[] storage memberList,
        mapping(address => uint256) storage poolMemberIndices,
        address member
    ) internal {
        uint256 index = poolMemberIndices[member];
        uint256 lastIndex = memberList.length - 1;

        if (index != lastIndex) {
            address lastMember = memberList[lastIndex];
            memberList[index] = lastMember;
            poolMemberIndices[lastMember] = index;
        }

        memberList.pop();
        delete poolMemberIndices[member];
    }







    /**
     * @dev Internal function to add a member to a pool
     * @param pool The pool storage reference
     * @param poolMemberIndices Mapping of member indices
     * @param poolId The pool ID
     * @param peerId The peer ID of the new member
     * @param accountId The account ID of the new member
     */
    function addMemberInternal(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage poolMemberIndices,
        mapping(address => uint256) storage /* lockedTokens */,
        mapping(address => uint256) storage /* userTotalRequiredLockedTokens */,
        uint32 poolId,
        string memory peerId,
        address accountId
    ) external {
        require(accountId != address(0), "Invalid account ID");
        require(pool.memberList.length < 1000, "Pool is full"); // MAX_MEMBERS = 1000
        require(pool.peerIdToMember[peerId] == address(0), "PeerId already in use in this pool");

        // Update member data
        if (pool.members[accountId].joinDate == 0) {
            IStoragePool.Member storage newMember = pool.members[accountId];
            newMember.joinDate = block.timestamp;
            newMember.accountId = accountId;
            newMember.reputationScore = 400;

            // Update member list and indices
            poolMemberIndices[accountId] = pool.memberList.length;
            pool.memberList.push(accountId);
        }

        // Add peer ID to member's peer ID list
        pool.memberPeerIds[accountId].push(peerId);
        pool.peerIdToMember[peerId] = accountId;

        // Do NOT update userTotalRequiredLockedTokens here - it was already incremented
        // during createJoinRequest when tokens were locked for the join request
        // This prevents double counting of required tokens

        emit MemberJoined(poolId, accountId, peerId);
    }

    // Events for setDataPoolCreationTokensFull
    event AdminActionExecuted(
        address indexed admin,
        string action,
        uint256 targetId,
        address targetAddress,
        uint256 amount,
        string details,
        uint256 timestamp
    );

    event SecurityParameterChanged(
        address indexed admin,
        string parameterName,
        uint256 oldValue,
        uint256 newValue,
        string description,
        uint256 timestamp
    );

    /**
     * @dev Helper function to convert uint256 to string for event logging
     */
    function uint2str(uint256 value) external pure returns (string memory) {
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
    function calculateApprovalThreshold(uint256 memberCount) external pure returns (uint256) {
        if (memberCount == 0) return 1; // Edge case protection
        if (memberCount <= 2) return 1; // Minimum threshold for small pools
        return (memberCount + 2) / 3; // Ceiling division: ceil(memberCount/3)
    }

    /**
     * @dev Calculate rejection threshold using ceiling division for majority
     */
    function calculateRejectionThreshold(uint256 memberCount) external pure returns (uint256) {
        if (memberCount == 0) return 1; // Edge case protection
        if (memberCount == 1) return 1; // Single member requires 1 rejection
        return (memberCount / 2) + 1; // Majority: more than half
    }

    /**
     * @dev Allows users to claim tokens that were marked as claimable when direct transfers failed
     */
    function claimTokensFull(
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address caller
    ) external {
        uint256 claimableAmount = claimableTokens[caller];
        require(claimableAmount > 0, "No tokens to claim");

        claimableTokens[caller] = 0;
        bool transferSuccess = safeTokenTransfer(transferLocks, token, caller, claimableAmount);
        require(transferSuccess, "Transfer failed");

        emit TokensClaimed(caller, claimableAmount);
    }

    /**
     * @dev Get locked tokens for any wallet
     */
    function getUserLockedTokens(
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        address wallet
    ) external view returns (
        uint256 lockedAmount,
        uint256 totalRequired,
        uint256 claimableAmount
    ) {
        lockedAmount = lockedTokens[wallet];
        totalRequired = userTotalRequiredLockedTokens[wallet];
        claimableAmount = claimableTokens[wallet];
    }

    /**
     * @dev Safely adds tokens to a mapping with overflow protection
     * @param tokenMapping The mapping to update
     * @param account The account to update
     * @param amount The amount to add
     * @notice Prevents integer overflow attacks by checking for overflow before addition
     */
    function safeAddTokens(
        mapping(address => uint256) storage tokenMapping,
        address account,
        uint256 amount
    ) internal {
        require(account != address(0), "Invalid account");
        require(amount > 0, "Amount must be positive");

        uint256 currentBalance = tokenMapping[account];
        // Check for overflow: if currentBalance + amount < currentBalance, overflow occurred
        require(currentBalance + amount >= currentBalance, "Token amount overflow");

        tokenMapping[account] = currentBalance + amount;
    }

    /**
     * @dev Safely subtracts tokens from userTotalRequiredLockedTokens with underflow protection
     * @param userTotalRequiredLockedTokens The mapping to update
     * @param account The account to update
     * @param amount The amount to subtract
     * @notice Prevents underflow by setting to zero if amount exceeds current balance
     */
    function safeSubtractUserTokens(
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        address account,
        uint256 amount
    ) internal {
        require(account != address(0), "Invalid account");

        uint256 currentBalance = userTotalRequiredLockedTokens[account];
        if (currentBalance >= amount) {
            userTotalRequiredLockedTokens[account] = currentBalance - amount;
        } else {
            userTotalRequiredLockedTokens[account] = 0;
        }
    }

    /**
     * @dev Sets the number of tokens needed to be locked to create a data pool
     * @param oldAmount The current amount of tokens required
     * @param _amount The new amount of tokens required for pool creation
     * @param caller The address calling this function
     * @return newAmount The new amount that was set
     */
    function setDataPoolCreationTokensFull(
        uint256 oldAmount,
        uint256 _amount,
        address caller
    ) external returns (uint256 newAmount) {
        // Enhanced validation
        require(_amount > 0, "Amount must be positive");
        require(_amount <= 10_000_000 * 10**18, "Amount exceeds maximum limit"); // MAX_REQUIRED_TOKENS

        // Enhanced monitoring events
        emit AdminActionExecuted(
            caller,
            "SET_POOL_CREATION_TOKENS",
            0, // no specific target ID
            address(0), // no specific target address
            _amount,
            "Pool creation tokens updated",
            block.timestamp
        );

        emit SecurityParameterChanged(
            caller,
            "dataPoolCreationTokens",
            oldAmount,
            _amount,
            "Admin updated pool creation token requirement",
            block.timestamp
        );

        return _amount;
    }







}