// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IStoragePool.sol";

contract StoragePool is IStoragePool, OwnableUpgradeable, UUPSUpgradeable {
    mapping(uint256 => Pool) public pools;
    mapping(uint256 => JoinRequest[]) public joinRequests;
    uint256 public poolCounter;

    function initialize() public initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
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
