// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRewardsProgram Interface
/// @notice Contains all shared types, events, and errors for the RewardsProgram contract
interface IRewardsProgram {
    // === ENUMS ===

    enum MemberRole {
        None,
        Client,
        TeamLeader,
        ProgramAdmin
    }

    enum MemberType {
        Free,
        Vip,
        Elite,
        PSPartner
    }

    // === STRUCTS ===

    struct Program {
        uint32 id;
        bytes8 code;
        string name;
        string description;
        bool active;
    }

    struct Member {
        address wallet;
        bytes12 memberID;
        MemberRole role;
        uint8 memberType;   // MemberType enum — packs with role in slot 2 padding
        uint32 programId;
        address parent;
        bool active;
    }

    struct TimeLockTranche {
        uint128 amount;
        uint64 unlockTime;
    }

    struct Balance {
        uint256 available;
        uint256 permanentlyLocked;
    }

    // === EVENTS ===

    event ProgramCreated(uint32 indexed programId, bytes8 code, string name);
    event ProgramAdminAssigned(uint32 indexed programId, address indexed wallet, bytes12 memberID);
    event MemberAdded(
        uint32 indexed programId,
        address indexed wallet,
        address indexed parent,
        MemberRole role,
        uint8 memberType,
        bytes12 memberID
    );
    event TokensDeposited(
        uint256 indexed depositId,
        uint32 indexed programId,
        address indexed wallet,
        uint256 amount,
        uint8 rewardType,
        string note
    );
    event TokensTransferredToMember(
        uint32 indexed programId,
        address indexed from,
        address indexed to,
        uint256 amount,
        bool locked,
        uint32 lockTimeDays,
        string note
    );
    event TokensTransferredToParent(
        uint32 indexed programId,
        address indexed from,
        address indexed to,
        uint256 amount,
        string note
    );
    event TokensWithdrawn(uint32 indexed programId, address indexed wallet, uint256 amount);
    event TimeLockResolved(uint32 indexed programId, address indexed wallet, uint256 amount);
    event ProgramUpdated(uint32 indexed programId, string name);
    event ProgramDeactivated(uint32 indexed programId);
    event MemberIDUpdated(uint32 indexed programId, address indexed wallet, bytes12 oldMemberID, bytes12 newMemberID);
    event MemberRemoved(uint32 indexed programId, address indexed wallet);
    event MemberWalletChanged(uint32 indexed programId, address indexed memberKey, address oldWallet, address newWallet);
    event MemberClaimed(uint32 indexed programId, address indexed memberKey, address indexed wallet);
    event EditCodeHashSet(uint32 indexed programId, address indexed memberKey);
    event MemberTypeChanged(uint32 indexed programId, address indexed memberKey, uint8 oldType, uint8 newType);
    event RewardTypeAdded(uint8 indexed typeId, bytes16 name);
    event RewardTypeRemoved(uint8 indexed typeId);
    event SubTypeAdded(uint32 indexed programId, uint8 indexed rewardType, uint8 subTypeId, bytes16 name);
    event SubTypeRemoved(uint32 indexed programId, uint8 indexed rewardType, uint8 subTypeId);
    event DepositSubTypes(
        uint256 indexed depositId,
        uint32 indexed programId,
        address indexed depositor,
        uint8[] subTypeIds,
        uint128[] quantities
    );
    event ExtensionUpdated(address indexed oldExtension, address indexed newExtension);
    event ExtensionChangeProposed(address indexed proposedExtension, uint256 executeAfter);
    event ExtensionChangeCancelled(address indexed cancelledExtension);
    event ClaimCommitted(uint32 indexed programId, address indexed claimer);

    // === ERRORS ===

    error InvalidProgramCode();
    error DuplicateProgramCode();
    error ProgramNotFound();
    error ProgramNotActive();
    error MemberAlreadyExists();
    error MemberNotFound();
    error MemberNotActive();
    error InvalidMemberID();
    error DuplicateMemberID();
    error InsufficientBalance(uint256 requested, uint256 available);
    error NotSubMember();
    error NotInParentChain();
    error InvalidAmount();
    error InvalidRole();
    error UnauthorizedRole();
    error NoteTooLong();
    error InvalidMemberType();
    error InvalidRewardType();
    error InvalidSubTypeData();
    error LockTimeTooLong();
    error MaxTimeLockTranchesReached();
    error NoParentFound();
    error InvalidEditCode();
    error ExtensionNotSet();
    error TransferExceedsLimit(uint256 requested, uint256 maxAllowed);
    error InvalidTransferLimit();
    error WalletAlreadyMapped();
    error PoolTransferFailed();
    error CommitRequired();
    error CommitTooEarly();
    error CommitExpired();
    error ExtensionAlreadySet();
    error ExtensionChangeNotReady();
    error NoPendingExtensionChange();
    error NameTooLong();
    error DescriptionTooLong();

    event TransferLimitUpdated(uint32 indexed programId, uint8 oldLimit, uint8 newLimit);
}
