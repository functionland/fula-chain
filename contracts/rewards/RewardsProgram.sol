// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RewardsStorageBase.sol";

/// @title RewardsProgram
/// @notice Manages reward programs with hierarchical membership and token accounting.
/// @dev Functions not found here are delegated to the extension contract via fallback().
contract RewardsProgram is RewardsStorageBase {
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // === INITIALIZATION ===

    function initialize(
        address _token,
        address _stakingPool,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        if (_token == address(0) || _stakingPool == address(0)) revert InvalidAddress();
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();

        __GovernanceModule_init(initialOwner, initialAdmin);
        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner);

        token = IERC20(_token);
        stakingPool = _stakingPool;
    }

    // === FALLBACK → EXTENSION ===

    /// @notice Delegates unrecognized calls to the extension contract.
    fallback() external {
        address ext = extension;
        if (ext == address(0)) revert IRewardsProgram.ExtensionNotSet();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    /// @notice Set the extension contract address (admin only).
    /// @dev Only allowed when extension is not yet set (initial deployment).
    ///      For subsequent changes, use proposeExtension → executeExtensionChange.
    function setExtension(address ext)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (ext == address(0)) revert InvalidAddress();
        if (extension != address(0)) revert IRewardsProgram.ExtensionAlreadySet();
        extension = ext;
        emit IRewardsProgram.ExtensionUpdated(address(0), ext);
    }

    uint48 constant EXTENSION_CHANGE_DELAY = 48 hours;

    /// @notice Propose a new extension address. Requires 48-hour delay before execution.
    function proposeExtension(address ext)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (ext == address(0)) revert InvalidAddress();
        if (extension == address(0)) revert IRewardsProgram.ExtensionNotSet();
        pendingExtension = ext;
        pendingExtensionTime = uint64(block.timestamp);
        emit IRewardsProgram.ExtensionChangeProposed(ext, block.timestamp + EXTENSION_CHANGE_DELAY);
    }

    /// @notice Execute a pending extension change after the timelock delay.
    function executeExtensionChange()
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        address ext = pendingExtension;
        if (ext == address(0)) revert IRewardsProgram.NoPendingExtensionChange();
        if (block.timestamp < uint256(pendingExtensionTime) + EXTENSION_CHANGE_DELAY)
            revert IRewardsProgram.ExtensionChangeNotReady();

        address old = extension;
        extension = ext;
        pendingExtension = address(0);
        pendingExtensionTime = 0;
        emit IRewardsProgram.ExtensionUpdated(old, ext);
    }

    /// @notice Cancel a pending extension change.
    function cancelExtensionChange()
        external
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        address ext = pendingExtension;
        if (ext == address(0)) revert IRewardsProgram.NoPendingExtensionChange();
        pendingExtension = address(0);
        pendingExtensionTime = 0;
        emit IRewardsProgram.ExtensionChangeCancelled(ext);
    }

    // NOTE: createProgram, updateProgram, updateMemberID, deactivateProgram moved to RewardsExtension

    function getProgram(uint32 programId) external view returns (IRewardsProgram.Program memory) {
        return _programs[programId];
    }

    function assignProgramAdmin(
        uint32 programId,
        address wallet,
        bytes12 memberID,
        bytes32 editCodeHash,
        uint8 memberType
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        _requireActiveProgram(programId);
        address storageKey = _addMember(programId, wallet, memberID, IRewardsProgram.MemberRole.ProgramAdmin, msg.sender, editCodeHash, memberType);
        emit IRewardsProgram.ProgramAdminAssigned(programId, storageKey, memberID);
    }

    // === MEMBER MANAGEMENT ===

    function addMember(
        uint32 programId,
        address wallet,
        bytes12 memberID,
        IRewardsProgram.MemberRole role,
        bytes32 editCodeHash,
        uint8 memberType
    )
        external
        whenNotPaused
        nonReentrant
    {
        _requireActiveProgram(programId);
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        address callerKey = _resolveStorageKey(programId, msg.sender);
        _validateAddAuthority(programId, callerKey, role, isAdmin);

        address storageKey = _addMember(programId, wallet, memberID, role, callerKey, editCodeHash, memberType);
        emit IRewardsProgram.MemberAdded(programId, storageKey, callerKey, role, memberType, memberID);
    }

    function addMemberUnder(
        uint32 programId,
        bytes12 parentMemberID,
        address wallet,
        bytes12 memberID,
        IRewardsProgram.MemberRole role,
        bytes32 editCodeHash,
        uint8 memberType
    )
        external
        whenNotPaused
        nonReentrant
    {
        _requireActiveProgram(programId);
        address parentKey = memberIDLookup[parentMemberID][programId];
        if (parentKey == address(0)) revert IRewardsProgram.MemberNotFound();
        if (!_members[programId][parentKey].active) revert IRewardsProgram.MemberNotActive();

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        if (!isAdmin) {
            if (_findActingWallet(programId, parentKey) != msg.sender) revert IRewardsProgram.UnauthorizedRole();
        }
        _validateAddAuthority(programId, parentKey, role, isAdmin);

        address storageKey = _addMember(programId, wallet, memberID, role, parentKey, editCodeHash, memberType);
        emit IRewardsProgram.MemberAdded(programId, storageKey, parentKey, role, memberType, memberID);
    }

    // NOTE: setMemberWallet, removeMember, commitClaim, claimMember, setEditCodeHash
    // moved to RewardsExtension to reduce contract size.

    // === TOKEN OPERATIONS ===

    function addTokens(uint32 programId, uint256 amount, uint8 rewardType, string calldata note)
        external whenNotPaused nonReentrant
    {
        address key = _resolveStorageKey(programId, msg.sender);
        _requireMemberOrAdmin(programId, key);
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
        _addTokensCore(programId, msg.sender, key, amount, rewardType, note);
    }

    function transferToSubMember(
        uint32 programId, address to, uint256 amount,
        bool locked, uint32 lockTimeDays,
        uint8 rewardType, uint8 subTypeId, string calldata note
    ) external whenNotPaused nonReentrant {
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        address key = _resolveStorageKey(programId, msg.sender);
        _transferToSubCore(programId, key, to, amount, locked, lockTimeDays, isAdmin, rewardType, subTypeId, note);
    }

    function transferToParent(uint32 programId, address to, uint256 amount, string calldata note) external whenNotPaused nonReentrant {
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
        address key = _resolveStorageKey(programId, msg.sender);
        _transferToParentCore(programId, key, to, amount, note);
    }

    function withdraw(uint32 programId, uint256 amount) external whenNotPaused nonReentrant {
        address key = _resolveStorageKey(programId, msg.sender);
        _requireMemberOrAdmin(programId, key);
        _withdrawCore(programId, key, msg.sender, amount);
    }

    /// @notice Act on behalf of a walletless member.
    /// action: 1=deposit, 2=transferSub, 3=transferParent, 4=withdraw
    function actForMember(
        uint32 programId, bytes12 memberID, uint8 action,
        address to, uint256 amount,
        bool locked, uint32 lockTimeDays,
        uint8 rewardType, string calldata note
    ) external whenNotPaused nonReentrant {
        address key = _resolveOnBehalf(programId, memberID, action == 4);
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
        if (action == 1) {
            _addTokensCore(programId, msg.sender, key, amount, rewardType, note);
        } else if (action == 2) {
            bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
            _transferToSubCore(programId, key, to, amount, locked, lockTimeDays, isAdmin, rewardType, 0, note);
        } else if (action == 3) {
            _transferToParentCore(programId, key, to, amount, note);
        } else if (action == 4) {
            _withdrawCore(programId, key, msg.sender, amount);
        } else {
            revert IRewardsProgram.InvalidRole();
        }
    }

    // NOTE: getProgram, getMember, getMemberByID, getBalance moved to RewardsExtension.

    // === INTERNAL HELPERS (main contract only) ===

    function _addMember(
        uint32 programId, address wallet, bytes12 memberID,
        IRewardsProgram.MemberRole role, address parent,
        bytes32 editCodeHash, uint8 memberType
    ) internal returns (address storageKey) {
        storageKey = wallet != address(0) ? wallet : _virtualAddr(memberID, programId);

        if (memberID == bytes12(0)) revert IRewardsProgram.InvalidMemberID();
        if (_members[programId][storageKey].active) revert IRewardsProgram.MemberAlreadyExists();
        if (memberIDLookup[memberID][programId] != address(0)) revert IRewardsProgram.DuplicateMemberID();

        _members[programId][storageKey] = IRewardsProgram.Member({
            wallet: wallet,
            memberID: memberID,
            role: role,
            memberType: memberType,
            programId: programId,
            parent: parent,
            active: true
        });
        memberIDLookup[memberID][programId] = storageKey;
        _children[programId][parent].push(storageKey);

        if (editCodeHash != bytes32(0)) {
            _editCodeHashes[programId][storageKey] = editCodeHash;
        }

        // M3: Maintain PA counter for scalable _requireAnyProgramAdminOrAdmin
        if (role == IRewardsProgram.MemberRole.ProgramAdmin && wallet != address(0)) {
            _programAdminCount[wallet]++;
        }
    }

    function _validateAddAuthority(
        uint32 programId, address caller,
        IRewardsProgram.MemberRole targetRole, bool isAdmin
    ) internal view {
        if (targetRole == IRewardsProgram.MemberRole.None) revert IRewardsProgram.InvalidRole();
        if (isAdmin) return;

        IRewardsProgram.Member storage callerMember = _members[programId][caller];
        if (!callerMember.active) revert IRewardsProgram.MemberNotFound();

        if (callerMember.role == IRewardsProgram.MemberRole.ProgramAdmin) {
            if (targetRole == IRewardsProgram.MemberRole.ProgramAdmin) revert IRewardsProgram.UnauthorizedRole();
        } else if (callerMember.role == IRewardsProgram.MemberRole.TeamLeader) {
            if (targetRole != IRewardsProgram.MemberRole.Client) revert IRewardsProgram.UnauthorizedRole();
        } else {
            revert IRewardsProgram.UnauthorizedRole();
        }
    }

    function _transferToSubCore(
        uint32 programId, address from, address to, uint256 amount,
        bool locked, uint32 lockTimeDays, bool isAdmin,
        uint8 rewardType, uint8 subTypeId, string calldata note
    ) internal {
        _requireActiveProgram(programId);
        if (!_isSubMember(programId, from, to, isAdmin)) revert IRewardsProgram.NotSubMember();
        if (amount == 0) revert IRewardsProgram.InvalidAmount();
        if (lockTimeDays > MAX_LOCK_TIME_DAYS) revert IRewardsProgram.LockTimeTooLong();

        IRewardsProgram.Balance storage senderBal = _balances[programId][from];
        if (senderBal.available < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, senderBal.available);
        }
        senderBal.available -= amount;

        if (locked) {
            _balances[programId][to].permanentlyLocked += amount;
        } else if (lockTimeDays > 0) {
            // H4: Prevent silent truncation when casting to uint128
            if (amount > type(uint128).max) revert IRewardsProgram.InvalidAmount();
            // L3: MAX_TIME_LOCK_TRANCHES (50) caps the array. A griefer with transfer
            // rights could fill all 50 slots with tiny amounts, blocking legitimate
            // time-locked transfers until tranches expire and are resolved.
            // Mitigation: resolveTimeLocks() frees expired slots via swap-and-pop.
            IRewardsProgram.TimeLockTranche[] storage tranches = _timeLocks[programId][to];
            if (tranches.length >= MAX_TIME_LOCK_TRANCHES) {
                revert IRewardsProgram.MaxTimeLockTranchesReached();
            }
            tranches.push(IRewardsProgram.TimeLockTranche({
                amount: uint128(amount),
                unlockTime: uint64(block.timestamp + uint256(lockTimeDays) * 1 days)
            }));
        } else {
            _balances[programId][to].available += amount;
        }

        emit IRewardsProgram.TokensTransferredToMember(programId, from, to, amount, locked, lockTimeDays, rewardType, subTypeId, note);
    }

    function _transferToParentCore(uint32 programId, address from, address to, uint256 amount, string calldata note) internal {
        _requireActiveProgram(programId);
        if (!_members[programId][from].active) revert IRewardsProgram.MemberNotFound();

        address target = to;
        if (target == address(0)) {
            target = _members[programId][from].parent;
            if (target == address(0)) revert IRewardsProgram.NoParentFound();
        } else {
            if (!_isInParentChain(programId, from, target) &&
                !hasRole(ProposalTypes.ADMIN_ROLE, target))
                revert IRewardsProgram.NotInParentChain();
        }

        if (amount == 0) revert IRewardsProgram.InvalidAmount();

        _resolveExpiredLocks(programId, from);

        IRewardsProgram.Balance storage fromBal = _balances[programId][from];
        uint256 totalBalance = fromBal.available + fromBal.permanentlyLocked;
        {
            IRewardsProgram.TimeLockTranche[] storage tr = _timeLocks[programId][from];
            for (uint256 j = 0; j < tr.length; j++) {
                totalBalance += tr[j].amount;
            }
        }
        // Transfer control limit — only applies to Clients.
        // NOTE: Limit is per-transaction against current balance. Repeated transfers each
        // get a fresh percentage of the remaining balance, converging asymptotically
        // (remaining ≈ totalBalance × (1 - limitPct/100)^N). This is by design.
        {
            uint8 limitPct = _transferLimits[programId];
            if (limitPct > 0 && _members[programId][from].role == IRewardsProgram.MemberRole.Client) {
                uint256 maxTransferable = (totalBalance * limitPct) / 100;
                if (amount > maxTransferable)
                    revert IRewardsProgram.TransferExceedsLimit(amount, maxTransferable);
            }
        }
        if (totalBalance < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, totalBalance);
        }

        uint256 remaining = amount;

        if (fromBal.available > 0) {
            uint256 d = fromBal.available < remaining ? fromBal.available : remaining;
            fromBal.available -= d;
            remaining -= d;
        }

        if (remaining > 0) {
            remaining = _deductFromTranches(programId, from, remaining);
        }

        if (remaining > 0) {
            fromBal.permanentlyLocked -= remaining;
        }

        _balances[programId][target].available += amount;
        emit IRewardsProgram.TokensTransferredToParent(programId, from, target, amount, note);
    }

    function _withdrawCore(uint32 programId, address storageKey, address recipient, uint256 amount) internal {
        _requireActiveProgram(programId);
        if (amount == 0) revert IRewardsProgram.InvalidAmount();

        uint256 resolvedAmount = _resolveExpiredLocks(programId, storageKey);
        if (resolvedAmount > 0) {
            emit IRewardsProgram.TimeLockResolved(programId, storageKey, resolvedAmount);
        }

        IRewardsProgram.Balance storage bal = _balances[programId][storageKey];
        if (bal.available < amount) {
            revert IRewardsProgram.InsufficientBalance(amount, bal.available);
        }
        bal.available -= amount;

        // M2: Emit before external calls (CEI pattern). Protected by nonReentrant on
        // all entry points, but maintained for defense-in-depth.
        emit IRewardsProgram.TokensWithdrawn(programId, storageKey, amount);

        // H5: Check return values from StakingPool
        if (!IPool(stakingPool).transferTokens(amount)) revert IRewardsProgram.PoolTransferFailed();
        token.safeTransfer(recipient, amount);
    }

    function _resolveExpiredLocks(uint32 programId, address wallet) internal returns (uint256 resolved) {
        IRewardsProgram.TimeLockTranche[] storage tranches = _timeLocks[programId][wallet];
        uint256 i = 0;
        while (i < tranches.length) {
            if (tranches[i].unlockTime <= block.timestamp) {
                resolved += tranches[i].amount;
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                i++;
            }
        }
        if (resolved > 0) {
            _balances[programId][wallet].available += resolved;
        }
    }

    function _deductFromTranches(uint32 programId, address wallet, uint256 amount) internal returns (uint256 remaining) {
        remaining = amount;
        IRewardsProgram.TimeLockTranche[] storage tranches = _timeLocks[programId][wallet];

        uint256 i = 0;
        while (i < tranches.length && remaining > 0) {
            uint256 trancheAmt = tranches[i].amount;
            if (trancheAmt <= remaining) {
                remaining -= trancheAmt;
                tranches[i] = tranches[tranches.length - 1];
                tranches.pop();
            } else {
                tranches[i].amount -= uint128(remaining);
                remaining = 0;
            }
        }
    }

    /// @notice Resolve member storage key and authorize caller.
    /// @param strict If true, narrow auth for withdraw safety. If false, expanded auth.
    function _resolveOnBehalf(uint32 programId, bytes12 memberID, bool strict) internal view returns (address) {
        address sk = memberIDLookup[memberID][programId];
        if (sk == address(0)) revert IRewardsProgram.MemberNotFound();
        if (!_members[programId][sk].active) revert IRewardsProgram.MemberNotActive();
        if (hasRole(ProposalTypes.ADMIN_ROLE, msg.sender)) return sk;

        if (_members[programId][sk].wallet == address(0)) {
            // Walletless member
            if (strict) {
                // Withdraw: only nearest ancestor wallet (original behavior)
                if (_findActingWallet(programId, sk) != msg.sender)
                    revert IRewardsProgram.UnauthorizedRole();
                return sk;
            }
            // Expanded: any ancestor with a wallet
            address p = _members[programId][sk].parent;
            for (uint256 i = 0; i < MAX_HIERARCHY_DEPTH && p != address(0); i++) {
                if (_members[programId][p].wallet == msg.sender) return sk;
                p = _members[programId][p].parent;
            }
            // Or: any TL or PA in same program
            address ck = _resolveStorageKey(programId, msg.sender);
            if (_members[programId][ck].active &&
                _members[programId][ck].role >= IRewardsProgram.MemberRole.TeamLeader)
                return sk;
        } else {
            // Has wallet: self always allowed
            if (_members[programId][sk].wallet == msg.sender) return sk;
            if (!strict) {
                // Expanded: PA can also act
                address ck = _resolveStorageKey(programId, msg.sender);
                if (_members[programId][ck].active &&
                    _members[programId][ck].role == IRewardsProgram.MemberRole.ProgramAdmin)
                    return sk;
            }
        }
        revert IRewardsProgram.UnauthorizedRole();
    }

    // === GOVERNANCE OVERRIDES ===

    function _authorizeUpgrade(address newImplementation)
        internal
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        if (!_checkUpgrade(newImplementation)) revert InvalidAddress();
    }
}
