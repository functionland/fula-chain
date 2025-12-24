// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../governance/GovernanceModule.sol";
import "../governance/libraries/ProposalTypes.sol";
import "./StorageToken.sol";
import "./StoragePool.sol";
import "./StakingPool.sol";

/// @title RewardEngine
/// @notice Manages mining and storage rewards for pool members
/// @dev Inherits governance functionality from GovernanceModule
/// @dev Uses upgradeable pattern to allow for future improvements
contract RewardEngine is GovernanceModule {
    using SafeERC20 for IERC20;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Events
    event MiningRewardsClaimed(address indexed account, bytes32 indexed peerId, uint32 indexed poolId, uint256 amount);
    event StorageRewardsClaimed(address indexed account, bytes32 indexed peerId, uint32 indexed poolId, uint256 amount);
    event OnlineStatusSubmitted(uint32 indexed poolId, address indexed submitter, uint256 count, uint256 timestamp);
    event MonthlyRewardPerPeerUpdated(uint256 oldAmount, uint256 newAmount);
    event ExpectedPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event RewardPoolSet(address indexed stakingPool);
    event TotalRewardsDistributedUpdated(uint256 totalDistributed);
    event UserTotalRewardsUpdated(address indexed user, uint256 totalClaimed);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed recipient, uint256 amount);
    event CircuitBreakerActivated(address indexed triggeredBy, uint256 blockNumber);
    event CircuitBreakerReset(address indexed resetBy, uint256 blockNumber, bool isAutoReset);
    event OnlineStatusesMigrated(uint32 indexed poolId, uint256 timestampsProcessed, uint256 lastTimestamp, bool complete);

    // Errors
    error InvalidAmount();
    error InvalidPoolId();
    error InvalidPeerId();
    error NotPoolCreator();
    error NotPoolMember();
    error InsufficientRewards();
    error NoRewardsToClaim();
    error InvalidTimeRange();
    error BatchTooLarge();
    error InvalidOnlineStatus();
    error CircuitBreakerTripped();
    error InvalidRecipient();
    error InsufficientBalance();
    error DeprecatedFunction();
    error NoDataToMigrate();
    error MigrationAlreadyComplete();
    error MigrationNotComplete();
    error ExpectedPeriodChangeBlocked();

    // Constants
    uint256 public constant MAX_BATCH_SIZE = 250;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant SECONDS_PER_MONTH = 30 days;
    uint256 public constant DEFAULT_EXPECTED_PERIOD = 8 hours;
    uint256 public constant DEFAULT_MONTHLY_REWARD_PER_PEER = 8000 * 10**18; // 8000 tokens per peer per month
    uint256 public constant MAX_HISTORICAL_SUBMISSION = 7 days; // Maximum 1 week back
    uint256 public constant MAX_FUTURE_SUBMISSION = 1 minutes; // Maximum 1 minute future
    uint256 public constant MAX_MONTHLY_REWARD_PER_PEER = 96000 * 10**18; // 96000 tokens per month
    uint256 public constant DEFAULT_CLAIM_PERIODS_PER_TX = 90; // Default periods to process per claim transaction (~30 days at 8hr periods)
    uint256 public constant MAX_CLAIM_PERIODS_LIMIT = 90; // Hard cap on periods per claim to prevent abuse
    
    // V2 Constants - O(1) lookup allows much higher limits
    // IMPORTANT: These three constants must stay synchronized
    uint256 public constant SIX_MONTHS_IN_PERIODS = 540; // 6 months at 8hr periods (base constant)
    uint256 public constant DEFAULT_CLAIM_PERIODS_PER_TX_V2 = SIX_MONTHS_IN_PERIODS;
    uint256 public constant MAX_CLAIM_PERIODS_LIMIT_V2 = SIX_MONTHS_IN_PERIODS;
    uint256 public constant MAX_VIEW_PERIODS_V2 = SIX_MONTHS_IN_PERIODS;

    // State variables
    StorageToken public token;
    StoragePool public storagePool;
    StakingPool public stakingPool;

    uint256 public monthlyRewardPerPeer;
    uint256 public expectedPeriod;
    uint256 public rewardSystemStartTime; // When the reward system became active

    // Online status tracking - optimized for zero-loop batch operations
    // poolId => timestamp => array of peerIds that were online
    mapping(uint32 => mapping(uint256 => bytes32[])) public onlineStatus;

    // Linked-list for efficient timestamp storage - O(1) insertions
    // poolId => timestamp => next timestamp (0 means end of list)
    mapping(uint32 => mapping(uint256 => uint256)) public timestampNext;

    // Head of linked list for each pool (0 means empty list)
    mapping(uint32 => uint256) public timestampHead;

    // Check if timestamp exists: poolId => timestamp => exists
    mapping(uint32 => mapping(uint256 => bool)) public timestampExists;

    // Claimed rewards tracking to prevent double claiming
    // account => peerId => poolId => lastClaimedTimestamp
    mapping(address => mapping(bytes32 => mapping(uint32 => uint256))) public lastClaimedRewards;

    // Track last submission timestamp per period to handle multiple submissions
    // poolId => period => lastSubmissionTimestamp
    mapping(uint32 => mapping(uint256 => uint256)) public lastPeriodSubmission;

    // Track monthly rewards per peer ID to enforce caps
    // peerId => poolId => month => claimedAmount
    mapping(bytes32 => mapping(uint32 => mapping(uint256 => uint256))) public monthlyRewardsClaimed;

    // V2: Direct period indexing for O(1) lookups - solves O(n²) complexity
    // poolId => periodIndex => peerId => isOnline
    mapping(uint32 => mapping(uint256 => mapping(bytes32 => bool))) public periodOnlineStatus;

    // Migration state: tracks progress of migrating old online status to V2 format
    // poolId => current timestamp cursor (0 means not started or complete)
    mapping(uint32 => uint256) public migrationCursor;
    // poolId => peer index cursor within current timestamp (for resuming mid-array)
    mapping(uint32 => uint256) public migrationPeerCursor;
    // poolId => whether migration has been completed (prevents re-running)
    mapping(uint32 => bool) public migrationComplete;
    // poolId => whether pool has V2 submissions (data is already in V2 format, no migration needed)
    mapping(uint32 => bool) public poolHasV2Submissions;
    // Tracks if any V2 data has been written globally (blocks expectedPeriod changes)
    bool public hasV2Data;

    // Circuit breaker state
    bool public circuitBreakerTripped;
    uint256 public lastCircuitBreakerResetBlock;
    uint256 public constant CIRCUIT_BREAKER_COOLDOWN_BLOCKS = 300; // ~1 hour at 12s/block

    // Reward tracking
    mapping(address => uint256) public totalRewardsClaimed;
    uint256 public totalRewardsDistributed;

    // I-03 Fix: Storage gap for future upgrades (50 slots reserved)
    uint256[50] private __gap;

    /// @notice Initialize the RewardEngine contract
    /// @param _token Address of the StorageToken contract
    /// @param _storagePool Address of the StoragePool contract
    /// @param _stakingPool Address of the StakingPool contract (holds reward tokens)
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    function initialize(
        address _token,
        address _storagePool,
        address _stakingPool,
        address initialOwner,
        address initialAdmin
    ) external initializer {
        if (_token == address(0)) revert InvalidAddress();
        if (_storagePool == address(0)) revert InvalidAddress();
        if (_stakingPool == address(0)) revert InvalidAddress();
        if (initialOwner == address(0)) revert InvalidAddress();
        if (initialAdmin == address(0)) revert InvalidAddress();

        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard,
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);

        token = StorageToken(_token);
        storagePool = StoragePool(_storagePool);
        stakingPool = StakingPool(_stakingPool);

        monthlyRewardPerPeer = DEFAULT_MONTHLY_REWARD_PER_PEER;
        expectedPeriod = DEFAULT_EXPECTED_PERIOD;
        rewardSystemStartTime = block.timestamp; // Set when the reward system becomes active

        // Initialize circuit breaker
        circuitBreakerTripped = false;
        lastCircuitBreakerResetBlock = block.number;

        emit RewardPoolSet(_stakingPool);
    }

    /// @notice Internal function to check and potentially reset circuit breaker
    /// @param allowReset Whether to allow auto-reset (false for view functions)
    function _checkCircuitBreaker(bool allowReset) internal {
        if (circuitBreakerTripped) {
            if (block.number < lastCircuitBreakerResetBlock + CIRCUIT_BREAKER_COOLDOWN_BLOCKS) {
                revert CircuitBreakerTripped();
            } else if (allowReset) {
                // Auto-reset after cooldown (only for state-changing functions)
                circuitBreakerTripped = false;
                lastCircuitBreakerResetBlock = block.number;
                emit CircuitBreakerReset(msg.sender, block.number, true);
            } else {
                // For view functions, still revert even after cooldown
                revert CircuitBreakerTripped();
            }
        }
    }

    /// @notice Internal function to check circuit breaker for view functions
    function _checkCircuitBreakerView() internal view {
        if (circuitBreakerTripped) {
            if (block.number >= lastCircuitBreakerResetBlock + CIRCUIT_BREAKER_COOLDOWN_BLOCKS) {
                // Circuit breaker cooldown has elapsed, but we don't auto-reset in view functions
                // Users should call canResetCircuitBreaker() to check status
                revert CircuitBreakerTripped();
            } else {
                revert CircuitBreakerTripped();
            }
        }
    }

    /// @notice L-03 Fix: Check if circuit breaker can be reset after cooldown
    /// @dev Returns true if cooldown elapsed and circuit breaker can be reset
    /// @return canReset True if circuit breaker can be reset
    function canResetCircuitBreaker() external view returns (bool canReset) {
        return circuitBreakerTripped && 
               block.number >= lastCircuitBreakerResetBlock + CIRCUIT_BREAKER_COOLDOWN_BLOCKS;
    }

    /// @notice Modifier to check circuit breaker status with auto-reset
    modifier notTripped() {
        _checkCircuitBreaker(true);
        _;
    }

    /// @notice Trip the circuit breaker (admin only)
    function tripCircuitBreaker() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        circuitBreakerTripped = true;
        lastCircuitBreakerResetBlock = block.number;
        emit CircuitBreakerActivated(msg.sender, block.number);
    }

    /// @notice Reset the circuit breaker (admin only)
    function resetCircuitBreaker() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        circuitBreakerTripped = false;
        lastCircuitBreakerResetBlock = block.number;
        emit CircuitBreakerReset(msg.sender, block.number, false);
    }

    /// @notice Migrate old online status data to V2 format (admin only, one-time)
    /// @dev H-01 Fix: Tracks total SSTORE operations instead of timestamps to prevent gas DoS
    /// @param poolId The pool ID to migrate
    /// @param maxOperations Max SSTORE operations (peer writes) per call, not timestamps
    function adminMigrateOnlineStatuses(
        uint32 poolId,
        uint256 maxOperations
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) nonReentrant {
        if (migrationComplete[poolId]) revert MigrationAlreadyComplete();
        
        uint256 ts = migrationCursor[poolId];
        if (ts == 0) ts = timestampHead[poolId];
        if (ts == 0) revert NoDataToMigrate();
        
        uint256 peerIdx = migrationPeerCursor[poolId];
        uint256 operations;
        
        while (ts != 0 && operations < maxOperations) {
            uint256 periodIdx = ts / expectedPeriod;
            bytes32[] memory peers = onlineStatus[poolId][ts];
            
            // Resume from peer cursor if we're continuing within a timestamp
            while (peerIdx < peers.length && operations < maxOperations) {
                periodOnlineStatus[poolId][periodIdx][peers[peerIdx]] = true;
                peerIdx++;
                operations++;
            }
            
            // If we finished all peers for this timestamp, move to next
            if (peerIdx >= peers.length) {
                ts = timestampNext[poolId][ts];
                peerIdx = 0; // Reset peer cursor for next timestamp
            }
        }
        
        // Save cursors for next call
        migrationCursor[poolId] = ts;
        migrationPeerCursor[poolId] = peerIdx;
        
        // Mark complete if we've processed all timestamps
        if (ts == 0) {
            migrationComplete[poolId] = true;
        }
        
        emit OnlineStatusesMigrated(poolId, operations, ts, ts == 0);
    }

    /// @notice Emergency withdrawal function for stuck tokens (admin only)
    /// @dev Can only transfer tokens to the StorageToken contract address for security
    /// @dev Can bypass pause restrictions for true emergencies
    /// @param tokenAddress Address of the token to withdraw
    /// @param amount Amount to withdraw
    function emergencyWithdraw(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) nonReentrant {
        if (tokenAddress == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();

        // Security: Only allow withdrawal to the StorageToken contract address
        address recipient = address(token);
        if (recipient == address(0)) revert InvalidRecipient();

        IERC20 tokenContract = IERC20(tokenAddress);
        uint256 contractBalance = tokenContract.balanceOf(address(this));

        if (contractBalance < amount) revert InsufficientBalance();

        // Transfer tokens to StorageToken contract
        tokenContract.safeTransfer(recipient, amount);

        emit EmergencyWithdrawal(tokenAddress, recipient, amount);
    }

    /// @notice Recover accidentally transferred ERC20 tokens (admin only)
    /// @dev Can recover any ERC20 tokens except the main reward token to prevent abuse
    /// @param tokenAddress Address of the token to recover
    /// @param recipient Address to send recovered tokens to
    /// @param amount Amount to recover
    function adminRecoverERC20(
        address tokenAddress,
        address recipient,
        uint256 amount
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) nonReentrant {
        if (tokenAddress == address(0)) revert InvalidAddress();
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();

        // Security: Prevent recovery of the main reward token to avoid abuse
        if (tokenAddress == address(token)) revert InvalidAddress();

        IERC20 tokenContract = IERC20(tokenAddress);
        uint256 contractBalance = tokenContract.balanceOf(address(this));

        if (contractBalance < amount) revert InsufficientBalance();

        // Transfer tokens to specified recipient
        tokenContract.safeTransfer(recipient, amount);

        emit ERC20Recovered(tokenAddress, recipient, amount);
    }

    /// @notice Set the monthly reward per peer amount
    /// @param _monthlyRewardPerPeer New monthly reward per peer amount
    function setMonthlyRewardPerPeer(uint256 _monthlyRewardPerPeer)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (_monthlyRewardPerPeer == 0) revert InvalidAmount();

        uint256 oldAmount = monthlyRewardPerPeer;
        monthlyRewardPerPeer = _monthlyRewardPerPeer;

        emit MonthlyRewardPerPeerUpdated(oldAmount, _monthlyRewardPerPeer);
    }

    /// @notice Set the expected period for online status reporting
    /// @dev M-03 Fix: Blocked when V2 data exists to prevent period index mismatch
    /// @param _expectedPeriod New expected period in seconds
    function setExpectedPeriod(uint256 _expectedPeriod)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (_expectedPeriod == 0) revert InvalidAmount();
        
        // M-03: Block expectedPeriod changes if V2 data has been written
        // Changing expectedPeriod would break period index lookups for existing V2 data
        if (hasV2Data) revert ExpectedPeriodChangeBlocked();

        uint256 oldPeriod = expectedPeriod;
        expectedPeriod = _expectedPeriod;

        emit ExpectedPeriodUpdated(oldPeriod, _expectedPeriod);
    }

    /// @notice Submit online status for multiple peer IDs (batch operation) - DEPRECATED
    /// @dev This function is deprecated. Use submitOnlineStatusBatchV2 instead.
    /// @dev Kept for backwards compatibility - reverts to prevent new submissions with old method
    function submitOnlineStatusBatch(
        uint32,
        bytes32[] calldata,
        uint256
    ) external pure {
        revert DeprecatedFunction();
    }

    /// @notice Submit online status for multiple peer IDs (batch operation) - V2 with O(1) lookups
    /// @param poolId The pool ID to submit status for
    /// @param peerIds Array of peer IDs that were online
    /// @param timestamp The timestamp for this status update
    function submitOnlineStatusBatchV2(
        uint32 poolId,
        bytes32[] calldata peerIds,
        uint256 timestamp
    ) external whenNotPaused nonReentrant notTripped {
        if (peerIds.length == 0 || peerIds.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        // Enhanced timestamp validation
        if (timestamp == 0) revert InvalidTimeRange();
        if (timestamp > block.timestamp + MAX_FUTURE_SUBMISSION) revert InvalidTimeRange();
        if (timestamp < block.timestamp - MAX_HISTORICAL_SUBMISSION) revert InvalidTimeRange();

        // Verify caller is either the pool creator or has POOL_ADMIN_ROLE
        address poolCreator = _getPoolCreator(poolId);
        if (msg.sender != poolCreator && !hasRole(ProposalTypes.POOL_ADMIN_ROLE, msg.sender)) {
            revert NotPoolCreator();
        }

        // Calculate the period index for this timestamp (global, not per-user)
        uint256 periodIndex = timestamp / expectedPeriod;

        // Track the latest submission time for this period
        lastPeriodSubmission[poolId][periodIndex] = block.timestamp;

        // L-01 Fix: Removed redundant V1 storage writes (onlineStatus, timestampExists, linked list)
        // V1 storage is no longer needed as V2 is the primary storage after migration
        // This saves ~40,000 gas per submission

        // V2: Direct period indexing for O(1) lookups
        for (uint256 i = 0; i < peerIds.length; i++) {
            periodOnlineStatus[poolId][periodIndex][peerIds[i]] = true;
        }
        
        // Mark that this pool has V2 submissions (H-02: no migration needed for this pool)
        if (!poolHasV2Submissions[poolId]) {
            poolHasV2Submissions[poolId] = true;
        }
        
        // M-03: Mark that V2 data exists globally (blocks expectedPeriod changes)
        if (!hasV2Data) {
            hasV2Data = true;
        }

        emit OnlineStatusSubmitted(poolId, msg.sender, peerIds.length, timestamp);
    }

    /// @notice Get online status for a specific peerId since a given time
    /// @dev L-01 Fix: Updated to use V2 period-based lookups instead of V1 linked list
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param sinceTime The timestamp to check from (0 for default period)
    /// @return onlineCount Number of periods with online status found
    /// @return totalExpected Total expected periods in the range
    function getOnlineStatusSince(
        bytes32 peerId,
        uint32 poolId,
        uint256 sinceTime
    ) external view returns (uint256 onlineCount, uint256 totalExpected) {
        // Check circuit breaker for view functions (no auto-reset)
        _checkCircuitBreakerView();
        if (sinceTime == 0) {
            sinceTime = block.timestamp - expectedPeriod;
        }

        if (sinceTime >= block.timestamp) revert InvalidTimeRange();

        // Calculate period range
        uint256 startPeriodIndex = sinceTime / expectedPeriod;
        uint256 endPeriodIndex = block.timestamp / expectedPeriod;
        
        // Don't count the current incomplete period
        if (block.timestamp % expectedPeriod != 0) {
            endPeriodIndex--;
        }
        
        if (endPeriodIndex < startPeriodIndex) {
            return (0, 0);
        }

        totalExpected = endPeriodIndex - startPeriodIndex + 1;
        onlineCount = 0;

        // V2: Use O(1) period lookups instead of V1 linked list
        for (uint256 periodIdx = startPeriodIndex; periodIdx <= endPeriodIndex; periodIdx++) {
            if (periodOnlineStatus[poolId][periodIdx][peerId]) {
                onlineCount++;
            }
        }

        return (onlineCount, totalExpected);
    }

    /// @notice Get the effective start time for reward calculation for a specific member
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return effectiveStartTime The timestamp from which rewards should be calculated
    function getEffectiveRewardStartTime(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 effectiveStartTime) {
        // Verify the account and peerId are members of the pool
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Get member join date
        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];

        if (lastClaimed > 0) {
            // User has claimed before – start from last claimed period boundary
            return lastClaimed;
        } else {
            // First time claiming – start from join date (periods are anchored at join date)
            return joinDate;
        }
    }

    /// @notice Get detailed reward calculation information for debugging/transparency
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return startTime When reward calculation starts from
    /// @return endTime When reward calculation ends (current time)
    /// @return totalPeriods Total expected periods in the range
    /// @return onlinePeriods Number of periods the member was online
    /// @return rewardPerPeriod Reward amount per period
    /// @return totalReward Total calculated reward
    function getRewardCalculationDetails(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (
        uint256 startTime,
        uint256 endTime,
        uint256 totalPeriods,
        uint256 onlinePeriods,
        uint256 rewardPerPeriod,
        uint256 totalReward
    ) {
        // Verify membership
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Get member join date and last claimed timestamp
        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];

        // Determine calculation start time (raw)
        if (lastClaimed > 0) {
            startTime = lastClaimed;
        } else {
            startTime = joinDate;
        }


        
        endTime = block.timestamp;

        if (startTime >= endTime) {
            return (startTime, endTime, 0, 0, 0, 0);
        }

        // Calculate eligible periods using V2 O(1) lookup
        onlinePeriods = _calculateEligiblePeriodsFromJoinDateV2(peerId, poolId, joinDate, startTime, endTime);
        
        // Calculate total periods that have passed (complete periods only)
        // M-02 Fix: Cap totalPeriods at MAX_VIEW_PERIODS_V2 for consistency with onlinePeriods
        uint256 timeElapsed = endTime - startTime;
        totalPeriods = timeElapsed / expectedPeriod;
        if (totalPeriods > MAX_VIEW_PERIODS_V2) {
            totalPeriods = MAX_VIEW_PERIODS_V2;
        }

        // Calculate reward per period
        rewardPerPeriod = _calculateRewardPerPeriod();
        
        // Calculate total reward (no ratio - just count of eligible periods)
        if (onlinePeriods > 0 && rewardPerPeriod > 0) {
            totalReward = rewardPerPeriod * onlinePeriods;
        }

        return (startTime, endTime, totalPeriods, onlinePeriods, rewardPerPeriod, totalReward);
    }

    /// @notice Calculate eligible mining rewards - DEPRECATED, use calculateEligibleMiningRewardsV2
    function calculateEligibleMiningRewards(
        address,
        bytes32,
        uint32
    ) external pure returns (uint256) {
        revert DeprecatedFunction();
    }

    /// @notice V2: Calculate eligible mining rewards using O(1) lookups
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return eligibleRewards Amount of eligible mining rewards
    function calculateEligibleMiningRewardsV2(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 eligibleRewards) {
        return _calculateEligibleMiningRewardsV2Internal(account, peerId, poolId);
    }
    
    /// @notice L-02 Fix: Internal version to avoid external self-calls
    function _calculateEligibleMiningRewardsV2Internal(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) internal view returns (uint256 eligibleRewards) {
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];
        uint256 calculationStartTime = lastClaimed > 0 ? lastClaimed : joinDate;

        if (calculationStartTime >= block.timestamp) {
            return 0;
        }

        // V2: Uses O(1) lookups instead of O(n) linked list iteration
        uint256 eligiblePeriods = _calculateEligiblePeriodsFromJoinDateV2(peerId, poolId, joinDate, calculationStartTime, block.timestamp);
        
        if (eligiblePeriods == 0) {
            return 0;
        }

        uint256 rewardPerPeriod = _calculateRewardPerPeriod();
        if (rewardPerPeriod == 0) return 0;

        eligibleRewards = rewardPerPeriod * eligiblePeriods;

        uint256 currentMonth = _getCurrentMonth();
        uint256 alreadyClaimed = monthlyRewardsClaimed[peerId][poolId][currentMonth];

        if (alreadyClaimed >= MAX_MONTHLY_REWARD_PER_PEER) {
            return 0;
        }

        if (eligibleRewards + alreadyClaimed > MAX_MONTHLY_REWARD_PER_PEER) {
            eligibleRewards = MAX_MONTHLY_REWARD_PER_PEER - alreadyClaimed;
        }

        return eligibleRewards;
    }

    /// @notice Calculate eligible storage rewards for a specific account/peerId pair
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return eligibleRewards Amount of eligible storage rewards (currently 0 as placeholder)
    function calculateEligibleStorageRewards(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 eligibleRewards) {
        return _calculateEligibleStorageRewardsInternal(account, peerId, poolId);
    }
    
    /// @notice L-02 Fix: Internal version to avoid external self-calls
    function _calculateEligibleStorageRewardsInternal(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) internal view returns (uint256) {
        // Verify the account and peerId are members of the pool
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Storage rewards are set to 0 as placeholder for now
        return 0;
    }

    /// @notice Get total eligible rewards (mining + storage) for a specific account/peerId pair
    /// @dev L-02 Fix: Uses internal functions instead of external self-calls for gas efficiency
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return miningRewards Amount of eligible mining rewards
    /// @return storageRewards Amount of eligible storage rewards
    /// @return totalRewards Total eligible rewards
    function getEligibleRewards(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 miningRewards, uint256 storageRewards, uint256 totalRewards) {
        miningRewards = _calculateEligibleMiningRewardsV2Internal(account, peerId, poolId);
        storageRewards = _calculateEligibleStorageRewardsInternal(account, peerId, poolId);
        totalRewards = miningRewards + storageRewards;

        return (miningRewards, storageRewards, totalRewards);
    }

    /// @notice Claim eligible rewards - DEPRECATED, use claimRewardsV2
    function claimRewards(
        bytes32,
        uint32
    ) external pure {
        revert DeprecatedFunction();
    }

    /// @notice Claim eligible rewards with limit - DEPRECATED, use claimRewardsWithLimitV2
    function claimRewardsWithLimit(
        bytes32,
        uint32,
        uint256
    ) external pure {
        revert DeprecatedFunction();
    }

    /// @notice V2: Claim eligible rewards using O(1) lookups (uses default period limit)
    /// @param peerId The peer ID to claim rewards for
    /// @param poolId The pool ID
    function claimRewardsV2(
        bytes32 peerId,
        uint32 poolId
    ) external whenNotPaused nonReentrant notTripped {
        _claimRewardsInternalV2(peerId, poolId, DEFAULT_CLAIM_PERIODS_PER_TX_V2);
    }

    /// @notice V2: Claim eligible rewards with custom period limit using O(1) lookups
    /// @param peerId The peer ID to claim rewards for
    /// @param poolId The pool ID
    /// @param maxPeriods Maximum number of periods to process (up to MAX_CLAIM_PERIODS_LIMIT_V2)
    function claimRewardsWithLimitV2(
        bytes32 peerId,
        uint32 poolId,
        uint256 maxPeriods
    ) external whenNotPaused nonReentrant notTripped {
        if (maxPeriods == 0 || maxPeriods > MAX_CLAIM_PERIODS_LIMIT_V2) {
            maxPeriods = DEFAULT_CLAIM_PERIODS_PER_TX_V2;
        }
        _claimRewardsInternalV2(peerId, poolId, maxPeriods);
    }

    /// @notice V2: Internal function to claim rewards using O(1) lookups
    /// @dev H-02 Fix: Blocks V2 claims if pool has unmigrated V1 data to prevent reward loss
    /// @dev C-01 Fix: Timestamp only advances for actually paid periods, not all processed periods
    /// @param peerId The peer ID to claim rewards for
    /// @param poolId The pool ID
    /// @param maxPeriodsToProcess Maximum periods to process
    function _claimRewardsInternalV2(
        bytes32 peerId,
        uint32 poolId,
        uint256 maxPeriodsToProcess
    ) internal {
        // H-02: Prevent V2 claims for pools with unmigrated V1-only data
        // Only block if: pool has V1 data AND pool has NO V2 submissions AND migration not complete
        // Pools with V2 submissions have data already in V2 format (no migration needed)
        if (timestampHead[poolId] != 0 && !poolHasV2Submissions[poolId] && !migrationComplete[poolId]) {
            revert MigrationNotComplete();
        }
        
        address account = msg.sender;

        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];
        uint256 calculationStartTime = lastClaimed > 0 ? lastClaimed : joinDate;

        if (calculationStartTime >= block.timestamp) revert NoRewardsToClaim();

        // V2: Calculate eligible periods with O(1) lookups
        (uint256 eligiblePeriods, uint256 newLastClaimedTime) = _calculateEligiblePeriodsLimitedV2(
            peerId, poolId, joinDate, calculationStartTime, block.timestamp, maxPeriodsToProcess
        );

        // C-01 Fix: Do NOT update lastClaimedRewards here - wait until after cap is applied

        if (eligiblePeriods == 0) {
            // No eligible periods but still advance timestamp to skip empty periods
            if (newLastClaimedTime > calculationStartTime) {
                lastClaimedRewards[account][peerId][poolId] = newLastClaimedTime;
            }
            emit MiningRewardsClaimed(account, peerId, poolId, 0);
            return;
        }

        uint256 rewardPerPeriod = _calculateRewardPerPeriod();
        if (rewardPerPeriod == 0) {
            // No rewards but still advance timestamp
            if (newLastClaimedTime > calculationStartTime) {
                lastClaimedRewards[account][peerId][poolId] = newLastClaimedTime;
            }
            emit MiningRewardsClaimed(account, peerId, poolId, 0);
            return;
        }

        uint256 miningRewards = rewardPerPeriod * eligiblePeriods;
        uint256 storageRewards = 0;
        uint256 totalRewards = miningRewards + storageRewards;
        uint256 actualPaidPeriods = eligiblePeriods; // Track how many periods are actually paid

        uint256 currentMonth = _getCurrentMonth();
        uint256 alreadyClaimed = monthlyRewardsClaimed[peerId][poolId][currentMonth];
        if (alreadyClaimed >= MAX_MONTHLY_REWARD_PER_PEER) {
            // Cap already hit - don't advance timestamp at all (user can try again next month)
            emit MiningRewardsClaimed(account, peerId, poolId, 0);
            return;
        }
        if (totalRewards + alreadyClaimed > MAX_MONTHLY_REWARD_PER_PEER) {
            // C-01 Fix: Calculate actual paid periods based on capped rewards
            totalRewards = MAX_MONTHLY_REWARD_PER_PEER - alreadyClaimed;
            miningRewards = totalRewards;
            // Calculate how many periods this actually covers
            actualPaidPeriods = totalRewards / rewardPerPeriod;
            
            // H-01 Fix: If remaining cap is less than 1 period worth, don't pay partial amount
            // This prevents stuck state where timestamp doesn't advance but tokens are paid
            // User must wait until next month when cap resets
            if (actualPaidPeriods == 0) {
                emit MiningRewardsClaimed(account, peerId, poolId, 0);
                return;
            }
        }

        // C-01 Fix: Calculate adjusted timestamp based on ACTUAL paid periods
        // Only advance timestamp for periods we're actually paying for
        uint256 adjustedLastClaimedTime;
        if (actualPaidPeriods == eligiblePeriods) {
            // No cap hit - use the full newLastClaimedTime
            adjustedLastClaimedTime = newLastClaimedTime;
        } else {
            // Cap hit - calculate timestamp for actual paid periods only
            uint256 firstPeriodIndex = 0;
            if (calculationStartTime > joinDate) {
                firstPeriodIndex = (calculationStartTime - joinDate) / expectedPeriod;
                if ((calculationStartTime - joinDate) % expectedPeriod != 0) {
                    firstPeriodIndex++;
                }
            }
            // Advance only by actual paid periods (guaranteed > 0 due to H-01 fix above)
            adjustedLastClaimedTime = joinDate + ((firstPeriodIndex + actualPaidPeriods) * expectedPeriod);
        }

        // NOW update lastClaimedRewards with adjusted timestamp
        // Note: With H-01 fix, actualPaidPeriods > 0, so adjustedLastClaimedTime > calculationStartTime is guaranteed
        if (adjustedLastClaimedTime > calculationStartTime) {
            lastClaimedRewards[account][peerId][poolId] = adjustedLastClaimedTime;
        }

        uint256 stakingPoolTokenBalance = token.balanceOf(address(stakingPool));
        if (stakingPoolTokenBalance < totalRewards) revert InsufficientRewards();

        monthlyRewardsClaimed[peerId][poolId][currentMonth] += totalRewards;

        bool success = stakingPool.transferTokens(totalRewards);
        if (!success) revert InsufficientRewards();

        totalRewardsDistributed += totalRewards;
        totalRewardsClaimed[account] += totalRewards;

        IERC20(address(token)).safeTransfer(account, totalRewards);

        emit TotalRewardsDistributedUpdated(totalRewardsDistributed);
        emit UserTotalRewardsUpdated(account, totalRewardsClaimed[account]);

        if (miningRewards > 0) {
            emit MiningRewardsClaimed(account, peerId, poolId, miningRewards);
        }
        if (storageRewards > 0) {
            emit StorageRewardsClaimed(account, peerId, poolId, storageRewards);
        }
    }

    /// @notice Get claimed rewards information for a specific account/peerId pair
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return lastClaimedTimestamp Timestamp of last claim
    /// @return timeSinceLastClaim Time elapsed since last claim
    function getClaimedRewardsInfo(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 lastClaimedTimestamp, uint256 timeSinceLastClaim) {
        lastClaimedTimestamp = lastClaimedRewards[account][peerId][poolId];
        timeSinceLastClaim = lastClaimedTimestamp > 0 ? block.timestamp - lastClaimedTimestamp : 0;

        return (lastClaimedTimestamp, timeSinceLastClaim);
    }

    /// @notice Get accumulated unclaimed rewards for a specific account/peerId pair
    /// @dev M-02 Fix: Uses internal functions instead of external self-call for gas efficiency
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return unclaimedMining Unclaimed mining rewards
    /// @return unclaimedStorage Unclaimed storage rewards
    /// @return totalUnclaimed Total unclaimed rewards
    function getUnclaimedRewards(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 unclaimedMining, uint256 unclaimedStorage, uint256 totalUnclaimed) {
        unclaimedMining = _calculateEligibleMiningRewardsV2Internal(account, peerId, poolId);
        unclaimedStorage = _calculateEligibleStorageRewardsInternal(account, peerId, poolId);
        totalUnclaimed = unclaimedMining + unclaimedStorage;
        
        return (unclaimedMining, unclaimedStorage, totalUnclaimed);  // L-03: Explicit return for consistency
    }

    /// @notice Get claim status - DEPRECATED, use getClaimStatusV2
    function getClaimStatus(
        address,
        bytes32,
        uint32
    ) external pure returns (uint256, uint256, uint256, uint256, bool) {
        revert DeprecatedFunction();
    }

    /// @notice V2: Get claim status using O(1) lookups
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return totalUnclaimedPeriods Total number of unclaimed periods
    /// @return defaultPeriodsPerClaim Default periods per claim (V2 limit)
    /// @return maxPeriodsPerClaim Maximum periods per claim (V2 limit)
    /// @return estimatedClaimsNeeded Estimated claims needed
    /// @return hasMoreToClaim Whether more periods than one tx can handle
    function getClaimStatusV2(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (
        uint256 totalUnclaimedPeriods,
        uint256 defaultPeriodsPerClaim,
        uint256 maxPeriodsPerClaim,
        uint256 estimatedClaimsNeeded,
        bool hasMoreToClaim
    ) {
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];
        uint256 calculationStartTime = lastClaimed > 0 ? lastClaimed : joinDate;

        if (calculationStartTime >= block.timestamp) {
            return (0, DEFAULT_CLAIM_PERIODS_PER_TX_V2, MAX_CLAIM_PERIODS_LIMIT_V2, 0, false);
        }

        // V2: Uses O(1) lookups
        totalUnclaimedPeriods = _calculateEligiblePeriodsFromJoinDateV2(
            peerId, poolId, joinDate, calculationStartTime, block.timestamp
        );

        defaultPeriodsPerClaim = DEFAULT_CLAIM_PERIODS_PER_TX_V2;
        maxPeriodsPerClaim = MAX_CLAIM_PERIODS_LIMIT_V2;
        hasMoreToClaim = totalUnclaimedPeriods > DEFAULT_CLAIM_PERIODS_PER_TX_V2;
        
        if (totalUnclaimedPeriods == 0) {
            estimatedClaimsNeeded = 0;
        } else {
            estimatedClaimsNeeded = (totalUnclaimedPeriods + DEFAULT_CLAIM_PERIODS_PER_TX_V2 - 1) / DEFAULT_CLAIM_PERIODS_PER_TX_V2;
        }

        return (totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim);
    }

    /// @notice Internal function to get pool creator with caching
    /// @param poolId The pool ID
    /// @return creator Address of the pool creator
    function _getPoolCreator(uint32 poolId) internal view returns (address creator) {
        // Get pool creator directly from the pools mapping
        // Note: We can't cache this in a view function, but it's a simple storage read
        (address poolCreator, , , , , , , , ) = storagePool.pools(poolId);
        if (poolCreator == address(0)) revert InvalidPoolId();
        return poolCreator;
    }

    /// @notice Internal function to get current month for reward cap tracking
    /// @return month Current month as timestamp / (30 days)
    function _getCurrentMonth() internal view returns (uint256 month) {
        return block.timestamp / (30 days);
    }

    /// @notice Internal function to normalize timestamp to period boundary
    /// @param timestamp The timestamp to normalize
    /// @return normalizedTimestamp The timestamp aligned to period boundary
    function _normalizeToPeriodBoundary(uint256 timestamp) internal view returns (uint256 normalizedTimestamp) {
        return (timestamp / expectedPeriod) * expectedPeriod;
    }

    /// @notice Internal function to check if a peerId was online at a specific timestamp
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @param peerId The peer ID to check
    /// @return isOnline True if the peerId was online at the timestamp
    function _isPeerOnlineAtTimestamp(uint32 poolId, uint256 timestamp, bytes32 peerId) internal view returns (bool isOnline) {
        bytes32[] memory onlinePeers = onlineStatus[poolId][timestamp];
        for (uint256 i = 0; i < onlinePeers.length; i++) {
            if (onlinePeers[i] == peerId) {
                return true;
            }
        }
        return false;
    }

    // L-01 Fix: Removed _insertTimestampLinked (dead code - no longer called after V1 writes removed)

    // ============================================
    // V1 LEGACY FUNCTIONS - For migration verification only
    // These functions read from V1 storage which is no longer written to.
    // After migration is complete, these will only return pre-migration data.
    // ============================================

    /// @notice V1 LEGACY: Get all online peerIds for a specific pool and timestamp
    /// @dev WARNING: Only returns V1 data. For V2, use periodOnlineStatus mapping directly.
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @return peerIds Array of peerIds that were online at the timestamp
    function getOnlinePeerIds(uint32 poolId, uint256 timestamp) external view returns (bytes32[] memory peerIds) {
        return onlineStatus[poolId][timestamp];
    }

    /// @notice M-02 Fix: DEPRECATED - This function only returns V1 data
    /// @dev V1 linked list is no longer written to. Use V2 periodOnlineStatus mapping.
    function getLatestOnlinePeerIds(uint32) external pure returns (bytes32[] memory) {
        revert DeprecatedFunction();
    }

    /// @notice V1 LEGACY: Check if a specific peerId was online at a timestamp
    /// @dev WARNING: Only checks V1 data. For V2, use periodOnlineStatus mapping.
    /// @dev Kept for migration verification - checks V1 array storage.
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @param peerId The peer ID to check
    /// @return isOnline True if the peerId was online at the timestamp (V1 data only)
    function isPeerOnlineAtTimestamp(uint32 poolId, uint256 timestamp, bytes32 peerId) external view returns (bool isOnline) {
        return _isPeerOnlineAtTimestamp(poolId, timestamp, peerId);
    }

    /// @notice Internal function to safely calculate reward per period with overflow protection
    /// @dev L-05 Fix: Reward per period = monthlyRewardPerPeer / (SECONDS_PER_MONTH / expectedPeriod)
    /// @dev With default 8-hour periods: periodsPerMonth = 30 days / 8 hours = 90 periods
    /// @dev Example: 8000 tokens / 90 periods = ~88.89 tokens per period
    /// @return rewardPerPeriod Safe reward per period calculation
    function _calculateRewardPerPeriod() internal view returns (uint256 rewardPerPeriod) {
        // Calculate periods per month based on expectedPeriod
        // Default: 30 days / 8 hours = 2,592,000 / 28,800 = 90 periods per month
        uint256 periodsPerMonth = SECONDS_PER_MONTH / expectedPeriod;

        if (periodsPerMonth == 0) return 0;

        // Check for potential overflow before division
        if (monthlyRewardPerPeer > type(uint256).max / periodsPerMonth) return 0;

        return monthlyRewardPerPeer / periodsPerMonth;
    }

    // I-02 Fix: Removed unused _calculateTotalReward function (dead code)

    /// @notice V2: Calculate eligible periods from join date with O(1) lookups
    /// @param peerId The peer ID
    /// @param poolId The pool ID  
    /// @param joinDate The user's join date
    /// @param calculationStartTime Start time for calculation (join date or last claimed)
    /// @param currentTime Current timestamp
    /// @return eligiblePeriods Number of complete periods with online status
    function _calculateEligiblePeriodsFromJoinDateV2(
        bytes32 peerId,
        uint32 poolId,
        uint256 joinDate,
        uint256 calculationStartTime,
        uint256 currentTime
    ) internal view returns (uint256 eligiblePeriods) {
        if (calculationStartTime >= currentTime || expectedPeriod == 0) {
            return 0;
        }

        uint256 eligibleCount = 0;
        
        // Find the first period that starts at or after calculationStartTime
        uint256 firstPeriodIndex = 0;
        if (calculationStartTime > joinDate) {
            firstPeriodIndex = (calculationStartTime - joinDate) / expectedPeriod;
            if ((calculationStartTime - joinDate) % expectedPeriod != 0) {
                firstPeriodIndex++;
            }
        }
        
        // V2: Check up to 6 months (540 periods) - O(1) per period lookup
        uint256 periodIndex = firstPeriodIndex;
        uint256 maxPeriods = MAX_VIEW_PERIODS_V2;
        uint256 periodsChecked = 0;
        
        // L-02 Gas Optimization: Calculate periodStart once, then increment
        // Saves ~200 gas per iteration (avoids multiplication each loop)
        uint256 periodStart = joinDate + (firstPeriodIndex * expectedPeriod);

        while (periodsChecked < maxPeriods) {
            uint256 periodEnd = periodStart + expectedPeriod;

            if (periodEnd > currentTime) {
                break;
            }

            // V2: O(1) lookup instead of O(n) linked list iteration
            if (_hasOnlineStatusInPeriodV2(peerId, poolId, periodStart)) {
                eligibleCount++;
            }

            periodStart = periodEnd;  // L-02: Increment instead of recalculate
            periodIndex++;
            periodsChecked++;
        }
        
        return eligibleCount;
    }

    /// @notice V2: Calculate eligible periods with limit using O(1) lookups
    /// @param peerId The peer ID
    /// @param poolId The pool ID  
    /// @param joinDate The user's join date
    /// @param calculationStartTime Start time for calculation
    /// @param currentTime Current timestamp
    /// @param maxPeriodsToProcess Maximum periods to process
    /// @return eligiblePeriods Number of complete periods with online status
    /// @return newLastClaimedTime The timestamp to store as lastClaimed
    function _calculateEligiblePeriodsLimitedV2(
        bytes32 peerId,
        uint32 poolId,
        uint256 joinDate,
        uint256 calculationStartTime,
        uint256 currentTime,
        uint256 maxPeriodsToProcess
    ) internal view returns (uint256 eligiblePeriods, uint256 newLastClaimedTime) {
        if (calculationStartTime >= currentTime || expectedPeriod == 0) {
            return (0, calculationStartTime);
        }

        uint256 eligibleCount = 0;
        
        uint256 firstPeriodIndex = 0;
        if (calculationStartTime > joinDate) {
            firstPeriodIndex = (calculationStartTime - joinDate) / expectedPeriod;
            if ((calculationStartTime - joinDate) % expectedPeriod != 0) {
                firstPeriodIndex++;
            }
        }
        
        uint256 periodIndex = firstPeriodIndex;
        uint256 periodsChecked = 0;
        uint256 lastProcessedPeriodEnd = calculationStartTime;

        while (periodsChecked < maxPeriodsToProcess) {
            uint256 periodStart = joinDate + (periodIndex * expectedPeriod);
            uint256 periodEnd = periodStart + expectedPeriod;

            if (periodEnd > currentTime) {
                break;
            }

            // V2: O(1) lookup
            if (_hasOnlineStatusInPeriodV2(peerId, poolId, periodStart)) {
                eligibleCount++;
            }

            lastProcessedPeriodEnd = periodEnd;
            periodIndex++;
            periodsChecked++;
        }
        
        return (eligibleCount, lastProcessedPeriodEnd);
    }

    /// @notice V2: Check if peerId has online status in a specific period - O(1) lookup
    /// @dev Uses direct period indexing instead of linked list iteration
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param periodStart Start of the period (used to calculate period index)
    /// @return hasStatus True if peerId has online status in the period
    function _hasOnlineStatusInPeriodV2(
        bytes32 peerId,
        uint32 poolId,
        uint256 periodStart
    ) internal view returns (bool hasStatus) {
        uint256 periodIndex = periodStart / expectedPeriod;
        return periodOnlineStatus[poolId][periodIndex][peerId];
    }

    /// @notice Get the last complete period end timestamp based on join date
    /// @param joinDate The user's join date
    /// @param currentTime Current timestamp
    /// @return lastPeriodEnd The end timestamp of the last complete period
    function _getLastCompletePeriodEnd(uint256 joinDate, uint256 currentTime) internal view returns (uint256 lastPeriodEnd) {
        if (currentTime <= joinDate || expectedPeriod == 0) {
            return joinDate;
        }
        
        // Calculate how many complete periods have passed since join date
        uint256 timeElapsed = currentTime - joinDate;
        uint256 completePeriods = timeElapsed / expectedPeriod;
        
        // Return the end of the last complete period
        return joinDate + (completePeriods * expectedPeriod);
    }

    /// @notice Get reward statistics for an address
    /// @dev L-06 Fix: Added zero address validation
    /// @param account The address to query
    /// @return totalClaimed Total rewards claimed by the address
    /// @return totalDistributed Total rewards distributed by the contract
    /// @return claimPercentage Percentage of total rewards claimed by this address (in basis points)
    function getRewardStatistics(address account) external view returns (
        uint256 totalClaimed,
        uint256 totalDistributed,
        uint256 claimPercentage
    ) {
        if (account == address(0)) revert InvalidRecipient();
        
        totalClaimed = totalRewardsClaimed[account];
        totalDistributed = totalRewardsDistributed;

        if (totalDistributed > 0) {
            // Calculate percentage in basis points (1% = 100 basis points)
            claimPercentage = (totalClaimed * 10000) / totalDistributed;
        } else {
            claimPercentage = 0;
        }

        return (totalClaimed, totalDistributed, claimPercentage);
    }

    /// @notice V1 LEGACY: Get raw online status array for a pool and timestamp
    /// @dev WARNING: Only returns V1 data. V1 storage is no longer written to.
    /// @dev Kept for migration verification only.
    function getRawOnlineInterned(uint32 poolId, uint256 timestamp) external view returns (bytes32[] memory) {
        return onlineStatus[poolId][timestamp];
    }

    /// @notice Authorize upgrade through governance proposal system
    function _authorizeUpgrade(address newImplementation)
        internal
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        // Delegate the authorization to the governance module
        if (!_checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");
    }

    /// @notice Execute custom proposals for this contract
    function _executeCustomProposal(bytes32) internal virtual override {

        // Currently no custom proposals to execute
        // This function could be extended in the future if needed

        revert InvalidProposalType(uint8(0));
    }

    /// @notice Create custom proposals for this contract
    function _createCustomProposal(
        uint8,
        uint40 /* id */,
        address /* target */,
        bytes32 /* role */,
        uint96 /* amount */,
        address /* tokenAddress */
    ) internal virtual override returns (bytes32) {
        // Currently no custom proposals supported
        // This function could be extended in the future if needed
        revert InvalidProposalType(uint8(0));
    }



}
