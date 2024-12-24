// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IStoragePool.sol";
import "./StorageToken.sol";

contract StoragePool is IStoragePool, OwnableUpgradeable, UUPSUpgradeable {
    StorageToken public token;
    mapping(uint256 => Pool) public pools;
    mapping(uint256 => JoinRequest[]) public joinRequests;
    mapping(address => uint256) public lockedTokens;
    uint256 public poolCounter;
    uint256 public poolCreationTokens; // Amount needed to create a pool

    function initialize(address _token) public initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        token = StorageToken(_token);
        poolCreationTokens = 500_000 * 10**18; // 500K tokens with 18 decimals
    }

    function setPoolCreationTokens(uint256 _amount) external onlyOwner {
        poolCreationTokens = _amount;
    }

    function createPool(uint256 requiredTokens) external {
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

    function submitJoinRequest(uint256 poolId, string memory peerId) external {
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

    function cancelJoinRequest(uint256 poolId) external {
        JoinRequest[] storage requests = joinRequests[poolId];
        
        for (uint i = 0; i < requests.length; i++) {
            if (requests[i].accountId == msg.sender) {
                // Unlock tokens
                token.transfer(msg.sender, lockedTokens[msg.sender]);
                lockedTokens[msg.sender] = 0;
                _removeJoinRequest(poolId, i);
                break;
            }
        }
    }

    function leavePool(uint256 poolId) external {
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
        uint256 poolId,
        string memory peerId,
        address accountId
    ) internal {
        Pool storage pool = pools[poolId];
        Member storage newMember = pool.members[accountId];
        newMember.joinDate = block.timestamp;
        newMember.peerId = peerId;
        newMember.accountId = accountId;
        newMember.reputationScore = 0;
        pool.memberList.push(accountId);
        
        emit MemberJoined(poolId, accountId);
    }

    function _removeJoinRequest(uint256 poolId, uint256 index) internal {
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
        uint256 poolId,
        string memory peerIdToVote,
        bool approve
    ) external {
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0, "Not a pool member");
        
        JoinRequest[] storage requests = joinRequests[poolId];
        for (uint i = 0; i < requests.length; i++) {
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
        uint256 poolId,
        address member,
        uint256 score
    ) external {
        Pool storage pool = pools[poolId];
        require(msg.sender == pool.creator, "Only pool creator");
        require(pool.members[member].joinDate > 0, "Not a member");
        pool.members[member].reputationScore = score;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
