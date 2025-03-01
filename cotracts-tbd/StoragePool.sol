// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./interfaces/IStoragePool.sol";
import "./StorageToken.sol";

contract StoragePool is IStoragePool, OwnableUpgradeable, UUPSUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, AccessControlUpgradeable {
    bytes32 public constant ROLE_VERIFIER = keccak256("ROLE_VERIFIER");
    bytes32 public constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");

    uint256 private lastEmergencyAction;
    uint256 private constant EMERGENCY_COOLDOWN = 5 minutes;
    
    uint256 public constant IMPLEMENTATION_VERSION = 1;

    uint256 private constant POOL_ACTION_DELAY = 8 hours;
    mapping(bytes32 => uint256) private poolActionTimeLocks;
    
    StorageToken public token;
    mapping(uint256 => Pool) public pools;
    mapping(uint32 => JoinRequest[]) public joinRequests;
    mapping(address => uint256) public lockedTokens;
    mapping(address => uint256) public requestIndex;
    // Single mapping using bit flags
    mapping(address => uint8) public providerStatus;
    address[] private providerList;
    // Constants for bit positions
    uint8 private constant IS_PROVIDER = 1;      // 0000 0001
    uint8 private constant IS_LARGE_PROVIDER = 2; // 0000 0010
    uint256 public totalSmallProviders;
    uint256 public totalLargeProviders;
    uint256 public poolCounter;
    uint256 public dataPoolCreationTokens; // Amount needed to create a pool
    uint32 private constant MAX_MEMBERS = 1000;
    mapping(uint32 => uint256) public storageCostPerTBYear;

    // required to remove for loops to make gas fees predictable
    mapping(address => uint256) private userTotalRequiredLockedTokens;
    mapping(string => JoinRequest) private usersActiveJoinRequestByPeerID;
    mapping(uint256 => mapping(address => uint256)) private poolMemberIndices;

    function initialize(address _token, address initialOwner) public reinitializer(1) {
        require(_token != address(0), "Invalid token address");
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner); // Owner has admin role
        _grantRole(POOL_CREATOR_ROLE, initialOwner); // Assign initial roles
        _grantRole(ROLE_VERIFIER, initialOwner);
        token = StorageToken(_token);
        dataPoolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
    }

    function emergencyPausePool() external onlyOwner {
        require(block.timestamp >= lastEmergencyAction + EMERGENCY_COOLDOWN, "Cooldown active");
        lastEmergencyAction = block.timestamp;
        _pause();
        emit PoolEmergencyAction("Pool Contract paused", block.timestamp);
    }

    function emergencyUnpausePool() external onlyOwner {
        _unpause();
        emit PoolEmergencyAction("Pool Contract unpaused", block.timestamp);
    }

    modifier validatePoolId(uint32 poolId) {
        require(poolId < poolCounter, "Invalid pool ID");
        require(pools[poolId].creator != address(0), "Pool does not exist");
        _;
    }

    // This sets the number of tokens needed to be locked to be able to create a data pool for data storage
    function setDataPoolCreationTokens(uint256 _amount) external onlyOwner {
        dataPoolCreationTokens = _amount;
    }

    // Calculate the required number of locked tokens for a user address
    function calculateRequiredLockedTokens(address user) public view returns (uint256) {

        return userTotalRequiredLockedTokens[user];
    }

    // This method creates a data pool and sets the required information for the pool.
    // It locks the necessary tokens for pool creation and ensures only one pool can be created per token lock.
    function createDataPool(
        string memory name,
        string memory region,
        uint256 requiredTokens,
        uint256 minPingTime,
        uint256 maxChallengeResponsePeriod,
        string memory creatorPeerId
    ) external nonReentrant whenNotPaused {
        // Ensure the required tokens to join a pool do not exceed the pool creation tokens
        require(requiredTokens <= dataPoolCreationTokens, "Required tokens to join the pool exceed limit");

        // Check if the user has enough tokens to create a new pool
        require(token.balanceOf(msg.sender) >= dataPoolCreationTokens, "Insufficient tokens for pool creation");
        bytes32 actionHash = keccak256(abi.encodePacked("CREATE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash], "Timelock active");

        // Check if the user has enough locked tokens for the pools they have already created
        uint256 numberOfRequiredLockedTokens = calculateRequiredLockedTokens(msg.sender);
        require(lockedTokens[msg.sender] >= numberOfRequiredLockedTokens, "Locked tokens are not enough");

        // Validate that name, region, and minPingTime are not empty or invalid
        require(bytes(name).length > 0, "Pool name cannot be empty");
        require(bytes(region).length > 0, "Region cannot be empty");
        require(minPingTime > 0, "Minimum ping time must be greater than zero");

        // Set maxChallengeResponsePeriod: use provided value or default to 7 days if input is empty or zero
        if (maxChallengeResponsePeriod == 0) {
            maxChallengeResponsePeriod = 7 days; // Default value
        }

        // If poolCounter does not exist (uninitialized), default it to 0
        if (poolCounter == 0) {
            poolCounter = 0;
        }

        // Lock tokens for pool creation
        require(token.transferFrom(msg.sender, address(this), dataPoolCreationTokens), "Token transfer failed");
        lockedTokens[msg.sender] += dataPoolCreationTokens;

        // Initialize a new Pool struct
        Pool storage pool = pools[poolCounter];

        // Set pool properties
        pool.name = name; // Pool name provided by the user
        pool.id = poolCounter + 1; // Auto-incremented ID starting from 1
        pool.region = region; // Region provided by the user
        pool.creator = msg.sender; // Address of the creator
        pool.requiredTokens = requiredTokens; // Minimum tokens required to join
        pool.criteria.minPingTime = minPingTime; // Criteria for minimum ping time
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod; // Maximum period a storer can submit store claims without providing a challenge response

        // Add the creator as a member of the newly created pool using _addMember
        _addMember(uint32(poolCounter), creatorPeerId, msg.sender);

        // Increment the global counter for pools after successful creation
        poolCounter++;

        // Grant the POOL_CREATOR_ROLE to the caller
        _grantRole(POOL_CREATOR_ROLE, msg.sender);
        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;

        userTotalRequiredLockedTokens[msg.sender] += dataPoolCreationTokens;
        emit DataPoolCreated(pool.id, pool.name, pool.creator);
    }

    // This method allows the pool creator to delete their pool if no members other than themselves exist.
    // It also unlocks the tokens locked by the creator and removes all pending join requests.
    function deletePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];
        uint256 requiredTokensForPool = pool.requiredTokens;
        address creator = pool.creator;

        // Ensure only the pool creator or contract owner can delete the pool
        require(msg.sender == creator || msg.sender == owner(), "Not authorized");
        bytes32 actionHash = keccak256(abi.encodePacked("DELETE_POOL", msg.sender));
        require(block.timestamp >= poolActionTimeLocks[actionHash], "Timelock active");

        // If not the contract owner, ensure no members other than the creator exist
        if (msg.sender != owner()) {
            require(pool.memberList.length == 1, "Pool has active members");
            require(pool.memberList[0] == creator, "Only creator should remain in member list");
        }

        // Unlock the tokens locked by the pool creator and reset their balance
        // Calculate the total number of tokens this user needs to have locked so far
        uint256 requiredLockedTokens = calculateRequiredLockedTokens(creator);
        if (msg.sender != owner()) {
            require(lockedTokens[creator] >= requiredLockedTokens, "Insufficient locked tokens");
        }
        require(token.balanceOf(address(this)) >= dataPoolCreationTokens, "Contract has insufficient tokens");
        if (lockedTokens[creator] >= requiredLockedTokens) {
            require(token.transfer(creator, dataPoolCreationTokens), "Token transfer failed");
            lockedTokens[creator] -= dataPoolCreationTokens;
        }

        // Remove all pending join requests for this pool and refund their locked tokens
        while (joinRequests[poolId].length > 0) {
            JoinRequest storage request = joinRequests[poolId][joinRequests[poolId].length - 1];
            
            // Refund locked tokens to the user who submitted the join request
            uint256 requiredLockedTokensForUser = calculateRequiredLockedTokens(request.accountId);
            if (msg.sender != owner()) {
                require(lockedTokens[request.accountId] >= requiredLockedTokensForUser, "Insufficient locked tokens for join requests");
            }
            require(token.balanceOf(address(this)) >= requiredTokensForPool, "Contract has insufficient tokens");
            if (lockedTokens[request.accountId] >= requiredLockedTokensForUser) {
                require(token.transfer(request.accountId, requiredTokensForPool), "Token transfer failed");
                lockedTokens[request.accountId] -= requiredTokensForPool;
            }
            // Reduce required locked tokens for the removed joined request.
            if (userTotalRequiredLockedTokens[request.accountId] >= requiredTokensForPool){
                userTotalRequiredLockedTokens[request.accountId] -= requiredTokensForPool;
            } else {
                userTotalRequiredLockedTokens[request.accountId] = 0;
            }

            // Remove the join request from storage
            _removeJoinRequest(poolId, request.accountId);
        }

        // Clear all members from the member list and refund their locked tokens (if any)
        while (pool.memberList.length > 0) {
            address member = pool.memberList[pool.memberList.length - 1];
            uint256 requiredLockedTokensForUser = calculateRequiredLockedTokens(member);
            if (msg.sender != owner()) {
                require(lockedTokens[member] >= requiredLockedTokensForUser, "Insufficient locked tokens for pool member");
            }
            require(token.balanceOf(address(this)) >= requiredTokensForPool, "Contract has insufficient tokens");
            if (lockedTokens[member] >= requiredLockedTokensForUser && member != creator) {
                // Refund locked tokens to the member
                require(token.transfer(member, requiredTokensForPool), "Token transfer failed");
                lockedTokens[member] -= requiredTokensForPool;
            }
            if (member != creator){
                // Reduce required locked tokens for the removed pool member.
                if (userTotalRequiredLockedTokens[member] >= requiredTokensForPool){
                    userTotalRequiredLockedTokens[member] -= requiredTokensForPool;
                } else {
                    userTotalRequiredLockedTokens[member] = 0;
                }
            }

            _removeMemberFromList(pool.memberList, member, poolId);
            delete pool.members[member]; // Clear membership data from storage
        }

        // Revoke the POOL_CREATOR_ROLE from the pool creator
        _revokeRole(POOL_CREATOR_ROLE, creator);

        // Delete the pool itself
        delete pools[poolId];
        poolActionTimeLocks[actionHash] = block.timestamp + POOL_ACTION_DELAY;

        // Reduce required locked tokens for the pool creator.
        if (userTotalRequiredLockedTokens[creator] >= dataPoolCreationTokens){
            userTotalRequiredLockedTokens[creator] -= dataPoolCreationTokens;
        } else {
            userTotalRequiredLockedTokens[creator] = 0;
        }

        emit DataPoolDeleted(poolId, creator);
    }


    // This method allows a user to submit a request to join a data pool as a resource provider.
    // Each user can only send one join request at a time and can only be a member of one pool at a time.
    // A user cannot send a join request to the same pool they already have an active request for.
    // The total number of active members plus pending join requests for a pool cannot exceed MAX_MEMBERS.
    function submitJoinRequest(uint32 poolId, string memory peerId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        // Ensure the user does not have locked tokens for another pool
        require(lockedTokens[msg.sender] == 0, "Tokens already locked for another data pool");

        Pool storage pool = pools[poolId];

        // Ensure the pool exists
        require(pool.creator != address(0), "Data pool does not exist");

        // Ensure the user is not already a member of any pool
        require(pool.members[msg.sender].joinDate == 0, "Already a member");

        // Ensure the user has sufficient tokens to meet the required amount for this pool
        require(token.balanceOf(msg.sender) >= pool.requiredTokens, "Insufficient tokens");

        // Ensure the user does not already have an active join request for this pool
        JoinRequest[] storage requests = joinRequests[poolId];
        require(requestIndex[msg.sender] == 0, "User already has active requests");

        // Ensure the total number of active members plus pending join requests does not exceed MAX_MEMBERS
        require(pool.memberList.length + requests.length < MAX_MEMBERS, "Data pool has reached maximum capacity");

        // Lock the user's tokens for this join request
        require(token.transferFrom(msg.sender, address(this), pool.requiredTokens), "Token transfer failed");
        lockedTokens[msg.sender] += pool.requiredTokens;

        // Create and save the new join request
        uint256 newIndex = requests.length;
        requests.push(); // Push an empty slot first to save gas on array resizing

        JoinRequest storage newRequest = requests[newIndex];
        newRequest.peerId = peerId; // Set peer ID provided by the user
        newRequest.accountId = msg.sender; // Set the account ID of the requester
        newRequest.poolId = poolId; // Set the ID of the target pool
        newRequest.approvals = 0; // Initialize approvals count
        newRequest.rejections = 0; // Initialize rejections count

        JoinRequest storage peerRequest = usersActiveJoinRequestByPeerID[peerId];
        peerRequest.peerId = peerId;
        peerRequest.accountId = msg.sender;
        peerRequest.poolId = poolId;
        peerRequest.approvals = 0;
        peerRequest.rejections = 0;

        // Save the index of this request for efficient lookup during cancellation or management
        requestIndex[msg.sender] = newIndex;
        userTotalRequiredLockedTokens[msg.sender] += pool.requiredTokens;
        
        emit JoinRequestSubmitted(poolId, peerId, msg.sender);

    }

    function getStorageCost(uint32 poolId) external view override returns (uint256) {
        return storageCostPerTBYear[poolId];
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

    // This method allows a user to cancel their join request for a specific data pool.
    // Upon cancellation, the user's locked tokens are unlocked and refunded.
    // The join request is removed from storage efficiently to reduce gas costs.
    function cancelJoinRequest(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        require(poolId < poolCounter, "Invalid pool ID");
        // Retrieve the index of the user's join request from the mapping
        uint256 index = requestIndex[msg.sender];
        require(index > 0, "Request not found");
        // Validate that the index is within bounds of the joinRequests array for the specified pool
        require(index < joinRequests[poolId].length, "Invalid request");
        Pool storage pool = pools[poolId];

        // Unlock the user's tokens and reset their locked token balance
        uint256 lockedAmount = lockedTokens[msg.sender];
        require(lockedAmount >= pool.requiredTokens, "Not enough tokens locked");
        require(token.transfer(msg.sender, pool.requiredTokens), "Token transfer failed");
        lockedTokens[msg.sender] -= pool.requiredTokens;

        // Remove the join request from the pool's joinRequests array
        _removeJoinRequest(poolId, msg.sender);

        if(userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens){
            userTotalRequiredLockedTokens[msg.sender] -= pool.requiredTokens;
        } else {
            userTotalRequiredLockedTokens[msg.sender] = 0;
        }

        // Emit an event to log the cancellation of the join request
        emit JoinRequestCanceled(poolId, msg.sender);
    }

    // This method allows a member of a pool to leave the pool they are part of.
    // Upon leaving, the user's locked tokens are unlocked and refunded.
    // The pool creator cannot leave their own pool.
    function leavePool(uint32 poolId) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Ensure the caller is a member of the pool
        require(pool.members[msg.sender].joinDate > 0, "Not a member");

        // Prevent the pool creator from leaving their own pool
        require(msg.sender != pool.creator, "Pool creator cannot leave their own pool");

        // Unlock the user's locked tokens and reset their balance
        uint256 lockedAmount = lockedTokens[msg.sender];
        require(lockedAmount >= pool.requiredTokens, "Not enough tokens locked");
        require(token.transfer(msg.sender, pool.requiredTokens), "Token transfer failed");
        lockedTokens[msg.sender] -= pool.requiredTokens;

        // Remove the user from the member list efficiently
        _removeMemberFromList(pool.memberList, msg.sender, poolId);

        // Delete the user's membership data from storage
        delete pool.members[msg.sender];
        if (userTotalRequiredLockedTokens[msg.sender] >= pool.requiredTokens) {
            userTotalRequiredLockedTokens[msg.sender] -= pool.requiredTokens;
        } else {
            userTotalRequiredLockedTokens[msg.sender] = 0;
        }

        // Emit an event to log that the user has left the pool
        emit MemberLeft(poolId, msg.sender);
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    // The member's locked tokens are unlocked and refunded upon removal.
    function removeMember(uint32 poolId, address member) external nonReentrant whenNotPaused validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Ensure only the pool creator or contract owner can remove a member
        require(msg.sender == pool.creator || msg.sender == owner(), "Not authorized");

        // Ensure the member exists in the pool
        require(pool.members[member].joinDate > 0, "Not a member");

        // Prevent removing the pool creator themselves
        require(member != pool.creator, "Cannot remove the pool creator");

        // Unlock tokens locked by the member
        uint256 lockedAmount = lockedTokens[member];
        if (lockedAmount >= pool.requiredTokens) {
            require(token.transfer(member, pool.requiredTokens), "Token transfer failed");
            lockedTokens[member] -= pool.requiredTokens;
        }
        if (userTotalRequiredLockedTokens[member] >= pool.requiredTokens) {
            userTotalRequiredLockedTokens[member] -= pool.requiredTokens;
        } else {
            userTotalRequiredLockedTokens[member] = 0;
        }

        // Remove the member from the member list
        _removeMemberFromList(pool.memberList, member, poolId);

        // Clear membership data from storage
        delete pool.members[member];

        emit MemberRemoved(poolId, member, msg.sender);
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
        Member storage newMember = pool.members[accountId];
        newMember.joinDate = block.timestamp;
        newMember.peerId = peerId;
        newMember.accountId = accountId;
        newMember.reputationScore = 400;
        poolMemberIndices[poolId][accountId] = pool.memberList.length;
        pool.memberList.push(accountId);
        
        emit MemberJoined(poolId, accountId);
    }

    function _removeJoinRequest(uint32 poolId, address member) internal {
        // Retrieve the index of the user's join request from the mapping
        uint256 index = requestIndex[member];

        uint256 lastIndex = joinRequests[poolId].length - 1;
        joinRequests[poolId][index].peerId = joinRequests[poolId][lastIndex].peerId;
        joinRequests[poolId][index].accountId = joinRequests[poolId][lastIndex].accountId;
        joinRequests[poolId][index].poolId = joinRequests[poolId][lastIndex].poolId;
        joinRequests[poolId][index].approvals = joinRequests[poolId][lastIndex].approvals;
        joinRequests[poolId][index].rejections = joinRequests[poolId][lastIndex].rejections;
        joinRequests[poolId].pop();
        // Clear the user's request index mapping entry
        delete usersActiveJoinRequestByPeerID[joinRequests[poolId][index].peerId];
        delete requestIndex[member];
        requestIndex[joinRequests[poolId][lastIndex].accountId] = index;
    }

    // This method allows current members of a data pool to vote on a new join request.
    // If the number of approvals exceeds one-third of the total members or 10, the request is approved, and the user is added to the pool.
    // If more than half of the members reject the request, it is denied, and the user's locked tokens are refunded.
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

        // Iterate through join requests to find the one matching `peerIdToVote`
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
            if (
                request.approvals >= pool.memberList.length / 3 || 
                request.approvals >= 10
            ) {
                // Add the user as a member of the pool
                _addMember(poolId, request.peerId, request.accountId);

                // Remove the join request from storage
                _removeJoinRequest(poolId, request.accountId);
            }
        } else {
            // Increment rejection count
            request.rejections++;

            // Check if rejections meet the threshold for denial
            if (request.rejections >= pool.memberList.length / 2) {
                // Refund locked tokens to the user
                uint256 lockedAmount = lockedTokens[request.accountId];
                if (lockedAmount >= pool.requiredTokens) {
                    require(token.transfer(request.accountId, pool.requiredTokens), "Token transfer failed");
                    lockedTokens[request.accountId] -= pool.requiredTokens;
                }

                // Remove the join request from storage
                _removeJoinRequest(poolId, request.accountId);

                emit JoinRequestRejected(poolId, request.accountId);
            }
        }
    }

    // Set reputation implementation
    function setReputation(
        uint32 poolId,
        address member,
        uint8 score
    ) external nonReentrant whenNotPaused onlyRole(POOL_CREATOR_ROLE) {
        require(score <= 1000, "Score exceeds maximum");
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Not Authorized");
        require(pool.members[member].joinDate > 0, "Not a member");
        pool.members[member].reputationScore = score;
    }

    function isProviderActive(address provider) external view override returns (bool) {
        return (providerStatus[provider] & IS_PROVIDER) != 0;
    }
    function _isProviderActive(address provider) internal view returns (bool) {
        return (providerStatus[provider] & IS_PROVIDER) != 0;
    }

    function addProvider(address provider, uint256 storageSize) external nonReentrant onlyRole(ROLE_VERIFIER) {
        require(provider != address(0), "Invalid provider address");
        require(!_isProviderActive(provider), "Provider already exists");
        
        uint8 status = IS_PROVIDER; // Set provider bit
        bool isLarge = storageSize >= 2 ether;
        if (isLarge) {
            status |= IS_LARGE_PROVIDER; // Set large provider bit
            totalLargeProviders++;
        } else {
            totalSmallProviders++;
        }
        
        providerStatus[provider] = status;
        providerList.push(provider);
        
        emit ProviderAdded(provider, storageSize, isLarge);
    }

    // New optimized getProviderCounts
    function getProviderCounts() external view returns (uint256 smallProviders, uint256 largeProviders) {
        return (totalSmallProviders, totalLargeProviders);
    }

    function getAllProviders() external view returns (address[] memory) {
        return providerList;
    }  

    function isLargeProviderActive(address provider) external view returns (bool) {
        return (providerStatus[provider] & IS_LARGE_PROVIDER) != 0;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}