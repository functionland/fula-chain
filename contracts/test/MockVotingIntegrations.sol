// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Exposes the exact integer square root CommunityVoting uses, so it can be fuzzed
///         against an off-chain reference without adding a preview function to production code.
contract VotingMathHarness {
    function sqrt(uint256 value) external pure returns (uint256) {
        return Math.sqrt(value);
    }

    /// @dev The full power formula, in the same order the contract applies it: root first, then
    ///      the multiplier. Folding the multiplier inside the root would turn "2x" into ~1.41x.
    function power(uint256 basis, uint256 multiplierBps) external pure returns (uint256) {
        return (Math.sqrt(basis) * multiplierBps) / 10_000;
    }
}

/// @notice Test double for the slice of StakingEngineLinear that CommunityVoting reads.
/// @dev Mirrors the real contract's public `stakes` mapping exactly, so the generated getter has
///      the same six-value shape CommunityVoting decodes. Using a double rather than the real
///      engine is deliberate: states such as "stake exists but is inactive" or "lock ends one
///      second before close" are what need coverage, and they are impractical to stage against
///      the real engine, which has no early-exit path. Behaviour against the deployed contract is
///      covered separately by the Base fork test.
contract MockStakingEngine {
    struct StakeInfo {
        uint256 amount;
        uint256 rewardDebt;
        uint256 lockPeriod;
        uint256 startTime;
        address referrer;
        bool isActive;
    }

    mapping(address => StakeInfo[]) public stakes;

    function addStake(
        address user,
        uint256 amount,
        uint256 lockPeriod,
        uint256 startTime,
        bool isActive
    ) external {
        stakes[user].push(
            StakeInfo({
                amount: amount,
                rewardDebt: 0,
                lockPeriod: lockPeriod,
                startTime: startTime,
                referrer: address(0),
                isActive: isActive
            })
        );
    }

    function setActive(address user, uint256 index, bool isActive) external {
        stakes[user][index].isActive = isActive;
    }

    function stakeCount(address user) external view returns (uint256) {
        return stakes[user].length;
    }
}

/// @notice Test double for the slice of StoragePool that CommunityVoting reads.
/// @dev `joinTimestamp` is keyed by peer id globally in the real contract and is NOT cleared when
///      a peer is removed unless it was the member's last one, so a stale non-zero timestamp can
///      outlive the membership. This double keeps membership and timestamp independently
///      settable precisely so that case can be tested.
contract MockStoragePool {
    mapping(uint32 => mapping(bytes32 => address)) public peerIdToMember;
    mapping(uint32 => mapping(bytes32 => uint256)) public peerLockedTokens;
    mapping(bytes32 => uint32) public joinTimestamp;
    mapping(address => bool) public isForfeited;

    function setMember(
        uint32 poolId,
        bytes32 peerId,
        address member,
        uint256 lockedTokens,
        uint32 joinedAt
    ) external {
        peerIdToMember[poolId][peerId] = member;
        peerLockedTokens[poolId][peerId] = lockedTokens;
        joinTimestamp[peerId] = joinedAt;
    }

    /// @dev Clears membership while deliberately leaving `joinTimestamp` behind, reproducing the
    ///      real contract's removal asymmetry.
    function clearMembership(uint32 poolId, bytes32 peerId) external {
        delete peerIdToMember[poolId][peerId];
        delete peerLockedTokens[poolId][peerId];
    }

    function setForfeited(address account, bool flag) external {
        isForfeited[account] = flag;
    }

    function getPeerIdInfo(uint32 poolId, bytes32 peerId)
        external
        view
        returns (address member, uint256 lockedTokens)
    {
        member = peerIdToMember[poolId][peerId];
        lockedTokens = peerLockedTokens[poolId][peerId];
    }
}
