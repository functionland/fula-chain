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
        bool depositRefundable;     // informational: set by finalize, and by claimDeposit when it
                                    // pays out without finalize having run. The authoritative
                                    // gate is depositSettled plus the live quorum comparison.
        bool depositSettled;        // true once the deposit was refunded or burned
        // --- slot 3 ---
        uint128 totalPowerCast;
        uint128 totalBasis;
        // --- slots 4 and 5 ---
        // Every rule that decides an outcome is snapshotted when the subject is created.
        //
        // Refund thresholds: evaluating them live would let a later governance change
        // retroactively decide whether a creator gets their deposit back.
        //
        // Power rules: evaluating THOSE live would be worse. Receipts are immutable, so early
        // voters are locked into the rules in force when they voted; changing the multiplier,
        // the stake weight or the eligibility gates mid-poll would hand late voters a different
        // exchange rate and silently reweight a vote already in progress.
        uint96 quorumBasisAt;
        uint32 quorumVotersAt;
        uint32 memberMultiplierBpsAt;
        uint32 stakerMultiplierBpsAt;
        uint16 stakeWeightBpsAt;
        uint96 minVoteBasisAt;
        uint96 minPoolJoinStakeAt;
        // --- reference slots ---
        /// @notice Short human-readable question.
        string title;
        /// @notice IPFS CID of the full proposal text. Held in state, not only in the creation
        ///         event, so the pointer to a subject's full text is readable from the contract
        ///         itself and cannot be lost with an indexer.
        string descriptionCID;
        // NOTE: the ballot LABELS are deliberately NOT stored — only their keccak256 hashes, in
        // index order (see `_optionHashes`). Holding a dynamic string ARRAY per subject, plus the
        // encoder to read it back, was the expensive part; two single strings are cheap by
        // comparison. The labels are published in {SubjectOptions}, the hashes keep the ballot
        // tamper-evident, and votes are cast against indices fixed at creation.
    }

    /// @notice One wallet's immutable vote on one subject.
    struct Receipt {
        // --- slot 1 ---
        uint128 lockedAmount;       // freshly locked wei, refundable after close
        uint128 power;              // sqrt-derived, multiplier applied
        // --- slot 2 ---
        uint128 basis;              // lockedAmount + weighted stake, pre-sqrt
        uint16 option;
        bool voted;                 // explicit flag: a valid vote may carry zero fresh lock
        bool claimed;
        /// @notice Total commitment multiplier applied to this vote, in bps (10_000 = 1x).
        /// @dev Records the combined pool-membership and staker boosts, so the exact weighting a
        ///      vote received stays auditable after the fact even if parameters later change.
        uint32 multiplierBps;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @dev The title and description CID are NOT repeated here: both live in the subject's state
    ///      and are readable with {CommunityVoting.getSubject}, so duplicating them in the log
    ///      would only cost bytecode this contract does not have to spare.
    event SubjectCreated(
        uint256 indexed subjectId,
        address indexed creator,
        uint40 createdAt,
        uint40 closeTime,
        uint16 optionCount,
        uint96 burnedFee,
        uint96 deposit
    );

    /// @dev Emitted alongside {SubjectCreated} so indexers get the ballot without an archive node.
    event SubjectOptions(uint256 indexed subjectId, string[] options);

    event VoteCast(
        uint256 indexed subjectId,
        address indexed voter,
        uint16 indexed option,
        uint128 basis,
        uint128 power,
        uint32 multiplierBps
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

    error AlreadyVoted(uint256 subjectId, address voter);
    error InvalidOption(uint16 option);
    error BasisBelowMinimum(uint256 basis, uint256 required);

    error TooManyStakeIndices(uint256 count);
    error StakeIndicesNotAscending();
    error StakeNotQualifying(uint256 index);

    error MembershipNotEligible();
    /// @notice An optional integration (staking engine / storage pool) is not configured.
    error IntegrationDisabled(uint8 slot);

    error NothingToClaim();
    error AlreadyClaimed();
    error DepositAlreadySettled();
    /// @notice The deposit met quorum and belongs to the creator, so it cannot be burned.
    error DepositIsRefundable();
    error NotSubjectCreator();
    error QuorumNotMet();

    /// @dev Guards the balance-delta accounting against an unchecked subtraction.
    error BalanceDecreased();
}
