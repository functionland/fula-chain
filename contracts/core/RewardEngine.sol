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

    // Events
    event MiningRewardsClaimed(address indexed account, string indexed peerId, uint32 indexed poolId, uint256 amount);
    event StorageRewardsClaimed(address indexed account, string indexed peerId, uint32 indexed poolId, uint256 amount);
    event OnlineStatusSubmitted(uint32 indexed poolId, address indexed submitter, uint256 count, uint256 timestamp);
    event YearlyMiningRewardsUpdated(uint256 oldAmount, uint256 newAmount);
    event ExpectedPeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event RewardPoolSet(address indexed stakingPool);
    event TotalRewardsDistributedUpdated(uint256 totalDistributed);
    event UserTotalRewardsUpdated(address indexed user, uint256 totalClaimed);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint256 amount);
    event ERC20Recovered(address indexed token, address indexed recipient, uint256 amount);

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
    uint256 public constant DEFAULT_EXPECTED_PERIOD = 8 hours;
    uint256 public constant DEFAULT_YEARLY_MINING_REWARDS = 120_000_000 * 10**18; // 120M tokens
    uint256 public constant MAX_HISTORICAL_SUBMISSION = 7 days; // Maximum 1 week back
    uint256 public constant MAX_FUTURE_SUBMISSION = 1 minutes; // Maximum 1 minute future
    uint256 public constant MAX_MONTHLY_REWARD_PER_PEER = 8000 * 10**18; // 8000 tokens per month

    // State variables
    StorageToken public token;
    StoragePool public storagePool;
    StakingPool public stakingPool;

    uint256 public yearlyMiningRewards;
    uint256 public expectedPeriod;
    uint256 public rewardSystemStartTime; // When the reward system became active

    // Online status tracking - optimized for zero-loop batch operations
    // poolId => timestamp => array of peerIds that were online
    mapping(uint32 => mapping(uint256 => string[])) public onlineStatus;

    // Timestamp index for efficient period lookups - eliminates time iteration loops
    // poolId => array of timestamps when online status was recorded
    mapping(uint32 => uint256[]) public recordedTimestamps;

    // Helper mapping to check if timestamp already exists: poolId => timestamp => index+1 (0 means not found)
    mapping(uint32 => mapping(uint256 => uint256)) private timestampIndex;

    // Claimed rewards tracking to prevent double claiming
    // account => peerId => poolId => lastClaimedTimestamp
    mapping(address => mapping(string => mapping(uint32 => uint256))) public lastClaimedRewards;

    // Track last submission timestamp per period to handle multiple submissions
    // poolId => period => lastSubmissionTimestamp
    mapping(uint32 => mapping(uint256 => uint256)) public lastPeriodSubmission;

    // Track monthly rewards per peer ID to enforce caps
    // peerId => poolId => month => claimedAmount
    mapping(string => mapping(uint32 => mapping(uint256 => uint256))) public monthlyRewardsClaimed;

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

        yearlyMiningRewards = DEFAULT_YEARLY_MINING_REWARDS;
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
            } else {
                // For view functions, still revert even after cooldown
                revert CircuitBreakerTripped();
            }
        }
    }

    /// @notice Internal function to check circuit breaker for view functions
    function _checkCircuitBreakerView() internal view {
        if (circuitBreakerTripped) {
            revert CircuitBreakerTripped();
        }
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
    }

    /// @notice Reset the circuit breaker (admin only)
    function resetCircuitBreaker() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        circuitBreakerTripped = false;
        lastCircuitBreakerResetBlock = block.number;
    }

    /// @notice Emergency withdrawal function for stuck tokens (admin only)
    /// @dev Can only transfer tokens to the StorageToken contract address for security
    /// @param tokenAddress Address of the token to withdraw
    /// @param amount Amount to withdraw
    function emergencyWithdraw(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) whenPaused nonReentrant {
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

    /// @notice Set the yearly mining rewards amount
    /// @param _yearlyMiningRewards New yearly mining rewards amount
    function setYearlyMiningRewards(uint256 _yearlyMiningRewards)
        external
        whenNotPaused
        nonReentrant
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (_yearlyMiningRewards == 0) revert InvalidAmount();

        uint256 oldAmount = yearlyMiningRewards;
        yearlyMiningRewards = _yearlyMiningRewards;

        emit YearlyMiningRewardsUpdated(oldAmount, _yearlyMiningRewards);
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
        string[] calldata peerIds,
        uint256 timestamp
    ) external whenNotPaused nonReentrant {
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

        // Normalize timestamp to period boundary for consistent storage
        uint256 normalizedTimestamp = _normalizeToPeriodBoundary(timestamp);

        // Zero-loop batch recording - store entire array at once
        // No validation needed here - pool membership will be verified during reward calculation
        onlineStatus[poolId][normalizedTimestamp] = peerIds;

        // Record timestamp in sorted order if it's new (for efficient binary search)
        if (timestampIndex[poolId][normalizedTimestamp] == 0) {
            _insertTimestampSorted(poolId, normalizedTimestamp);
        }

        emit OnlineStatusSubmitted(poolId, msg.sender, peerIds.length, normalizedTimestamp);
    }

    /// @notice Get online status for a specific peerId since a given time
    /// @param peerId The peer ID
    /// @param poolId The pool ID
    /// @param sinceTime The timestamp to check from (0 for default period)
    /// @return onlineCount Number of online status records found
    /// @return totalExpected Total expected status reports in the period
    function getOnlineStatusSince(
        string memory peerId,
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

        // Ultra-optimized: Use binary search to find timestamp range efficiently
        // This scales logarithmically instead of linearly, crucial for long-term usage
        uint256[] storage timestamps = recordedTimestamps[poolId];
        onlineCount = 0;

        if (timestamps.length == 0) {
            return (0, totalExpected);
        }

        // Binary search to find the start and end indices for our time range
        uint256 startIndex = _findFirstTimestampIndex(timestamps, normalizedSinceTime);
        uint256 endIndex = _findLastTimestampIndex(timestamps, normalizedCurrentTime);

        // Only iterate through timestamps within our range
        for (uint256 i = startIndex; i <= endIndex && i < timestamps.length; i++) {
            uint256 timestamp = timestamps[i];

            // Check if this peerId was online at this timestamp
            if (_isPeerOnlineAtTimestamp(poolId, timestamp, peerId)) {
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
        string memory peerId,
        uint32 poolId
    ) external view returns (uint256 effectiveStartTime) {
        // Verify the account and peerId are members of the pool
        (bool isMember, address memberAddress) = storagePool.isPeerIdMemberOfPool(poolId, peerId);
        if (!isMember || memberAddress != account) revert NotPoolMember();

        // Get member join date
        (, , uint256 joinDate, ) = storagePool.getMemberReputation(poolId, account);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];

        if (lastClaimed > 0) {
            // User has claimed before - start from last claim
            return lastClaimed;
        } else {
            // First time claiming - start from the later of join date or reward system start
            return joinDate > rewardSystemStartTime ? joinDate : rewardSystemStartTime;
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
        string memory peerId,
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
        (bool isMember, address memberAddress) = storagePool.isPeerIdMemberOfPool(poolId, peerId);
        if (!isMember || memberAddress != account) revert NotPoolMember();

        startTime = this.getEffectiveRewardStartTime(account, peerId, poolId);
        endTime = block.timestamp;

        if (startTime >= endTime) {
            return (startTime, endTime, 0, 0, 0, 0);
        }

        (onlinePeriods, totalPeriods) = this.getOnlineStatusSince(peerId, poolId, startTime);

        // Calculate reward per period with consolidated overflow and division protection
        uint256 totalMembers = storagePool.getTotalMembers();
        if (totalMembers > 0 && totalPeriods > 0) {
            rewardPerPeriod = _calculateRewardPerPeriod(totalMembers);
            totalReward = _calculateTotalReward(rewardPerPeriod, onlinePeriods, totalPeriods);
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
        string memory peerId,
        uint32 poolId
    ) external view returns (uint256 eligibleRewards) {
        // Verify the account and peerId are members of the pool
        (bool isMember, address memberAddress) = storagePool.isPeerIdMemberOfPool(poolId, peerId);
        if (!isMember || memberAddress != account) revert NotPoolMember();

        // Get member join date and last claimed timestamp
        (, , uint256 joinDate, ) = storagePool.getMemberReputation(poolId, account);
        uint256 lastClaimed = lastClaimedRewards[account][peerId][poolId];

        // Determine the start time for reward calculation
        uint256 sinceTime;
        if (lastClaimed > 0) {
            // User has claimed before - calculate from last claim
            sinceTime = lastClaimed;
        } else {
            // First time claiming - calculate from the later of join date or reward system start
            // This prevents claiming rewards from before the reward system was active
            sinceTime = joinDate > rewardSystemStartTime ? joinDate : rewardSystemStartTime;
        }

        // Ensure we don't calculate rewards from the future
        if (sinceTime >= block.timestamp) {
            return 0;
        }

        // Get online status since the calculated start time
        // Note: Users only get rewards for periods they were marked as online
        // If status reporting is missed for multiple periods, no rewards are given for those periods
        // This incentivizes consistent status reporting and prevents retroactive reward claims
        (uint256 onlineCount, uint256 totalExpected) = this.getOnlineStatusSince(peerId, poolId, sinceTime);

        if (onlineCount == 0 || totalExpected == 0) {
            return 0;
        }

        // Calculate base mining reward per period using consolidated function
        uint256 totalMembers = storagePool.getTotalMembers();
        if (totalMembers == 0) return 0;

        uint256 rewardPerMemberPerPeriod = _calculateRewardPerPeriod(totalMembers);
        if (rewardPerMemberPerPeriod == 0) return 0;

        // Calculate eligible rewards using consolidated function
        eligibleRewards = _calculateTotalReward(rewardPerMemberPerPeriod, onlineCount, totalExpected);

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
        string memory peerId,
        uint32 poolId
    ) external view returns (uint256 eligibleRewards) {
        // Verify the account and peerId are members of the pool
        (bool isMember, address memberAddress) = storagePool.isPeerIdMemberOfPool(poolId, peerId);
        if (!isMember || memberAddress != account) revert NotPoolMember();

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
        string memory peerId,
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
        string memory peerId,
        uint32 poolId
    ) external whenNotPaused nonReentrant notTripped {
        address account = msg.sender;

        // Verify the account and peerId are members of the pool
        (bool isMember, address memberAddress) = storagePool.isPeerIdMemberOfPool(poolId, peerId);
        if (!isMember || memberAddress != account) revert NotPoolMember();

        // Calculate eligible rewards
        (uint256 miningRewards, uint256 storageRewards, uint256 totalRewards) =
            this.getEligibleRewards(account, peerId, poolId);

        if (totalRewards == 0) revert NoRewardsToClaim();

        // Additional check: ensure StakingPool can actually transfer the tokens
        // This prevents race conditions between balance check and transfer
        uint256 stakingPoolTokenBalance = token.balanceOf(address(stakingPool));
        if (stakingPoolTokenBalance < totalRewards) revert InsufficientRewards();

        // 2. EFFECTS - Update state BEFORE external calls (proper CEI pattern)
        lastClaimedRewards[account][peerId][poolId] = block.timestamp;

        // Update monthly rewards tracking for cap enforcement
        uint256 currentMonth = _getCurrentMonth();
        monthlyRewardsClaimed[peerId][poolId][currentMonth] += totalRewards;

        // 3. INTERACTIONS - External calls last
        // If ANY external call fails, the entire transaction reverts
        // This automatically restores the state to before the transaction
        bool success = stakingPool.transferTokens(totalRewards);
        if (!success) revert InsufficientRewards();

        // Update total rewards distributed after successful transfer from staking pool
        totalRewardsDistributed += totalRewards;

        // Update caller's total claimed rewards before final transfer
        totalRewardsClaimed[account] += totalRewards;

        // Transfer tokens to the user (external call)
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
        string memory peerId,
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
        string memory peerId,
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
        (, , , , , address poolCreator, ) = storagePool.pools(poolId);
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
    function _isPeerOnlineAtTimestamp(uint32 poolId, uint256 timestamp, string memory peerId) internal view returns (bool isOnline) {
        string[] memory onlinePeers = onlineStatus[poolId][timestamp];
        for (uint256 i = 0; i < onlinePeers.length; i++) {
            if (keccak256(bytes(onlinePeers[i])) == keccak256(bytes(peerId))) {
                return true;
            }
        }
        return false;
    }

    /// @notice Internal function to insert timestamp in sorted order
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to insert
    function _insertTimestampSorted(uint32 poolId, uint256 timestamp) internal {
        uint256[] storage timestamps = recordedTimestamps[poolId];

        // If array is empty or timestamp is greater than last element, just append
        if (timestamps.length == 0 || timestamp > timestamps[timestamps.length - 1]) {
            timestamps.push(timestamp);
            timestampIndex[poolId][timestamp] = timestamps.length;
            return;
        }

        // Find insertion point using binary search
        uint256 insertIndex = _findInsertionIndex(timestamps, timestamp);

        // Insert at the found position
        timestamps.push(0); // Expand array

        // Shift elements to the right
        for (uint256 i = timestamps.length - 1; i > insertIndex; i--) {
            timestamps[i] = timestamps[i - 1];
        }

        // Insert the new timestamp
        timestamps[insertIndex] = timestamp;

        // Update all indices after insertion point
        for (uint256 i = insertIndex; i < timestamps.length; i++) {
            timestampIndex[poolId][timestamps[i]] = i + 1;
        }
    }

    /// @notice Internal function to find insertion index for maintaining sorted order
    /// @param timestamps Sorted array of timestamps
    /// @param timestamp Timestamp to find insertion point for
    /// @return index The index where timestamp should be inserted
    function _findInsertionIndex(uint256[] storage timestamps, uint256 timestamp) internal view returns (uint256 index) {
        uint256 left = 0;
        uint256 right = timestamps.length;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            if (timestamps[mid] < timestamp) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        return left;
    }

    /// @notice Internal function to find first timestamp index >= target using binary search
    /// @param timestamps Sorted array of timestamps
    /// @param target Target timestamp
    /// @return index First index where timestamp >= target
    function _findFirstTimestampIndex(uint256[] storage timestamps, uint256 target) internal view returns (uint256 index) {
        uint256 left = 0;
        uint256 right = timestamps.length;

        while (left < right) {
            uint256 mid = (left + right) / 2;
            if (timestamps[mid] < target) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        return left;
    }

    /// @notice Internal function to find last timestamp index <= target using binary search
    /// @param timestamps Sorted array of timestamps
    /// @param target Target timestamp
    /// @return index Last index where timestamp <= target
    function _findLastTimestampIndex(uint256[] storage timestamps, uint256 target) internal view returns (uint256 index) {
        if (timestamps.length == 0) return 0;

        uint256 left = 0;
        uint256 right = timestamps.length - 1;

        while (left <= right) {
            uint256 mid = (left + right) / 2;
            if (timestamps[mid] <= target) {
                left = mid + 1;
            } else {
                if (mid == 0) break;
                right = mid - 1;
            }
        }

        return right;
    }

    /// @notice Get all online peerIds for a specific pool and timestamp
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @return peerIds Array of peerIds that were online at the timestamp
    function getOnlinePeerIds(uint32 poolId, uint256 timestamp) external view returns (string[] memory peerIds) {
        return onlineStatus[poolId][timestamp];
    }

    /// @notice Check if a specific peerId was online at a timestamp
    /// @param poolId The pool ID
    /// @param timestamp The timestamp to check
    /// @param peerId The peer ID to check
    /// @return isOnline True if the peerId was online at the timestamp
    function isPeerOnlineAtTimestamp(uint32 poolId, uint256 timestamp, string memory peerId) external view returns (bool isOnline) {
        return _isPeerOnlineAtTimestamp(poolId, timestamp, peerId);
    }

    /// @notice Get the count of recorded timestamps for a pool
    /// @param poolId The pool ID
    /// @return count Number of timestamps recorded for the pool
    function getRecordedTimestampCount(uint32 poolId) external view returns (uint256 count) {
        return recordedTimestamps[poolId].length;
    }

    /// @notice Get recorded timestamps for a pool (paginated)
    /// @param poolId The pool ID
    /// @param offset Starting index
    /// @param limit Maximum number of timestamps to return
    /// @return timestamps Array of recorded timestamps
    function getRecordedTimestamps(uint32 poolId, uint256 offset, uint256 limit) external view returns (uint256[] memory timestamps) {
        uint256[] storage allTimestamps = recordedTimestamps[poolId];
        uint256 totalCount = allTimestamps.length;

        if (offset >= totalCount) {
            return new uint256[](0);
        }

        uint256 endIndex = offset + limit;
        if (endIndex > totalCount) {
            endIndex = totalCount;
        }

        uint256 resultLength = endIndex - offset;
        timestamps = new uint256[](resultLength);

        for (uint256 i = 0; i < resultLength; i++) {
            timestamps[i] = allTimestamps[offset + i];
        }

        return timestamps;
    }

    /// @notice Internal function to safely calculate reward per period with overflow protection
    /// @param totalMembers Total number of members
    /// @return rewardPerPeriod Safe reward per period calculation
    function _calculateRewardPerPeriod(uint256 totalMembers) internal view returns (uint256 rewardPerPeriod) {
        if (totalMembers == 0) return 0;

        // Check for potential overflow before multiplication
        if (yearlyMiningRewards > type(uint256).max / expectedPeriod) return 0;

        uint256 numerator = yearlyMiningRewards * expectedPeriod;
        uint256 denominator = SECONDS_PER_YEAR * totalMembers;

        // Additional safety check for denominator
        if (denominator == 0) return 0;

        return numerator / denominator;
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

    /// @notice Get total rewards claimed by a specific address
    /// @param account The address to query
    /// @return totalClaimed Total rewards claimed by the address
    function getTotalRewardsClaimed(address account) external view returns (uint256 totalClaimed) {
        return totalRewardsClaimed[account];
    }

    /// @notice Get total rewards distributed by the contract
    /// @return totalDistributed Total rewards distributed
    function getTotalRewardsDistributed() external view returns (uint256 totalDistributed) {
        return totalRewardsDistributed;
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

    /// @notice Get contract version for upgrade compatibility
    /// @return version Contract version
    function getVersion() external pure returns (uint256 version) {
        return 1;
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
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];

        // Currently no custom proposals to execute
        // This function could be extended in the future if needed

        revert InvalidProposalType(uint8(proposal.proposalType));
    }

    /// @notice Create custom proposals for this contract
    function _createCustomProposal(
        uint8 proposalType,
        uint40 /* id */,
        address /* target */,
        bytes32 /* role */,
        uint96 /* amount */,
        address /* tokenAddress */
    ) internal virtual override returns (bytes32) {
        // Currently no custom proposals supported
        // This function could be extended in the future if needed
        revert InvalidProposalType(proposalType);
    }
}
