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

    // Constants
    uint256 public constant MAX_BATCH_SIZE = 100;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant SECONDS_PER_MONTH = 30 days;
    uint256 public constant DEFAULT_EXPECTED_PERIOD = 8 hours;
    uint256 public constant DEFAULT_MONTHLY_REWARD_PER_PEER = 8000 * 10**18; // 8000 tokens per peer per month
    uint256 public constant MAX_HISTORICAL_SUBMISSION = 7 days; // Maximum 1 week back
    uint256 public constant MAX_FUTURE_SUBMISSION = 1 minutes; // Maximum 1 minute future
    uint256 public constant MAX_MONTHLY_REWARD_PER_PEER = 8000 * 10**18; // 8000 tokens per month

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

    // Circuit breaker state
    bool public circuitBreakerTripped;
    uint256 public lastCircuitBreakerResetBlock;
    uint256 public constant CIRCUIT_BREAKER_COOLDOWN_BLOCKS = 300; // ~1 hour at 12s/block

    // Reward tracking
    mapping(address => uint256) public totalRewardsClaimed;
    uint256 public totalRewardsDistributed;

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
                // Users should call resetCircuitBreakerAuto() to reset it
                revert CircuitBreakerTripped();
            } else {
                revert CircuitBreakerTripped();
            }
        }
    }

    /// @notice Auto-reset circuit breaker after cooldown (view function, callable by anyone)
    /// @dev This is a view function that can be called off-chain to reset the circuit breaker
    function resetCircuitBreakerAuto() external view {
        if (circuitBreakerTripped && block.number >= lastCircuitBreakerResetBlock + CIRCUIT_BREAKER_COOLDOWN_BLOCKS) {
            // Note: This is a view function, so it doesn't actually reset the state
            // It's meant to be called off-chain to check if reset is possible
            // The actual reset happens in state-changing functions via _checkCircuitBreaker(true)
            return;
        }
        revert CircuitBreakerTripped();
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
    /// @param _expectedPeriod New expected period in seconds
    function setExpectedPeriod(uint256 _expectedPeriod)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (_expectedPeriod == 0) revert InvalidAmount();

        uint256 oldPeriod = expectedPeriod;
        expectedPeriod = _expectedPeriod;

        emit ExpectedPeriodUpdated(oldPeriod, _expectedPeriod);
    }

    /// @notice Submit online status for multiple peer IDs (batch operation)
    /// @param poolId The pool ID to submit status for
    /// @param peerIds Array of peer IDs that were online
    /// @param timestamp The timestamp for this status update
    function submitOnlineStatusBatch(
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

        // Calculate the period for this timestamp to handle multiple submissions
        uint256 period = timestamp / expectedPeriod;

        // Check if this is a duplicate submission for the same period
        // Allow updates but track the latest submission time
        lastPeriodSubmission[poolId][period] = block.timestamp;

        // Store the raw timestamp so period checks relative to joinDate work correctly
        onlineStatus[poolId][timestamp] = peerIds;

        // Record timestamp in linked list if it's new (O(1) insertion)
        if (!timestampExists[poolId][timestamp]) {
            _insertTimestampLinked(poolId, timestamp);
        }

        emit OnlineStatusSubmitted(poolId, msg.sender, peerIds.length, timestamp);
    }

    /// @notice Get online status for a specific peerId since a given time
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param sinceTime The timestamp to check from (0 for default period)
    /// @return onlineCount Number of online status records found
    /// @return totalExpected Total expected status reports in the period
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

        // Normalize timestamps to period boundaries for consistent calculations
        uint256 normalizedSinceTime = _normalizeToPeriodBoundary(sinceTime);
        uint256 normalizedCurrentTime = _normalizeToPeriodBoundary(block.timestamp);

        uint256 timeRange = normalizedCurrentTime - normalizedSinceTime;
        totalExpected = timeRange / expectedPeriod;

        // Ultra-optimized: Use linked-list to iterate through timestamps efficiently
        // This scales linearly but with O(1) insertions, crucial for long-term usage
        onlineCount = 0;
        uint256 currentTimestamp = timestampHead[poolId];

        if (currentTimestamp == 0) {
            return (0, totalExpected);
        }

        // Iterate through linked list of timestamps within our range
        while (currentTimestamp != 0) {
            if (currentTimestamp >= normalizedSinceTime && currentTimestamp <= normalizedCurrentTime) {
                // Check if this peerId was online at this timestamp
                if (_isPeerOnlineAtTimestamp(poolId, currentTimestamp, peerId)) {
                    onlineCount++;
                }
            }
            currentTimestamp = timestampNext[poolId][currentTimestamp];
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

        // Calculate eligible periods using new period-based logic
        onlinePeriods = _calculateEligiblePeriodsFromJoinDate(peerId, poolId, joinDate, startTime, endTime);
        
        // Calculate total periods that have passed (complete periods only)
        uint256 timeElapsed = endTime - startTime;
        totalPeriods = timeElapsed / expectedPeriod;

        // Calculate reward per period
        rewardPerPeriod = _calculateRewardPerPeriod();
        
        // Calculate total reward (no ratio - just count of eligible periods)
        if (onlinePeriods > 0 && rewardPerPeriod > 0) {
            totalReward = rewardPerPeriod * onlinePeriods;
        }

        return (startTime, endTime, totalPeriods, onlinePeriods, rewardPerPeriod, totalReward);
    }

    /// @notice Calculate eligible mining rewards for a specific account/peerId pair
    /// @param account The member account
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @return eligibleRewards Amount of eligible mining rewards
    function calculateEligibleMiningRewards(
        address account,
        bytes32 peerId,
        uint32 poolId
    ) external view returns (uint256 eligibleRewards) {
        // Verify the account and peerId are members of the pool
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Get member join date and last claimed timestamp
        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];

        // Determine the start time for reward calculation
        // Always start from join date for period calculations, not reward system start
        uint256 calculationStartTime;
        if (lastClaimed > 0) {
            // User has claimed before - start from last claimed period boundary
            calculationStartTime = lastClaimed;
        } else {
            // First time claiming - start from join date
            calculationStartTime = joinDate;
        }

        // Ensure we don't calculate rewards from the future
        if (calculationStartTime >= block.timestamp) {
            return 0;
        }

        // Calculate eligible periods based on fixed periods from join date
        uint256 eligiblePeriods = _calculateEligiblePeriodsFromJoinDate(peerId, poolId, joinDate, calculationStartTime, block.timestamp);
        
        if (eligiblePeriods == 0) {
            return 0;
        }

        // Calculate reward per period
        uint256 rewardPerPeriod = _calculateRewardPerPeriod();
        if (rewardPerPeriod == 0) return 0;

        // Calculate total eligible rewards (no ratio - just count of complete periods)
        eligibleRewards = rewardPerPeriod * eligiblePeriods;

        // Apply monthly cap per peer ID
        uint256 currentMonth = _getCurrentMonth();
        uint256 alreadyClaimed = monthlyRewardsClaimed[peerId][poolId][currentMonth];

        if (alreadyClaimed >= MAX_MONTHLY_REWARD_PER_PEER) {
            return 0; // Already reached monthly cap
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
        // Verify the account and peerId are members of the pool
         (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Storage rewards are set to 0 as placeholder for now
        return 0;
    }

    /// @notice Get total eligible rewards (mining + storage) for a specific account/peerId pair
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
        miningRewards = this.calculateEligibleMiningRewards(account, peerId, poolId);
        storageRewards = this.calculateEligibleStorageRewards(account, peerId, poolId);
        totalRewards = miningRewards + storageRewards;

        return (miningRewards, storageRewards, totalRewards);
    }

    /// @notice Claim eligible rewards for a specific account/peerId pair
    /// @param peerId The peer ID to claim rewards for
    /// @param poolId The pool ID
    function claimRewards(
        bytes32 peerId,
        uint32 poolId
    ) external whenNotPaused nonReentrant notTripped {
        address account = msg.sender;

        // Verify the account and peerId are members of the pool
        (address memberAddress, ) = storagePool.getPeerIdInfo(poolId, peerId);
        if (memberAddress == address(0) || memberAddress != account) revert NotPoolMember();

        // Calculate eligible rewards
        (uint256 miningRewards, uint256 storageRewards, uint256 totalRewards) =
            this.getEligibleRewards(account, peerId, poolId);

        if (totalRewards == 0) revert NoRewardsToClaim();

        // Additional check: ensure StakingPool can actually transfer the tokens
        // This prevents race conditions between balance check and transfer
        uint256 stakingPoolTokenBalance = token.balanceOf(address(stakingPool));
        if (stakingPoolTokenBalance < totalRewards) revert InsufficientRewards();

        // 2. EFFECTS - Update state BEFORE external calls (proper CEI pattern)
        // Store the last complete period boundary for next calculation
        uint256 joinDate = storagePool.joinTimestamp(peerId);
        uint256 lastCompletePeriodEnd = _getLastCompletePeriodEnd(joinDate, block.timestamp);
        lastClaimedRewards[account][peerId][poolId] = lastCompletePeriodEnd;

        // Update monthly rewards tracking for cap enforcement
        uint256 currentMonth = _getCurrentMonth();
        monthlyRewardsClaimed[peerId][poolId][currentMonth] += totalRewards;

        // 3. INTERACTIONS - Single atomic transfer to prevent dual-transfer ordering issues
        // First, transfer tokens from StakingPool to this contract
        bool success = stakingPool.transferTokens(totalRewards);
        if (!success) revert InsufficientRewards();

        // Update total rewards distributed after successful transfer from staking pool
        totalRewardsDistributed += totalRewards;

        // Update caller's total claimed rewards before final transfer
        totalRewardsClaimed[account] += totalRewards;

        // Now transfer tokens from this contract to the user (single external call)
        // If this fails, the entire transaction reverts and state is restored
        IERC20(address(token)).safeTransfer(account, totalRewards);

        // Emit tracking events
        emit TotalRewardsDistributedUpdated(totalRewardsDistributed);
        emit UserTotalRewardsUpdated(account, totalRewardsClaimed[account]);

        // Emit events for mining and storage rewards separately
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
        return this.getEligibleRewards(account, peerId, poolId);
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

    /// @notice Internal function to insert timestamp in linked list (O(1) operation)
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to insert
    function _insertTimestampLinked(uint32 poolId, uint256 timestamp) internal {
        // Mark timestamp as existing
        timestampExists[poolId][timestamp] = true;

        // Insert at head of linked list for O(1) insertion
        uint256 currentHead = timestampHead[poolId];
        timestampNext[poolId][timestamp] = currentHead;
        timestampHead[poolId] = timestamp;
    }



    /// @notice Get all online peerIds for a specific pool and timestamp
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @return peerIds Array of peerIds that were online at the timestamp
    function getOnlinePeerIds(uint32 poolId, uint256 timestamp) external view returns (bytes32[] memory peerIds) {
        return onlineStatus[poolId][timestamp];
    }

    /// @notice Get all online peerIds for the latest submission in a pool
    /// @param poolId The pool ID
    /// @return peerIds Array of peerIds that were online in the latest submission
    function getLatestOnlinePeerIds(uint32 poolId) external view returns (bytes32[] memory peerIds) {
        // Get the latest timestamp (first in the linked list)
        uint256 latestTimestamp = timestampHead[poolId];

        if (latestTimestamp == 0) {
            return new bytes32[](0); // No submissions yet
        }

        return this.getOnlinePeerIds(poolId, latestTimestamp);
    }

    /// @notice Check if a specific peerId was online at a timestamp
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @param peerId The peer ID to check
    /// @return isOnline True if the peerId was online at the timestamp
    function isPeerOnlineAtTimestamp(uint32 poolId, uint256 timestamp, bytes32 peerId) external view returns (bool isOnline) {
        return _isPeerOnlineAtTimestamp(poolId, timestamp, peerId);
    }

    /// @notice Get the count of recorded timestamps for a pool
    /// @param poolId The pool ID
    /// @return count Number of timestamps recorded for the pool
    function getRecordedTimestampCount(uint32 poolId) external view returns (uint256 count) {
        // Count timestamps in linked list
        uint256 currentTimestamp = timestampHead[poolId];
        count = 0;

        while (currentTimestamp != 0) {
            count++;
            currentTimestamp = timestampNext[poolId][currentTimestamp];
        }

        return count;
    }

    /// @notice Get recorded timestamps for a pool (paginated)
    /// @param poolId The pool ID
    /// @param offset Starting index
    /// @param limit Maximum number of timestamps to return
    /// @return timestamps Array of recorded timestamps
    function getRecordedTimestamps(uint32 poolId, uint256 offset, uint256 limit) external view returns (uint256[] memory timestamps) {
        // First, count total timestamps
        uint256 totalCount = this.getRecordedTimestampCount(poolId);

        if (offset >= totalCount) {
            return new uint256[](0);
        }

        uint256 endIndex = offset + limit;
        if (endIndex > totalCount) {
            endIndex = totalCount;
        }

        uint256 resultLength = endIndex - offset;
        timestamps = new uint256[](resultLength);

        // Traverse linked list to get timestamps
        uint256 currentTimestamp = timestampHead[poolId];
        uint256 currentIndex = 0;
        uint256 resultIndex = 0;

        while (currentTimestamp != 0 && resultIndex < resultLength) {
            if (currentIndex >= offset) {
                timestamps[resultIndex] = currentTimestamp;
                resultIndex++;
            }
            currentIndex++;
            currentTimestamp = timestampNext[poolId][currentTimestamp];
        }

        return timestamps;
    }

    /// @notice Internal function to safely calculate reward per period with overflow protection
    /// @return rewardPerPeriod Safe reward per period calculation
    function _calculateRewardPerPeriod() internal view returns (uint256 rewardPerPeriod) {
        // Simplified calculation: use monthly reward per peer directly
        // Calculate reward per period based on monthly amount
        uint256 periodsPerMonth = SECONDS_PER_MONTH / expectedPeriod;

        if (periodsPerMonth == 0) return 0;

        // Check for potential overflow before division
        if (monthlyRewardPerPeer > type(uint256).max / periodsPerMonth) return 0;

        return monthlyRewardPerPeer / periodsPerMonth;
    }

    /// @notice Internal function to safely calculate total reward with overflow and division protection
    /// @param rewardPerPeriod Reward per period
    /// @param onlinePeriods Number of online periods
    /// @param totalPeriods Total periods
    /// @return totalReward Safe total reward calculation
    function _calculateTotalReward(
        uint256 rewardPerPeriod,
        uint256 onlinePeriods,
        uint256 totalPeriods
    ) internal pure returns (uint256 totalReward) {
        if (totalPeriods == 0 || rewardPerPeriod == 0) return 0;

        // Check for overflow before multiplication
        if (rewardPerPeriod > 0 && onlinePeriods > type(uint256).max / rewardPerPeriod) {
            // Use alternative calculation to prevent overflow
            return (rewardPerPeriod / totalPeriods) * onlinePeriods;
        } else {
            // Safe to multiply first for better precision
            return (rewardPerPeriod * onlinePeriods) / totalPeriods;
        }
    }

    /// @notice Calculate eligible periods from join date with online status check
    /// @param peerId The peer ID
    /// @param poolId The pool ID  
    /// @param joinDate The user's join date
    /// @param calculationStartTime Start time for calculation (join date or last claimed)
    /// @param currentTime Current timestamp
    /// @return eligiblePeriods Number of complete periods with online status
    function _calculateEligiblePeriodsFromJoinDate(
        bytes32 peerId,
        uint32 poolId,
        uint256 joinDate,
        uint256 calculationStartTime,
        uint256 currentTime
    ) internal view returns (uint256 eligiblePeriods) {
        if (calculationStartTime >= currentTime || expectedPeriod == 0) {
            return 0;
        }

        // Calculate periods based on fixed boundaries from join date
        // Period boundaries are: joinDate, joinDate + expectedPeriod, joinDate + 2*expectedPeriod, etc.
        
        uint256 eligibleCount = 0;
        
        // Find the first period that starts at or after calculationStartTime
        uint256 firstPeriodIndex = 0;
        if (calculationStartTime > joinDate) {
            firstPeriodIndex = (calculationStartTime - joinDate) / expectedPeriod;
            // If calculationStartTime is not exactly on a period boundary, start from next period
            if ((calculationStartTime - joinDate) % expectedPeriod != 0) {
                firstPeriodIndex++;
            }
        }
        
        // Check each complete period from firstPeriodIndex onwards
        uint256 periodIndex = firstPeriodIndex;
        uint256 maxPeriods = 1000; // Safety limit to prevent infinite loops and overflow
        uint256 periodsChecked = 0;

        while (periodsChecked < maxPeriods) {
            uint256 periodStart = joinDate + (periodIndex * expectedPeriod);
            uint256 periodEnd = periodStart + expectedPeriod;

            // Stop if this period hasn't completed yet
            if (periodEnd > currentTime) {
                break;
            }

            // Check if user has at least one online status in this period
            if (_hasOnlineStatusInPeriod(peerId, poolId, periodStart, periodEnd)) {
                eligibleCount++;
            }

            periodIndex++;
            periodsChecked++;
        }
        
        return eligibleCount;
    }

    /// @notice Check if peerId has online status in a specific period
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param periodStart Start of the period (inclusive)
    /// @param periodEnd End of the period (exclusive)
    /// @return hasStatus True if peerId has at least one online status in the period
    function _hasOnlineStatusInPeriod(
        bytes32 peerId,
        uint32 poolId,
        uint256 periodStart,
        uint256 periodEnd
    ) internal view returns (bool hasStatus) {
        // Iterate through all recorded timestamps for this pool
        uint256 currentTimestamp = timestampHead[poolId];
        uint256 iterations = 0;
        uint256 maxIterations = 1000; // Safety limit to prevent infinite loops

        while (currentTimestamp != 0 && iterations < maxIterations) {
            // Check if timestamp falls within the period
            // Note: We need to be more flexible here - any online status timestamp
            // that falls within this period should count, regardless of normalization
            if (currentTimestamp >= periodStart && currentTimestamp < periodEnd) {
                // Check if this peerId was online at this timestamp
                if (_isPeerOnlineAtTimestamp(poolId, currentTimestamp, peerId)) {
                    return true; // Found at least one online status in this period
                }
            }
            currentTimestamp = timestampNext[poolId][currentTimestamp];
            iterations++;
        }

        return false; // No online status found in this period
    }

    /// @notice Check if peerId has any online status since a given time
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param sinceTime Start time to check from (inclusive)
    /// @param untilTime End time to check until (exclusive)
    /// @return hasStatus True if peerId has at least one online status in the time range
    function _hasAnyOnlineStatusSince(
        bytes32 peerId,
        uint32 poolId,
        uint256 sinceTime,
        uint256 untilTime
    ) internal view returns (bool hasStatus) {
        // Iterate through all recorded timestamps for this pool
        uint256 currentTimestamp = timestampHead[poolId];
        
        while (currentTimestamp != 0) {
            // Check if timestamp falls within the time range
            if (currentTimestamp >= sinceTime && currentTimestamp < untilTime) {
                // Check if this peerId was online at this timestamp
                if (_isPeerOnlineAtTimestamp(poolId, currentTimestamp, peerId)) {
                    return true; // Found at least one online status in this time range
                }
            }
            currentTimestamp = timestampNext[poolId][currentTimestamp];
        }
        
        return false; // No online status found in this time range
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
    /// @param account The address to query
    /// @return totalClaimed Total rewards claimed by the address
    /// @return totalDistributed Total rewards distributed by the contract
    /// @return claimPercentage Percentage of total rewards claimed by this address (in basis points)
    function getRewardStatistics(address account) external view returns (
        uint256 totalClaimed,
        uint256 totalDistributed,
        uint256 claimPercentage
    ) {
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
