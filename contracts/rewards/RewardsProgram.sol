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
    function setExtension(address ext)
        external
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        address old = extension;
        extension = ext;
        emit IRewardsProgram.ExtensionUpdated(old, ext);
    }

    // === PROGRAM MANAGEMENT (Admin only) ===

    function createProgram(
        bytes8 code,
        string calldata name,
        string calldata description
    )
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (uint32)
    {
        if (code == bytes8(0)) revert IRewardsProgram.InvalidProgramCode();
        if (programCodeToId[code] != 0) revert IRewardsProgram.DuplicateProgramCode();

        programCount++;
        uint32 programId = programCount;

        _programs[programId] = IRewardsProgram.Program({
            id: programId,
            code: code,
            name: name,
            description: description,
            active: true
        });
        programCodeToId[code] = programId;

        emit IRewardsProgram.ProgramCreated(programId, code, name);
        return programId;
    }

    // NOTE: updateProgram, updateMemberID, deactivateProgram moved to RewardsExtension

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
        _validateAddAuthority(programId, msg.sender, role, isAdmin);

        address storageKey = _addMember(programId, wallet, memberID, role, msg.sender, editCodeHash, memberType);
        emit IRewardsProgram.MemberAdded(programId, storageKey, msg.sender, role, memberType, memberID);
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

    function setMemberWallet(uint32 programId, bytes12 memberID, address newWallet)
        external
        whenNotPaused
        nonReentrant
    {
        address storageKey = memberIDLookup[memberID][programId];
        if (storageKey == address(0)) revert IRewardsProgram.MemberNotFound();
        IRewardsProgram.Member storage member = _members[programId][storageKey];
        if (!member.active) revert IRewardsProgram.MemberNotActive();

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        if (!isAdmin) {
            address parentKey = member.parent;
            if (parentKey == address(0)) revert IRewardsProgram.UnauthorizedRole();
            if (_findActingWallet(programId, parentKey) != msg.sender) revert IRewardsProgram.UnauthorizedRole();
        }

        address oldWallet = member.wallet;
        member.wallet = newWallet;
        emit IRewardsProgram.MemberWalletChanged(programId, storageKey, oldWallet, newWallet);
    }

    function removeMember(uint32 programId, address memberKey)
        external
        whenNotPaused
        nonReentrant
    {
        IRewardsProgram.Member storage member = _members[programId][memberKey];
        if (!member.active) revert IRewardsProgram.MemberNotFound();

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        if (!isAdmin) {
            IRewardsProgram.Member storage caller = _members[programId][msg.sender];
            if (!caller.active || caller.role != IRewardsProgram.MemberRole.ProgramAdmin)
                revert IRewardsProgram.UnauthorizedRole();
            if (member.role == IRewardsProgram.MemberRole.ProgramAdmin)
                revert IRewardsProgram.UnauthorizedRole();
        }

        delete memberIDLookup[member.memberID][programId];
        member.active = false;
        emit IRewardsProgram.MemberRemoved(programId, memberKey);
    }

    // === EDIT CODE / CLAIM ===

    function claimMember(uint32 programId, bytes12 memberID, bytes32 editCode)
        external
        whenNotPaused
        nonReentrant
    {
        address storageKey = memberIDLookup[memberID][programId];
        if (storageKey == address(0)) revert IRewardsProgram.MemberNotFound();
        IRewardsProgram.Member storage member = _members[programId][storageKey];
        if (!member.active) revert IRewardsProgram.MemberNotActive();

        if (member.wallet != address(0)) revert IRewardsProgram.InvalidEditCode();

        bytes32 storedHash = _editCodeHashes[programId][storageKey];
        if (storedHash == bytes32(0)) revert IRewardsProgram.InvalidEditCode();
        if (keccak256(abi.encodePacked(editCode)) != storedHash) revert IRewardsProgram.InvalidEditCode();

        member.wallet = msg.sender;
        emit IRewardsProgram.MemberClaimed(programId, storageKey, msg.sender);
    }

    function setEditCodeHash(uint32 programId, bytes12 memberID, bytes32 newHash)
        external
        whenNotPaused
        nonReentrant
    {
        address storageKey = memberIDLookup[memberID][programId];
        if (storageKey == address(0)) revert IRewardsProgram.MemberNotFound();
        if (!_members[programId][storageKey].active) revert IRewardsProgram.MemberNotActive();

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        if (!isAdmin) {
            address parentKey = _members[programId][storageKey].parent;
            if (parentKey == address(0)) revert IRewardsProgram.UnauthorizedRole();
            if (_findActingWallet(programId, parentKey) != msg.sender) revert IRewardsProgram.UnauthorizedRole();
        }

        _editCodeHashes[programId][storageKey] = newHash;
        emit IRewardsProgram.EditCodeHashSet(programId, storageKey);
    }

    // === TOKEN OPERATIONS ===

    function addTokens(uint32 programId, uint256 amount, uint8 rewardType, string calldata note)
        external whenNotPaused nonReentrant
    {
        _requireMemberOrAdmin(programId, msg.sender);
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
        _addTokensCore(programId, msg.sender, msg.sender, amount, rewardType, note);
    }

    function transferToSubMember(
        uint32 programId, address to, uint256 amount,
        bool locked, uint32 lockTimeDays
    ) external whenNotPaused nonReentrant {
        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        _transferToSubCore(programId, msg.sender, to, amount, locked, lockTimeDays, isAdmin);
    }

    function transferToParent(uint32 programId, address to, uint256 amount) external whenNotPaused nonReentrant {
        _transferToParentCore(programId, msg.sender, to, amount);
    }

    function withdraw(uint32 programId, uint256 amount) external whenNotPaused nonReentrant {
        _requireMemberOrAdmin(programId, msg.sender);
        _withdrawCore(programId, msg.sender, msg.sender, amount);
    }

    /// @notice Act on behalf of a walletless member.
    /// action: 1=deposit, 2=transferSub, 3=transferParent, 4=withdraw
    function actForMember(
        uint32 programId, bytes12 memberID, uint8 action,
        address to, uint256 amount,
        bool locked, uint32 lockTimeDays,
        uint8 rewardType, string calldata note
    ) external whenNotPaused nonReentrant {
        address key = _resolveOnBehalf(programId, memberID);
        if (action == 1) {
            if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();
            _addTokensCore(programId, msg.sender, key, amount, rewardType, note);
        } else if (action == 2) {
            bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
            _transferToSubCore(programId, key, to, amount, locked, lockTimeDays, isAdmin);
        } else if (action == 3) {
            _transferToParentCore(programId, key, to, amount);
        } else if (action == 4) {
            _withdrawCore(programId, key, msg.sender, amount);
        }
    }

    // === VIEW FUNCTIONS ===

    function getProgram(uint32 programId) external view returns (IRewardsProgram.Program memory) {
        return _programs[programId];
    }

    function getMember(uint32 programId, address memberKey)
        external view returns (IRewardsProgram.Member memory)
    {
        return _members[programId][memberKey];
    }

    function getMemberByID(bytes12 memberID, uint32 programId)
        external view returns (IRewardsProgram.Member memory)
    {
        address key = memberIDLookup[memberID][programId];
        if (key == address(0)) revert IRewardsProgram.MemberNotFound();
        return _members[programId][key];
    }

    function getBalance(uint32 programId, address memberKey)
        external view returns (uint256 available, uint256 permanentlyLocked, uint256 totalTimeLocked)
    {
        IRewardsProgram.Balance storage bal = _balances[programId][memberKey];
        available = bal.available;
        permanentlyLocked = bal.permanentlyLocked;

        IRewardsProgram.TimeLockTranche[] storage tranches = _timeLocks[programId][memberKey];
        for (uint256 i = 0; i < tranches.length; i++) {
            totalTimeLocked += tranches[i].amount;
        }
    }

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
        bool locked, uint32 lockTimeDays, bool isAdmin
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

        emit IRewardsProgram.TokensTransferredToMember(programId, from, to, amount, locked, lockTimeDays);
    }

    function _transferToParentCore(uint32 programId, address from, address to, uint256 amount) internal {
        _requireActiveProgram(programId);
        if (!_members[programId][from].active) revert IRewardsProgram.MemberNotFound();

        address target = to;
        if (target == address(0)) {
            target = _members[programId][from].parent;
            if (target == address(0)) revert IRewardsProgram.NoParentFound();
        } else {
            if (!_isInParentChain(programId, from, target))
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
        emit IRewardsProgram.TokensTransferredToParent(programId, from, target, amount);
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

        IPool(stakingPool).transferTokens(amount);
        token.safeTransfer(recipient, amount);
        emit IRewardsProgram.TokensWithdrawn(programId, storageKey, amount);
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

    function _resolveOnBehalf(uint32 programId, bytes12 memberID) internal view returns (address) {
        address storageKey = memberIDLookup[memberID][programId];
        if (storageKey == address(0)) revert IRewardsProgram.MemberNotFound();
        if (!_members[programId][storageKey].active) revert IRewardsProgram.MemberNotActive();
        if (hasRole(ProposalTypes.ADMIN_ROLE, msg.sender)) return storageKey;
        if (_findActingWallet(programId, storageKey) != msg.sender) revert IRewardsProgram.UnauthorizedRole();
        return storageKey;
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
