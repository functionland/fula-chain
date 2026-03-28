// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";
import "../governance/interfaces/IStoragePool.sol";
import "./interfaces/IRewardsProgram.sol";

/// @title RewardsStorageBase
/// @notice Shared storage layout and helpers for RewardsProgram + RewardsExtension.
/// @dev Both RewardsProgram and RewardsExtension inherit from this to guarantee
///      identical storage slots (required for fallback-delegatecall pattern).
abstract contract RewardsStorageBase is Initializable, GovernanceModule {
    using SafeERC20 for IERC20;

    uint8 constant MAX_HIERARCHY_DEPTH = 50;
    uint8 constant MAX_TIME_LOCK_TRANCHES = 50;
    uint32 constant MAX_LOCK_TIME_DAYS = 1095;

    // === STATE VARIABLES (layout order matters for UUPS + delegatecall) ===

    IERC20 public token;
    address public stakingPool;

    uint32 public programCount;
    uint64 public depositCount;          // packed with programCount

    mapping(uint32 => IRewardsProgram.Program) internal _programs;
    mapping(bytes8 => uint32) public programCodeToId;

    address public extension;            // was: adminMemberIDs (dead)

    mapping(uint32 => mapping(address => IRewardsProgram.Member)) internal _members;
    mapping(uint32 => mapping(address => address[])) internal _children;
    mapping(bytes12 => mapping(uint32 => address)) public memberIDLookup;

    mapping(uint32 => mapping(address => IRewardsProgram.Balance)) internal _balances;
    mapping(uint32 => mapping(address => IRewardsProgram.TimeLockTranche[])) internal _timeLocks;

    uint256 public validRewardTypes;     // bitmap — was: transferCount (dead)
    mapping(uint8 => bytes16) public rewardTypeNames; // was: _transfers (dead)

    mapping(uint32 => mapping(uint8 => uint256)) public validSubTypes; // was: _memberPrograms (dead)
    mapping(uint32 => mapping(uint8 => mapping(uint8 => bytes16))) public subTypeNames; // from __gap

    mapping(uint32 => mapping(address => bytes32)) internal _editCodeHashes;

    mapping(uint32 => uint8) internal _transferLimits; // 0=no limit, 1-100=max % client can transfer to parent

    uint256[37] private __gap;

    // === SHARED INTERNAL HELPERS ===

    function _virtualAddr(bytes12 memberID, uint32 programId) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(memberID, programId)))));
    }

    function _findActingWallet(uint32 programId, address storageKey) internal view returns (address) {
        address current = storageKey;
        for (uint256 i = 0; i < MAX_HIERARCHY_DEPTH; i++) {
            IRewardsProgram.Member storage m = _members[programId][current];
            if (m.wallet != address(0)) return m.wallet;
            current = m.parent;
            if (current == address(0)) return address(0);
        }
        return address(0);
    }

    function _requireActiveProgram(uint32 programId) internal view {
        if (programId == 0 || programId > programCount) revert IRewardsProgram.ProgramNotFound();
        if (!_programs[programId].active) revert IRewardsProgram.ProgramNotActive();
    }

    function _requireMemberOrAdmin(uint32 programId, address wallet) internal view {
        if (hasRole(ProposalTypes.ADMIN_ROLE, wallet)) return;
        if (!_members[programId][wallet].active) revert IRewardsProgram.MemberNotFound();
    }

    function _isInParentChain(uint32 programId, address child, address ancestor) internal view returns (bool) {
        address current = child;
        for (uint256 i = 0; i < MAX_HIERARCHY_DEPTH; i++) {
            address p = _members[programId][current].parent;
            if (p == address(0)) return false;
            if (p == ancestor) return true;
            current = p;
        }
        return false;
    }

    function _isSubMember(uint32 programId, address caller, address target, bool isAdmin) internal view returns (bool) {
        if (!_members[programId][target].active) return false;
        if (isAdmin) return true;
        return _isInParentChain(programId, target, caller);
    }

    function _addTokensCore(
        uint32 programId, address payer, address beneficiary,
        uint256 amount, uint8 rewardType, string calldata note
    ) internal {
        if (amount == 0) revert IRewardsProgram.InvalidAmount();
        _requireActiveProgram(programId);
        token.safeTransferFrom(payer, stakingPool, amount);
        IPool(stakingPool).receiveTokens(payer, amount);
        _balances[programId][beneficiary].available += amount;
        depositCount++;
        emit IRewardsProgram.TokensDeposited(
            depositCount, programId, beneficiary, amount, rewardType, note
        );
    }

    // === GOVERNANCE OVERRIDES (defaults — RewardsProgram overrides _authorizeUpgrade) ===

    function _createCustomProposal(
        uint8 proposalType, uint40, address, bytes32, uint96, address
    ) internal virtual override returns (bytes32) {
        revert InvalidProposalType(proposalType);
    }

    function _handleCustomProposalExpiry(bytes32) internal virtual override {}

    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        revert InvalidProposalType(uint8(proposal.proposalType));
    }
}
