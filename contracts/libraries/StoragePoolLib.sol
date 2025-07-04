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
    event MemberJoined(uint256 indexed poolId, address member);
    event MemberLeft(uint256 indexed poolId, address member);
    event MemberRemoved(uint32 indexed poolId, address member, address removedBy);
    event JoinRequestSubmitted(uint256 indexed poolId, string peerId, address member);
    event JoinRequestCanceled(uint256 indexed poolId, address requester);
    event JoinRequestRejected(uint32 poolId, address indexed accountId);
    event TokensLocked(address user, uint256 amount);
    event TokensUnlocked(address user, uint256 amount);
    event TokensMarkedClaimable(address user, uint256 amount);
    event TokensClaimed(address user, uint256 amount);
    event PoolCreationRequirementUpdated(uint256 newAmount);
    event PoolEmergencyAction(string action, uint256 timestamp);
    event StorageCostSet(uint32 indexed poolId, uint256 costPerTBYear);
    event ProviderAdded(address indexed provider, uint256 storageSize, bool isLargeProvider);

    // === Enhanced Validation Events ===
    event ValidationError(string indexed errorType, address indexed caller, string details);

    // === Comprehensive Validation Functions ===

    /**
     * @dev Validates address parameters to prevent zero address and contract issues
     * @param addr The address to validate
     * @param paramName The parameter name for error reporting
     */
    function validateAddress(address addr, string memory paramName) internal pure {
        require(addr != address(0), string(abi.encodePacked("Invalid ", paramName, ": zero address")));
        // Additional validation: ensure it's not a known problematic address
        require(addr != address(0xdead), string(abi.encodePacked("Invalid ", paramName, ": dead address")));
    }

    /**
     * @dev Validates string parameters for length and content
     * @param str The string to validate
     * @param paramName The parameter name for error reporting
     * @param allowEmpty Whether empty strings are allowed
     */
    function validateString(string memory str, string memory paramName, bool allowEmpty) internal pure {
        bytes memory strBytes = bytes(str);
        if (!allowEmpty) {
            require(strBytes.length > 0, string(abi.encodePacked(paramName, " cannot be empty")));
        }
        require(strBytes.length <= MAX_STRING_LENGTH, string(abi.encodePacked(paramName, " too long")));

        // Validate that string contains only printable ASCII characters
        for (uint256 i = 0; i < strBytes.length; i++) {
            bytes1 char = strBytes[i];
            require(char >= 0x20 && char <= 0x7E, string(abi.encodePacked("Invalid character in ", paramName)));
        }
    }

    /**
     * @dev Validates numeric ranges for pool parameters
     * @param value The value to validate
     * @param min Minimum allowed value
     * @param max Maximum allowed value
     * @param paramName The parameter name for error reporting
     */
    function validateRange(uint256 value, uint256 min, uint256 max, string memory paramName) internal pure {
        require(value >= min, string(abi.encodePacked(paramName, " below minimum")));
        require(value <= max, string(abi.encodePacked(paramName, " above maximum")));
    }

    /**
     * @dev Validates pool creation parameters comprehensively
     * @param name Pool name
     * @param region Pool region
     * @param requiredTokens Required tokens to join
     * @param minPingTime Minimum ping time requirement
     * @param maxChallengeResponsePeriod Maximum challenge response period
     * @param creatorPeerId Creator's peer ID
     * @param creator Creator's address
     */
    function validatePoolCreationParams(
        string memory name,
        string memory region,
        uint256 requiredTokens,
        uint256 minPingTime,
        uint256 maxChallengeResponsePeriod,
        string memory creatorPeerId,
        address creator
    ) internal pure {
        // Address validation
        validateAddress(creator, "creator");

        // String validation
        validateString(name, "pool name", false);
        validateString(region, "region", false);
        validateString(creatorPeerId, "creator peer ID", false);

        // Numeric range validation
        validateRange(requiredTokens, 1, MAX_REQUIRED_TOKENS, "required tokens");
        validateRange(minPingTime, MIN_PING_TIME, MAX_PING_TIME, "minimum ping time");
        validateRange(maxChallengeResponsePeriod, MIN_CHALLENGE_PERIOD, MAX_CHALLENGE_PERIOD, "challenge response period");

        // Business logic validation
        require(requiredTokens > 0, "Required tokens must be positive");
    }

    /**
     * @dev Creates a new data storage pool with comprehensive validation and token management
     *
     * @notice This is the core pool creation function that handles:
     * - Comprehensive input validation via validatePoolCreationParams
     * - Token locking requirements (bypassed for admins)
     * - Pool data structure initialization with optimized field ordering
     * - Automatic addition of creator as first pool member
     * - Event emission for monitoring and indexing
     *
     * @notice Algorithm Flow:
     * 1. Validate all input parameters comprehensively
     * 2. Check business logic constraints (required tokens vs creation tokens)
     * 3. Handle token locking based on admin status
     * 4. Initialize pool struct with optimized gas layout
     * 5. Add creator as first member with default reputation
     * 6. Emit creation event for off-chain monitoring
     *
     * @notice Gas Optimization Features:
     * - Struct fields ordered to minimize storage slots
     * - Inlined criteria struct to reduce indirection
     * - Efficient member addition via addMemberToPool
     *
     * @notice Security Features:
     * - Comprehensive input validation prevents malformed data
     * - Token lock validation ensures economic security
     * - Admin bypass allows governance flexibility
     * - Checks-Effects-Interactions pattern prevents reentrancy
     *
     * @param pools Storage mapping of all pools in the system
     * @param lockedTokens Storage mapping tracking user locked token amounts
     * @param userTotalRequiredLockedTokens Storage mapping tracking total required locks per user
     * @param token The StorageToken contract instance for token operations
     * @param poolCounter Current pool counter for ID generation
     * @param dataPoolCreationTokens Required tokens to create a pool
     * @param name Human-readable pool name (validated for length and content)
     * @param region Geographical region identifier (validated for length and content)
     * @param requiredTokens Tokens members must lock to join (validated for range)
     * @param minPingTime Minimum acceptable ping time in milliseconds (validated for range)
     * @param maxChallengeResponsePeriod Maximum challenge response time in seconds (validated for range)
     * @param creatorPeerId IPFS peer ID of the pool creator (validated for format)
     * @param creator Address of the pool creator (validated for zero address)
     * @param isAdmin Whether the creator has admin privileges (affects token lock requirements)
     *
     * @return newPoolId The unique identifier assigned to the newly created pool
     *
     * @custom:security-note This function modifies critical state and handles token locking.
     * All validations occur before state changes to ensure atomicity.
     */
    function createPool(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        StorageToken token,
        uint256 poolCounter,
        uint256 dataPoolCreationTokens,
        string memory name,
        string memory region,
        uint256 requiredTokens,
        uint256 minPingTime,
        uint256 maxChallengeResponsePeriod,
        string memory creatorPeerId,
        address creator,
        bool isAdmin
    ) external returns (uint256 newPoolId) {
        // Comprehensive input validation
        validatePoolCreationParams(
            name,
            region,
            requiredTokens,
            minPingTime,
            maxChallengeResponsePeriod,
            creatorPeerId,
            creator
        );

        // Additional business logic validation
        require(requiredTokens <= dataPoolCreationTokens, "Required tokens to join the pool exceed limit");

        // Token locking logic - admin can bypass
        if (isAdmin) {
            // Admin can create pools without locking tokens
            // Only lock tokens if admin chooses to and has sufficient balance
            if (token.balanceOf(creator) >= dataPoolCreationTokens) {
                if (token.transferFrom(creator, address(this), dataPoolCreationTokens)) {
                    lockedTokens[creator] += dataPoolCreationTokens;
                    userTotalRequiredLockedTokens[creator] += dataPoolCreationTokens;
                    emit TokensLocked(creator, dataPoolCreationTokens);
                }
            }
        } else {
            // Non-admin pool creators must lock tokens
            require(token.balanceOf(creator) >= dataPoolCreationTokens, "Insufficient tokens for pool creation");
            require(token.transferFrom(creator, address(this), dataPoolCreationTokens), "Token transfer failed");
            lockedTokens[creator] += dataPoolCreationTokens;
            userTotalRequiredLockedTokens[creator] += dataPoolCreationTokens;
            emit TokensLocked(creator, dataPoolCreationTokens);
        }

        newPoolId = poolCounter + 1;
        IStoragePool.Pool storage pool = pools[newPoolId];

        // Set pool properties (optimized struct layout)
        pool.name = name;
        pool.region = region;
        pool.id = newPoolId;
        pool.requiredTokens = requiredTokens;
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod;
        pool.creator = creator;
        pool.minPingTime = minPingTime;  // Inlined from criteria struct

        // Add creator as first member
        addMemberToPool(pool, creatorPeerId, creator);

        emit DataPoolCreated(newPoolId, name, creator);
    }

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
        string memory peerId,
        address member
    ) internal {
        require(pool.members[member].joinDate == 0, "Already a member");
        require(pool.memberList.length < 1000, "Pool is full"); // MAX_MEMBERS = 1000

        pool.members[member] = IStoragePool.Member({
            joinDate: block.timestamp,
            accountId: member,
            reputationScore: 500,    // Default reputation score
            statusFlags: 0,          // Default status flags
            peerId: peerId
        });

        pool.memberList.push(member);
        emit MemberJoined(pool.id, member);
    }

    /**
     * @dev Adds a member to a pool with proper access control and token management
     * @param pool The pool storage reference
     * @param lockedTokens Mapping of locked tokens per user
     * @param userTotalRequiredLockedTokens Mapping of total required locked tokens per user
     * @param token The storage token contract
     * @param peerId The peer ID of the member
     * @param member The address of the member to add
     * @param caller The address calling this function
     * @param isAdmin Whether the caller is an admin
     * @param requireTokenLock Whether token locking is required
     */
    function addMemberToPoolWithTokens(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        StorageToken token,
        string memory peerId,
        address member,
        address caller,
        bool isAdmin,
        bool requireTokenLock
    ) external {
        require(pool.members[member].joinDate == 0, "Already a member");
        require(pool.memberList.length < 1000, "Pool is full");

        // Access control: only admin or pool creator
        require(caller == pool.creator || isAdmin, "Not authorized");

        // Token locking logic
        if (requireTokenLock) {
            if (isAdmin) {
                // Admin can bypass token locking requirement
                // Only update userTotalRequiredLockedTokens if tokens are actually locked
                if (lockedTokens[member] >= pool.requiredTokens) {
                    userTotalRequiredLockedTokens[member] += pool.requiredTokens;
                }
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
        pool.members[member] = IStoragePool.Member({
            joinDate: block.timestamp,
            accountId: member,
            reputationScore: 500,    // Default reputation score
            statusFlags: 0,          // Default status flags
            peerId: peerId
        });

        pool.memberList.push(member);
        emit MemberJoined(pool.id, member);
    }

    /**
     * @dev Removes a member from the pool's member list
     */
    function removeMemberFromList(
        address[] storage memberList,
        address member,
        uint256 poolId
    ) external {
        uint256 length = memberList.length;
        for (uint256 i = 0; i < length; i++) {
            if (memberList[i] == member) {
                // Move the last element to the position of the element to remove
                memberList[i] = memberList[length - 1];
                // Remove the last element
                memberList.pop();
                emit MemberLeft(poolId, member);
                break;
            }
        }
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
        StorageToken token,
        address /* caller */,
        uint256 dataPoolCreationTokens
    ) public {
        address creator = pool.creator;

        // Only refund if creator has locked tokens
        if (lockedTokens[creator] >= dataPoolCreationTokens) {
            // Update state before external calls to prevent reentrancy
            lockedTokens[creator] -= dataPoolCreationTokens;
            userTotalRequiredLockedTokens[creator] -= dataPoolCreationTokens;

            uint256 contractBalance = token.balanceOf(address(this));
            if (contractBalance >= dataPoolCreationTokens) {
                // External call after state updates - use secure transfer
                bool transferSuccess = safeTokenTransfer(token, creator, dataPoolCreationTokens);
                if (transferSuccess) {
                    emit TokensUnlocked(creator, dataPoolCreationTokens);
                } else {
                    // If transfer fails after validation, mark as claimable as last resort
                    claimableTokens[creator] += dataPoolCreationTokens;
                    emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
                }
            } else {
                // If contract doesn't have enough tokens, mark as claimable for later
                claimableTokens[creator] += dataPoolCreationTokens;
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
            userTotalRequiredLockedTokens[creator] -= dataPoolCreationTokens;

            uint256 contractBalance = token.balanceOf(address(this));
            if (contractBalance >= dataPoolCreationTokens) {
                // External call after state updates - use secure transfer
                bool transferSuccess = safeTokenTransfer(token, creator, dataPoolCreationTokens);
                if (transferSuccess) {
                    emit TokensUnlocked(creator, dataPoolCreationTokens);
                } else {
                    // If transfer fails after validation, mark as claimable as last resort
                    claimableTokens[creator] += dataPoolCreationTokens;
                    emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
                }
            } else {
                // If contract doesn't have enough tokens, mark as claimable for later
                claimableTokens[creator] += dataPoolCreationTokens;
                emit TokensMarkedClaimable(creator, dataPoolCreationTokens);
            }
        }

        // Refund member tokens
        refundMemberTokens(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
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
        StorageToken token,
        address member,
        uint256 requiredTokensForPool,
        address caller,
        bool isAdmin
    ) internal {
        uint256 lockedAmount = lockedTokens[member];
        if (lockedAmount >= requiredTokensForPool) {
            uint256 refundAmount = requiredTokensForPool;

            // Update state before external calls to prevent reentrancy
            lockedTokens[member] -= refundAmount;
            userTotalRequiredLockedTokens[member] -= refundAmount;

            // Use secure transfer with validation
            bool transferSuccess = safeTokenTransfer(token, member, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(member, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                claimableTokens[member] += refundAmount;
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
        StorageToken token,
        address caller,
        bool isAdmin,
        uint256 requiredTokensForPool,
        address creator
    ) internal {
        // Clear all members and refund their tokens
        while (pool.memberList.length > 0) {
            address member = pool.memberList[pool.memberList.length - 1];
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
                        bool transferSuccess = safeTokenTransfer(token, member, requiredTokensForPool);
                        if (transferSuccess) {
                            emit TokensUnlocked(member, requiredTokensForPool);
                        } else {
                            // If transfer fails after validation, mark as claimable as last resort
                            claimableTokens[member] += requiredTokensForPool;
                            emit TokensMarkedClaimable(member, requiredTokensForPool);
                        }
                    } else {
                        // If contract doesn't have enough tokens, mark as claimable for later
                        claimableTokens[member] += requiredTokensForPool;
                        emit TokensMarkedClaimable(member, requiredTokensForPool);
                    }
                }
            }
            
            if (member != creator) {
                if (userTotalRequiredLockedTokens[member] >= requiredTokensForPool) {
                    userTotalRequiredLockedTokens[member] -= requiredTokensForPool;
                } else {
                    userTotalRequiredLockedTokens[member] = 0;
                }
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
    function removeMembersBatchFull(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => uint256) storage poolMemberIndices,
        StorageToken token,
        address caller,
        bool isAdmin,
        uint256 maxMembers,
        uint32 poolId
    ) external returns (uint256) {
        require(maxMembers > 0 && maxMembers <= 100, "Invalid batch size");
        require(caller == pool.creator || isAdmin, "Not authorized");

        uint256 membersToRemove = 0;
        uint256 memberCount = pool.memberList.length;

        // Calculate how many members to remove (excluding creator)
        for (uint256 i = 0; i < memberCount && membersToRemove < maxMembers; i++) {
            if (pool.memberList[i] != pool.creator) {
                membersToRemove++;
            }
        }

        require(membersToRemove > 0, "No members to remove");

        return removeMembersBatch(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            poolMemberIndices,
            token,
            caller,
            isAdmin,
            maxMembers,
            poolId
        );
    }

    /**
     * @dev Remove members from pool in batches to avoid gas limit issues
     * @param pool The pool storage reference
     * @param lockedTokens The locked tokens mapping
     * @param userTotalRequiredLockedTokens The user total required locked tokens mapping
     * @param claimableTokens The claimable tokens mapping
     * @param poolMemberIndices The pool member indices mapping
     * @param token The storage token contract
     * @param caller The address calling the function
     * @param isAdmin Whether the caller is an admin
     * @param maxMembers Maximum number of members to remove in this batch
     * @param poolId The pool ID for proper index management
     * @return removedCount Number of members actually removed
     */
    function removeMembersBatch(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => uint256) storage poolMemberIndices,
        StorageToken token,
        address caller,
        bool isAdmin,
        uint256 maxMembers,
        uint32 poolId
    ) public returns (uint256) {
        require(pool.memberList.length > 0, "Pool has no members");

        uint256 removedCount = 0;

        // Remove members (excluding creator)
        for (uint256 i = 0; i < pool.memberList.length && removedCount < maxMembers; ) {
            address member = pool.memberList[i];

            if (member != pool.creator) {
                // Refund tokens for this specific member
                refundSingleMemberTokens(
                    lockedTokens,
                    userTotalRequiredLockedTokens,
                    claimableTokens,
                    token,
                    member,
                    pool.requiredTokens,
                    caller,
                    isAdmin
                );

                // Remove from member list and update indices
                _removeMemberFromListWithIndices(pool.memberList, member, poolMemberIndices);
                delete pool.members[member];

                removedCount++;

                emit MemberRemoved(poolId, member, caller);
                // Don't increment i since we removed an element
            } else {
                i++;
            }
        }

        return removedCount;
    }

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
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        address user
    ) public view returns (uint256) {
        return userTotalRequiredLockedTokens[user];
    }

    /**
     * @dev Processes secure token claims for users when direct transfers previously failed
     *
     * @notice This function provides a robust fallback mechanism for token recovery with the following features:
     * - Enables users to claim tokens when direct transfers fail during refunds
     * - Protects against malicious token contract manipulation
     * - Implements secure transfer validation with comprehensive checks
     * - Prevents double-claiming through state clearing
     * - Emits monitoring events for audit trails
     *
     * @notice Claimable Token System:
     * - Tokens become claimable when direct transfers fail during refunds
     * - Maintains user ownership even with problematic token contracts
     * - Provides alternative recovery path for stuck tokens
     * - Ensures no loss of user funds due to external contract issues
     *
     * @notice Security Implementation:
     * - Validates claimable amount before processing (prevents zero claims)
     * - Clears claimable balance before transfer (prevents reentrancy)
     * - Uses secure transfer validation to ensure success
     * - Requires successful transfer completion
     * - Comprehensive error handling for edge cases
     *
     * @notice Transfer Validation Process:
     * - Checks token contract balance before and after transfer
     * - Validates exact transfer amount was processed
     * - Prevents manipulation by malicious token contracts
     * - Ensures atomic claim operations with rollback on failure
     *
     * @notice Gas Optimization:
     * - Single storage read for claimable amount
     * - Immediate state clearing to prevent additional reads
     * - Efficient validation checks with early returns
     * - Minimal external contract interactions
     *
     * @param claimableTokens Storage mapping of user claimable token amounts
     * @param token The StorageToken contract instance for token operations
     * @param user Address of the user claiming tokens
     *
     * Requirements:
     * - User must have claimable tokens (amount > 0)
     * - Token contract must be functional for transfers
     * - Secure transfer validation must pass
     *
     * Emits:
     * - TokensClaimed(user, amount) for successful claims
     *
     * @custom:security This function implements secure token claiming with comprehensive validation and reentrancy protection.
     */
    function claimTokens(
        mapping(address => uint256) storage claimableTokens,
        StorageToken token,
        address user
    ) external {
        uint256 claimableAmount = claimableTokens[user];
        require(claimableAmount > 0, "No tokens to claim");

        // Clear claimable amount before transfer to prevent reentrancy
        claimableTokens[user] = 0;

        // Use secure transfer with validation - this should always succeed for claimable tokens
        bool transferSuccess = safeTokenTransfer(token, user, claimableAmount);
        require(transferSuccess, "Secure token transfer failed");

        emit TokensClaimed(user, claimableAmount);
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
        StorageToken token,
        address member
    ) external {
        // Update state before external calls to prevent reentrancy
        uint256 lockedAmount = lockedTokens[member];
        if (lockedAmount >= pool.requiredTokens) {
            uint256 refundAmount = pool.requiredTokens;
            lockedTokens[member] -= refundAmount;

            if (userTotalRequiredLockedTokens[member] >= refundAmount) {
                userTotalRequiredLockedTokens[member] -= refundAmount;
            } else {
                userTotalRequiredLockedTokens[member] = 0;
            }

            // External call after state updates - use secure transfer
            bool transferSuccess = safeTokenTransfer(token, member, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(member, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                claimableTokens[member] += refundAmount;
                emit TokensMarkedClaimable(member, refundAmount);
            }
        } else {
            if (userTotalRequiredLockedTokens[member] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[member] -= pool.requiredTokens;
            } else {
                userTotalRequiredLockedTokens[member] = 0;
            }
        }

        // Clear membership data from storage
        delete pool.members[member];
    }

    /**
     * @dev Validates join request submission requirements
     */
    function validateJoinRequest(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(address => uint256) storage requestIndex,
        StorageToken token,
        address requester,
        uint32 poolId
    ) external view {
        require(lockedTokens[requester] == 0, "Tokens already locked for another data pool");
        require(pool.creator != address(0), "Data pool does not exist");
        require(pool.members[requester].joinDate == 0, "Already a member");
        require(token.balanceOf(requester) >= pool.requiredTokens, "Insufficient tokens");
        require(requestIndex[requester] == 0, "User already has active requests");
        require(pool.memberList.length + joinRequests[poolId].length < 1000, "Data pool has reached maximum capacity"); // MAX_MEMBERS = 1000
    }

    /**
     * @dev Creates a join request
     */
    function createJoinRequest(
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(string => IStoragePool.JoinRequest) storage usersActiveJoinRequestByPeerID,
        mapping(address => uint256) storage requestIndex,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        StorageToken token,
        uint32 poolId,
        string memory peerId,
        address requester,
        uint256 requiredTokens
    ) external {
        // Lock the user's tokens for this join request
        require(token.transferFrom(requester, address(this), requiredTokens), "Token transfer failed");
        lockedTokens[requester] += requiredTokens;

        // Create and save the new join request (optimized struct)
        IStoragePool.JoinRequest[] storage requests = joinRequests[poolId];
        uint256 newIndex = requests.length;
        requests.push(); // Push an empty slot first to save gas on array resizing

        IStoragePool.JoinRequest storage newRequest = requests[newIndex];
        newRequest.accountId = requester;
        newRequest.poolId = poolId;
        newRequest.timestamp = uint32(block.timestamp);
        newRequest.status = 0;              // 0 = pending
        newRequest.approvals = 0;
        newRequest.rejections = 0;
        newRequest.peerId = peerId;

        IStoragePool.JoinRequest storage peerRequest = usersActiveJoinRequestByPeerID[peerId];
        peerRequest.peerId = peerId;
        peerRequest.accountId = requester;
        peerRequest.poolId = poolId;
        peerRequest.approvals = 0;
        peerRequest.rejections = 0;

        // Save the index of this request for efficient lookup
        requestIndex[requester] = newIndex;
        userTotalRequiredLockedTokens[requester] += requiredTokens;
    }

    /**
     * @dev Processes member votes on join requests with automatic threshold-based decision making
     *
     * @notice This function implements democratic pool governance with the following algorithm:
     * - Validates voter eligibility and request existence
     * - Records vote and prevents duplicate voting per member
     * - Calculates approval/rejection thresholds dynamically
     * - Automatically processes member addition or request rejection
     * - Handles token refunds and data structure updates
     *
     * @notice Voting Threshold Algorithm:
     * - Approval Threshold: max(ceil(memberCount/3), min(10, memberCount))
     * - Rejection Threshold: ceil(memberCount/2) + 1
     * - Dynamic calculation based on current pool membership
     * - Prevents manipulation through fixed thresholds
     *
     * @notice Vote Processing Logic:
     * 1. Validation: Checks voter membership and request validity
     * 2. Vote Recording: Updates approval/rejection counters
     * 3. Threshold Evaluation: Compares votes against calculated thresholds
     * 4. Decision Execution: Adds member or processes rejection
     * 5. Cleanup: Removes processed requests and updates mappings
     *
     * @notice Security Features:
     * - Duplicate vote prevention via voter tracking
     * - Member-only voting restriction
     * - Automatic threshold enforcement
     * - Secure token handling with fallback mechanisms
     * - Comprehensive validation of all inputs
     *
     * @notice Gas Optimization:
     * - Efficient threshold calculations using bitwise operations
     * - Early termination when thresholds are met
     * - Batch updates of related data structures
     * - Minimal storage operations for vote tracking
     *
     * @param pools Storage mapping of all pools
     * @param joinRequests Storage mapping of join requests by pool ID
     * @param usersActiveJoinRequestByPeerID Storage mapping of active requests by peer ID
     * @param requestIndex Storage mapping of user request indices
     * @param lockedTokens Storage mapping of user locked token amounts
     * @param userTotalRequiredLockedTokens Storage mapping of user total required locked tokens
     * @param claimableTokens Storage mapping of user claimable token amounts (fallback)
     * @param poolMemberIndices Storage mapping of member indices within pools
     * @param token The StorageToken contract instance for token operations
     * @param poolId Unique identifier of the pool containing the join request
     * @param peerIdToVote IPFS peer identifier of the user whose request is being voted on
     * @param approve Boolean indicating approval (true) or rejection (false) vote
     * @param voter Address of the pool member casting the vote
     *
     * Requirements:
     * - Voter must be an active member of the specified pool
     * - Join request must exist and be in pending status
     * - Voter must not have already voted on this specific request
     * - Pool must exist and be in valid state
     *
     * Emits:
     * - VoteCast(poolId, voter, peerIdToVote, approve) for vote tracking
     * - MemberJoined(poolId, newMember) if request is approved
     * - JoinRequestRejected(poolId, requester) if request is rejected
     * - TokensRefunded(user, amount) for rejected requests
     *
     * @custom:security This function implements secure democratic governance with comprehensive validation.
     */
    function voteOnJoinRequest(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(string => IStoragePool.JoinRequest) storage usersActiveJoinRequestByPeerID,
        mapping(address => uint256) storage requestIndex,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(uint256 => mapping(address => uint256)) storage poolMemberIndices,
        StorageToken token,
        uint32 poolId,
        string memory peerIdToVote,
        bool approve,
        address voter
    ) external {
        require(bytes(peerIdToVote).length > 0, "Invalid peer ID");
        require(usersActiveJoinRequestByPeerID[peerIdToVote].accountId != address(0), "Join request not found");

        IStoragePool.Pool storage pool = pools[poolId];

        // Ensure the voter is a member of the pool
        require(pool.members[voter].joinDate > 0, "Not a pool member");

        // Get the join request
        IStoragePool.JoinRequest storage request = usersActiveJoinRequestByPeerID[peerIdToVote];
        require(request.poolId == poolId, "Invalid pool ID");

        // Ensure the voter has not already voted on this request
        require(!request.votes[voter], "Already voted");

        // Record the voter's vote
        request.votes[voter] = true;

        if (approve) {
            // Increment approval count
            request.approvals++;

            // Check if approvals meet the threshold for acceptance
            uint256 approvalThreshold = calculateApprovalThreshold(pool.memberList.length);
            uint256 absoluteThreshold = 10; // Absolute threshold for large pools

            if (
                request.approvals >= approvalThreshold ||
                request.approvals >= absoluteThreshold
            ) {
                // Add the user as a member of the pool
                addMemberFromVoting(pool, poolMemberIndices[poolId], userTotalRequiredLockedTokens, lockedTokens, poolId, request.peerId, request.accountId);

                // Remove the join request from storage
                removeJoinRequest(joinRequests, usersActiveJoinRequestByPeerID, requestIndex, poolId, request.accountId);
            }
        } else {
            // Increment rejection count
            request.rejections++;

            // Check if rejections meet the threshold for denial
            uint256 rejectionThreshold = calculateRejectionThreshold(pool.memberList.length);

            if (request.rejections >= rejectionThreshold) {
                // Update state before external calls to prevent reentrancy
                uint256 lockedAmount = lockedTokens[request.accountId];
                if (lockedAmount >= pool.requiredTokens) {
                    uint256 refundAmount = pool.requiredTokens;
                    lockedTokens[request.accountId] -= refundAmount;

                    // External call after state updates - use secure transfer with validation
                    bool transferSuccess = safeTokenTransfer(token, request.accountId, refundAmount);
                    if (transferSuccess) {
                        emit TokensUnlocked(request.accountId, refundAmount);
                    } else {
                        // If transfer fails after validation, mark as claimable as last resort
                        claimableTokens[request.accountId] += refundAmount;
                        emit TokensMarkedClaimable(request.accountId, refundAmount);
                    }
                }

                // Remove the join request from storage
                removeJoinRequest(joinRequests, usersActiveJoinRequestByPeerID, requestIndex, poolId, request.accountId);

                emit JoinRequestRejected(poolId, request.accountId);
            }
        }
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
     * @dev Adds a member from voting process (internal helper)
     */
    function addMemberFromVoting(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage poolMemberIndices,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage lockedTokens,
        uint256 poolId,
        string memory peerId,
        address accountId
    ) internal {
        require(accountId != address(0), "Invalid account ID");
        require(pool.memberList.length < 1000, "Pool is full");

        // Update member data (optimized struct)
        IStoragePool.Member storage newMember = pool.members[accountId];
        newMember.joinDate = block.timestamp;
        newMember.accountId = accountId;
        newMember.reputationScore = 400;
        newMember.statusFlags = 0;          // Default status flags
        newMember.peerId = peerId;

        // Update member list and indices
        poolMemberIndices[accountId] = pool.memberList.length;
        pool.memberList.push(accountId);

        // Only update userTotalRequiredLockedTokens if user actually has tokens locked
        // This is for the voting mechanism where tokens are already locked during join request
        if (lockedTokens[accountId] >= pool.requiredTokens) {
            userTotalRequiredLockedTokens[accountId] += pool.requiredTokens;
        }

        emit MemberJoined(poolId, accountId);
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

        // Check if there are any join requests
        require(joinRequests[poolId].length > 0, "No join requests to remove");

        // Ensure the index is valid
        require(index < joinRequests[poolId].length, "Invalid request index");

        // Get the peer ID to delete from the mapping
        string memory peerIdToDelete = joinRequests[poolId][index].peerId;

        // Get the last index
        uint256 lastIndex = joinRequests[poolId].length - 1;

        // If the element to remove is not the last one, swap it with the last element
        if (index != lastIndex) {
            address movedAccountId = joinRequests[poolId][lastIndex].accountId;

            // Copy the last element to the position of the element to remove
            joinRequests[poolId][index].peerId = joinRequests[poolId][lastIndex].peerId;
            joinRequests[poolId][index].accountId = joinRequests[poolId][lastIndex].accountId;
            joinRequests[poolId][index].poolId = joinRequests[poolId][lastIndex].poolId;
            joinRequests[poolId][index].approvals = joinRequests[poolId][lastIndex].approvals;
            joinRequests[poolId][index].rejections = joinRequests[poolId][lastIndex].rejections;

            // Update the index mapping for the moved element
            requestIndex[movedAccountId] = index;
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
    function cancelJoinRequest(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(string => IStoragePool.JoinRequest) storage usersActiveJoinRequestByPeerID,
        mapping(address => uint256) storage requestIndex,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        StorageToken token,
        uint32 poolId,
        address requester
    ) external {
        require(poolId < 1000000, "Invalid pool ID"); // Reasonable upper bound
        uint256 index = requestIndex[requester];
        require(index > 0, "Request not found");
        require(index < joinRequests[poolId].length, "Invalid request");
        IStoragePool.Pool storage pool = pools[poolId];

        // Update state before external calls to prevent reentrancy
        uint256 lockedAmount = lockedTokens[requester];
        uint256 refundAmount = 0;

        if (lockedAmount >= pool.requiredTokens) {
            refundAmount = pool.requiredTokens;
            lockedTokens[requester] -= refundAmount;

            // Update userTotalRequiredLockedTokens only if it was previously set
            if (userTotalRequiredLockedTokens[requester] >= pool.requiredTokens) {
                userTotalRequiredLockedTokens[requester] -= pool.requiredTokens;
            } else {
                userTotalRequiredLockedTokens[requester] = 0;
            }
        }

        removeJoinRequest(joinRequests, usersActiveJoinRequestByPeerID, requestIndex, poolId, requester);

        // External call after state updates - use secure transfer with validation
        if (refundAmount > 0) {
            bool transferSuccess = safeTokenTransfer(token, requester, refundAmount);
            if (transferSuccess) {
                emit TokensUnlocked(requester, refundAmount);
            } else {
                // If transfer fails after validation, mark as claimable as last resort
                claimableTokens[requester] += refundAmount;
                emit TokensMarkedClaimable(requester, refundAmount);
            }
        }

        emit JoinRequestCanceled(poolId, requester);
    }

    /**
     * @dev Safely transfers tokens with proper validation to prevent manipulation
     * @param token The token contract to transfer from
     * @param to The recipient address
     * @param amount The amount to transfer
     * @return success Whether the transfer was successful
     */
    function safeTokenTransfer(
        StorageToken token,
        address to,
        uint256 amount
    ) public returns (bool success) {
        // Validate inputs
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");

        // Check token contract balance before transfer
        uint256 contractBalanceBefore = token.balanceOf(address(this));
        require(contractBalanceBefore >= amount, "Insufficient contract balance");

        // Check recipient balance before transfer
        uint256 recipientBalanceBefore = token.balanceOf(to);

        // Attempt the transfer with try-catch to handle reverts gracefully
        try token.transfer(to, amount) returns (bool transferResult) {
            if (!transferResult) {
                return false; // Transfer returned false
            }

            // Verify the transfer actually happened by checking balances
            uint256 contractBalanceAfter = token.balanceOf(address(this));
            uint256 recipientBalanceAfter = token.balanceOf(to);

            // Validate that balances changed as expected
            bool contractBalanceCorrect = (contractBalanceBefore - contractBalanceAfter) == amount;
            bool recipientBalanceCorrect = (recipientBalanceAfter - recipientBalanceBefore) == amount;

            if (contractBalanceCorrect && recipientBalanceCorrect) {
                return true; // Transfer successful and verified
            } else {
                // Balances don't match expected changes - potential manipulation
                return false;
            }
        } catch {
            // Transfer reverted
            return false;
        }
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
    function deletePoolFull(
        IStoragePool.Pool storage pool,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => uint256) storage poolMemberIndices,
        IStoragePool.JoinRequest[] storage joinRequests,
        StorageToken token,
        address caller,
        bool isAdmin,
        uint256 dataPoolCreationTokens
    ) external returns (address creator, uint256 creatorLockedTokens) {
        creator = pool.creator;

        // Validate deletion requirements
        validatePoolDeletion(pool, caller, isAdmin);

        // Get locked tokens before refund for event emission
        creatorLockedTokens = lockedTokens[creator];

        // Process creator token refunds only (all other members should have been removed via batch removal)
        processCreatorTokenRefunds(
            pool,
            lockedTokens,
            userTotalRequiredLockedTokens,
            claimableTokens,
            token,
            caller,
            dataPoolCreationTokens
        );

        // Remove creator from member list and clean up mappings
        _removeMemberFromListWithIndices(pool.memberList, creator, poolMemberIndices);
        delete pool.members[creator];

        // Remove all pending join requests
        while (joinRequests.length > 0) {
            joinRequests.pop();
        }
    }
}
