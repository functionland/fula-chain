// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";

interface IPool {
    function transferTokens(uint256 amount) external returns (bool);
    function receiveTokens(address from, uint256 amount) external returns (bool);
}

contract StoragePool is Initializable, GovernanceModule {
    using SafeERC20 for IERC20;

    IERC20 public storageToken;
    address public tokenPool;
    uint256 public createPoolLockAmount;

    struct Pool {
        uint32 id;
        uint32 maxChallengeResponsePeriod;
        uint32 memberCount;
        uint32 maxMembers;
        uint256 requiredTokens;
        uint256 minPingTime;
        address creator;
        string name;
        string region;
        address[] memberList;
        mapping(address => uint256) memberIndex;
        mapping(address => string[]) memberPeerIds;
        mapping(string => address) peerIdToMember;
        mapping(string => uint256) lockedTokens;
    }

    struct JoinRequest {
        address account;
        uint32 poolId;
        uint32 timestamp;
        uint32 index;
        uint8 status;
        uint128 approvals;
        uint128 rejections;
        string peerId;
        mapping(string => bool) votes;
    }

    mapping(uint32 => Pool) private pools;
    uint32[] public poolIds;
    mapping(uint32 => uint256) private poolIndex;
    mapping(uint32 => string[]) private joinRequestKeys;
    mapping(uint32 => mapping(string => uint256)) private joinRequestIndex;
    mapping(uint32 => mapping(string => JoinRequest)) private joinRequests;
    mapping(address => bool) public isForfeited;

    event PoolCreated(uint32 indexed poolId, address indexed creator, string name, string region, uint256 requiredTokens, uint32 maxMembers);
    event JoinRequestSubmitted(uint32 indexed poolId, address indexed account, string peerId);
    event JoinRequestResolved(uint32 indexed poolId, address indexed account, string peerId, bool approved, bool tokensForfeited);
    event MemberAdded(uint32 indexed poolId, address indexed account, string peerId, address indexed addedBy);
    event MemberRemoved(uint32 indexed poolId, address indexed account, string peerId, bool tokensForfeited, address removedBy);
    event ForfeitFlagSet(address indexed account);
    event ForfeitFlagCleared(address indexed account);
    event PoolParametersUpdated(uint32 indexed poolId, uint256 requiredTokens, uint32 maxMembers);
    event EmergencyTokensRecovered(uint256 amount);

    error PoolNotFound(uint32 poolId);
    error AlreadyInPool(string peerId);
    error AlreadyRequested(string peerId);
    error PeerNotFound(string peerId);
    error CapacityReached(uint32 poolId);
    error UserFlagged(address user);
    error NotMember(address user);
    error AlreadyVoted(string voterPeerId);
    error NoActiveRequest(string peerId);
    error OnlyCreatorOrAdmin();
    error PoolNotEmpty(uint32 poolId);
    error PendingRequestsExist(uint32 poolId);
    error InvalidTokenAmount();
    error InsufficientAllowance(uint256 required);

    function initialize(address _storageToken, address _tokenPool, address initialOwner, address initialAdmin) public reinitializer(1) {
        if (_storageToken == address(0) || _tokenPool == address(0) || initialOwner == address(0) || initialAdmin == address(0)) {
            revert InvalidAddress();
        }
        __GovernanceModule_init(initialOwner, initialAdmin);
        storageToken = IERC20(_storageToken);
        tokenPool = _tokenPool;
    }

    function _removePeerFromPool(uint32 poolId, string memory peerId) internal {
        Pool storage pool = pools[poolId];
        address account = pool.peerIdToMember[peerId];
        uint256 amount = pool.lockedTokens[peerId];
        bool forfeited = isForfeited[account];
        
        delete pool.peerIdToMember[peerId];
        delete pool.lockedTokens[peerId];
        
        string[] storage peerArray = pool.memberPeerIds[account];
        for (uint256 i = 0; i < peerArray.length; i++) {
            if (keccak256(bytes(peerArray[i])) == keccak256(bytes(peerId))) {
                peerArray[i] = peerArray[peerArray.length - 1];
                peerArray.pop();
                break;
            }
        }
        
        if (peerArray.length == 0) {
            uint256 idx = pool.memberIndex[account];
            address lastAddr = pool.memberList[pool.memberList.length - 1];
            pool.memberList[idx] = lastAddr;
            pool.memberIndex[lastAddr] = idx;
            pool.memberList.pop();
            delete pool.memberIndex[account];
        }
        
        if (pool.memberCount > 0) {
            pool.memberCount -= 1;
        }
        
        if (amount > 0) {
            IPool(tokenPool).transferTokens(amount);
            if (forfeited) {
                storageToken.safeTransfer(address(storageToken), amount);
            } else {
                storageToken.safeTransfer(account, amount);
            }
        }
        emit MemberRemoved(poolId, account, peerId, forfeited, msg.sender);
    }

    function createPool(string memory name, string memory region, uint256 requiredTokens, uint32 maxChallengeResponsePeriod, uint256 minPingTime, uint32 maxMembers, string memory peerId) external whenNotPaused nonReentrant {
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender);
        if (isForfeited[msg.sender]) revert UserFlagged(msg.sender);

        if (!isPrivileged) {
            if (bytes(peerId).length == 0) revert InvalidAddress();
            if (createPoolLockAmount > 0) {
                if (storageToken.allowance(msg.sender, address(this)) < createPoolLockAmount) {
                    revert InsufficientAllowance(createPoolLockAmount);
                }
                storageToken.safeTransferFrom(msg.sender, tokenPool, createPoolLockAmount);
                IPool(tokenPool).receiveTokens(msg.sender, createPoolLockAmount);
            }
        }

        if (requiredTokens > createPoolLockAmount) requiredTokens = createPoolLockAmount;

        uint32 poolId = uint32(poolIds.length + 1);
        Pool storage pool = pools[poolId];
        pool.id = poolId;
        pool.name = name;
        pool.region = region;
        pool.requiredTokens = requiredTokens;
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod;
        pool.creator = msg.sender;
        pool.minPingTime = minPingTime;
        pool.memberCount = 0;
        pool.maxMembers = maxMembers;

        poolIndex[poolId] = poolIds.length;
        poolIds.push(poolId);

        if (bytes(peerId).length > 0) {
            pool.peerIdToMember[peerId] = msg.sender;
            pool.memberPeerIds[msg.sender].push(peerId);
            pool.memberList.push(msg.sender);
            pool.memberIndex[msg.sender] = pool.memberList.length - 1;
            pool.memberCount = 1;
            pool.lockedTokens[peerId] = isPrivileged ? 0 : createPoolLockAmount;
        }
        emit PoolCreated(poolId, msg.sender, name, region, requiredTokens, maxMembers);
    }

    function joinPoolRequest(uint32 poolId, string memory peerId) external whenNotPaused nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        if (isForfeited[msg.sender]) revert UserFlagged(msg.sender);
        if (pool.peerIdToMember[peerId] != address(0)) revert AlreadyInPool(peerId);
        if (joinRequests[poolId][peerId].account != address(0) && joinRequests[poolId][peerId].status == 0) {
            revert AlreadyRequested(peerId);
        }
        
        if (pool.maxMembers != 0 && (pool.memberCount + joinRequestKeys[poolId].length) >= pool.maxMembers) {
            revert CapacityReached(poolId);
        }
        
        uint256 reqAmount = pool.requiredTokens;
        if (reqAmount > 0) {
            if (storageToken.allowance(msg.sender, address(this)) < reqAmount) {
                revert InsufficientAllowance(reqAmount);
            }
            storageToken.safeTransferFrom(msg.sender, tokenPool, reqAmount);
            IPool(tokenPool).receiveTokens(msg.sender, reqAmount);
        }
        
        JoinRequest storage req = joinRequests[poolId][peerId];
        req.account = msg.sender;
        req.poolId = poolId;
        req.timestamp = uint32(block.timestamp);
        req.status = 0;
        req.approvals = 0;
        req.rejections = 0;
        req.peerId = peerId;
        
        joinRequestIndex[poolId][peerId] = joinRequestKeys[poolId].length;
        joinRequestKeys[poolId].push(peerId);
        req.index = uint32(joinRequestKeys[poolId].length - 1);
        emit JoinRequestSubmitted(poolId, msg.sender, peerId);
    }

    function voteOnJoinRequest(uint32 poolId, string memory peerId, string memory voterPeerId, bool approve) external whenNotPaused {
        JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 0) revert NoActiveRequest(peerId);
        Pool storage pool = pools[poolId];

        address voterAccount = pool.peerIdToMember[voterPeerId];
        if (voterAccount != msg.sender) revert NotMember(msg.sender);
        if (req.votes[voterPeerId]) revert AlreadyVoted(voterPeerId);

        req.votes[voterPeerId] = true;
        if (approve) req.approvals += 1;
        else req.rejections += 1;

        uint256 memberCount = pool.memberCount;
        uint256 threshold = memberCount <= 2 ? 1 : (memberCount + 2) / 3;
        if (threshold > 10) threshold = 10;
        bool forfeited = isForfeited[req.account];

        if (req.approvals >= threshold && !forfeited) {
            req.status = 1;
            pool.peerIdToMember[peerId] = req.account;
            pool.memberPeerIds[req.account].push(peerId);
            if (pool.memberPeerIds[req.account].length == 1) {
                pool.memberList.push(req.account);
                pool.memberIndex[req.account] = pool.memberList.length - 1;
            }
            pool.memberCount += 1;
            pool.lockedTokens[peerId] = pool.requiredTokens;

            _removeJoinRequest(poolId, peerId);
            emit JoinRequestResolved(poolId, req.account, peerId, true, false);
            delete joinRequests[poolId][peerId];
        } else if (req.rejections >= threshold || forfeited) {
            req.status = 2;
            _removeJoinRequest(poolId, peerId);

            uint256 amount = pool.requiredTokens;
            if (amount > 0) {
                IPool(tokenPool).transferTokens(amount);
                storageToken.safeTransfer(forfeited ? address(storageToken) : req.account, amount);
            }
            emit JoinRequestResolved(poolId, req.account, peerId, false, forfeited);
            delete joinRequests[poolId][peerId];
        }
    }

    function _removeJoinRequest(uint32 poolId, string memory peerId) internal {
        uint256 idx = joinRequestIndex[poolId][peerId];
        string memory lastKey = joinRequestKeys[poolId][joinRequestKeys[poolId].length - 1];
        joinRequestKeys[poolId][idx] = lastKey;
        joinRequestIndex[poolId][lastKey] = idx;
        joinRequestKeys[poolId].pop();
        delete joinRequestIndex[poolId][peerId];
    }

    function cancelJoinRequest(uint32 poolId, string memory peerId) external whenNotPaused nonReentrant {
        JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 0) revert NoActiveRequest(peerId);
        Pool storage pool = pools[poolId];
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender);
        if (!(msg.sender == req.account || isPrivileged || msg.sender == pool.creator)) {
            revert OnlyCreatorOrAdmin();
        }

        req.status = 2;
        _removeJoinRequest(poolId, peerId);

        uint256 amount = pool.requiredTokens;
        bool forfeited = isForfeited[req.account];
        if (amount > 0) {
            IPool(tokenPool).transferTokens(amount);
            storageToken.safeTransfer(forfeited ? address(storageToken) : req.account, amount);
        }
        emit JoinRequestResolved(poolId, req.account, peerId, false, forfeited);
        delete joinRequests[poolId][peerId];
    }

    function approveJoinRequest(uint32 poolId, string memory peerId) external whenNotPaused nonReentrant onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 0) revert NoActiveRequest(peerId);
        if (isForfeited[req.account]) revert UserFlagged(req.account);
        Pool storage pool = pools[poolId];

        if (pool.maxMembers != 0 && (pool.memberCount + 1) > pool.maxMembers) {
            revert CapacityReached(poolId);
        }

        req.status = 1;
        pool.peerIdToMember[peerId] = req.account;
        pool.memberPeerIds[req.account].push(peerId);
        if (pool.memberPeerIds[req.account].length == 1) {
            pool.memberList.push(req.account);
            pool.memberIndex[req.account] = pool.memberList.length - 1;
        }
        pool.memberCount += 1;
        pool.lockedTokens[peerId] = pool.requiredTokens;

        _removeJoinRequest(poolId, peerId);
        emit JoinRequestResolved(poolId, req.account, peerId, true, false);
        delete joinRequests[poolId][peerId];
    }

    function addMember(uint32 poolId, address account, string memory peerId) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        if (isForfeited[account]) revert UserFlagged(account);
        if (pool.peerIdToMember[peerId] != address(0)) revert AlreadyInPool(peerId);
        if (joinRequests[poolId][peerId].account != address(0) && joinRequests[poolId][peerId].status == 0) {
            revert AlreadyRequested(peerId);
        }
        if (pool.maxMembers != 0 && (pool.memberCount + joinRequestKeys[poolId].length) >= pool.maxMembers) {
            revert CapacityReached(poolId);
        }

        pool.peerIdToMember[peerId] = account;
        pool.memberPeerIds[account].push(peerId);
        if (pool.memberPeerIds[account].length == 1) {
            pool.memberList.push(account);
            pool.memberIndex[account] = pool.memberList.length - 1;
        }
        pool.memberCount += 1;
        pool.lockedTokens[peerId] = 0;
        emit MemberAdded(poolId, account, peerId, msg.sender);
    }

    function removeMemberPeerId(uint32 poolId, string memory peerId) external whenNotPaused nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        address memberAccount = pool.peerIdToMember[peerId];
        if (memberAccount == address(0)) revert PeerNotFound(peerId);
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender);
        if (!(msg.sender == memberAccount || isPrivileged || msg.sender == pool.creator)) {
            revert OnlyCreatorOrAdmin();
        }
        _removePeerFromPool(poolId, peerId);
    }

    function removeMembersBatch(uint32 poolId, uint256 count) external whenNotPaused nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender);
        if (!(isPrivileged || msg.sender == pool.creator)) {
            revert OnlyCreatorOrAdmin();
        }
        uint256 removed = 0;
        bool keepCreator = (msg.sender == pool.creator);
        while (removed < count) {
            uint256 mCount = pool.memberList.length;
            if (mCount == 0) break;
            if (keepCreator && mCount == 1) break;

            address target = pool.memberList[mCount - 1];
            string[] memory peers = pool.memberPeerIds[target];
            uint256 peerCount = peers.length;
            for (uint256 i = 0; i < peerCount; i++) {
                string memory lastPeer = peers[peerCount - 1 - i];
                _removePeerFromPool(poolId, lastPeer);
            }
            removed += 1;
        }
    }

    function deletePool(uint32 poolId) external whenNotPaused nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        if (!(msg.sender == pool.creator || hasRole(ProposalTypes.ADMIN_ROLE, msg.sender))) {
            revert OnlyCreatorOrAdmin();
        }
        uint256 memberCount = pool.memberCount;
        if (msg.sender == pool.creator) {
            if (!(memberCount == 0 || (memberCount == 1 && pool.memberList.length == 1 && pool.memberList[0] == msg.sender))) {
                revert PoolNotEmpty(poolId);
            }
        } else {
            if (memberCount != 0) revert PoolNotEmpty(poolId);
        }

        if (pool.memberList.length > 0) {
            address target = pool.memberList[0];
            string[] memory peers = pool.memberPeerIds[target];
            for (uint256 i = 0; i < peers.length; i++) {
                _removePeerFromPool(poolId, peers[i]);
            }
        }

        uint256 idx = poolIndex[poolId];
        uint32 lastPoolId = poolIds[poolIds.length - 1];
        poolIds[idx] = lastPoolId;
        poolIndex[lastPoolId] = idx;
        poolIds.pop();
        delete poolIndex[poolId];
        delete pools[poolId];
    }

    function setMaxMembers(uint32 poolId, uint32 newMax) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        uint256 currentUsage = pool.memberCount + joinRequestKeys[poolId].length;
        if (newMax != 0 && newMax < currentUsage) {
            revert PendingRequestsExist(poolId);
        }
        pool.maxMembers = newMax;
        emit PoolParametersUpdated(poolId, pool.requiredTokens, newMax);
    }

    function setRequiredTokens(uint32 poolId, uint256 newRequired) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PoolNotFound(poolId);
        if (newRequired > createPoolLockAmount) {
            newRequired = createPoolLockAmount;
        }
        if (newRequired > pool.requiredTokens && joinRequestKeys[poolId].length > 0) {
            revert PendingRequestsExist(poolId);
        }
        pool.requiredTokens = newRequired;
        emit PoolParametersUpdated(poolId, newRequired, pool.maxMembers);
    }

    function setForfeitFlag(address account, bool flag) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        isForfeited[account] = flag;
        if (flag) {
            emit ForfeitFlagSet(account);
        } else {
            emit ForfeitFlagCleared(account);
        }
    }

    function emergencyRecoverTokens(uint256 amount) external nonReentrant onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (amount == 0) revert InvalidTokenAmount();
        uint256 poolBalance = storageToken.balanceOf(tokenPool);
        if (amount > poolBalance) {
            amount = poolBalance;
        }
        if (amount == 0) return;
        IPool(tokenPool).transferTokens(amount);
        storageToken.safeTransfer(address(storageToken), amount);
        emit EmergencyTokensRecovered(amount);
    }

    function getPool(uint32 poolId) external view returns (
        string memory name,
        string memory region,
        address creator,
        uint256 requiredTokens,
        uint32 memberCount,
        uint32 maxMembers,
        uint32 maxChallengeResponsePeriod,
        uint256 minPingTime
    ) {
        Pool storage pool = pools[poolId];
        name = pool.name;
        region = pool.region;
        creator = pool.creator;
        requiredTokens = pool.requiredTokens;
        memberCount = pool.memberCount;
        maxMembers = pool.maxMembers;
        maxChallengeResponsePeriod = pool.maxChallengeResponsePeriod;
        minPingTime = pool.minPingTime;
    }

    function getPendingJoinRequests(uint32 poolId) external view returns (
        address[] memory accounts,
        string[] memory peerIds,
        uint128[] memory approvals,
        uint128[] memory rejections
    ) {
        string[] storage keys = joinRequestKeys[poolId];
        uint256 len = keys.length;
        accounts = new address[](len);
        peerIds = new string[](len);
        approvals = new uint128[](len);
        rejections = new uint128[](len);
        for (uint256 i = 0; i < len; i++) {
            string storage pId = keys[i];
            JoinRequest storage req = joinRequests[poolId][pId];
            accounts[i] = req.account;
            peerIds[i] = pId;
            approvals[i] = req.approvals;
            rejections[i] = req.rejections;
        }
    }

    function isPeerInPool(uint32 poolId, string memory peerId) external view returns (bool) {
        return pools[poolId].peerIdToMember[peerId] != address(0);
    }

    function isJoinRequestPending(uint32 poolId, string memory peerId) external view returns (bool) {
        JoinRequest storage req = joinRequests[poolId][peerId];
        return (req.account != address(0) && req.status == 0);
    }

    function getLockedTokens(uint32 poolId, string memory peerId) external view returns (uint256) {
        Pool storage pool = pools[poolId];
        if (pool.peerIdToMember[peerId] != address(0)) {
            return pool.lockedTokens[peerId];
        }
        JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account != address(0) && req.status == 0) {
            return pool.requiredTokens;
        }
        return 0;
    }

    function _authorizeUpgrade(address newImplementation) internal nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) override {
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }

    function _createCustomProposal(uint8 proposalType, uint40, address, bytes32, uint96, address) internal virtual override returns (bytes32) {
        revert InvalidProposalType(proposalType);
    }

    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        revert InvalidProposalType(uint8(proposal.proposalType));
    }
}
