// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
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

    /// @notice Tunable parameters, indexed by the `P_*` identifiers. Index 0 is unused.
    /// @dev Held as a flat array rather than a packed struct on purpose. A struct needs a
    ///      13-branch chain with masked read-modify-write SSTOREs in both the setter and the
    ///      getter, which cost ~3.4 KiB of bytecode in a contract that already inherits ~14 KiB
    ///      of GovernanceModule. The array makes set and get O(1) with no branching. The trade
    ///      is a few extra cold SLOADs per call, worth a fraction of a cent on Base.
    ///      Read individual values with {paramValue} or the whole vector with {allParams}.
    uint256[14] internal _params;

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

        _params[P_BURN_FEE] = 50_000 * TOKEN_UNIT;
        _params[P_DEPOSIT] = 100_000 * TOKEN_UNIT;
        _params[P_MIN_VOTE_BASIS] = 10_000 * TOKEN_UNIT;
        _params[P_MIN_DURATION] = 3 days;
        _params[P_MAX_DURATION] = 30 days;
        _params[P_MEMBER_MULTIPLIER_BPS] = 20_000; // 2x
        _params[P_STAKE_WEIGHT_BPS] = 10_000; // 100%
        _params[P_QUORUM_BASIS] = 5_000_000 * TOKEN_UNIT;
        _params[P_QUORUM_VOTERS] = 15;
        _params[P_MAX_OPEN_PER_CREATOR] = 3;
        _params[P_CREATE_COOLDOWN] = 1 days;
        _params[P_MIN_POOL_JOIN_STAKE] = TOKEN_UNIT;
        _params[P_MIN_MEMBERSHIP_AGE] = 14 days;
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

    /// @notice Stages a parameter or integration change for the two-admin flow.
    /// @dev Encoding is deliberately canonical — unused fields must be zero — so one intended
    ///      change has exactly one on-chain representation. Without that, several differently
    ///      encoded proposals could describe the same action, which complicates review and
    ///      de-duplication.
    ///
    ///      `target` is always `address(this)` (the base rejects a zero target). That serialises
    ///      parameter governance: only one parameter proposal can be pending at a time, and an
    ///      expired one keeps blocking until `cleanupExpiredProposals` is called, because the
    ///      base's `pendingProposals` check does not test for expiry. Documented in the runbook
    ///      and covered by tests.
    function _createCustomProposal(
        uint8 proposalType,
        uint40 id,
        address target,
        bytes32 role,
        uint96 amount,
        address tokenAddress
    ) internal virtual override returns (bytes32) {
        // Reject the type first, so an unrecognised proposal reports InvalidProposalType rather
        // than a confusing complaint about field encoding.
        if (proposalType != PROPOSAL_SET_PARAM && proposalType != PROPOSAL_SET_INTEGRATION) {
            revert InvalidProposalType(proposalType);
        }
        if (target != address(this)) revert NonCanonicalProposalField();
        if (role != bytes32(0)) revert NonCanonicalProposalField();

        bytes32 proposalId;

        if (proposalType == PROPOSAL_SET_PARAM) {
            if (tokenAddress != address(0)) revert NonCanonicalProposalField();
            // Validated as a uint40 so a value like 2**32 + 1 cannot truncate to a valid id.
            if (id == 0 || id > P_LAST) revert InvalidParam(uint8(id));
            _validateParamValue(uint8(id), amount);

            proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(id, amount))
            );
            ProposalTypes.UnifiedProposal storage p = proposals[proposalId];
            _initializeProposal(p, target);
            p.proposalType = proposalType;
            // Persist BOTH payload fields explicitly. StorageToken's ChangeTreasuryFee once
            // omitted `amount` here and silently executed as zero; see StorageToken.sol:431-434.
            p.id = id;
            p.amount = amount;
        } else if (proposalType == PROPOSAL_SET_INTEGRATION) {
            if (amount != 0) revert NonCanonicalProposalField();
            if (id != I_STAKING_ENGINE && id != I_STORAGE_POOL) revert InvalidParam(uint8(id));

            // The new address travels in `tokenAddress`, not `target`, precisely so it may be
            // zero — that is how an integration is switched off.
            proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(id, tokenAddress))
            );
            ProposalTypes.UnifiedProposal storage p = proposals[proposalId];
            _initializeProposal(p, target);
            p.proposalType = proposalType;
            p.id = id;
            p.tokenAddress = tokenAddress;
        }

        return proposalId;
    }

    /// @dev Executes a staged change. Bounds are re-checked here, not just at creation: a
    ///      proposal sits for 24-48 hours and interacting parameters may have moved in between.
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        uint8 proposalType = proposal.proposalType;

        if (proposalType == PROPOSAL_SET_PARAM) {
            _applyParam(uint8(proposal.id), proposal.amount);
        } else if (proposalType == PROPOSAL_SET_INTEGRATION) {
            _applyIntegration(uint8(proposal.id), proposal.tokenAddress);
        } else {
            revert InvalidProposalType(proposalType);
        }
    }

    /// @dev Reverts unless `value` is inside the compile-time bounds for `paramId`.
    function _validateParamValue(uint8 paramId, uint256 value) internal pure {
        (uint256 lo, uint256 hi) = paramBounds(paramId); // reverts InvalidParam if unknown
        if (value < lo || value > hi) revert ParamOutOfBounds(paramId, value);
    }

    function _applyParam(uint8 paramId, uint256 value) internal {
        _validateParamValue(paramId, value);

        uint256 previous = _params[paramId];
        _params[paramId] = value;

        // Cross-field invariant: a window with min > max would make every duration invalid
        // and freeze subject creation entirely.
        if (_params[P_MIN_DURATION] > _params[P_MAX_DURATION]) {
            revert ParamOutOfBounds(paramId, value);
        }

        emit ParamUpdated(paramId, previous, value);
    }

    function _applyIntegration(uint8 slot, address newAddress) internal {
        address previous;
        if (slot == I_STAKING_ENGINE) {
            previous = stakingEngine;
            stakingEngine = newAddress;
        } else if (slot == I_STORAGE_POOL) {
            previous = storagePool;
            storagePool = newAddress;
        } else {
            revert InvalidParam(slot);
        }
        emit IntegrationUpdated(slot, previous, newAddress);
    }

    /// @dev Upgrades run through the full two-admin proposal flow: quorum, a 24h execution
    ///      delay and a 48h expiry window, all enforced by {GovernanceModule-_checkUpgrade}.
    function _authorizeUpgrade(
        address newImplementation
    ) internal nonReentrant whenNotPaused onlyRole(ProposalTypes.ADMIN_ROLE) override {
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }

    // ---------------------------------------------------------------------
    // Subjects
    // ---------------------------------------------------------------------

    /// @notice Posts a poll. Burns a non-refundable fee and locks a refundable deposit.
    /// @param title           Short human-readable question. Bounded; the long form lives in the CID.
    /// @param descriptionCID  IPFS CID for the full description.
    /// @param options         2-100 short ballot labels, non-empty, unique, <=64 bytes each.
    /// @param duration        Seconds until voting closes; must sit inside [minDuration, maxDuration].
    /// @return subjectId      Identifier of the new subject (ids start at 1).
    function createSubject(
        string calldata title,
        string calldata descriptionCID,
        string[] calldata options,
        uint256 duration
    ) external whenNotPaused nonReentrant returns (uint256 subjectId) {
        uint256 optionCount = options.length;
        if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
            revert InvalidOptionCount(optionCount);
        }
        if (bytes(title).length > MAX_TITLE_BYTES) revert TitleTooLong();
        if (bytes(descriptionCID).length > MAX_CID_BYTES) revert CidTooLong();
        if (duration < _params[P_MIN_DURATION] || duration > _params[P_MAX_DURATION]) {
            revert InvalidDuration(duration);
        }

        uint256 lastAt = lastCreateAt[msg.sender];
        if (lastAt != 0) {
            uint256 readyAt = lastAt + _params[P_CREATE_COOLDOWN];
            if (block.timestamp < readyAt) revert CreateCooldownActive(uint40(readyAt));
        }

        // "Open" means closeTime is still in the future, NOT "not yet finalized" — otherwise an
        // abandoned subject nobody bothers to finalize would occupy a creator's slot forever.
        uint256 openCount = _pruneCreatorOpen(msg.sender);
        if (openCount >= _params[P_MAX_OPEN_PER_CREATOR]) revert TooManyOpenSubjects(openCount);

        subjectId = ++subjectCount;

        // ---- effects ----
        Subject storage s = _subjects[subjectId];
        s.creator = msg.sender;
        s.createdAt = uint40(block.timestamp);
        s.closeTime = uint40(block.timestamp + duration);
        s.optionCount = uint16(optionCount);
        // Meaningful only once finalized, but seeded so a caller reading an open subject can
        // never mistake a default 0 for "option 0 is winning".
        s.winningOption = NO_WINNER;
        s.title = title;
        s.descriptionCID = descriptionCID;

        string[] storage stored = _options[subjectId];
        for (uint256 i = 0; i < optionCount; i++) {
            bytes memory label = bytes(options[i]);
            if (label.length == 0) revert OptionEmpty(i);
            if (label.length > MAX_OPTION_BYTES) revert OptionTooLong(i);
            // Duplicate or look-alike labels would split the vote and make a "winner" ambiguous.
            bytes32 labelHash = keccak256(label);
            if (_optionSeen[subjectId][labelHash]) revert DuplicateOption(i);
            _optionSeen[subjectId][labelHash] = true;
            stored.push(options[i]);
        }

        _creatorOpen[msg.sender].push(subjectId);
        lastCreateAt[msg.sender] = uint40(block.timestamp);

        uint256 fee = _params[P_BURN_FEE];
        uint256 depositAmount = _params[P_DEPOSIT];

        // ---- interactions ----
        // Burn straight from the creator rather than pulling in and then burning. StorageToken
        // skips the platform fee whenever `to == address(0)`, so this both avoids losing a slice
        // of the fee on an intermediate transfer and needs no delta accounting: `burnFrom`
        // destroys exactly `fee`.
        IFulaBurnable(address(token)).burnFrom(msg.sender, fee);

        uint256 received = _pullTokens(msg.sender, depositAmount);
        s.deposit = SafeCast.toUint96(received);
        totalDepositLiability += received;

        emit SubjectCreated(
            subjectId,
            msg.sender,
            s.createdAt,
            s.closeTime,
            uint16(optionCount),
            SafeCast.toUint96(fee),
            s.deposit,
            title,
            descriptionCID
        );
        emit SubjectOptions(subjectId, options);
    }

    /// @dev Drops subjects whose voting window has closed from a creator's occupied-slot list and
    ///      returns how many remain open. Bounded by `maxOpenPerCreator` (hard max 20).
    function _pruneCreatorOpen(address creator) internal returns (uint256) {
        uint256[] storage ids = _creatorOpen[creator];
        uint256 i = 0;
        while (i < ids.length) {
            if (_subjects[ids[i]].closeTime <= block.timestamp) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
            } else {
                i++;
            }
        }
        return ids.length;
    }

    /// @dev Moves tokens in and credits the amount that actually arrived. The token carries an
    ///      optional platform fee, so the received amount can be smaller than the amount asked
    ///      for; every liability must be based on what landed, never on what was requested.
    function _pullTokens(address from, uint256 amount) internal returns (uint256 received) {
        if (amount == 0) return 0;
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore) revert BalanceDecreased();
        received = balanceAfter - balanceBefore;
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

    /// @notice Current value of a tunable parameter, by `P_*` id.
    function paramValue(uint8 paramId) public view returns (uint256) {
        if (paramId == 0 || paramId > P_LAST) revert InvalidParam(paramId);
        return _params[paramId];
    }

    /// @notice The whole parameter vector, indexed by `P_*` id. Index 0 is unused.
    function allParams() external view returns (uint256[14] memory) {
        return _params;
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
