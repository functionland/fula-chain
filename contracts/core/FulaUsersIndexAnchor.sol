// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/GovernanceModule.sol";

/// @title FulaUsersIndexAnchor
/// @notice Single-slot anchor that records the latest *master-published*
///         users-index CBOR CID for the Fula network.
///
/// @dev Phase 3.2 chain-backup channel. The Fula master server runs
///      `mainnet-reward-server`, which calls `publish(cid, sequence)`
///      every ~12h (the cron cadence is shorter than IPNS lifetime —
///      see the master-independent-reads plan, section 3.2.c).
///
///      The contract stores **one** overwriting `(cid, sequence, ts)`
///      tuple — bounded forever, regardless of user count or write
///      volume. History lives in `Published` event logs, which are
///      free to read off-chain via standard log indexers.
///
///      Authorization: `publish` requires `CONTRACT_OPERATOR_ROLE`
///      (granted to the master via the standard governance proposal
///      flow in `GovernanceModule.createProposal(AddRole, ...)`).
///      The role is multi-sig-managed; revoking goes through the same
///      flow. Emergency `pause()` is wired via GovernanceModule's
///      `emergencyAction(1)` so admins can stop further submissions
///      without an upgrade.
///
///      `publish` enforces strict-monotonic sequence as a replay
///      defense: SDK clients reject any chain-fetched payload whose
///      embedded sequence regresses below their highest-seen value.
///      Even a compromised operator key cannot push a stale CID.
///
///      Storage layout: 1 slot for `latestCid` (bytes32), 1 slot
///      packing `sequence` (uint64) + `updatedAt` (uint64). 2 slots
///      total beyond what GovernanceModule already occupies.
contract FulaUsersIndexAnchor is GovernanceModule {
    /// @notice Latest published users-index CBOR CID.
    /// @dev Stored as the raw 32-byte multihash digest of the
    ///      content-addressed CBOR. SDK clients reconstruct the
    ///      full CIDv1 (codec=dag-cbor 0x71, multihash-fn=sha2-256
    ///      0x12, length=32). Encoding the digest (not the full
    ///      string CID) keeps storage at exactly one slot.
    bytes32 public latestCid;

    /// @notice Monotonic sequence — only ever increases.
    /// @dev Embedded inside the published CBOR payload itself; this
    ///      field mirrors that value so SDK chain-only readers can
    ///      verify the on-chain commitment without first fetching
    ///      bytes via gateway. Strict-monotonic enforcement here is
    ///      load-bearing: it stops any party (including a compromised
    ///      operator) from submitting a stale CID.
    uint64 public sequence;

    /// @notice `block.timestamp` of the most recent successful
    ///         publish. Diagnostic only.
    uint64 public updatedAt;

    /// @notice Emitted on every successful publish. Clients indexing
    ///         this log build a free off-chain history without
    ///         consuming on-chain storage.
    event Published(uint64 indexed seq, bytes32 cid, uint64 updatedAt);

    /// @notice Reverts on a non-monotonic sequence in `publish`.
    error NonMonotonicSequence(uint64 current, uint64 attempted);

    /// @notice Reverts on a zero CID submission.
    error EmptyCid();

    /// @notice Initialize the contract via the governance module's
    ///         standard owner+admin pattern PLUS a deployment-time
    ///         operator grant.
    ///
    /// @dev `initialOperator` is granted `CONTRACT_OPERATOR_ROLE`
    ///      directly here (bypassing the governance AddRole proposal
    ///      flow) so the master's chain-anchor cron can call `publish`
    ///      immediately after deploy without waiting for the 1-day
    ///      `ROLE_CHANGE_DELAY` × 2 round-trip of an AddRole proposal.
    ///      This is the only fast-path: every subsequent grant or
    ///      revoke of `CONTRACT_OPERATOR_ROLE` (whether to add a
    ///      second operator, replace the initial one, or fully
    ///      revoke it) MUST go through governance — see
    ///      `_executeCommonProposal` in `GovernanceModule.sol`.
    ///
    ///      The operator's `roleChangeTimeLock` is set the same way
    ///      owner/admin's are in `__GovernanceModule_init`: 1 day
    ///      from `block.timestamp`. Without this, governance could
    ///      re-grant or revoke the operator role at zero delay,
    ///      defeating the role-change discipline that protects every
    ///      other admin slot.
    ///
    ///      Trust model: the deployer is already trusted to ship the
    ///      bytecode and choose `initialOwner`/`initialAdmin`; adding
    ///      `initialOperator` as a constructor arg doesn't widen that
    ///      trust surface — it only removes operational dead time on
    ///      day one of every deployment.
    ///
    ///      `initialOperator` MAY equal `initialOwner` or
    ///      `initialAdmin` (e.g., a single-EOA bootstrap on staging),
    ///      but production deployments should keep all three distinct
    ///      to preserve the multi-sig invariant. We don't enforce
    ///      distinctness here — it's a deployment-time policy choice.
    function initialize(
        address initialOwner,
        address initialAdmin,
        address initialOperator
    )
        public
        initializer
    {
        if (
            initialOwner == address(0) ||
            initialAdmin == address(0) ||
            initialOperator == address(0)
        ) {
            revert InvalidAddress();
        }

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __GovernanceModule_init(initialOwner, initialAdmin);

        // Bootstrap: grant the operator role immediately so the
        // master's chain-anchor cron is functional from the first
        // block after deployment. Mirrors the pattern at
        // `GovernanceModule.__GovernanceModule_init` lines 117-123
        // for the owner/admin slots: grant role + set the same
        // ROLE_CHANGE_DELAY timelock the governance flow would set.
        _grantRole(ProposalTypes.CONTRACT_OPERATOR_ROLE, initialOperator);
        timeConfigs[initialOperator].roleChangeTimeLock = uint64(
            block.timestamp + ProposalTypes.ROLE_CHANGE_DELAY
        );
    }

    /// @notice Submit the new users-index CID + sequence.
    /// @dev Operator-fast-path. No proposal/timelock — the chain cron
    ///      runs every 12h and must not be gated by multi-sig. The
    ///      role itself is gated by multi-sig (granting/revoking is a
    ///      governance proposal); compromise of the role-holder still
    ///      cannot regress `sequence`.
    /// @param cid 32-byte multihash digest of the dag-cbor users-index
    /// @param newSequence monotonic sequence (strictly greater than
    ///                    current `sequence`)
    function publish(bytes32 cid, uint64 newSequence)
        external
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.CONTRACT_OPERATOR_ROLE)
    {
        if (cid == bytes32(0)) revert EmptyCid();
        if (newSequence <= sequence) {
            revert NonMonotonicSequence(sequence, newSequence);
        }
        latestCid = cid;
        sequence = newSequence;
        updatedAt = uint64(block.timestamp);
        emit Published(newSequence, cid, updatedAt);
    }

    /// @notice Single read for SDK clients. Returns the full tuple
    ///         in one call to avoid an extra RPC round-trip.
    function latest()
        external
        view
        returns (bytes32 cid, uint64 seq, uint64 ts)
    {
        return (latestCid, sequence, updatedAt);
    }

    /// @notice Required by GovernanceModule. This contract has no
    ///         custom proposal types — built-in (AddRole, RemoveRole,
    ///         Upgrade, Recovery) cover everything the operator
    ///         needs. Revert with the canonical InvalidProposalType
    ///         error so the governance UI surfaces a clear message.
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal pure override returns (bytes32) {
        revert InvalidProposalType(proposalType);
    }

    /// @notice Required by GovernanceModule. No custom types ⇒
    ///         no custom executions. Defensive revert in case a
    ///         caller somehow constructs a non-built-in proposalId.
    function _executeCustomProposal(bytes32) internal pure override {
        revert InvalidProposalType(0);
    }

    /// @notice UUPS upgrade authorization — delegates entirely to
    ///         GovernanceModule's proposal-based flow. Mirrors the
    ///         pattern used by every other GovernanceModule consumer
    ///         in this repo (TestnetMiningRewards, RewardEngine, …).
    function _authorizeUpgrade(address newImplementation)
        internal
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }
}
