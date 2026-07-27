// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";
import "../governance/interfaces/ICommunityVoting.sol";

/// @notice Minimal view of the burn surface StorageToken exposes.
/// @dev `burn`/`burnFrom` bypass the platform fee because {StorageToken-_update} skips the
///      fee whenever `to == address(0)`, and they increment `voluntarilyBurned` so burning
///      here cannot create fresh headroom under the bridge supply cap.
interface IFulaBurnable {
    function burn(uint256 value) external;
    function burnFrom(address account, uint256 value) external;
}

/// @title CommunityVoting
/// @notice Quadratic-style, signaling-only community polls backed by locked FULA.
/// @dev See `docs/voting-design.md` for the full design record, threat model and the
///      reasoning behind each guard. Highlights that are easy to get wrong:
///
///      1. {createProposal} is overridden to block the inherited `Recovery` proposal type
///         against the governed token. Without that override two admins could transfer
///         every voter's locked balance out of this contract.
///      2. Claims are deliberately NOT `whenNotPaused`; a pause must never trap user funds.
///      3. `finalize` performs no external calls, so a token pause or a blacklist can never
///         prevent a poll's result from being recorded.
contract CommunityVoting is Initializable, GovernanceModule, ICommunityVoting {
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @dev Contract-local proposal types. 0-11 are the shared {ProposalTypes} enum and
    ///      12/13 are reserved by StorageToken for its bridge minters, so these start at 14.
    ///      The shared enum is deliberately NOT extended: it is inherited by ~10 live contracts.
    uint8 internal constant PROPOSAL_SET_PARAM = 14;
    uint8 internal constant PROPOSAL_SET_INTEGRATION = 15;

    // Parameter identifiers, packed into the proposal's `uint40 id` field.
    uint8 internal constant P_BURN_FEE = 1;
    uint8 internal constant P_DEPOSIT = 2;
    uint8 internal constant P_MIN_VOTE_BASIS = 3;
    uint8 internal constant P_MIN_DURATION = 4;
    uint8 internal constant P_MAX_DURATION = 5;
    uint8 internal constant P_MEMBER_MULTIPLIER_BPS = 6;
    uint8 internal constant P_STAKE_WEIGHT_BPS = 7;
    uint8 internal constant P_QUORUM_BASIS = 8;
    uint8 internal constant P_QUORUM_VOTERS = 9;
    uint8 internal constant P_MAX_OPEN_PER_CREATOR = 10;
    uint8 internal constant P_CREATE_COOLDOWN = 11;
    uint8 internal constant P_MIN_POOL_JOIN_STAKE = 12;
    uint8 internal constant P_MIN_MEMBERSHIP_AGE = 13;
    uint8 internal constant P_LAST = 13;

    // Integration slots for PROPOSAL_SET_INTEGRATION.
    uint8 internal constant I_STAKING_ENGINE = 1;
    uint8 internal constant I_STORAGE_POOL = 2;

    uint256 internal constant TOKEN_UNIT = 10 ** 18;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @dev Ballot shape limits. Options are stored on-chain by design, so they are tightly
    ///      bounded; the long-form question body lives behind `descriptionCID`.
    uint16 internal constant MIN_OPTIONS = 2;
    uint16 internal constant MAX_OPTIONS = 100;
    uint256 internal constant MAX_OPTION_BYTES = 64;
    uint256 internal constant MAX_TITLE_BYTES = 256;
    uint256 internal constant MAX_CID_BYTES = 100;

    /// @dev Bounds the per-vote stake scan. `StakingEngineLinear` allows at most 100 active
    ///      stakes per user; 50 keeps a vote comfortably cheap while covering realistic holders.
    uint256 internal constant MAX_STAKE_INDICES = 50;

    uint8 internal constant STATUS_OPEN = 0;
    uint8 internal constant STATUS_FINALIZED = 1;

    /// @dev Sentinel written to `winningOption` when there is no mandate (tie, or zero votes).
    uint16 internal constant NO_WINNER = type(uint16).max;

    // ---------------------------------------------------------------------
    // Storage — first child slot is 11 under the current gap-less GovernanceModule.
    // Do NOT declare a leading __gap[40]; that absorber is only for children whose live
    // implementation was recorded WITH the parent gap. See contracts/UPGRADING.md.
    // ---------------------------------------------------------------------

    IERC20 public token;
    address public stakingEngine;   // zero => staked balances contribute no voting power
    address public storagePool;     // zero => the membership multiplier is unavailable

    Params public params;

    uint256 public subjectCount;

    mapping(uint256 => Subject) internal _subjects;
    mapping(uint256 => string[]) internal _options;
    /// @dev Guards against duplicate/lookalike option labels within one subject.
    mapping(uint256 => mapping(bytes32 => bool)) internal _optionSeen;
    mapping(uint256 => mapping(uint16 => uint128)) public tally;
    mapping(uint256 => mapping(address => Receipt)) internal _receipts;

    /// @dev Subject ids a creator currently occupies a slot with. Pruned by `closeTime` on
    ///      every create, so an abandoned un-finalized subject cannot eat a slot forever.
    mapping(address => uint256[]) internal _creatorOpen;
    mapping(address => uint40) public lastCreateAt;

    /// @dev Running total of what the contract owes users, so solvency is checkable on-chain.
    uint256 public totalLockedLiability;
    uint256 public totalDepositLiability;

    uint256[50] private __gap;

    // ---------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------

    /// @param _token          StorageToken (FULA) proxy on this chain.
    /// @param _stakingEngine  StakingEngineLinear proxy, or zero to disable stake-derived power.
    /// @param _storagePool    StoragePool proxy, or zero to disable the membership multiplier.
    function initialize(
        address _token,
        address _stakingEngine,
        address _storagePool,
        address initialOwner,
        address initialAdmin
    ) public initializer {
        if (_token == address(0)) revert InvalidAddress();
        __GovernanceModule_init(initialOwner, initialAdmin);

        token = IERC20(_token);
        stakingEngine = _stakingEngine;
        storagePool = _storagePool;

        params = Params({
            burnFee: uint96(50_000 * TOKEN_UNIT),
            deposit: uint96(100_000 * TOKEN_UNIT),
            minDuration: uint32(3 days),
            maxDuration: uint32(30 days),
            minVoteBasis: uint96(10_000 * TOKEN_UNIT),
            quorumBasis: uint96(5_000_000 * TOKEN_UNIT),
            createCooldown: uint32(1 days),
            minMembershipAge: uint32(14 days),
            minPoolJoinStake: uint96(TOKEN_UNIT),
            memberMultiplierBps: 20_000,
            quorumVoters: 15,
            stakeWeightBps: 10_000,
            maxOpenPerCreator: 3
        });
    }

    // ---------------------------------------------------------------------
    // Governance overrides
    // ---------------------------------------------------------------------

    /// @notice Creates a governance proposal, refusing any recovery of the governed token.
    /// @dev GovernanceModule's `Recovery` proposal type transfers an arbitrary ERC20 from this
    ///      contract's balance to an arbitrary target, guarded only by `tokenAddress != address(this)`.
    ///      This contract custodies voter locks and creator deposits denominated in `token`, so
    ///      inheriting that path unchanged would hand two admins a drain of every user's funds.
    ///      Recovery of unrelated tokens accidentally sent here remains available.
    ///
    ///      This override MUST ship in the first deployed implementation: adding it later would
    ///      require an upgrade, and trusting admins to perform that upgrade is exactly the
    ///      assumption the design removes.
    ///
    ///      IMPLEMENTATION NOTE: Solidity does not permit `super.f()` for a function the parent
    ///      declared `external`, so this cannot simply guard-and-delegate. The body below is a
    ///      faithful mirror of {GovernanceModule-createProposal} with exactly one behavioural
    ///      difference — the `RecoveryBlocked` check. Every branch is covered by dedicated tests
    ///      so any future divergence from the parent is caught rather than assumed away.
    function createProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address tokenAddress
    )
        external
        virtual
        override
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
        returns (bytes32)
    {
        if (target == address(0)) revert InvalidAddress();

        // ---- the one deviation from the inherited implementation ----
        if (
            proposalType == uint8(ProposalTypes.ProposalType.Recovery) &&
            tokenAddress == address(token)
        ) {
            revert RecoveryBlocked();
        }
        // -------------------------------------------------------------

        _validateTimelock(msg.sender);
        _validateQuorum(ProposalTypes.ADMIN_ROLE);

        if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);

        bytes32 proposalId;

        if (
            proposalType == uint8(ProposalTypes.ProposalType.AddRole) ||
            proposalType == uint8(ProposalTypes.ProposalType.RemoveRole)
        ) {
            if (
                role != ProposalTypes.ADMIN_ROLE &&
                role != ProposalTypes.CONTRACT_OPERATOR_ROLE &&
                role != ProposalTypes.BRIDGE_OPERATOR_ROLE &&
                role != ProposalTypes.POOL_ADMIN_ROLE
            ) revert InvalidRole(role);

            if (proposalType == uint8(ProposalTypes.ProposalType.AddRole)) {
                if (timeConfigs[target].roleChangeTimeLock != 0) revert AlreadyOwnsRole(target);
            }
            proposalId = _createRoleChangeProposal(target, role, proposalType);
        } else if (proposalType == uint8(ProposalTypes.ProposalType.Upgrade)) {
            if (target == address(this)) revert AlreadyUpgraded();
            proposalId = _createUpgradeProposal(target);
            upgradeProposals[target] = proposalId;
        } else if (proposalType == uint8(ProposalTypes.ProposalType.Recovery)) {
            // Reachable only for tokens other than `token` — stray-asset rescue.
            if (tokenAddress == address(this)) revert Failed(1);
            if (amount == 0) revert AmountMustBePositive();

            proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, tokenAddress, amount))
            );
            ProposalTypes.UnifiedProposal storage recovery = proposals[proposalId];
            _initializeProposal(recovery, target);
            recovery.proposalType = proposalType;
            recovery.tokenAddress = tokenAddress;
            recovery.amount = amount;
        } else {
            proposalId = _createCustomProposal(proposalType, id, target, role, amount, tokenAddress);
        }

        proposalRegistry[proposalCount] = proposalId;
        proposalIndex[proposalId] = proposalCount;
        proposalCount += 1;
        pendingProposals[target].proposalType = proposalType;

        emit ProposalCreated(proposalId, proposalType, target, role, amount, tokenAddress, msg.sender);
        _updateActivityTimestamp();
        return proposalId;
    }

    /// @dev Filled in by Step 2 of the implementation plan.
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal virtual override returns (bytes32) {
        revert InvalidProposalType(proposalType);
    }

    /// @dev Filled in by Step 2 of the implementation plan.
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        revert InvalidProposalType(uint8(proposal.proposalType));
    }

    /// @dev Upgrades run through the full two-admin proposal flow: quorum, a 24h execution
    ///      delay and a 48h expiry window, all enforced by {GovernanceModule-_checkUpgrade}.
    function _authorizeUpgrade(
        address newImplementation
    ) internal nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) override {
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Hard, compile-time bounds for a tunable parameter.
    /// @dev Exposed as a single function rather than ~26 constant getters to keep the
    ///      deployed bytecode small. Governance cannot set a value outside these bounds.
    function paramBounds(uint8 paramId) public pure returns (uint256 minValue, uint256 maxValue) {
        if (paramId == P_BURN_FEE) return (1_000 * TOKEN_UNIT, 2_000_000 * TOKEN_UNIT);
        if (paramId == P_DEPOSIT) return (10_000 * TOKEN_UNIT, 10_000_000 * TOKEN_UNIT);
        if (paramId == P_MIN_VOTE_BASIS) return (100 * TOKEN_UNIT, 1_000_000 * TOKEN_UNIT);
        if (paramId == P_MIN_DURATION) return (1 days, 90 days);
        if (paramId == P_MAX_DURATION) return (1 days, 90 days);
        if (paramId == P_MEMBER_MULTIPLIER_BPS) return (10_000, 50_000);
        if (paramId == P_STAKE_WEIGHT_BPS) return (0, 10_000);
        if (paramId == P_QUORUM_BASIS) return (100_000 * TOKEN_UNIT, 100_000_000 * TOKEN_UNIT);
        if (paramId == P_QUORUM_VOTERS) return (3, 1_000);
        if (paramId == P_MAX_OPEN_PER_CREATOR) return (1, 20);
        if (paramId == P_CREATE_COOLDOWN) return (0, 7 days);
        if (paramId == P_MIN_POOL_JOIN_STAKE) return (0, 10_000_000 * TOKEN_UNIT);
        if (paramId == P_MIN_MEMBERSHIP_AGE) return (0, 90 days);
        revert InvalidParam(paramId);
    }

    function getSubject(uint256 subjectId) external view returns (Subject memory) {
        Subject storage s = _subjects[subjectId];
        if (s.createdAt == 0) revert SubjectNotFound(subjectId);
        return s;
    }

    function getOptions(uint256 subjectId) external view returns (string[] memory) {
        if (_subjects[subjectId].createdAt == 0) revert SubjectNotFound(subjectId);
        return _options[subjectId];
    }

    function getReceipt(uint256 subjectId, address voter) external view returns (Receipt memory) {
        return _receipts[subjectId][voter];
    }

    /// @notice Full tally vector, so a tie or a zero-turnout result is independently verifiable.
    function getTally(uint256 subjectId) external view returns (uint128[] memory result) {
        Subject storage s = _subjects[subjectId];
        if (s.createdAt == 0) revert SubjectNotFound(subjectId);
        uint16 n = s.optionCount;
        result = new uint128[](n);
        for (uint16 i = 0; i < n; i++) {
            result[i] = tally[subjectId][i];
        }
    }
}
