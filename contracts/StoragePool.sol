// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./interfaces/IStoragePool.sol";
import "./StorageToken.sol";

contract StoragePool is IStoragePool, OwnableUpgradeable, UUPSUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable, AccessControlUpgradeable {
    uint256 public constant IMPLEMENTATION_VERSION = 1;
    bytes32 public constant POOL_CREATOR_ROLE = keccak256("POOL_CREATOR_ROLE");
    StorageToken public token;
    mapping(uint256 => Pool) public pools;
    mapping(uint256 => JoinRequest[]) public joinRequests;
    mapping(address => uint256) public lockedTokens;
    mapping(address => uint256) public requestIndex;
    uint256 public poolCounter;
    uint256 public poolCreationTokens; // Amount needed to create a pool
    uint256 private constant MAX_MEMBERS = 1000;

    function initialize(address _token) public reinitializer(1) {
        require(_token != address(0), "Invalid token address");
        __Ownable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender); // Owner has admin role
        _setupRole(POOL_CREATOR_ROLE, msg.sender); // Assign initial roles
        token = StorageToken(_token);
        poolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
    }

    function emergencyPause() external onlyOwner {
        _pause();
        emit EmergencyAction("Contract paused", block.timestamp);
    }

    function emergencyUnpause() external onlyOwner {
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp);
    }

    modifier validatePoolId(uint32 poolId) {
        require(poolId < poolCounter, "Invalid pool ID");
        require(pools[poolId].creator != address(0), "Pool does not exist");
        _;
    }

    function setPoolCreationTokens(uint256 _amount) external onlyOwner {
        poolCreationTokens = _amount;
    }

    function createPool(uint256 requiredTokens) external nonReentrant {
        require(requiredTokens <= poolCreationTokens, "Required tokens exceed limit");
        require(token.balanceOf(msg.sender) >= poolCreationTokens, "Insufficient tokens for pool creation");
        
        // Lock tokens for pool creation
        token.transferFrom(msg.sender, address(this), poolCreationTokens);
        lockedTokens[msg.sender] = poolCreationTokens;

        Pool storage pool = pools[poolCounter];
        pool.creator = msg.sender;
        pool.requiredTokens = requiredTokens;
        poolCounter++;
    }

    function submitJoinRequest(uint32 poolId, string memory peerId) external nonReentrant validatePoolId(poolId) {
        require(lockedTokens[msg.sender] == 0, "Tokens already locked");
        Pool storage pool = pools[poolId];
        require(pool.creator != address(0), "Pool does not exist");
        require(pool.members[msg.sender].joinDate == 0, "Already a member");
        require(token.balanceOf(msg.sender) >= pool.requiredTokens, "Insufficient tokens");
        
        // Lock tokens
        token.transferFrom(msg.sender, address(this), pool.requiredTokens);
        lockedTokens[msg.sender] = pool.requiredTokens;

        // Create new request and set properties individually
        JoinRequest[] storage requests = joinRequests[poolId];
        uint256 newIndex = requests.length;
        requests.push(); // Push empty request first
        
        // Then set the values
        requests[newIndex].peerId = peerId;
        requests[newIndex].accountId = msg.sender;
        requests[newIndex].poolId = poolId;
        requests[newIndex].approvals = 0;
        requests[newIndex].rejections = 0;
    }

    function cancelJoinRequest(uint32 poolId) external nonReentrant {
        uint256 index = requestIndex[msg.sender];
        require(index < joinRequests[poolId].length, "Invalid request");
        
        // Unlock tokens and remove request efficiently
        token.transfer(msg.sender, lockedTokens[msg.sender]);
        lockedTokens[msg.sender] = 0;
        
        _removeJoinRequest(poolId, index);
    }

    function leavePool(uint32 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0, "Not a member");
        
        // Remove from member list
        for (uint i = 0; i < pool.memberList.length; i++) {
            if (pool.memberList[i] == msg.sender) {
                pool.memberList[i] = pool.memberList[pool.memberList.length - 1];
                pool.memberList.pop();
                break;
            }
        }
        
        // Unlock tokens
        token.transfer(msg.sender, lockedTokens[msg.sender]);
        lockedTokens[msg.sender] = 0;
        delete pool.members[msg.sender];
        
        emit MemberLeft(poolId, msg.sender);
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
        newMember.reputationScore = 0;
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

    // Vote on pool join request implementation
    function voteOnJoinRequest(
        uint32 poolId,
        string memory peerIdToVote,
        bool approve
    ) external nonReentrant {
        require(bytes(peerIdToVote).length > 0, "Invalid peer ID");
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0, "Not a pool member");
        
        JoinRequest[] storage requests = joinRequests[poolId];
        uint256 requestsLength = requests.length;
        for (uint i = 0; i < requestsLength; i++) {
            if (keccak256(bytes(requests[i].peerId)) == keccak256(bytes(peerIdToVote))) {
                if (!requests[i].votes[msg.sender]) {
                    if (approve) {
                        requests[i].approvals++;
                        if (requests[i].approvals >= pool.memberList.length / 3 || 
                            requests[i].approvals >= 10) {
                            _addMember(poolId, requests[i].peerId, requests[i].accountId);
                        }
                    } else {
                        requests[i].rejections++;
                        if (requests[i].rejections >= pool.memberList.length / 2) {
                            _removeJoinRequest(poolId, i);
                        }
                    }
                    requests[i].votes[msg.sender] = true;
                }
                break;
            }
        }
    }

    // Set reputation implementation
    function setReputation(
        uint32 poolId,
        address member,
        uint8 score
    ) external onlyRole(POOL_CREATOR_ROLE) {
        require(score <= 100, "Score exceeds maximum");
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Only pool creator");
        require(pool.members[member].joinDate > 0, "Not a member");
        pool.members[member].reputationScore = score;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}
