// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICommunityVoting
/// @notice Events, errors and shared types for {CommunityVoting}.
/// @dev Follows the repo idiom of keeping a contract's event/error/type surface in a
///      dedicated interface (see {IStoragePool}, {IStorageToken}).
interface ICommunityVoting {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Tunable economic and timing parameters. Packed into three slots.
    /// @dev Every field is clamped to a compile-time MIN/MAX bound at both proposal
    ///      creation and execution. See {CommunityVoting.paramBounds}.
    struct Params {
        // --- slot 1 ---
        uint96 burnFee;             // wei, burned outright on subject creation
        uint96 deposit;             // wei, refundable only if the participation quorum is met
        uint32 minDuration;         // seconds
        uint32 maxDuration;         // seconds
        // --- slot 2 ---
        uint96 minVoteBasis;        // wei, minimum combined basis to cast a vote
        uint96 quorumBasis;         // wei, capital component of the refund quorum
        uint32 createCooldown;      // seconds between subject creations by one address
        uint32 minMembershipAge;    // seconds a pool membership must predate a subject
        // --- slot 3 ---
        uint96 minPoolJoinStake;    // wei, a peer's OWN locked tokens required for the multiplier
        uint32 memberMultiplierBps; // 10_000 = 1x
        uint32 quorumVoters;        // distinct-voter component of the refund quorum
        uint16 stakeWeightBps;      // 10_000 = staked tokens count at full weight
        uint16 maxOpenPerCreator;   // concurrent open subjects per creator
    }

    /// @notice One poll.
    /// @dev `status` is 0 while unfinalized and 1 once {CommunityVoting.finalize} has run.
    ///      A subject exists iff `createdAt != 0`.
    struct Subject {
        // --- slot 1 ---
        address creator;
        uint40 createdAt;
        uint40 closeTime;
        uint16 optionCount;
        // --- slot 2 ---
        uint96 deposit;             // actually received, net of any transfer fee
        uint32 voterCount;
        uint16 winningOption;
        uint8 status;
        bool tied;                  // true => no mandate (includes the all-zero-tally case)
        bool depositRefundable;     // set by finalize; consumed by claimDeposit
        bool depositSettled;        // true once the deposit was refunded or burned
        // --- slot 3 ---
        uint128 totalPowerCast;
        uint128 totalBasis;
        // --- reference slots ---
        string title;
        string descriptionCID;
    }

    /// @notice One wallet's immutable vote on one subject.
    struct Receipt {
        // --- slot 1 ---
        uint128 lockedAmount;       // freshly locked wei, refundable after close
        uint128 power;              // sqrt-derived, multiplier applied
        // --- slot 2 ---
        uint128 basis;              // lockedAmount + weighted stake, pre-sqrt
        uint16 option;
        bool claimed;
        bool multiplied;            // whether the DePIN membership multiplier was applied
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event SubjectCreated(
        uint256 indexed subjectId,
        address indexed creator,
        uint40 createdAt,
        uint40 closeTime,
        uint16 optionCount,
        uint96 burnedFee,
        uint96 deposit,
        string title,
        string descriptionCID
    );

    /// @dev Emitted alongside {SubjectCreated} so indexers get the ballot without an archive node.
    event SubjectOptions(uint256 indexed subjectId, string[] options);

    event VoteCast(
        uint256 indexed subjectId,
        address indexed voter,
        uint16 indexed option,
        uint128 basis,
        uint128 power,
        bool multiplied
    );

    /// @dev Records the outcome. Reserved as the hook a future execution module would consume.
    event SubjectFinalized(
        uint256 indexed subjectId,
        uint16 winningOption,
        bool tied,
        bool quorumMet,
        uint128 totalPowerCast,
        uint128 totalBasis,
        uint32 voterCount
    );

    event TokensClaimed(uint256 indexed subjectId, address indexed voter, uint128 amount);
    event DepositClaimed(uint256 indexed subjectId, address indexed creator, uint96 amount);
    event DepositBurned(uint256 indexed subjectId, address indexed creator, uint96 amount);

    event ParamUpdated(uint8 indexed paramId, uint256 oldValue, uint256 newValue);
    event IntegrationUpdated(uint8 indexed slot, address oldAddress, address newAddress);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice The inherited `Recovery` proposal may not target the governed token.
    /// @dev Without this, two admins could transfer every voter's locked FULA out of the
    ///      contract via GovernanceModule's built-in recovery path. See docs/voting-design.md §5.
    error RecoveryBlocked();

    error InvalidParam(uint8 paramId);
    error ParamOutOfBounds(uint8 paramId, uint256 value);
    error NonCanonicalProposalField();

    error InvalidOptionCount(uint256 count);
    error OptionEmpty(uint256 index);
    error OptionTooLong(uint256 index);
    error DuplicateOption(uint256 index);
    error TitleTooLong();
    error CidTooLong();
    error InvalidDuration(uint256 duration);

    error CreateCooldownActive(uint40 until);
    error TooManyOpenSubjects(uint256 open);

    error SubjectNotFound(uint256 subjectId);
    error SubjectClosed(uint256 subjectId);
    error SubjectStillOpen(uint256 subjectId);
    error AlreadyFinalized(uint256 subjectId);
    error NotFinalized(uint256 subjectId);

    error AlreadyVoted(uint256 subjectId, address voter);
    error InvalidOption(uint16 option);
    error BasisBelowMinimum(uint256 basis, uint256 required);

    error TooManyStakeIndices(uint256 count);
    error StakeIndicesNotAscending();
    error StakeNotQualifying(uint256 index);

    error MembershipNotEligible();

    error NothingToClaim();
    error AlreadyClaimed();
    error DepositAlreadySettled();
    error NotSubjectCreator();
    error QuorumNotMet();

    /// @dev Guards the balance-delta accounting against an unchecked subtraction.
    error BalanceDecreased();
    error ZeroAmount();
}
