// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./interfaces/IStoragePool.sol";
import "./StorageToken.sol";

contract StoragePool is IStoragePool, OwnableUpgradeable, UUPSUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, AccessControlUpgradeable {
    uint256 public constant IMPLEMENTATION_VERSION = 1;
    bytes32 public constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");
    StorageToken public token;
    mapping(uint256 => Pool) public pools;
    mapping(uint32 => JoinRequest[]) public joinRequests;
    mapping(address => uint256) public lockedTokens;
    mapping(address => uint256) public requestIndex;
    uint256 public poolCounter;
    uint256 public dataPoolCreationTokens; // Amount needed to create a pool
    uint32 private constant MAX_MEMBERS = 1000;
    mapping(uint32 => uint256) public storageCostPerTBYear;

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
        token = StorageToken(_token);
        dataPoolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
    }

    function emergencyPausePool() external onlyOwner {
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
        uint256 requiredLockedTokens = 0;

        // Calculate the number of pools the user created
        uint256 userCreatedPools = 0;
        for (uint256 i = 0; i < poolCounter; i++) {
            if (pools[i].creator == user) {
                userCreatedPools++;
            }
        }
        requiredLockedTokens += userCreatedPools * dataPoolCreationTokens;

        // Calculate the number of pools the user is a member of (except the ones they created)
        for (uint256 i = 0; i < poolCounter; i++) {
            if (pools[i].members[user].joinDate > 0 && pools[i].creator != user) {
                requiredLockedTokens += pools[i].requiredTokens;
            }
        }

        // Calculate the number of join requests the user has made
        for (uint32 i = 0; i < poolCounter; i++) {
            for (uint32 j = 0; j < joinRequests[i].length; j++) {
                if (joinRequests[i][j].accountId == user) {
                    requiredLockedTokens += pools[i].requiredTokens;
                }
            }
        }

        return requiredLockedTokens;
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
    ) external nonReentrant {
        // Ensure the required tokens to join a pool do not exceed the pool creation tokens
        require(requiredTokens <= dataPoolCreationTokens, "Required tokens to join the pool exceed limit");

        // Check if the user has enough tokens to create a new pool
        require(token.balanceOf(msg.sender) >= dataPoolCreationTokens, "Insufficient tokens for pool creation");

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
        token.transferFrom(msg.sender, address(this), dataPoolCreationTokens);
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

        emit DataPoolCreated(pool.id, pool.name, pool.creator);
    }

    // This method allows the pool creator to delete their pool if no members other than themselves exist.
    // It also unlocks the tokens locked by the creator and removes all pending join requests.
    function deletePool(uint32 poolId) external nonReentrant validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Ensure only the pool creator or contract owner can delete the pool
        require(msg.sender == pool.creator || msg.sender == owner(), "Not authorized");

        // If not the contract owner, ensure no members other than the creator exist
        if (msg.sender != owner()) {
            require(pool.memberList.length == 1, "Pool has active members");
            require(pool.memberList[0] == pool.creator, "Only creator should remain in member list");
        }

        // Unlock the tokens locked by the pool creator and reset their balance
        // Calculate the total number of tokens this user needs to have locked so far
        uint256 requiredLockedTokens = calculateRequiredLockedTokens(pool.creator);
        if (msg.sender != owner()) {
            require(lockedTokens[pool.creator] >= requiredLockedTokens, "Insufficient locked tokens");
        }
        require(token.balanceOf(address(this)) >= dataPoolCreationTokens, "Contract has insufficient tokens");
        if (lockedTokens[pool.creator] >= requiredLockedTokens) {
            token.transfer(pool.creator, dataPoolCreationTokens);
            lockedTokens[pool.creator] -= dataPoolCreationTokens;
        }

        // Remove all pending join requests for this pool and refund their locked tokens
        while (joinRequests[poolId].length > 0) {
            JoinRequest storage request = joinRequests[poolId][joinRequests[poolId].length - 1];
            
            // Refund locked tokens to the user who submitted the join request
            uint256 requiredLockedTokensForUser = calculateRequiredLockedTokens(request.accountId);
            if (msg.sender != owner()) {
                require(lockedTokens[request.accountId] >= requiredLockedTokensForUser, "Insufficient locked tokens for join requests");
            }
            require(token.balanceOf(address(this)) >= pool.requiredTokens, "Contract has insufficient tokens");
            if (lockedTokens[request.accountId] >= requiredLockedTokensForUser) {
                token.transfer(request.accountId, pool.requiredTokens);
                lockedTokens[request.accountId] -= pool.requiredTokens;
            }

            // Remove the join request from storage
            _removeJoinRequest(poolId, joinRequests[poolId].length - 1);
        }

        // Clear all members from the member list and refund their locked tokens (if any)
        while (pool.memberList.length > 0) {
            address member = pool.memberList[pool.memberList.length - 1];
            uint256 requiredLockedTokensForUser = calculateRequiredLockedTokens(member);
            if (msg.sender != owner()) {
                require(lockedTokens[member] >= requiredLockedTokensForUser, "Insufficient locked tokens for pool member");
            }
            require(token.balanceOf(address(this)) >= pool.requiredTokens, "Contract has insufficient tokens");
            if (lockedTokens[member] >= requiredLockedTokensForUser && member != pool.creator) {
                // Refund locked tokens to the member
                token.transfer(member, pool.requiredTokens);
                lockedTokens[member] -= pool.requiredTokens;
            }

            _removeMemberFromList(pool.memberList, member);
            delete pool.members[member]; // Clear membership data from storage
        }

        // Delete the pool itself
        delete pools[poolId];

        emit DataPoolDeleted(poolId, msg.sender);
    }


    // This method allows a user to submit a request to join a data pool as a resource provider.
    // Each user can only send one join request at a time and can only be a member of one pool at a time.
    // A user cannot send a join request to the same pool they already have an active request for.
    // The total number of active members plus pending join requests for a pool cannot exceed MAX_MEMBERS.
    function submitJoinRequest(uint32 poolId, string memory peerId) external nonReentrant validatePoolId(poolId) {
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
        for (uint256 i = 0; i < requests.length; i++) {
            require(requests[i].accountId != msg.sender, "Already submitted a join request for this data pool");
        }

        // Ensure the total number of active members plus pending join requests does not exceed MAX_MEMBERS
        require(pool.memberList.length + requests.length < MAX_MEMBERS, "Data pool has reached maximum capacity");

        // Lock the user's tokens for this join request
        token.transferFrom(msg.sender, address(this), pool.requiredTokens);
        lockedTokens[msg.sender] = pool.requiredTokens;

        // Create and save the new join request
        uint256 newIndex = requests.length;
        requests.push(); // Push an empty slot first to save gas on array resizing

        JoinRequest storage newRequest = requests[newIndex];
        newRequest.peerId = peerId; // Set peer ID provided by the user
        newRequest.accountId = msg.sender; // Set the account ID of the requester
        newRequest.poolId = poolId; // Set the ID of the target pool
        newRequest.approvals = 0; // Initialize approvals count
        newRequest.rejections = 0; // Initialize rejections count

        // Save the index of this request for efficient lookup during cancellation or management
        requestIndex[msg.sender] = newIndex;

        emit JoinRequestSubmitted(poolId, peerId, msg.sender);
    }

    function getStorageCost(uint32 poolId) external view override returns (uint256) {
        return storageCostPerTBYear[poolId];
    }

    // Function to set the storage cost per pool
    function setStorageCost(uint32 poolId, uint256 costPerTBYear) external nonReentrant onlyRole(POOL_CREATOR_ROLE) {
        require(costPerTBYear > 0, "Invalid cost");
        require(costPerTBYear <= type(uint256).max / 365, "Overflow risk"); // Prevent overflow
        storageCostPerTBYear[poolId] = costPerTBYear; // Set the cost for the specified pool
        emit StorageCostSet(poolId, costPerTBYear); // Emit event with poolId
    }

    // This method allows a user to cancel their join request for a specific data pool.
    // Upon cancellation, the user's locked tokens are unlocked and refunded.
    // The join request is removed from storage efficiently to reduce gas costs.
    function cancelJoinRequest(uint32 poolId) external nonReentrant validatePoolId(poolId) {
        // Retrieve the index of the user's join request from the mapping
        uint256 index = requestIndex[msg.sender];

        // Validate that the index is within bounds of the joinRequests array for the specified pool
        require(index < joinRequests[poolId].length, "Invalid request");

        // Unlock the user's tokens and reset their locked token balance
        uint256 lockedAmount = lockedTokens[msg.sender];
        require(lockedAmount > 0, "No tokens locked");
        token.transfer(msg.sender, lockedAmount);
        lockedTokens[msg.sender] = 0;

        // Remove the join request from the pool's joinRequests array
        _removeJoinRequest(poolId, index);

        // Clear the user's request index mapping entry
        delete requestIndex[msg.sender];

        // Emit an event to log the cancellation of the join request
        emit JoinRequestCanceled(poolId, msg.sender);
    }

    // This method allows a member of a pool to leave the pool they are part of.
    // Upon leaving, the user's locked tokens are unlocked and refunded.
    // The pool creator cannot leave their own pool.
    function leavePool(uint32 poolId) external nonReentrant validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Ensure the caller is a member of the pool
        require(pool.members[msg.sender].joinDate > 0, "Not a member");

        // Prevent the pool creator from leaving their own pool
        require(msg.sender != pool.creator, "Pool creator cannot leave their own pool");

        // Unlock the user's locked tokens and reset their balance
        uint256 lockedAmount = lockedTokens[msg.sender];
        require(lockedAmount > 0, "No tokens locked");
        token.transfer(msg.sender, lockedAmount);
        lockedTokens[msg.sender] = 0;

        // Remove the user from the member list efficiently
        _removeMemberFromList(pool.memberList, msg.sender);

        // Delete the user's membership data from storage
        delete pool.members[msg.sender];

        // Emit an event to log that the user has left the pool
        emit MemberLeft(poolId, msg.sender);
    }

    // This method allows the pool creator or contract owner to remove a member from the pool.
    // The member's locked tokens are unlocked and refunded upon removal.
    function removeMember(uint32 poolId, address member) external nonReentrant validatePoolId(poolId) {
        Pool storage pool = pools[poolId];

        // Ensure only the pool creator or contract owner can remove a member
        require(msg.sender == pool.creator || msg.sender == owner(), "Not authorized");

        // Ensure the member exists in the pool
        require(pool.members[member].joinDate > 0, "Not a member");

        // Prevent removing the pool creator themselves
        require(member != pool.creator, "Cannot remove the pool creator");

        // Unlock tokens locked by the member
        uint256 lockedAmount = lockedTokens[member];
        if (lockedAmount > 0) {
            token.transfer(member, lockedAmount);
            lockedTokens[member] = 0;
        }

        // Remove the member from the member list
        _removeMemberFromList(pool.memberList, member);

        // Clear membership data from storage
        delete pool.members[member];

        emit MemberRemoved(poolId, member, msg.sender);
    }

    // Internal function to efficiently remove a member from the member list.
    // This function swaps the target member with the last member in the list and then pops it.
    function _removeMemberFromList(address[] storage memberList, address member) internal {
        uint256 length = memberList.length;
        
        for (uint256 i = 0; i < length; i++) {
            if (memberList[i] == member) {
                // Swap with last element and pop to remove efficiently
                memberList[i] = memberList[length - 1];
                memberList.pop();
                return;
            }
        }

        // If we reach here, something went wrong (this should never happen if validations are correct)
        revert("Member not found in list");
    }

    function _addMember(
        uint32 poolId,
        string memory peerId,
        address accountId
    ) internal {
        require(accountId != address(0), "Invalid account ID");
        Pool storage pool = pools[poolId];
        require(pool.memberList.length <= MAX_MEMBERS, "Pool is full");
        Member storage newMember = pool.members[accountId];
        newMember.joinDate = block.timestamp;
        newMember.peerId = peerId;
        newMember.accountId = accountId;
        newMember.reputationScore = 400;
        pool.memberList.push(accountId);
        
        emit MemberJoined(poolId, accountId);
    }

    function _removeJoinRequest(uint32 poolId, uint256 index) internal {
        uint256 lastIndex = joinRequests[poolId].length - 1;
        joinRequests[poolId][index].peerId = joinRequests[poolId][lastIndex].peerId;
        joinRequests[poolId][index].accountId = joinRequests[poolId][lastIndex].accountId;
        joinRequests[poolId][index].poolId = joinRequests[poolId][lastIndex].poolId;
        joinRequests[poolId][index].approvals = joinRequests[poolId][lastIndex].approvals;
        joinRequests[poolId][index].rejections = joinRequests[poolId][lastIndex].rejections;
        joinRequests[poolId].pop();
    }

    // This method allows current members of a data pool to vote on a new join request.
    // If the number of approvals exceeds one-third of the total members or 10, the request is approved, and the user is added to the pool.
    // If more than half of the members reject the request, it is denied, and the user's locked tokens are refunded.
    function voteOnJoinRequest(
        uint32 poolId,
        string memory peerIdToVote,
        bool approve
    ) external nonReentrant validatePoolId(poolId) {
        require(bytes(peerIdToVote).length > 0, "Invalid peer ID");

        Pool storage pool = pools[poolId];

        // Ensure the voter is a member of the pool
        require(pool.members[msg.sender].joinDate > 0, "Not a pool member");

        JoinRequest[] storage requests = joinRequests[poolId];
        uint256 requestsLength = requests.length;

        // Iterate through join requests to find the one matching `peerIdToVote`
        for (uint256 i = 0; i < requestsLength; i++) {
            if (keccak256(bytes(requests[i].peerId)) == keccak256(bytes(peerIdToVote))) {
                JoinRequest storage request = requests[i];

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
                        _removeJoinRequest(poolId, i);
                    }
                } else {
                    // Increment rejection count
                    request.rejections++;

                    // Check if rejections meet the threshold for denial
                    if (request.rejections >= pool.memberList.length / 2) {
                        // Refund locked tokens to the user
                        token.transfer(request.accountId, lockedTokens[request.accountId]);
                        lockedTokens[request.accountId] = 0;

                        // Remove the join request from storage
                        _removeJoinRequest(poolId, i);

                        emit JoinRequestRejected(poolId, request.accountId);
                    }
                }

                return; // Exit after processing the vote to save gas
            }
        }

        revert("Join request not found");
    }

    // Set reputation implementation
    function setReputation(
        uint32 poolId,
        address member,
        uint8 score
    ) external onlyRole(POOL_CREATOR_ROLE) {
        require(score <= 1000, "Score exceeds maximum");
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Only pool creator");
        require(pool.members[member].joinDate > 0, "Not a member");
        pool.members[member].reputationScore = score;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}
