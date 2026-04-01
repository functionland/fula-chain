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

    // === MOVED FUNCTIONS (from RewardsProgram — saves ~350 bytes in main contract) ===

    function updateProgram(uint32 programId, string calldata name, string calldata description)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        _requireActiveProgram(programId);
        _programs[programId].name = name;
        _programs[programId].description = description;
        emit IRewardsProgram.ProgramUpdated(programId, name);
    }

    function deactivateProgram(uint32 programId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        _requireActiveProgram(programId);
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

    // === REWARD TYPE MANAGEMENT (bitmap-based, admin only) ===

    /// @notice Register a reward type. typeId 0-255, name is a display label.
    function addRewardType(uint8 typeId, bytes16 name)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        validRewardTypes |= (1 << uint256(typeId));
        rewardTypeNames[typeId] = name;
        emit IRewardsProgram.RewardTypeAdded(typeId, name);
    }

    /// @notice Remove a reward type from the valid set.
    function removeRewardType(uint8 typeId)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        validRewardTypes &= ~(1 << uint256(typeId));
        emit IRewardsProgram.RewardTypeRemoved(typeId);
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

    /// @notice Returns all active reward type IDs and their names.
    function getRewardTypes() external view returns (uint8[] memory ids, bytes16[] memory names) {
        uint256 bitmap = validRewardTypes;
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
            names[i] = rewardTypeNames[temp[i]];
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
