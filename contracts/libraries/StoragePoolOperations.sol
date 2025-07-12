// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/interfaces/IStoragePool.sol";
import "../core/StorageToken.sol";

/**
 * @title StoragePoolOperations
 * @dev Library to handle complex StoragePool operations
 * This reduces the main contract size by moving large functions here
 */
library StoragePoolOperations {
    
    event MemberRemoved(uint256 indexed poolId, address indexed member, string peerId);
    event JoinRequestCanceled(uint256 indexed poolId, address indexed requester, string peerId);
    event MemberLeft(uint256 indexed poolId, address indexed member, string peerId);
    event TokensUnlocked(address indexed user, uint256 amount);
    event TokensMarkedClaimable(address indexed user, uint256 amount);

    /**
     * @dev Remove members from pool in batches
     */
    function removeMembersBatch(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        mapping(uint256 => mapping(address => uint256)) storage poolMemberIndices,
        mapping(string => address) storage globalPeerIdToAccount,
        mapping(string => uint32) storage globalPeerIdToPool,
        StorageToken token,
        uint32 poolId,
        uint256 maxMembers,
        address caller,
        bool isAdmin
    ) internal {
        require(maxMembers > 0 && maxMembers <= 100);
        IStoragePool.Pool storage pool = pools[poolId];
        require(caller == pool.creator || isAdmin);
        require(pool.memberList.length > 0);

        uint256 removedCount = 0;
        for (uint256 i = 0; i < pool.memberList.length && removedCount < maxMembers; ) {
            if (gasleft() < 60000) break;
            address member = pool.memberList[i];

            if (member != pool.creator) {
                // Remove member's peer IDs from global mappings
                string[] memory memberPeerIds = pool.memberPeerIds[member];
                for (uint256 j = 0; j < memberPeerIds.length; j++) {
                    delete globalPeerIdToAccount[memberPeerIds[j]];
                    delete globalPeerIdToPool[memberPeerIds[j]];
                    delete pool.peerIdToMember[memberPeerIds[j]];
                }

                // Remove member data
                delete pool.members[member];
                delete pool.memberPeerIds[member];
                delete poolMemberIndices[poolId][member];

                // Process refund
                uint256 lockedAmount = lockedTokens[member];
                if ((pool.members[member].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens) {
                    uint256 refundAmount = pool.requiredTokens;
                    lockedTokens[member] -= refundAmount;
                    if (userTotalRequiredLockedTokens[member] >= refundAmount) {
                        userTotalRequiredLockedTokens[member] -= refundAmount;
                    }

                    // Try direct transfer, fallback to claimable
                    uint256 contractBalance = token.balanceOf(address(this));
                    if (contractBalance >= refundAmount) {
                        if (safeTokenTransfer(transferLocks, token, member, refundAmount)) {
                            emit TokensUnlocked(member, refundAmount);
                        } else {
                            claimableTokens[member] += refundAmount;
                            emit TokensMarkedClaimable(member, refundAmount);
                        }
                    } else {
                        claimableTokens[member] += refundAmount;
                        emit TokensMarkedClaimable(member, refundAmount);
                    }
                }

                // Remove from member list
                _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], member);
                
                for (uint256 k = 0; k < memberPeerIds.length; k++) {
                    emit MemberRemoved(poolId, member, memberPeerIds[k]);
                }
                
                removedCount++;
            } else {
                i++;
            }
        }
    }

    /**
     * @dev Cancel join request and refund tokens
     */
    function cancelJoinRequest(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(address => uint256) storage requestIndex,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        mapping(string => address) storage globalPeerIdToAccount,
        StorageToken token,
        uint32 poolId,
        address caller
    ) internal {
        uint256 index = requestIndex[caller];
        require(index > 0 && index <= joinRequests[poolId].length);

        IStoragePool.Pool storage pool = pools[poolId];
        string memory requestPeerId = joinRequests[poolId][index - 1].peerId;
        delete globalPeerIdToAccount[requestPeerId];
        
        // Remove join request
        _removeJoinRequest(joinRequests, requestIndex, poolId, caller);
        
        // Refund tokens
        _refundTokens(lockedTokens, userTotalRequiredLockedTokens, claimableTokens, transferLocks, token, caller, pool.requiredTokens);

        emit JoinRequestCanceled(poolId, caller, requestPeerId);
    }

    /**
     * @dev Leave pool and refund tokens
     */
    function leavePool(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        mapping(uint256 => mapping(address => uint256)) storage poolMemberIndices,
        mapping(string => address) storage globalPeerIdToAccount,
        mapping(string => uint32) storage globalPeerIdToPool,
        StorageToken token,
        uint32 poolId,
        address caller
    ) internal {
        IStoragePool.Pool storage pool = pools[poolId];
        require(pool.members[caller].joinDate > 0 && caller != pool.creator);

        uint256 lockedAmount = lockedTokens[caller];
        uint256 refundAmount = 0;

        if ((pool.members[caller].statusFlags & 0x01) == 0 && lockedAmount >= pool.requiredTokens && userTotalRequiredLockedTokens[caller] >= pool.requiredTokens) {
            refundAmount = pool.requiredTokens;
            lockedTokens[caller] -= refundAmount;
            if (userTotalRequiredLockedTokens[caller] >= refundAmount) {
                userTotalRequiredLockedTokens[caller] -= refundAmount;
            }
        }

        // Get peer IDs before removal for event emission
        string[] memory memberPeerIds = pool.memberPeerIds[caller];

        // Remove member's peer IDs from global mappings
        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            delete globalPeerIdToAccount[memberPeerIds[i]];
            delete globalPeerIdToPool[memberPeerIds[i]];
            delete pool.peerIdToMember[memberPeerIds[i]];
        }

        // Remove member data
        delete pool.members[caller];
        delete pool.memberPeerIds[caller];

        // Remove from member list
        _removeMemberFromList(pool.memberList, poolMemberIndices[poolId], caller);

        // Process refund if applicable
        if (refundAmount > 0) {
            uint256 contractBalance = token.balanceOf(address(this));
            if (contractBalance >= refundAmount) {
                if (safeTokenTransfer(transferLocks, token, caller, refundAmount)) {
                    emit TokensUnlocked(caller, refundAmount);
                } else {
                    claimableTokens[caller] += refundAmount;
                    emit TokensMarkedClaimable(caller, refundAmount);
                }
            } else {
                claimableTokens[caller] += refundAmount;
                emit TokensMarkedClaimable(caller, refundAmount);
            }
        }

        // Emit events for each peer ID
        for (uint256 i = 0; i < memberPeerIds.length; i++) {
            emit MemberLeft(poolId, caller, memberPeerIds[i]);
        }
    }

    /**
     * @dev Internal helper functions
     */
    function _removeJoinRequest(
        mapping(uint32 => IStoragePool.JoinRequest[]) storage joinRequests,
        mapping(address => uint256) storage requestIndex,
        uint32 poolId,
        address member
    ) internal {
        uint256 index = requestIndex[member];
        require(index > 0 && joinRequests[poolId].length > 0);

        uint256 arrayIndex = index - 1;
        uint256 lastArrayIndex = joinRequests[poolId].length - 1;

        if (arrayIndex != lastArrayIndex) {
            IStoragePool.JoinRequest storage lastRequest = joinRequests[poolId][lastArrayIndex];
            IStoragePool.JoinRequest storage currentRequest = joinRequests[poolId][arrayIndex];
            currentRequest.accountId = lastRequest.accountId;
            currentRequest.peerId = lastRequest.peerId;
            currentRequest.poolId = lastRequest.poolId;
            requestIndex[lastRequest.accountId] = index;
        }

        joinRequests[poolId].pop();
        delete requestIndex[member];
    }

    function _removeMemberFromList(
        address[] storage memberList,
        mapping(address => uint256) storage memberIndices,
        address member
    ) internal {
        uint256 memberIndex = memberIndices[member];
        require(memberIndex < memberList.length);
        address lastMember = memberList[memberList.length - 1];
        memberList[memberIndex] = lastMember;
        memberIndices[lastMember] = memberIndex;
        memberList.pop();
        delete memberIndices[member];
    }

    function _refundTokens(
        mapping(address => uint256) storage lockedTokens,
        mapping(address => uint256) storage userTotalRequiredLockedTokens,
        mapping(address => uint256) storage claimableTokens,
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address user,
        uint256 amount
    ) internal {
        uint256 lockedAmount = lockedTokens[user];
        if (lockedAmount >= amount) {
            lockedTokens[user] -= amount;
            if (userTotalRequiredLockedTokens[user] >= amount) {
                userTotalRequiredLockedTokens[user] -= amount;
            }
            if (safeTokenTransfer(transferLocks, token, user, amount)) {
                emit TokensUnlocked(user, amount);
            } else {
                claimableTokens[user] += amount;
                emit TokensMarkedClaimable(user, amount);
            }
        }
    }

    function safeTokenTransfer(
        mapping(address => bool) storage transferLocks,
        StorageToken token,
        address to,
        uint256 amount
    ) internal returns (bool) {
        if (transferLocks[to] || amount == 0) return false;
        
        transferLocks[to] = true;
        try token.transfer(to, amount) returns (bool success) {
            transferLocks[to] = false;
            return success;
        } catch {
            transferLocks[to] = false;
            return false;
        }
    }
}
