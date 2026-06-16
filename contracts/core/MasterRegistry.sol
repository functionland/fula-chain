// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";

/// @title MasterRegistry
/// @notice On-chain registry of FEDERATED MASTERS ("operators") for the Fula
///         network (Phase 3). An operator runs the full backend stack (S3
///         gateway + pinning API + billing + ipfs-cluster writer). To be a
///         master an operator must STAKE FULA; consumers (clients, followers,
///         the discovery Worker) fetch "current masters + their info" via a
///         read-only Base RPC call against this contract.
/// @dev    Additive, deployed alongside the live contracts; nothing in the
///         existing system depends on it until consumers opt in. UUPS via
///         GovernanceModule, same idiom as StakingPool.
///
///         Two pools are kept strictly separate, mirroring the off-chain plan:
///           - STAKE = a slashable bond (revoke -> forfeited to a sink).
///           - (deal funding lives in DealEscrow, NOT here.)
///         Exit is cooldown-gated so an operator cannot stake, serve, and
///         instantly withdraw before any dispute window.
contract MasterRegistry is
    Initializable,
    GovernanceModule
{
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Types ────────────────────────────────────────────────────────────
    enum OperatorStatus { None, Active, Draining, Revoked }

    struct Operator {
        OperatorStatus status;
        uint256 stake;            // FULA bonded by this operator
        uint64  since;            // first-registered timestamp
        uint64  unbondAt;         // when stake becomes withdrawable (0 = not unbonding)
        bytes32 clusterPeerId;    // the operator's ipfs-cluster writer peer id (low 32 bytes ok for 12D3 keyed lookups off-chain)
        string  endpoints;        // opaque JSON: {"s3":..,"api":..,"webui":..,"gateway":..} for the read-only API
    }

    // ─── Storage ──────────────────────────────────────────────────────────
    IERC20 public fulaToken;
    uint256 public minStake;          // minimum bond to be an active master
    uint64  public unbondingPeriod;   // cooldown between requestUnregister and withdraw
    address public slashSink;         // where revoked stake goes (e.g. DealEscrow repair pool / treasury)

    mapping(address => Operator) private _operators;
    address[] private _operatorList;  // append-only; status field gates "active"
    mapping(address => uint256) private _operatorIndex; // 1-based; 0 = not present

    uint256[45] private __gap;

    // ─── Events ───────────────────────────────────────────────────────────
    event OperatorRegistered(address indexed operator, uint256 stake, bytes32 clusterPeerId);
    event OperatorStakeIncreased(address indexed operator, uint256 added, uint256 total);
    event OperatorEndpointsUpdated(address indexed operator, string endpoints);
    event OperatorUnbondRequested(address indexed operator, uint64 unbondAt);
    event OperatorWithdrawn(address indexed operator, uint256 amount);
    event OperatorRevoked(address indexed operator, uint256 slashedStake);
    event MinStakeSet(uint256 minStake);
    event UnbondingPeriodSet(uint64 period);
    event SlashSinkSet(address indexed sink);

    // ─── Errors ───────────────────────────────────────────────────────────
    error InvalidAmount();
    error BelowMinStake(uint256 provided, uint256 required);
    error AlreadyRegistered();
    error NotRegistered();
    error NotUnbonding();
    error StillBonded(uint64 unbondAt);
    error WrongStatus();

    /// @notice Initialize the registry.
    /// @param _fulaToken      FULA ERC-20 used for the operator bond.
    /// @param _minStake       minimum bond to be an active master.
    /// @param _unbondingPeriod cooldown (seconds) before withdrawal after unbond request.
    /// @param _slashSink      destination for revoked (slashed) stake.
    /// @param initialOwner    owner.
    /// @param initialAdmin    admin.
    function initialize(
        address _fulaToken,
        uint256 _minStake,
        uint64 _unbondingPeriod,
        address _slashSink,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        if (_fulaToken == address(0) || _slashSink == address(0)) revert InvalidAddress();
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();

        __GovernanceModule_init(initialOwner, initialAdmin);
        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner);

        fulaToken = IERC20(_fulaToken);
        minStake = _minStake;
        unbondingPeriod = _unbondingPeriod;
        slashSink = _slashSink;

        emit MinStakeSet(_minStake);
        emit UnbondingPeriodSet(_unbondingPeriod);
        emit SlashSinkSet(_slashSink);
    }

    // ─── Operator lifecycle ───────────────────────────────────────────────

    /// @notice Become a federated master by bonding >= minStake FULA.
    /// @dev Caller must `approve` this contract for `stakeAmount` first.
    function registerOperator(uint256 stakeAmount, bytes32 clusterPeerId, string calldata endpoints)
        external
        whenNotPaused
        nonReentrant
    {
        Operator storage op = _operators[msg.sender];
        if (op.status != OperatorStatus.None) revert AlreadyRegistered();
        if (stakeAmount < minStake) revert BelowMinStake(stakeAmount, minStake);

        fulaToken.safeTransferFrom(msg.sender, address(this), stakeAmount);

        op.status = OperatorStatus.Active;
        op.stake = stakeAmount;
        op.since = uint64(block.timestamp);
        op.unbondAt = 0;
        op.clusterPeerId = clusterPeerId;
        op.endpoints = endpoints;

        _operatorList.push(msg.sender);
        _operatorIndex[msg.sender] = _operatorList.length; // 1-based

        emit OperatorRegistered(msg.sender, stakeAmount, clusterPeerId);
    }

    /// @notice Add more FULA to the bond (also clears any in-progress unbond,
    ///         re-activating a Draining operator).
    function increaseStake(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert InvalidAmount();
        Operator storage op = _operators[msg.sender];
        if (op.status == OperatorStatus.None || op.status == OperatorStatus.Revoked) revert NotRegistered();

        fulaToken.safeTransferFrom(msg.sender, address(this), amount);
        op.stake += amount;
        // Re-arm: topping up cancels an exit and restores Active service.
        op.unbondAt = 0;
        op.status = OperatorStatus.Active;

        emit OperatorStakeIncreased(msg.sender, amount, op.stake);
    }

    /// @notice Update the operator's published endpoints (read by the off-chain
    ///         master-list API). Does not affect stake/status.
    function updateEndpoints(string calldata endpoints) external whenNotPaused {
        Operator storage op = _operators[msg.sender];
        if (op.status != OperatorStatus.Active && op.status != OperatorStatus.Draining) revert WrongStatus();
        op.endpoints = endpoints;
        emit OperatorEndpointsUpdated(msg.sender, endpoints);
    }

    /// @notice Begin exiting: marks the operator Draining and starts the
    ///         cooldown. The operator stops being a valid settler immediately
    ///         (canSettleEpoch -> false) but cannot withdraw the bond until the
    ///         cooldown elapses, so any open dispute window can resolve first.
    function requestUnregister() external whenNotPaused nonReentrant {
        Operator storage op = _operators[msg.sender];
        if (op.status != OperatorStatus.Active) revert WrongStatus();
        op.status = OperatorStatus.Draining;
        op.unbondAt = uint64(block.timestamp) + unbondingPeriod;
        emit OperatorUnbondRequested(msg.sender, op.unbondAt);
    }

    /// @notice After the cooldown, withdraw the bond and leave the registry.
    function withdrawStake() external whenNotPaused nonReentrant {
        Operator storage op = _operators[msg.sender];
        if (op.status != OperatorStatus.Draining) revert NotUnbonding();
        if (block.timestamp < op.unbondAt) revert StillBonded(op.unbondAt);

        uint256 amount = op.stake;
        // Effects before interaction.
        _removeOperator(msg.sender);

        if (amount > 0) fulaToken.safeTransfer(msg.sender, amount);
        emit OperatorWithdrawn(msg.sender, amount);
    }

    // ─── Admin / slashing ─────────────────────────────────────────────────

    /// @notice Revoke a misbehaving operator and forfeit its bond to the sink.
    ///         This is the registry's slashing lever (distinct from the
    ///         StoragePool provider slashing). Admin-gated; conservative use.
    function revokeOperator(address operator) external whenNotPaused nonReentrant onlyRole(ProposalTypes.ADMIN_ROLE) {
        Operator storage op = _operators[operator];
        if (op.status == OperatorStatus.None || op.status == OperatorStatus.Revoked) revert NotRegistered();

        uint256 slashed = op.stake;
        _removeOperator(operator);
        if (slashed > 0) fulaToken.safeTransfer(slashSink, slashed);
        emit OperatorRevoked(operator, slashed);
    }

    function setMinStake(uint256 _minStake) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        minStake = _minStake;
        emit MinStakeSet(_minStake);
    }

    function setUnbondingPeriod(uint64 _period) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        unbondingPeriod = _period;
        emit UnbondingPeriodSet(_period);
    }

    function setSlashSink(address _sink) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (_sink == address(0)) revert InvalidAddress();
        slashSink = _sink;
        emit SlashSinkSet(_sink);
    }

    // ─── Views (read-only API surface) ────────────────────────────────────

    /// @notice A registered operator in good standing (Active + bond >= min).
    ///         The check DealEscrow/StorageProof use to gate epoch settlement.
    function canSettleEpoch(address operator) external view returns (bool) {
        Operator storage op = _operators[operator];
        return op.status == OperatorStatus.Active && op.stake >= minStake;
    }

    function isOperator(address operator) external view returns (bool) {
        return _operators[operator].status == OperatorStatus.Active;
    }

    function getOperator(address operator) external view returns (Operator memory) {
        return _operators[operator];
    }

    function operatorCount() external view returns (uint256) {
        return _operatorList.length;
    }

    /// @notice Paginated operator addresses (consumers then call getOperator).
    ///         Bounded by `limit` so the read stays O(limit), never O(all).
    function listOperators(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 n = _operatorList.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = _operatorList[i];
        }
    }

    // ─── Internal ─────────────────────────────────────────────────────────

    /// @dev Swap-remove from the list and clear the record.
    function _removeOperator(address operator) internal {
        uint256 idx1 = _operatorIndex[operator]; // 1-based
        if (idx1 != 0) {
            uint256 i = idx1 - 1;
            uint256 lastI = _operatorList.length - 1;
            if (i != lastI) {
                address moved = _operatorList[lastI];
                _operatorList[i] = moved;
                _operatorIndex[moved] = i + 1;
            }
            _operatorList.pop();
            _operatorIndex[operator] = 0;
        }
        delete _operators[operator];
    }

    // ─── GovernanceModule plumbing (no custom proposals; mirrors StakingPool) ─
    function _createCustomProposal(uint8 proposalType, uint40, address, bytes32, uint96, address)
        internal virtual override returns (bytes32)
    {
        revert InvalidProposalType(proposalType);
    }

    function _handleCustomProposalExpiry(bytes32) internal virtual override {}

    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        revert InvalidProposalType(uint8(proposal.proposalType));
    }

    /// @notice Authorize upgrade through governance.
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
