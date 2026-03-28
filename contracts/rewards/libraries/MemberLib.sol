// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IRewardsProgram.sol";

/// @title MemberLib
/// @notice Library for member management and hierarchy validation in RewardsProgram
library MemberLib {
    uint8 constant MAX_HIERARCHY_DEPTH = 50;

    /// @notice Add a member to a program
    /// @param storageKey Pre-computed key (wallet for wallet-based, virtual address for walletless)
    /// @param wallet The actual wallet (address(0) for walletless)
    function addMember(
        mapping(uint32 => mapping(address => IRewardsProgram.Member)) storage members,
        mapping(uint32 => mapping(address => address[])) storage children,
        mapping(bytes12 => mapping(uint32 => address)) storage memberIDLookup,
        uint32 programId,
        address storageKey,
        address wallet,
        bytes12 memberID,
        IRewardsProgram.MemberRole role,
        address parent
    ) internal {
        if (memberID == bytes12(0)) revert IRewardsProgram.InvalidMemberID();
        if (members[programId][storageKey].active) revert IRewardsProgram.MemberAlreadyExists();
        if (memberIDLookup[memberID][programId] != address(0)) revert IRewardsProgram.DuplicateMemberID();

        members[programId][storageKey] = IRewardsProgram.Member({
            wallet: wallet,
            memberID: memberID,
            role: role,
            memberType: 0,
            programId: programId,
            parent: parent,
            active: true
        });

        memberIDLookup[memberID][programId] = storageKey;
        children[programId][parent].push(storageKey);
    }

    /// @notice Validate that caller has authority to add a member with the given role
    function validateAddAuthority(
        mapping(uint32 => mapping(address => IRewardsProgram.Member)) storage members,
        uint32 programId,
        address caller,
        IRewardsProgram.MemberRole targetRole,
        bool isAdmin
    ) internal view {
        if (targetRole == IRewardsProgram.MemberRole.None) revert IRewardsProgram.InvalidRole();
        if (isAdmin) return;

        IRewardsProgram.Member storage callerMember = members[programId][caller];
        if (!callerMember.active) revert IRewardsProgram.MemberNotFound();

        if (callerMember.role == IRewardsProgram.MemberRole.ProgramAdmin) {
            if (targetRole == IRewardsProgram.MemberRole.ProgramAdmin) revert IRewardsProgram.UnauthorizedRole();
        } else if (callerMember.role == IRewardsProgram.MemberRole.TeamLeader) {
            if (targetRole != IRewardsProgram.MemberRole.Client) revert IRewardsProgram.UnauthorizedRole();
        } else {
            revert IRewardsProgram.UnauthorizedRole();
        }
    }

    /// @notice Check if an address is in the parent chain of a member
    function isInParentChain(
        mapping(uint32 => mapping(address => IRewardsProgram.Member)) storage members,
        uint32 programId,
        address child,
        address ancestor
    ) internal view returns (bool) {
        address current = child;
        for (uint256 i = 0; i < MAX_HIERARCHY_DEPTH; i++) {
            address parent = members[programId][current].parent;
            if (parent == address(0)) return false;
            if (parent == ancestor) return true;
            current = parent;
        }
        return false;
    }

    /// @notice Check if target is a sub-member (direct or indirect) of caller
    function isSubMember(
        mapping(uint32 => mapping(address => IRewardsProgram.Member)) storage members,
        uint32 programId,
        address caller,
        address target,
        bool isAdmin
    ) internal view returns (bool) {
        if (!members[programId][target].active) return false;
        if (isAdmin) return true;
        return isInParentChain(members, programId, target, caller);
    }
}
