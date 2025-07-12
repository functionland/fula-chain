// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/interfaces/IStoragePool.sol";
import "../core/StorageToken.sol";

/**
 * @title StoragePoolExtensions
 * @dev Extension library to reduce StoragePool main contract size
 * This library handles complex operations that don't require deep pools access
 */
library StoragePoolExtensions {
    
    /**
     * @dev Check if an address is a member of any pool
     * @param pools The pools mapping from main contract
     * @param poolCounter Total number of pools
     * @param member Address to check
     * @return true if the address is a member of any pool
     */
    function isMemberOfAnyPool(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        uint256 poolCounter,
        address member
    ) internal view returns (bool) {
        for (uint32 i = 1; i <= poolCounter; i++) {
            if (pools[i].creator != address(0) && pools[i].members[member].joinDate > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * @dev Get total number of unique members across all pools
     * @param pools The pools mapping from main contract
     * @param poolCounter Total number of pools
     * @return Total number of unique members across all pools
     */
    function getTotalMembers(
        mapping(uint256 => IStoragePool.Pool) storage pools,
        uint256 poolCounter
    ) internal view returns (uint256) {
        uint256 totalMembers = 0;
        for (uint32 i = 1; i <= poolCounter; i++) {
            if (pools[i].creator != address(0)) {
                totalMembers += pools[i].memberList.length;
            }
        }
        return totalMembers;
    }

    /**
     * @dev Get paginated list of pool members
     * @param pool The specific pool
     * @param offset Starting index for pagination
     * @param limit Maximum number of members to return
     * @return members Array of member addresses
     * @return hasMore Whether there are more members beyond this page
     */
    function getPoolMembers(
        IStoragePool.Pool storage pool,
        uint256 offset,
        uint256 limit
    ) internal view returns (address[] memory members, bool hasMore) {
        uint256 totalMembers = pool.memberList.length;
        require(offset < totalMembers);

        uint256 end = offset + limit;
        if (end > totalMembers) {
            end = totalMembers;
        }

        members = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            members[i - offset] = pool.memberList[i];
        }

        hasMore = end < totalMembers;
    }

    /**
     * @dev Get member reputation with validation
     * @param pool The specific pool
     * @param member Member address
     * @return exists Whether member exists
     * @return reputationScore Member's reputation score
     * @return joinDate When member joined
     * @return peerId Member's peer ID (first one if multiple)
     */
    function getMemberReputation(
        IStoragePool.Pool storage pool,
        address member
    ) internal view returns (
        bool exists,
        uint16 reputationScore,
        uint256 joinDate,
        string memory peerId
    ) {
        joinDate = pool.members[member].joinDate;
        exists = (joinDate > 0);
        if (exists) {
            reputationScore = pool.members[member].reputationScore;
            string[] memory peerIds = pool.memberPeerIds[member];
            peerId = peerIds.length > 0 ? peerIds[0] : "";
        }
    }

    /**
     * @dev Get member reputation with all peer IDs
     * @param pool The specific pool
     * @param member Member address
     * @return exists Whether member exists
     * @return reputationScore Member's reputation score
     * @return joinDate When member joined
     * @return peerIds All peer IDs for this member
     */
    function getMemberReputationMultiPeer(
        IStoragePool.Pool storage pool,
        address member
    ) internal view returns (
        bool exists,
        uint16 reputationScore,
        uint256 joinDate,
        string[] memory peerIds
    ) {
        joinDate = pool.members[member].joinDate;
        exists = (joinDate > 0);
        if (exists) {
            reputationScore = pool.members[member].reputationScore;
            peerIds = pool.memberPeerIds[member];
        }
    }

    /**
     * @dev Validate pool creation parameters
     * @param name Pool name
     * @param region Pool region
     * @param creatorPeerId Creator's peer ID
     * @param requiredTokens Required tokens
     * @param minPingTime Minimum ping time
     * @param dataPoolCreationTokens Maximum allowed tokens
     */
    function validatePoolCreation(
        string memory name,
        string memory region,
        string memory creatorPeerId,
        uint256 requiredTokens,
        uint256 minPingTime,
        uint256 dataPoolCreationTokens
    ) internal pure {
        require(
            bytes(name).length > 0 &&
            bytes(region).length > 0 &&
            bytes(creatorPeerId).length > 0 &&
            requiredTokens > 0 &&
            minPingTime > 0 &&
            requiredTokens <= dataPoolCreationTokens
        );
    }

    /**
     * @dev Validate join request parameters
     * @param pool The pool to join
     * @param peerId Peer ID for the request
     * @param requester Address making the request
     * @param bannedUsers Mapping of banned users
     * @param requestIndex Current request index for user
     * @param token Storage token contract
     * @param joinRequests Current join requests for pool
     */
    function validateJoinRequest(
        IStoragePool.Pool storage pool,
        string memory peerId,
        address requester,
        mapping(address => bool) storage bannedUsers,
        uint256 requestIndex,
        StorageToken token,
        IStoragePool.JoinRequest[] storage joinRequests
    ) internal view {
        require(
            pool.creator != address(0) &&
            pool.peerIdToMember[peerId] == address(0) &&
            !bannedUsers[requester] &&
            requestIndex == 0 &&
            token.balanceOf(requester) >= pool.requiredTokens &&
            pool.memberList.length + joinRequests.length < 1000
        );
    }

    /**
     * @dev Validate member removal
     * @param pool The pool
     * @param member Member to remove
     * @param caller Address calling the function
     * @param isAdmin Whether caller is admin
     */
    function validateMemberRemoval(
        IStoragePool.Pool storage pool,
        address member,
        address caller,
        bool isAdmin
    ) internal view {
        require(
            (caller == pool.creator || isAdmin) &&
            pool.members[member].joinDate > 0 &&
            member != pool.creator
        );
    }

    /**
     * @dev Validate storage cost setting
     * @param costPerTBYear Cost per TB per year
     * @param poolCreator Pool creator address
     * @param caller Address calling the function
     */
    function validateStorageCost(
        uint256 costPerTBYear,
        address poolCreator,
        address caller
    ) internal pure {
        require(
            costPerTBYear > 0 &&
            costPerTBYear <= type(uint256).max / (365 days) &&
            caller == poolCreator
        );
    }

    /**
     * @dev Validate reputation setting
     * @param pool The pool
     * @param peerId Peer ID
     * @param score Reputation score
     * @param caller Address calling the function
     */
    function validateReputationSetting(
        IStoragePool.Pool storage pool,
        string memory peerId,
        uint16 score,
        address caller
    ) internal view {
        require(score <= 1000 && bytes(peerId).length > 0 && caller != address(0));
        require(caller == pool.creator && pool.creator != address(0));

        address member = pool.peerIdToMember[peerId];
        require(member != address(0) && pool.members[member].joinDate > 0);
    }
}
