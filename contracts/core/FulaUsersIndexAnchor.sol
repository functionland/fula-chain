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
    ///         standard owner+admin pattern. The deployment script
    ///         passes the master operator's address as `initialAdmin`
    ///         and the multi-sig as `initialOwner`. Granting the
    ///         actual `CONTRACT_OPERATOR_ROLE` to the master is a
    ///         post-deploy step — see `scripts/deployFulaUsersIndexAnchor.ts`.
    function initialize(address initialOwner, address initialAdmin)
        public
        initializer
    {
        if (initialOwner == address(0) || initialAdmin == address(0)) {
            revert InvalidAddress();
        }

        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __GovernanceModule_init(initialOwner, initialAdmin);
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
