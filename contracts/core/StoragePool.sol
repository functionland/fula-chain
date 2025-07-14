// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";
import "../governance/interfaces/IStoragePool.sol";

contract StoragePool is Initializable, GovernanceModule, IStoragePool {
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    IERC20 public storageToken;
    address public tokenPool;
    uint256 public createPoolLockAmount;



    mapping(uint32 => IStoragePool.Pool) public pools;
    uint32[] public poolIds;
    mapping(uint32 => uint256) private poolIndex;
    mapping(uint32 => bytes32[]) public joinRequestKeys;
    mapping(uint32 => mapping(bytes32 => uint256)) private joinRequestIndex;
    mapping(uint32 => mapping(bytes32 => IStoragePool.JoinRequest)) public joinRequests;
    mapping(address => bool) public isForfeited;
    mapping(bytes32 => uint256) public claimableTokens;
    mapping(bytes32 => uint32) public joinTimestamp;

    function initialize(address _storageToken, address _tokenPool, address initialOwner, address initialAdmin) public reinitializer(1) {
        if (_storageToken == address(0) || _tokenPool == address(0) || initialOwner == address(0) || initialAdmin == address(0)) {
            revert InvalidAddress();
        }
        __GovernanceModule_init(initialOwner, initialAdmin);
        storageToken = IERC20(_storageToken);
        tokenPool = _tokenPool;
    }

    function _safeTransferOrMarkClaimable(bytes32 peerId, address to, uint256 amount) internal {
        try this.safeTransferWrapper(to, amount) {
            // success
        } catch {
            claimableTokens[peerId] += amount;
            emit TokensMarkedClaimable(peerId, amount);
        }
    }



    // Consolidated token refund helper - reduces code duplication
    function _processTokenRefund(bytes32 peerId, address account, uint256 amount, bool forfeited) internal {
        if (amount > 0) {
            IPool(tokenPool).transferTokens(amount);
            if (forfeited) {
                storageToken.safeTransfer(address(storageToken), amount);
            } else {
                _safeTransferOrMarkClaimable(peerId, account, amount);
            }
        }
    }

    // Helper to add member to pool - reduces code duplication
    function _addMemberToPool(uint32 poolId, address account, bytes32 peerId, uint256 lockedAmount) internal {
        IStoragePool.Pool storage pool = pools[poolId];
        pool.peerIdToMember[peerId] = account;
        pool.memberPeerIds[account].push(peerId);
        if (pool.memberPeerIds[account].length == 1) {
            pool.memberList.push(account);
            pool.memberIndex[account] = pool.memberList.length - 1;
            joinTimestamp[peerId] = uint32(block.timestamp);
        }
        pool.memberCount += 1;
        pool.lockedTokens[peerId] = lockedAmount;
    }

    function _removeJoinRequest(uint32 poolId, bytes32 peerId) internal {
        bytes32[] storage keys = joinRequestKeys[poolId];
        uint256 idx = joinRequestIndex[poolId][peerId];
        bytes32 lastKey = keys[keys.length - 1];
        keys[idx] = lastKey;
        joinRequestIndex[poolId][lastKey] = idx;
        keys.pop();
        delete joinRequestIndex[poolId][peerId];
        delete joinRequests[poolId][peerId];
    }

    function _removePeerFromPool(uint32 poolId, bytes32 peerId) internal {
        IStoragePool.Pool storage pool = pools[poolId];
        address account = pool.peerIdToMember[peerId];
        uint256 amount = pool.lockedTokens[peerId];
        bool forfeited = isForfeited[account];

        // Clear storage slots to get gas refunds
        delete pool.peerIdToMember[peerId];
        delete pool.lockedTokens[peerId];

        bytes32[] storage peerArray = pool.memberPeerIds[account];
        uint256 peerArrayLength = peerArray.length;

        // Optimize loop by direct bytes32 comparison
        for (uint256 i = 0; i < peerArrayLength; i++) {
            if (peerArray[i] == peerId) {
                peerArray[i] = peerArray[peerArrayLength - 1];
                peerArray.pop();
                break;
            }
        }

        if (peerArray.length == 0) {
            uint256 idx = pool.memberIndex[account];
            address[] storage memberList = pool.memberList;
            uint256 memberListLength = memberList.length;
            address lastAddr = memberList[memberListLength - 1];
            memberList[idx] = lastAddr;
            pool.memberIndex[lastAddr] = idx;
            memberList.pop();
            delete joinTimestamp[peerId];
            delete pool.memberIndex[account];
        }

        // Cache and update member count
        uint32 currentCount = pool.memberCount;
        if (currentCount > 0) pool.memberCount = currentCount - 1;

        _processTokenRefund(peerId, account, amount, forfeited);
        emit MemberRemoved(poolId, account, peerId, forfeited, msg.sender);
    }

    function createPool(string calldata name, string calldata region, uint256 requiredTokens, uint32 maxChallengeResponsePeriod, uint256 minPingTime, uint32 maxMembers, bytes32 peerId) external whenNotPaused nonReentrant {
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender);
        address sender = msg.sender; // Cache msg.sender
        if (isForfeited[sender]) revert UF();

        // Cache createPoolLockAmount to avoid repeated storage reads
        uint256 lockAmount = createPoolLockAmount;

        if (!isPrivileged) {
            if (peerId == bytes32(0)) revert InvalidAddress();
            if (lockAmount > 0) {
                if (storageToken.allowance(sender, address(this)) < lockAmount) {
                    revert IA();
                }
                storageToken.safeTransferFrom(sender, tokenPool, lockAmount);
                IPool(tokenPool).receiveTokens(sender, lockAmount);
            }
        }

        if (requiredTokens > lockAmount) requiredTokens = lockAmount;

        uint32 poolId = uint32(poolIds.length + 1);
        IStoragePool.Pool storage pool = pools[poolId];

        // Batch assign pool properties to minimize storage writes
        pool.id = poolId;
        pool.name = name;
        pool.region = region;
        pool.requiredTokens = requiredTokens;
        pool.maxChallengeResponsePeriod = maxChallengeResponsePeriod;
        pool.creator = sender;
        pool.minPingTime = minPingTime;
        pool.memberCount = 0;
        pool.maxMembers = maxMembers;

        poolIndex[poolId] = poolIds.length;
        poolIds.push(poolId);

        if (peerId != bytes32(0)) {
            pool.peerIdToMember[peerId] = sender;
            pool.memberPeerIds[sender].push(peerId);
            pool.memberList.push(sender);
            pool.memberIndex[sender] = pool.memberList.length - 1;
            pool.memberCount = 1;
            joinTimestamp[peerId] = uint32(block.timestamp);
            pool.lockedTokens[peerId] = isPrivileged ? 0 : lockAmount;
        }
        emit PoolCreated(poolId, sender, name, region, requiredTokens, maxMembers);
    }

    function joinPoolRequest(uint32 poolId, bytes32 peerId) external whenNotPaused nonReentrant {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();

        address sender = msg.sender; // Cache msg.sender
        if (isForfeited[sender]) revert UF();
        if (pool.peerIdToMember[peerId] != address(0)) revert AIP();

        IStoragePool.JoinRequest storage existingReq = joinRequests[poolId][peerId];
        if (existingReq.account != address(0) && existingReq.status == 1) { // Changed from 0 to 1 to avoid zero-to-nonzero writes
            revert ARQ();
        }

        // Consolidated capacity check
        if (pool.maxMembers != 0 && (pool.memberCount + joinRequestKeys[poolId].length) >= pool.maxMembers) {
            revert CR();
        }

        uint256 reqAmount = pool.requiredTokens;
        if (reqAmount > 0) {
            if (storageToken.allowance(sender, address(this)) < reqAmount) {
                revert IA();
            }
            storageToken.safeTransferFrom(sender, tokenPool, reqAmount);
            IPool(tokenPool).receiveTokens(sender, reqAmount);
        }

        IStoragePool.JoinRequest storage req = joinRequests[poolId][peerId];
        req.account = sender;
        req.poolId = poolId;
        req.timestamp = uint32(block.timestamp);
        req.status = 1; // Initialize to 1 instead of 0 to avoid zero-to-nonzero writes
        req.approvals = 0;
        req.rejections = 0;
        req.peerId = peerId;

        bytes32[] storage keys = joinRequestKeys[poolId];
        joinRequestIndex[poolId][peerId] = keys.length;
        keys.push(peerId);
        req.index = uint32(keys.length - 1);
        emit JoinRequestSubmitted(poolId, sender, peerId);
    }

    function voteOnJoinRequest(uint32 poolId, bytes32 peerId, bytes32 voterPeerId, bool approve) external whenNotPaused {
        IStoragePool.JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 1) revert NAR(); // Changed from 0 to 1
        IStoragePool.Pool storage pool = pools[poolId];

        address sender = msg.sender; // Cache msg.sender
        address voterAccount = pool.peerIdToMember[voterPeerId];
        if (voterAccount != sender) revert NM();
        if (req.votes[voterPeerId]) revert AV();

        req.votes[voterPeerId] = true;
        if (approve) req.approvals += 1;
        else req.rejections += 1;

        // Consolidated voting logic
        uint256 threshold = pool.memberCount <= 2 ? 1 : (pool.memberCount + 2) / 3;
        if (threshold > 10) threshold = 10;

        address reqAccount = req.account;
        bool forfeited = isForfeited[reqAccount];

        if (req.approvals >= threshold && !forfeited) {
            req.status = 2; // Changed from 1 to 2 for approved status
            _addMemberToPool(poolId, reqAccount, peerId, pool.requiredTokens);

            _removeJoinRequest(poolId, peerId);
            emit JoinRequestResolved(poolId, reqAccount, peerId, true, false);
        } else if (req.rejections >= threshold || forfeited) {
            req.status = 3; // Changed from 2 to 3 for rejected status
            _removeJoinRequest(poolId, peerId);
            _processTokenRefund(peerId, reqAccount, pool.requiredTokens, forfeited);
            emit JoinRequestResolved(poolId, reqAccount, peerId, false, forfeited);
        }
    }

    function cancelJoinRequest(uint32 poolId, bytes32 peerId) external whenNotPaused nonReentrant {
        IStoragePool.JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 1) revert NAR(); // Changed from 0 to 1
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();

        address sender = msg.sender; // Cache msg.sender
        address reqAccount = req.account; // Cache req.account
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, sender);
        if (!(sender == reqAccount || isPrivileged || sender == pool.creator)) {
            revert OCA();
        }

        req.status = 3; // Changed from 2 to 3 for cancelled status
        _removeJoinRequest(poolId, peerId);
        bool forfeited = isForfeited[reqAccount];
        _processTokenRefund(peerId, reqAccount, pool.requiredTokens, forfeited);
        emit JoinRequestResolved(poolId, reqAccount, peerId, false, forfeited);
    }

    function approveJoinRequest(uint32 poolId, bytes32 peerId) external whenNotPaused nonReentrant onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        IStoragePool.JoinRequest storage req = joinRequests[poolId][peerId];
        if (req.account == address(0) || req.status != 1) revert NAR(); // Changed from 0 to 1

        address reqAccount = req.account; // Cache req.account
        if (isForfeited[reqAccount]) revert UF();
        IStoragePool.Pool storage pool = pools[poolId];

        // Consolidated capacity check and member addition
        if (pool.maxMembers != 0 && (pool.memberCount + 1) > pool.maxMembers) {
            revert CR();
        }

        req.status = 2; // Changed from 1 to 2 for approved status
        _addMemberToPool(poolId, reqAccount, peerId, pool.requiredTokens);

        _removeJoinRequest(poolId, peerId);
        emit JoinRequestResolved(poolId, reqAccount, peerId, true, false);
    }

    function addMember(uint32 poolId, address account, bytes32 peerId) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();
        if (isForfeited[account]) revert UF();
        if (pool.peerIdToMember[peerId] != address(0)) revert AIP();

        IStoragePool.JoinRequest storage existingReq = joinRequests[poolId][peerId];
        if (existingReq.account != address(0) && existingReq.status == 1) { // Changed from 0 to 1
            revert ARQ();
        }

        // Consolidated capacity check
        if (pool.maxMembers != 0 && (pool.memberCount + joinRequestKeys[poolId].length) >= pool.maxMembers) {
            revert CR();
        }

        _addMemberToPool(poolId, account, peerId, 0);
        emit MemberAdded(poolId, account, peerId, msg.sender);
    }

    function removeMemberPeerId(uint32 poolId, bytes32 peerId) external whenNotPaused nonReentrant {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();
        address memberAccount = pool.peerIdToMember[peerId];
        if (memberAccount == address(0)) revert PNF2();

        address sender = msg.sender; // Cache msg.sender
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, sender);
        if (!(sender == memberAccount || isPrivileged || sender == pool.creator)) {
            revert OCA();
        }
        _removePeerFromPool(poolId, peerId);
    }

    function removeMembersBatch(uint32 poolId, uint256 count) external whenNotPaused nonReentrant {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();

        address sender = msg.sender; // Cache msg.sender
        bool isPrivileged = hasRole(ProposalTypes.ADMIN_ROLE, sender) || hasRole(ProposalTypes.POOL_ADMIN_ROLE, sender);
        if (!(isPrivileged || sender == pool.creator)) {
            revert OCA();
        }

        uint256 removed = 0;
        bool keepCreator = (sender == pool.creator);

        while (removed < count && pool.memberList.length > 0) {
            if (keepCreator && pool.memberList.length == 1) break;

            address target = pool.memberList[pool.memberList.length - 1];
            bytes32[] memory peers = pool.memberPeerIds[target];

            // Iterate backwards for more efficient removal
            for (uint256 i = peers.length; i > 0; i--) {
                _removePeerFromPool(poolId, peers[i - 1]);
            }
            removed += 1;
        }
    }

    function deletePool(uint32 poolId) external whenNotPaused nonReentrant {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();

        address sender = msg.sender; // Cache msg.sender
        address creator = pool.creator; // Cache pool.creator
        if (!(sender == creator || hasRole(ProposalTypes.ADMIN_ROLE, sender))) {
            revert OCA();
        }

        // Consolidated validation and cleanup
        if (sender == creator) {
            if (!(pool.memberCount == 0 || (pool.memberCount == 1 && pool.memberList.length == 1 && pool.memberList[0] == sender))) {
                revert PNE();
            }
        } else {
            if (pool.memberCount != 0) revert PNE();
        }

        if (pool.memberList.length > 0) {
            address target = pool.memberList[0];
            bytes32[] memory peers = pool.memberPeerIds[target];
            for (uint256 i = 0; i < peers.length; i++) {
                _removePeerFromPool(poolId, peers[i]);
            }
        }

        // Optimize pool removal
        uint256 idx = poolIndex[poolId];
        uint32 lastPoolId = poolIds[poolIds.length - 1];
        poolIds[idx] = lastPoolId;
        poolIndex[lastPoolId] = idx;
        poolIds.pop();
        delete poolIndex[poolId];
        delete pools[poolId]; // Clear storage slot for gas refund
    }

    function setMaxMembers(uint32 poolId, uint32 newMax) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();
        uint256 currentUsage = pool.memberCount + joinRequestKeys[poolId].length;
        if (newMax != 0 && newMax < currentUsage) {
            revert PRE();
        }
        pool.maxMembers = newMax;
        emit PoolParametersUpdated(poolId, pool.requiredTokens, newMax);
    }

    function setRequiredTokens(uint32 poolId, uint256 newRequired) external whenNotPaused onlyRole(ProposalTypes.POOL_ADMIN_ROLE) {
        IStoragePool.Pool storage pool = pools[poolId];
        if (pool.id != poolId) revert PNF();
        if (newRequired > createPoolLockAmount) {
            newRequired = createPoolLockAmount;
        }
        if (newRequired > pool.requiredTokens && joinRequestKeys[poolId].length > 0) {
            revert PRE();
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
        if (amount == 0) revert ITA();
        uint256 poolBalance = storageToken.balanceOf(tokenPool);
        if (amount > poolBalance) {
            amount = poolBalance;
        }
        if (amount == 0) return;
        IPool(tokenPool).transferTokens(amount);
        storageToken.safeTransfer(address(storageToken), amount);
        emit EmergencyTokensRecovered(amount);
    }


    function claimTokens(bytes32 peerId) external nonReentrant whenNotPaused {
        uint256 amount = claimableTokens[peerId];
        if (amount == 0) revert ITA();

        bool isOwner = false;
        for (uint256 i = 0; i < poolIds.length && !isOwner; i++) {
            if (pools[poolIds[i]].peerIdToMember[peerId] == msg.sender) isOwner = true;
        }
        if (!isOwner) revert NM();

        claimableTokens[peerId] = 0; // Clear storage slot for gas refund
        storageToken.safeTransfer(msg.sender, amount);
        emit TokensClaimed(peerId, amount);
    }

    // Minimal getters needed by RewardEngine - optimized for size
    function isPeerIdMemberOfPool(uint32 poolId, bytes32 peerId) external view returns (bool isMember, address memberAddress) {
        memberAddress = pools[poolId].peerIdToMember[peerId];
        isMember = memberAddress != address(0);
    }

    function getTotalMembers() external view returns (uint256 total) {
        for (uint256 i = 0; i < poolIds.length; i++) {
            total += pools[poolIds[i]].memberCount;
        }
    }

    function isMemberOfAnyPool(address account) external view returns (bool) {
        for (uint256 i = 0; i < poolIds.length; i++) {
            if (pools[poolIds[i]].memberPeerIds[account].length > 0) {
                return true;
            }
        }
        return false;
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

    // Required Getters

    //    Currently the below information can be fetched directly from storage variables
    //    - pools(poolId) → All pool basic data except nested mappings/arrays
    //    - joinRequests(poolId, peerId) → Full JoinRequest data except votes
    //    - joinRequestKeys(poolId, index) → List of peerIds with pending join requests
    //    - poolIds(index) → List of all pool IDs
    //    - isForfeited(address) and claimableTokens(peerId) → forfeiture & claimable balances
    
    //  Get Member List
    function getPoolMembers(uint32 poolId) external view returns (address[] memory) {
        return pools[poolId].memberList;
    }

    // Get Member Peer IDs
    function getMemberPeerIds(uint32 poolId, address member) external view returns (bytes32[] memory) {
        return pools[poolId].memberPeerIds[member];
    }

    // Get Peer Mapping Info
    function getPeerIdInfo(uint32 poolId, bytes32 peerId) external view returns (address member, uint256 lockedTokens) {
        IStoragePool.Pool storage pool = pools[poolId];
        member = pool.peerIdToMember[peerId];
        lockedTokens = pool.lockedTokens[peerId];
    }

    // Get Member Index to Confirm membership without iterating
    function getMemberIndex(uint32 poolId, address member) external view returns (uint256) {
        return pools[poolId].memberIndex[member];
    }

    // Get Vote Status
    function getVote(uint32 poolId, bytes32 peerId, bytes32 voterPeerId) external view returns (bool) {
        return joinRequests[poolId][peerId].votes[voterPeerId];
    }

    // Helper
    
    function safeTransferWrapper(address to, uint256 amount) external {
        // Wrap in external call to catch non-reverting failures
        require(msg.sender == address(this), "Unauthorized");
        storageToken.safeTransfer(to, amount); // this will revert on failure
    }

}
