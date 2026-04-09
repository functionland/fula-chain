// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RewardsStorageBase.sol";

/// @title RewardsExtension
/// @notice Extension contract for RewardsProgram — called via delegatecall from the
///         main contract's fallback(). Shares the same storage layout.
/// @dev Contains: moved functions (updateProgram, updateMemberID, deactivateProgram),
///      member type management, reward type management, sub-type management,
///      and detailed deposits with sub-type breakdown.
contract RewardsExtension is RewardsStorageBase {

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // === MOVED FUNCTIONS (from RewardsProgram — saves bytecode in main contract) ===

    function createProgram(bytes8 code, string calldata name, string calldata description)
        external whenNotPaused nonReentrant onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (uint32)
    {
        if (code == bytes8(0)) revert IRewardsProgram.InvalidProgramCode();
        if (programCodeToId[code] != 0) revert IRewardsProgram.DuplicateProgramCode();
        if (bytes(name).length > 256) revert IRewardsProgram.NameTooLong();
        if (bytes(description).length > 1024) revert IRewardsProgram.DescriptionTooLong();
        programCount++;
        uint32 programId = programCount;
        _programs[programId] = IRewardsProgram.Program(programId, code, name, description, true);
        programCodeToId[code] = programId;
        emit IRewardsProgram.ProgramCreated(programId, code, name);
        return programId;
    }

    function updateProgram(uint32 programId, string calldata name, string calldata description)
        external
        whenNotPaused
        nonReentrant
    {
        _requireActiveProgram(programId);
        _requireProgramAdminOrAdmin(programId);
        // L2: Prevent unbounded string storage
        if (bytes(name).length > 256) revert IRewardsProgram.NameTooLong();
        if (bytes(description).length > 1024) revert IRewardsProgram.DescriptionTooLong();
        _programs[programId].name = name;
        _programs[programId].description = description;
        emit IRewardsProgram.ProgramUpdated(programId, name);
    }

    function setProgramLogo(uint32 programId, string calldata logoCID)
        external whenNotPaused nonReentrant
    {
        _requireProgramAdminOrAdmin(programId);
        if (bytes(logoCID).length > 128) revert IRewardsProgram.NameTooLong();
        _programLogos[programId] = logoCID;
    }

    function deactivateProgram(uint32 programId)
        external
        whenNotPaused
        nonReentrant
    {
        _requireActiveProgram(programId);
        _requireProgramAdminOrAdmin(programId);
        _programs[programId].active = false;
        emit IRewardsProgram.ProgramDeactivated(programId);
    }

    function setTransferLimit(uint32 programId, uint8 limitPercent)
        external
        whenNotPaused
        nonReentrant
    {
        _requireActiveProgram(programId);
        _requireProgramAdminOrAdmin(programId);
        if (limitPercent > 100) revert IRewardsProgram.InvalidTransferLimit();
        uint8 old = _transferLimits[programId];
        _transferLimits[programId] = limitPercent;
        emit IRewardsProgram.TransferLimitUpdated(programId, old, limitPercent);
    }

    function getTransferLimit(uint32 programId) external view returns (uint8) {
        return _transferLimits[programId];
    }

    function updateMemberID(uint32 programId, bytes12 oldMemberID, bytes12 newMemberID)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (newMemberID == bytes12(0)) revert IRewardsProgram.InvalidMemberID();
        address key = memberIDLookup[oldMemberID][programId];
        if (key == address(0)) revert IRewardsProgram.MemberNotFound();
        if (memberIDLookup[newMemberID][programId] != address(0)) revert IRewardsProgram.DuplicateMemberID();

        delete memberIDLookup[oldMemberID][programId];
        memberIDLookup[newMemberID][programId] = key;
        _members[programId][key].memberID = newMemberID;

        emit IRewardsProgram.MemberIDUpdated(programId, key, oldMemberID, newMemberID);
    }

    // === MEMBER WALLET & REMOVAL (moved from RewardsProgram) ===

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

        // H1: Prevent wallet collision
        if (newWallet != address(0) && newWallet != storageKey) {
            address existing = _walletToStorageKey[programId][newWallet];
            if (existing != address(0) && existing != storageKey) revert IRewardsProgram.WalletAlreadyMapped();
        }

        member.wallet = newWallet;

        // M3: Update PA counter when wallet changes
        if (member.role == IRewardsProgram.MemberRole.ProgramAdmin) {
            if (oldWallet != address(0)) _programAdminCount[oldWallet]--;
            if (newWallet != address(0)) _programAdminCount[newWallet]++;
        }

        if (oldWallet != address(0) && oldWallet != storageKey) {
            delete _walletToStorageKey[programId][oldWallet];
        }
        if (newWallet != address(0) && newWallet != storageKey) {
            _walletToStorageKey[programId][newWallet] = storageKey;
        }

        emit IRewardsProgram.MemberWalletChanged(programId, storageKey, oldWallet, newWallet);
    }

    function removeMember(uint32 programId, address memberKey)
        external
        whenNotPaused
        nonReentrant
    {
        IRewardsProgram.Member storage member = _members[programId][memberKey];
        if (!member.active) revert IRewardsProgram.MemberNotFound();

        if (_balances[programId][memberKey].available > 0
            || _balances[programId][memberKey].permanentlyLocked > 0
            || _timeLocks[programId][memberKey].length > 0)
            revert IRewardsProgram.InsufficientBalance(0, 0);

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        if (!isAdmin) {
            address callerKey = _resolveStorageKey(programId, msg.sender);
            IRewardsProgram.Member storage caller = _members[programId][callerKey];
            if (!caller.active || caller.role != IRewardsProgram.MemberRole.ProgramAdmin)
                revert IRewardsProgram.UnauthorizedRole();
            if (member.role == IRewardsProgram.MemberRole.ProgramAdmin)
                revert IRewardsProgram.UnauthorizedRole();
            // H2: PA can only remove members in their own hierarchy
            if (!_isInParentChain(programId, memberKey, callerKey))
                revert IRewardsProgram.UnauthorizedRole();
        }

        // M3: Decrement PA counter
        if (member.role == IRewardsProgram.MemberRole.ProgramAdmin && member.wallet != address(0)) {
            _programAdminCount[member.wallet]--;
        }

        if (member.wallet != address(0) && member.wallet != memberKey) {
            delete _walletToStorageKey[programId][member.wallet];
        }

        // M5: Clean up _children array
        address parentKey = member.parent;
        if (parentKey != address(0)) _removeChild(programId, parentKey, memberKey);

        delete memberIDLookup[member.memberID][programId];
        member.active = false;
        emit IRewardsProgram.MemberRemoved(programId, memberKey);
    }

    // === ROLE & PROGRAM CHANGE ===

    /// @notice Change a member's role. Admin can set up to PA; PA can set up to TL.
    function setMemberRole(uint32 programId, bytes12 memberID, IRewardsProgram.MemberRole newRole)
        external whenNotPaused nonReentrant
    {
        if (newRole == IRewardsProgram.MemberRole.None) revert IRewardsProgram.InvalidRole();
        _requireActiveProgram(programId);

        address sk = memberIDLookup[memberID][programId];
        if (sk == address(0)) revert IRewardsProgram.MemberNotFound();
        IRewardsProgram.Member storage member = _members[programId][sk];
        if (!member.active) revert IRewardsProgram.MemberNotActive();

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);

        if (isAdmin) {
            if (newRole > IRewardsProgram.MemberRole.ProgramAdmin) revert IRewardsProgram.InvalidRole();
        } else {
            address callerKey = _resolveStorageKey(programId, msg.sender);
            IRewardsProgram.Member storage caller = _members[programId][callerKey];
            if (!caller.active || caller.role != IRewardsProgram.MemberRole.ProgramAdmin)
                revert IRewardsProgram.UnauthorizedRole();
            if (newRole > IRewardsProgram.MemberRole.TeamLeader)
                revert IRewardsProgram.UnauthorizedRole();
            if (!_isInParentChain(programId, sk, callerKey))
                revert IRewardsProgram.UnauthorizedRole();
        }

        IRewardsProgram.MemberRole oldRole = member.role;
        if (oldRole == newRole) return;

        // M3: Maintain _programAdminCount
        if (oldRole == IRewardsProgram.MemberRole.ProgramAdmin && member.wallet != address(0))
            _programAdminCount[member.wallet]--;
        if (newRole == IRewardsProgram.MemberRole.ProgramAdmin && member.wallet != address(0))
            _programAdminCount[member.wallet]++;

        member.role = newRole;
        emit IRewardsProgram.MemberRoleChanged(programId, sk, oldRole, newRole);
    }

    /// @notice Move a member to a different program. Admin only. Member must have zero balance and no children.
    function changeMemberProgram(
        uint32 programId, bytes12 memberID,
        uint32 newProgramId, bytes12 newParentMemberID
    )
        external whenNotPaused nonReentrant onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        _requireActiveProgram(programId);
        _requireActiveProgram(newProgramId);
        if (programId == newProgramId) revert IRewardsProgram.InvalidRole();

        address sk = memberIDLookup[memberID][programId];
        if (sk == address(0)) revert IRewardsProgram.MemberNotFound();
        IRewardsProgram.Member storage member = _members[programId][sk];
        if (!member.active) revert IRewardsProgram.MemberNotActive();

        // Require zero balance
        if (_balances[programId][sk].available > 0
            || _balances[programId][sk].permanentlyLocked > 0
            || _timeLocks[programId][sk].length > 0)
            revert IRewardsProgram.InsufficientBalance(0, 0);

        // Require no children
        if (_children[programId][sk].length > 0) revert IRewardsProgram.HasChildren();

        // Resolve new parent in target program
        address newParentKey = memberIDLookup[newParentMemberID][newProgramId];
        if (newParentKey == address(0)) revert IRewardsProgram.MemberNotFound();
        if (!_members[newProgramId][newParentKey].active) revert IRewardsProgram.MemberNotActive();

        // Prevent duplicate memberID in new program
        if (memberIDLookup[memberID][newProgramId] != address(0))
            revert IRewardsProgram.DuplicateMemberID();

        // Cache before cleanup
        address wallet = member.wallet;
        IRewardsProgram.MemberRole role = member.role;
        uint8 mType = member.memberType;
        bytes32 editHash = _editCodeHashes[programId][sk];

        // --- Deactivate in old program ---

        if (role == IRewardsProgram.MemberRole.ProgramAdmin && wallet != address(0))
            _programAdminCount[wallet]--;

        if (wallet != address(0) && wallet != sk)
            delete _walletToStorageKey[programId][wallet];

        address oldParent = member.parent;
        if (oldParent != address(0)) _removeChild(programId, oldParent, sk);
        delete memberIDLookup[memberID][programId];
        member.active = false;

        // --- Create in new program ---

        address newSk = wallet != address(0) ? wallet : _virtualAddr(memberID, newProgramId);
        if (_members[newProgramId][newSk].active) revert IRewardsProgram.MemberAlreadyExists();

        _members[newProgramId][newSk] = IRewardsProgram.Member({
            wallet: wallet,
            memberID: memberID,
            role: role,
            memberType: mType,
            programId: newProgramId,
            parent: newParentKey,
            active: true
        });
        memberIDLookup[memberID][newProgramId] = newSk;
        _children[newProgramId][newParentKey].push(newSk);

        if (wallet != address(0) && wallet != newSk)
            _walletToStorageKey[newProgramId][wallet] = newSk;

        if (editHash != bytes32(0))
            _editCodeHashes[newProgramId][newSk] = editHash;

        if (role == IRewardsProgram.MemberRole.ProgramAdmin && wallet != address(0))
            _programAdminCount[wallet]++;

        emit IRewardsProgram.MemberProgramChanged(programId, newProgramId, newSk, memberID);
    }

    // === EDIT CODE / CLAIM (commit-reveal, moved from RewardsProgram) ===

    function commitClaim(uint32 programId, bytes32 commitHash)
        external
        whenNotPaused
        nonReentrant
    {
        _claimCommits[programId][msg.sender] = commitHash;
        _claimCommitTimes[programId][msg.sender] = block.timestamp;
        emit IRewardsProgram.ClaimCommitted(programId, msg.sender);
    }

    function claimMember(uint32 programId, bytes12 memberID, bytes32 editCode)
        external
        whenNotPaused
        nonReentrant
    {
        bytes32 expectedCommit = keccak256(abi.encodePacked(memberID, editCode, msg.sender));
        if (_claimCommits[programId][msg.sender] != expectedCommit) revert IRewardsProgram.CommitRequired();
        uint256 commitTime = _claimCommitTimes[programId][msg.sender];
        if (block.timestamp < commitTime + MIN_COMMIT_DELAY) revert IRewardsProgram.CommitTooEarly();
        if (block.timestamp > commitTime + MAX_COMMIT_WINDOW) revert IRewardsProgram.CommitExpired();

        delete _claimCommits[programId][msg.sender];
        delete _claimCommitTimes[programId][msg.sender];

        address storageKey = memberIDLookup[memberID][programId];
        if (storageKey == address(0)) revert IRewardsProgram.MemberNotFound();
        IRewardsProgram.Member storage member = _members[programId][storageKey];
        if (!member.active) revert IRewardsProgram.MemberNotActive();

        if (member.wallet != address(0)) revert IRewardsProgram.InvalidEditCode();

        bytes32 storedHash = _editCodeHashes[programId][storageKey];
        if (storedHash == bytes32(0)) revert IRewardsProgram.InvalidEditCode();
        if (keccak256(abi.encodePacked(editCode)) != storedHash) revert IRewardsProgram.InvalidEditCode();

        // M6: Prevent overwriting existing wallet mapping
        if (_walletToStorageKey[programId][msg.sender] != address(0)) revert IRewardsProgram.WalletAlreadyMapped();

        member.wallet = msg.sender;
        _walletToStorageKey[programId][msg.sender] = storageKey;

        // M3: Update PA counter if claiming a PA member
        if (member.role == IRewardsProgram.MemberRole.ProgramAdmin) {
            _programAdminCount[msg.sender]++;
        }

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

    // === MEMBER TYPE MANAGEMENT ===

    /// @notice Change a member's type (parent or admin only).
    function setMemberType(uint32 programId, bytes12 memberID, uint8 newType)
        external
        whenNotPaused
        nonReentrant
    {
        if (newType > uint8(IRewardsProgram.MemberType.PSPartner)) revert IRewardsProgram.InvalidMemberType();

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

        uint8 oldType = member.memberType;
        member.memberType = newType;
        emit IRewardsProgram.MemberTypeChanged(programId, storageKey, oldType, newType);
    }

    // === REWARD TYPE MANAGEMENT (bitmap-based, per program, PA or admin) ===

    /// @notice Register a reward type for a program. typeId 0-255, name is a display label.
    function addRewardType(uint32 programId, uint8 typeId, bytes16 name)
        external
        whenNotPaused
        nonReentrant
    {
        _requireProgramAdminOrAdmin(programId);
        validRewardTypes[programId] |= (1 << uint256(typeId));
        rewardTypeNames[programId][typeId] = name;
        emit IRewardsProgram.RewardTypeAdded(programId, typeId, name);
    }

    /// @notice Remove a reward type from the valid set for a program.
    function removeRewardType(uint32 programId, uint8 typeId)
        external
        whenNotPaused
        nonReentrant
    {
        _requireProgramAdminOrAdmin(programId);
        validRewardTypes[programId] &= ~(1 << uint256(typeId));
        emit IRewardsProgram.RewardTypeRemoved(programId, typeId);
    }

    // === SUB-TYPE MANAGEMENT (per program, PA or admin) ===

    /// @notice Add a sub-type under a reward type for a specific program.
    function addSubType(uint32 programId, uint8 rewardType, uint8 subTypeId, bytes16 name)
        external
        whenNotPaused
        nonReentrant
    {
        _requireProgramAdminOrAdmin(programId);
        validSubTypes[programId][rewardType] |= (1 << uint256(subTypeId));
        subTypeNames[programId][rewardType][subTypeId] = name;
        emit IRewardsProgram.SubTypeAdded(programId, rewardType, subTypeId, name);
    }

    /// @notice Remove a sub-type.
    function removeSubType(uint32 programId, uint8 rewardType, uint8 subTypeId)
        external
        whenNotPaused
        nonReentrant
    {
        _requireProgramAdminOrAdmin(programId);
        validSubTypes[programId][rewardType] &= ~(1 << uint256(subTypeId));
        emit IRewardsProgram.SubTypeRemoved(programId, rewardType, subTypeId);
    }

    // === DETAILED DEPOSIT (with sub-type breakdown) ===

    /// @notice Deposit tokens with full metadata: reward type, note, and sub-type breakdown.
    function addTokensDetailed(
        uint32 programId,
        uint256 amount,
        uint8 rewardType,
        string calldata note,
        uint8[] calldata subTypeIds,
        uint128[] calldata subTypeQtys
    )
        external
        whenNotPaused
        nonReentrant
    {
        address key = _resolveStorageKey(programId, msg.sender);
        _requireMemberOrAdmin(programId, key);
        if (bytes(note).length > 128) revert IRewardsProgram.NoteTooLong();

        // Validate sub-type data
        if (subTypeIds.length != subTypeQtys.length) revert IRewardsProgram.InvalidSubTypeData();
        uint256 subTotal;
        uint256 subBitmap = validSubTypes[programId][rewardType];
        for (uint256 i; i < subTypeIds.length; i++) {
            if ((subBitmap & (1 << uint256(subTypeIds[i]))) == 0) revert IRewardsProgram.InvalidSubTypeData();
            subTotal += subTypeQtys[i];
        }
        if (subTotal != amount) revert IRewardsProgram.InvalidSubTypeData();

        // Perform deposit
        _addTokensCore(programId, msg.sender, key, amount, rewardType, note);

        // Emit sub-type breakdown linked to the deposit
        emit IRewardsProgram.DepositSubTypes(
            depositCount, programId, key, subTypeIds, subTypeQtys
        );
    }

    // === VIEW FUNCTIONS ===

    function getProgramLogo(uint32 programId) external view returns (string memory) {
        return _programLogos[programId];
    }

    function getMember(uint32 programId, address memberKey)
        external view returns (IRewardsProgram.Member memory)
    {
        IRewardsProgram.Member storage m = _members[programId][memberKey];
        if (m.active) return m;
        address resolved = _walletToStorageKey[programId][memberKey];
        if (resolved != address(0)) return _members[programId][resolved];
        return m;
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
        address key = _resolveStorageKey(programId, memberKey);
        IRewardsProgram.Balance storage bal = _balances[programId][key];
        available = bal.available;
        permanentlyLocked = bal.permanentlyLocked;
        IRewardsProgram.TimeLockTranche[] storage tranches = _timeLocks[programId][key];
        for (uint256 i = 0; i < tranches.length; i++) {
            totalTimeLocked += tranches[i].amount;
        }
    }

    /// @notice Returns all active reward type IDs and their names for a program.
    function getRewardTypes(uint32 programId) external view returns (uint8[] memory ids, bytes16[] memory names) {
        uint256 bitmap = validRewardTypes[programId];
        uint8[256] memory temp;
        uint256 count;
        for (uint256 i; i < 256; i++) {
            if (bitmap & (1 << i) != 0) {
                temp[count] = uint8(i);
                count++;
            }
        }
        ids = new uint8[](count);
        names = new bytes16[](count);
        for (uint256 i; i < count; i++) {
            ids[i] = temp[i];
            names[i] = rewardTypeNames[programId][temp[i]];
        }
    }

    /// @notice Returns all active sub-type IDs and names for a program + reward type.
    function getSubTypes(uint32 programId, uint8 rewardType)
        external view returns (uint8[] memory ids, bytes16[] memory names)
    {
        uint256 bitmap = validSubTypes[programId][rewardType];
        uint8[256] memory temp;
        uint256 count;
        for (uint256 i; i < 256; i++) {
            if (bitmap & (1 << i) != 0) {
                temp[count] = uint8(i);
                count++;
            }
        }
        ids = new uint8[](count);
        names = new bytes16[](count);
        for (uint256 i; i < count; i++) {
            ids[i] = temp[i];
            names[i] = subTypeNames[programId][rewardType][temp[i]];
        }
    }

    // === INTERNAL ===

    function _removeChild(uint32 programId, address parent, address child) internal {
        address[] storage siblings = _children[programId][parent];
        for (uint256 i = 0; i < siblings.length; i++) {
            if (siblings[i] == child) {
                siblings[i] = siblings[siblings.length - 1];
                siblings.pop();
                return;
            }
        }
    }

    /// @notice Require caller to be a PA in any program, or a global admin.
    /// @dev M3: Uses cached _programAdminCount for O(1) lookup instead of looping all programs.
    function _requireAnyProgramAdminOrAdmin() internal view {
        if (hasRole(ProposalTypes.ADMIN_ROLE, msg.sender)) return;
        if (_programAdminCount[msg.sender] > 0) return;
        revert IRewardsProgram.UnauthorizedRole();
    }

    function _requireProgramAdminOrAdmin(uint32 programId) internal view {
        if (hasRole(ProposalTypes.ADMIN_ROLE, msg.sender)) return;
        address key = _resolveStorageKey(programId, msg.sender);
        IRewardsProgram.Member storage m = _members[programId][key];
        if (!m.active || m.role != IRewardsProgram.MemberRole.ProgramAdmin)
            revert IRewardsProgram.UnauthorizedRole();
    }

    function _authorizeUpgrade(address) internal pure override {
        revert InvalidAddress(); // Extension is not upgradeable via UUPS
    }
}
