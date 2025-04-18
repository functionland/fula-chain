// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/*
Staking Periods and Rewards
User cannot claim rewards before the staking priod is over
| Lock Period | Duration | Fixed APY | Referrer Reward | 
|-------------|----------|-----------|-----------------| 
| LOCK_PERIOD_1 | 90 days | 2% | 0% | 
| LOCK_PERIOD_2 | 180 days | 6% | 1% | 
| LOCK_PERIOD_3 | 365 days | 15% | 4% |
*/
/*
Early Unstaking Penalty
| Time Remaining | Penalty Applied | 
|----------------|-----------------| 
| Very short period (< 3 dayS) | 95% penalty + 20% principal penalty | 
| > 90% time remaining | 90% penalty | 
| > 75% time remaining | 75% penalty | 
| > 60% time remaining | 60% penalty | 
| > 45% time remaining | 45% penalty | 
| > 30% time remaining | 30% penalty | 
| > 15% time remaining | 20% penalty | 
| < 15% time remaining | 10% penalty | 
| Full lock period elapsed | 0% (no penalty) |
*/
/*
Maximum and Minimum Limits
| Limit | Value | Description | 
|-------|-------|-------------| 
| Minimum Stake Amount | > 0 | The amount staked must be greater than zero | 
| MAX_STAKES_TO_PROCESS | 100 | Maximum number of stakes that can be processed in a single operation (for gas efficiency) | 
| PRECISION_FACTOR | 1e18 | Used for precision in calculations to avoid rounding errors |
*/

/// @title StakingEngine
/// @notice Handles token staking with different lock periods and rewards
/// @dev Non-upgradeable version of the staking contract with separate stake and reward pool addresses
contract StakingEngine is ERC20, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Define roles for access control
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    // Lock periods in seconds
    uint32 public constant LOCK_PERIOD_1 = 90 days;
    uint32 public constant LOCK_PERIOD_2 = 180 days;
    uint32 public constant LOCK_PERIOD_3 = 365 days;

    // Fixed APY percentages for each lock period
    uint256 public constant FIXED_APY_90_DAYS = 2; // 2% for 90 days
    uint256 public constant FIXED_APY_180_DAYS = 6; // 6% for 180 days
    uint256 public constant FIXED_APY_365_DAYS = 15; // 15% for 365 days

    // Referrer reward percentages for each lock period
    uint256 public constant REFERRER_REWARD_PERCENT_90_DAYS = 0; // 0% for 90 days
    uint256 public constant REFERRER_REWARD_PERCENT_180_DAYS = 1; // 1% for 180 days
    uint256 public constant REFERRER_REWARD_PERCENT_365_DAYS = 4; // 4% for 365 days

    // Precision factor for calculations to avoid rounding errors
    uint256 public constant PRECISION_FACTOR = 1e18;
    
    // Maximum number of stakes to process in a single operation
    uint256 public constant MAX_STAKES_TO_PROCESS = 100;

    // Referrer reward claim period
    uint256 public constant REFERRER_CLAIM_PERIOD = 90 days;

    struct StakeInfo {
        uint256 amount;
        uint256 rewardDebt; // Tracks user's share of accumulated rewards
        uint256 lockPeriod;
        uint256 startTime; // Track when the stake was created
        address referrer; // Address of the referrer (if any)
        bool isActive; // Whether the stake is still active
    }

    struct ReferrerInfo {
        uint256 totalReferred; // Total amount of tokens referred
        uint256 totalReferrerRewards; // Total rewards earned by the referrer
        uint256 unclaimedRewards; // Unclaimed rewards
        uint256 lastClaimTime; // Last time rewards were claimed
        uint256 referredStakersCount; // Number of unique stakers referred
        uint256 activeReferredStakersCount; // Number of active stakers referred
        uint256 totalActiveStaked; // Total amount of tokens currently staked by referees
        uint256 totalUnstaked; // Total amount of tokens unstaked by referees
        uint256 totalActiveStaked90Days; // Total active staked for 90 days
        uint256 totalActiveStaked180Days; // Total active staked for 180 days
        uint256 totalActiveStaked365Days; // Total active staked for 365 days
    }

    struct ReferrerRewardInfo {
        uint256 stakeId; // ID of the stake
        uint256 amount; // Amount of the stake
        uint256 lockPeriod; // Lock period of the stake
        uint256 startTime; // Start time of the stake
        uint256 endTime; // End time of the stake (startTime + lockPeriod)
        uint256 totalReward; // Total reward for the referrer
        uint256 claimedReward; // Amount of reward already claimed
        uint256 nextClaimTime; // Next time rewards can be claimed
        bool isActive; // Whether the stake is still active
        address referee; // Address of the referee
    }

    // Mapping from referrer to array of referred stakers
    mapping(address => address[]) public referredStakers;
    
    // Mapping from referrer to mapping of staker to whether they are referred
    mapping(address => mapping(address => bool)) public isReferred;

    // Mapping from referrer to array of referrer reward info
    mapping(address => ReferrerRewardInfo[]) public referrerRewards;

    mapping(address => StakeInfo[]) public stakes;
    mapping(address => ReferrerInfo) public referrers;
    mapping(address => mapping(uint256 => uint256)) public referrerRewardsByPeriod;
    
    uint256 public totalStaked;
    uint256 public lastUpdateTime;

    IERC20 public token;

    // CHANGE: Separate stake and reward pool addresses instead of single tokenPool
    address public stakePool;
    address public rewardPool;

    // Tracking variables for internal accounting
    uint256 public totalStakedInPool;    // Total tokens staked by users
    uint256 public totalRewardsInPool;   // Total tokens allocated for rewards

    uint256 public accRewardPerToken90Days;
    uint256 public accRewardPerToken180Days;
    uint256 public accRewardPerToken365Days;

    uint256 public totalStaked90Days;
    uint256 public totalStaked180Days;
    uint256 public totalStaked365Days;

    event RewardsAdded(uint256 amount);
    event RewardsWithdrawn(uint256 amount);
    event Staked(address indexed user, uint256 amount, uint256 lockPeriod);
    event StakedWithReferrer(address indexed user, address indexed referrer, uint256 amount, uint256 lockPeriod);
    event Unstaked(address indexed user, uint256 amount, uint256 distributedReward, uint256 penalty);
    event MissedRewards(address indexed user, uint256 amount);
    event ReferrerRewardsClaimed(address indexed referrer, uint256 amount);
    event ReferrerRewardUpdated(address indexed referrer, address indexed referee, uint256 stakeId, uint256 amount, uint256 lockPeriod);
    event TokensTransferredToStorageToken(address indexed from, uint256 amount);
    event RewardDistributionLog(
        address indexed user,
        uint256 amount,
        uint256 pendingRewards,
        uint256 penalty,
        uint256 rewardPoolBalance,
        uint256 lockPeriod,
        uint256 elapsedTime
    );
    event UnableToDistributeRewards(address indexed user, uint256 rewardPoolBalance, uint256 stakedAmount, uint256 finalRewards, uint256 lockPeriod);
    event EmergencyAction(string action, uint256 timestamp);
    event EarlyUnstakePenalty(address indexed user, uint256 originalAmount, uint256 penaltyAmount, uint256 returnedAmount);
    event PoolBalanceReconciled(uint256 amount, bool isExcess);

    error OperationFailed(uint256 code);
    error TotalStakedTooLow(uint256 totalStaked, uint256 required);
    error APYCannotBeSatisfied(uint8 stakingPeriod, uint256 projectedAPY, uint256 minimumAPY);
    error InvalidStorageTokenAddress();
    error NoReferrerRewardsAvailable();
    error InvalidTokenAddress();
    error InvalidReferrerAddress();
    error InsufficientApproval();
    error NoClaimableRewards();
    error ClaimPeriodNotReached();

    /**
     * @notice Constructor for the non-upgradeable contract
     * @param _token Address of the StorageToken
     * @param _stakePool Address of the stake pool
     * @param _rewardPool Address of the reward pool
     * @param initialOwner Address of the initial owner
     * @param initialAdmin Address of the initial admin
     * @param name Name of the token
     * @param symbol Symbol of the token
     */
    constructor(
        address _token,
        address _stakePool,
        address _rewardPool,
        address initialOwner,
        address initialAdmin,
        string memory name,
        string memory symbol
    ) ERC20(name, symbol) {
        require(
            _token != address(0) && 
            _stakePool != address(0) && 
            _rewardPool != address(0) && 
            initialOwner != address(0) && 
            initialAdmin != address(0), 
            "Invalid address"
        );

        // Validate that the token address is a valid ERC20 token
        try IERC20(_token).totalSupply() returns (uint256) {
            // Token implements totalSupply, likely a valid ERC20
        } catch {
            revert InvalidTokenAddress();
        }

        // Initialize roles
        _grantRole(OWNER_ROLE, initialOwner);
        _grantRole(ADMIN_ROLE, initialAdmin);
        _setRoleAdmin(ADMIN_ROLE, OWNER_ROLE);
        
        token = IERC20(_token);
        stakePool = _stakePool;
        rewardPool = _rewardPool;
        
        // Initialize tracking variables
        totalStakedInPool = 0;
        totalRewardsInPool = 0;
        lastUpdateTime = block.timestamp;
    }

    /**
     * @notice Emergency pause reward distribution
     * @dev Can only be called by admin
     */
    function emergencyPauseRewardDistribution() external onlyRole(ADMIN_ROLE) {
        _pause();
        emit EmergencyAction("Rewards Distribution paused", block.timestamp);
    }

    /**
     * @notice Emergency unpause reward distribution
     * @dev Can only be called by admin
     */
    function emergencyUnpauseRewardDistribution() external onlyRole(ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction("Rewards Distribution unpaused", block.timestamp);
    }

    /**
     * @notice Add rewards to the pool
     * @param amount Amount of rewards to add
     */
    function addRewardsToPool(uint256 amount) external onlyRole(OWNER_ROLE) {
        // Transfer tokens from sender to pool
        token.safeTransferFrom(msg.sender, rewardPool, amount);
        
        // Update tracking
        totalRewardsInPool += amount;
        
        emit RewardsAdded(amount);
    }

    /**
     * @notice Withdraw excess rewards if needed
     * @param amount Amount to withdraw
     */
    function withdrawExcessRewards(uint256 amount) external onlyRole(OWNER_ROLE) {
        uint256 excessRewards = getExcessRewards();
        require(amount <= excessRewards, "Cannot withdraw required rewards");
        
        // Update tracking before transfer
        totalRewardsInPool -= amount;
        
        // Transfer tokens from pool to owner
        // Pool must approve this contract first
        token.safeTransferFrom(rewardPool, msg.sender, amount);
        
        emit RewardsWithdrawn(amount);
    }

    /**
     * @notice Get excess rewards (rewards beyond what's needed for current stakes)
     * @return Amount of excess rewards
     */
    function getExcessRewards() public view returns (uint256) {
        uint256 requiredRewards = calculateRequiredRewards();
        if (totalRewardsInPool > requiredRewards) {
            return totalRewardsInPool - requiredRewards;
        }
        return 0;
    }

    /**
     * @notice Calculate rewards required for current stakes
     * @return Amount of rewards required
     */
    function calculateRequiredRewards() public view returns (uint256) {
        // Calculate required rewards based on current stakes and APY
        uint256 required90Days = (totalStaked90Days * FIXED_APY_90_DAYS) / 100;
        uint256 required180Days = (totalStaked180Days * FIXED_APY_180_DAYS) / 100;
        uint256 required365Days = (totalStaked365Days * FIXED_APY_365_DAYS) / 100;
        
        return required90Days + required180Days + required365Days;
    }

    /**
     * @notice Get detailed pool status
     * @return totalPoolBalance Expected total balance in pool
     * @return stakedAmount Amount of staked tokens
     * @return rewardsAmount Amount of reward tokens
     * @return actualBalance Actual token balance in pool
     */
    function getPoolStatus() external view returns (
        uint256 totalPoolBalance,
        uint256 stakedAmount,
        uint256 rewardsAmount,
        uint256 actualBalance
    ) {
        totalPoolBalance = totalStakedInPool + totalRewardsInPool;
        stakedAmount = totalStakedInPool;
        rewardsAmount = totalRewardsInPool;
        actualBalance = token.balanceOf(stakePool) + token.balanceOf(rewardPool);
        
        return (totalPoolBalance, stakedAmount, rewardsAmount, actualBalance);
    }

    /**
     * @notice Reconcile pool balance if accounting gets out of sync
     */
    function reconcilePoolBalance() external onlyRole(OWNER_ROLE) {
        uint256 expectedBalance = totalStakedInPool + totalRewardsInPool;
        uint256 actualBalance = token.balanceOf(stakePool) + token.balanceOf(rewardPool);
        
        if (actualBalance > expectedBalance) {
            // Excess tokens found, add to rewards
            uint256 excess = actualBalance - expectedBalance;
            totalRewardsInPool += excess;
            emit PoolBalanceReconciled(excess, true);
        } else if (actualBalance < expectedBalance) {
            // Shortage found, reduce rewards (never reduce staked amount)
            uint256 shortage = expectedBalance - actualBalance;
            if (shortage <= totalRewardsInPool) {
                totalRewardsInPool -= shortage;
            } else {
                // Critical situation - not enough rewards to cover shortage
                totalRewardsInPool = 0;
                emit EmergencyAction("Critical pool shortage detected", block.timestamp);
            }
            emit PoolBalanceReconciled(shortage, false);
        }
    }

    /**
     * @notice Set new stake pool address
     * @param _stakePool New stake pool address
     */
    function setStakePool(address _stakePool) external onlyRole(OWNER_ROLE) {
        require(_stakePool != address(0), "Invalid address");
        stakePool = _stakePool;
    }

    /**
     * @notice Set new reward pool address
     * @param _rewardPool New reward pool address
     */
    function setRewardPool(address _rewardPool) external onlyRole(OWNER_ROLE) {
        require(_rewardPool != address(0), "Invalid address");
        rewardPool = _rewardPool;
    }

    /**
     * @notice Get all stakes for a user
     * @param user Address of the user
     * @return Array of StakeInfo structs
     */
    function getUserStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }

    /**
     * @notice Get total staked amount by a user
     * @param user Address of the user
     * @return Total staked amount
     */
    function getUserTotalStaked(address user) external view returns (uint256) {
        uint256 total = 0;
        StakeInfo[] memory userStakes = stakes[user];
        
        for (uint256 i = 0; i < userStakes.length; i++) {
            if (userStakes[i].isActive) {
                total += userStakes[i].amount;
            }
        }
        
        return total;
    }

    /**
     * @notice Get total staked amount across all users
     * @return Total staked amount
     */
    function getTotalStaked() external view returns (uint256) {
        return totalStaked;
    }

    /**
     * @notice Get all referrer statistics
     * @param referrer Address of the referrer
     * @return ReferrerInfo struct with all statistics
     */
    function getReferrerStats(address referrer) external view returns (ReferrerInfo memory) {
        return referrers[referrer];
    }

    /**
     * @notice Get all referred stakers for a referrer
     * @param referrer Address of the referrer
     * @return Array of referred staker addresses
     */
    function getReferredStakers(address referrer) external view returns (address[] memory) {
        return referredStakers[referrer];
    }

    /**
     * @notice Get all referrer rewards
     * @param referrer Address of the referrer
     * @return Array of ReferrerRewardInfo structs
     */
    function getReferrerRewards(address referrer) external view returns (ReferrerRewardInfo[] memory) {
        return referrerRewards[referrer];
    }

    /**
     * @notice Get claimable rewards for a referrer
     * @param referrer Address of the referrer
     * @return Claimable rewards amount
     */
    function getClaimableReferrerRewards(address referrer) public view returns (uint256) {
        uint256 claimable = 0;
        ReferrerRewardInfo[] memory rewards = referrerRewards[referrer];
        
        for (uint256 i = 0; i < rewards.length; i++) {
            if (rewards[i].isActive && block.timestamp >= rewards[i].nextClaimTime) {
                // Calculate how many claim periods have passed since last claim
                uint256 timeSinceLastClaim = block.timestamp - (rewards[i].nextClaimTime - REFERRER_CLAIM_PERIOD);
                uint256 claimPeriodsPassed = timeSinceLastClaim / REFERRER_CLAIM_PERIOD;
                
                // Only proceed if at least one period has passed
                if (claimPeriodsPassed > 0) {
                    // Calculate total time from start to now
                    uint256 totalTimeElapsed = block.timestamp - rewards[i].startTime;
                    
                    // Calculate total reward per day
                    uint256 rewardPerDay = rewards[i].totalReward / (rewards[i].lockPeriod / 1 days);
                    
                    // Calculate reward for the claim periods
                    uint256 daysToReward = claimPeriodsPassed * (REFERRER_CLAIM_PERIOD / 1 days);
                    
                    // Ensure we don't exceed the lock period
                    if (totalTimeElapsed > rewards[i].lockPeriod) {
                        daysToReward = (rewards[i].lockPeriod / 1 days) - (rewards[i].claimedReward / rewardPerDay);
                    }
                    
                    uint256 periodReward = rewardPerDay * daysToReward;
                    
                    // Ensure we don't exceed the total reward
                    if (rewards[i].claimedReward + periodReward > rewards[i].totalReward) {
                        periodReward = rewards[i].totalReward - rewards[i].claimedReward;
                    }
                    
                    claimable += periodReward;
                }
            }
        }
        
        return claimable;
    }

    /**
     * @notice Claim referrer rewards
     * @dev Allows referrers to claim their accumulated rewards
     */
    function claimReferrerRewards() external nonReentrant whenNotPaused {
        address referrer = msg.sender;
        uint256 claimable = getClaimableReferrerRewards(referrer);
        
        if (claimable == 0) {
            revert NoClaimableRewards();
        }
        
        ReferrerRewardInfo[] storage rewards = referrerRewards[referrer];
        
        // Update claimed amounts and next claim times
        for (uint256 i = 0; i < rewards.length; i++) {
            if (rewards[i].isActive && block.timestamp >= rewards[i].nextClaimTime) {
                // Calculate how many claim periods have passed since last claim
                uint256 timeSinceLastClaim = block.timestamp - (rewards[i].nextClaimTime - REFERRER_CLAIM_PERIOD);
                uint256 claimPeriodsPassed = timeSinceLastClaim / REFERRER_CLAIM_PERIOD;
                
                // Only proceed if at least one period has passed
                if (claimPeriodsPassed > 0) {
                    // Calculate total time from start to now
                    uint256 totalTimeElapsed = block.timestamp - rewards[i].startTime;
                    
                    // Calculate total reward per day
                    uint256 rewardPerDay = rewards[i].totalReward / (rewards[i].lockPeriod / 1 days);
                    
                    // Calculate reward for the claim periods
                    uint256 daysToReward = claimPeriodsPassed * (REFERRER_CLAIM_PERIOD / 1 days);
                    
                    // Ensure we don't exceed the lock period
                    if (totalTimeElapsed > rewards[i].lockPeriod) {
                        daysToReward = (rewards[i].lockPeriod / 1 days) - (rewards[i].claimedReward / rewardPerDay);
                    }
                    
                    uint256 periodReward = rewardPerDay * daysToReward;
                    
                    // Ensure we don't exceed the total reward
                    if (rewards[i].claimedReward + periodReward > rewards[i].totalReward) {
                        periodReward = rewards[i].totalReward - rewards[i].claimedReward;
                    }
                    
                    if (periodReward > 0) {
                        rewards[i].claimedReward += periodReward;
                        rewards[i].nextClaimTime = block.timestamp + REFERRER_CLAIM_PERIOD;
                    }
                }
            }
        }
        
        // Update referrer info
        ReferrerInfo storage referrerInfo = referrers[referrer];
        referrerInfo.lastClaimTime = block.timestamp;
        
        // Check if pool has sufficient balance for rewards
        uint256 poolBalance = token.balanceOf(rewardPool);
        uint256 availableForRewards = poolBalance;
        
        if (availableForRewards < claimable) {
            emit UnableToDistributeRewards(referrer, availableForRewards, 0, claimable, 0);
        } else {
            // Update contract accounting
            totalRewardsInPool -= claimable;
            
            // Update the totalReferrerRewards to track claimed rewards
            referrerInfo.totalReferrerRewards += claimable;
            
            // Transfer rewards
            token.safeTransferFrom(rewardPool, referrer, claimable);
            emit ReferrerRewardsClaimed(referrer, claimable);
        }
    }

    /**
     * @notice Update accumulated rewards
     * @dev Updates the accumulated rewards per token for each lock period
     */
    function updateRewards() public {
        if (block.timestamp <= lastUpdateTime) {
            return;
        }
        
        uint256 timeElapsed = block.timestamp - lastUpdateTime;
        
        // Update accumulated rewards for each lock period
        if (totalStaked90Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked90Days, FIXED_APY_90_DAYS, timeElapsed);
            accRewardPerToken90Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked90Days;
        }
        
        if (totalStaked180Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked180Days, FIXED_APY_180_DAYS, timeElapsed);
            accRewardPerToken180Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked180Days;
        }
        
        if (totalStaked365Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked365Days, FIXED_APY_365_DAYS, timeElapsed);
            accRewardPerToken365Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked365Days;
        }
        
        lastUpdateTime = block.timestamp;
    }

    /**
     * @notice Internal function to stake tokens
     * @param amount The amount to stake
     * @param lockPeriod The lock period (90, 180, or 365 days)
     * @param referrer Optional address of the referrer
     */
    function _stakeTokenInternal(uint256 amount, uint256 lockPeriod, address referrer) internal {
        // Update rewards before processing the stake
        updateRewards();
        
        // Calculate pending rewards for existing stakes
        uint256 pendingRewards = 0;
        for (uint256 i = 0; i < stakes[msg.sender].length; i++) {
            StakeInfo storage stake = stakes[msg.sender][i];
            if (stake.isActive) {
                uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(stake.lockPeriod);
                uint256 pendingReward = (stake.amount * (accRewardPerToken - stake.rewardDebt)) / PRECISION_FACTOR;
                pendingRewards += pendingReward;
                
                // Update reward debt to current accumulated rewards
                stake.rewardDebt = accRewardPerToken;
            }
        }
        
        // Add new stake
        uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(lockPeriod);
        stakes[msg.sender].push(
            StakeInfo({
                amount: amount,
                rewardDebt: accRewardPerToken,
                lockPeriod: lockPeriod,
                startTime: block.timestamp,
                referrer: referrer,
                isActive: true
            })
        );
        
        // Update total staked amounts
        totalStaked += amount;
        totalStakedInPool += amount;
        
        if (lockPeriod == LOCK_PERIOD_1) {
            totalStaked90Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked180Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked365Days += amount;
        }
        
        // Update referrer information if provided
        if (referrer != address(0)) {
            ReferrerInfo storage referrerInfo = referrers[referrer];
            
            // If this is a new referee for this referrer
            if (!isReferred[referrer][msg.sender]) {
                isReferred[referrer][msg.sender] = true;
                referredStakers[referrer].push(msg.sender);
                referrerInfo.referredStakersCount++;
                referrerInfo.activeReferredStakersCount++;
            }
            
            referrerInfo.totalReferred += amount;
            referrerInfo.totalActiveStaked += amount;
            
            if (lockPeriod == LOCK_PERIOD_1) {
                referrerInfo.totalActiveStaked90Days += amount;
            } else if (lockPeriod == LOCK_PERIOD_2) {
                referrerInfo.totalActiveStaked180Days += amount;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerInfo.totalActiveStaked365Days += amount;
            }
            
            // Calculate referrer reward based on lock period
            uint256 referrerRewardPercent = 0;
            if (lockPeriod == LOCK_PERIOD_1) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_90_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_2) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_180_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_365_DAYS;
            }
            
            if (referrerRewardPercent > 0) {
                uint256 totalReferrerReward = (amount * referrerRewardPercent) / 100;
                
                // Add to referrer rewards
                referrerRewards[referrer].push(
                    ReferrerRewardInfo({
                        stakeId: stakes[msg.sender].length - 1,
                        amount: amount,
                        lockPeriod: lockPeriod,
                        startTime: block.timestamp,
                        endTime: block.timestamp + lockPeriod,
                        totalReward: totalReferrerReward,
                        claimedReward: 0,
                        nextClaimTime: block.timestamp + REFERRER_CLAIM_PERIOD,
                        isActive: true,
                        referee: msg.sender
                    })
                );
                
                // Update unclaimed rewards
                referrerInfo.unclaimedRewards += totalReferrerReward;
                
                // Update rewards by period
                referrerRewardsByPeriod[referrer][lockPeriod] += totalReferrerReward;
                
                // Update total rewards in pool to account for referrer rewards
                totalRewardsInPool += totalReferrerReward;
                
                emit ReferrerRewardUpdated(referrer, msg.sender, stakes[msg.sender].length - 1, totalReferrerReward, lockPeriod);
            }
        }
        
        // Check if the user has sufficient allowance for this contract
        if (token.allowance(msg.sender, address(this)) < amount) {
            revert InsufficientApproval();
        }
        
        // Check if there are sufficient rewards available for the APY
        uint256 projectedAPY = calculateProjectedAPY(amount, lockPeriod);
        uint256 minimumAPY = 0;
        
        if (lockPeriod == LOCK_PERIOD_1) {
            minimumAPY = FIXED_APY_90_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            minimumAPY = FIXED_APY_180_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            minimumAPY = FIXED_APY_365_DAYS;
        }
        
        if (projectedAPY < minimumAPY) {
            revert APYCannotBeSatisfied(uint8(lockPeriod / (30 days)), projectedAPY, minimumAPY);
        }
        
        // Execute external interactions after state changes
        // Transfer staked tokens to pool
        token.safeTransferFrom(msg.sender, stakePool, amount);
        
        if (pendingRewards > 0) {
            // Check if the pool has sufficient balance for rewards
            uint256 poolBalance = token.balanceOf(rewardPool);
            uint256 availableForRewards = poolBalance;
            
            if (availableForRewards < pendingRewards) {
                emit UnableToDistributeRewards(msg.sender, availableForRewards, amount, pendingRewards, lockPeriod);
            } else {
                // Update tracking before transfer
                totalRewardsInPool -= pendingRewards;
                
                // Transfer rewards
                token.safeTransferFrom(rewardPool, msg.sender, pendingRewards);
            }
        }
    }

    /**
     * @dev Stakes tokens with an optional referrer
     * @param amount The amount to stake
     * @param lockPeriod The lock period (90, 180, or 365 days)
     * @param referrer Optional address of the referrer
     */
    function stakeTokenWithReferrer(uint256 amount, uint256 lockPeriod, address referrer) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(
            lockPeriod == LOCK_PERIOD_1 || lockPeriod == LOCK_PERIOD_2 || lockPeriod == LOCK_PERIOD_3,
            "Invalid lock period"
        );
        
        // Make the zero address handling explicit
        if (referrer == address(0)) {
            // Zero address is treated as "no referrer"
            _stakeTokenInternal(amount, lockPeriod, address(0));
            emit Staked(msg.sender, amount, lockPeriod);
            return;
        }
        
        // Referrer cannot be the same as the staker
        require(referrer != msg.sender, "Cannot refer yourself");
        
        // Additional validation to check referrer is not a contract
        uint256 size;
        assembly { size := extcodesize(referrer) }
        require(size == 0, "Referrer cannot be a contract");

        _stakeTokenInternal(amount, lockPeriod, referrer);
        
        emit StakedWithReferrer(msg.sender, referrer, amount, lockPeriod);
    }

    /**
     * @notice Stake tokens without a referrer
     * @param amount The amount to stake
     * @param lockPeriod The lock period (90, 180, or 365 days)
     */
    function stakeToken(uint256 amount, uint256 lockPeriod) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(
            lockPeriod == LOCK_PERIOD_1 || lockPeriod == LOCK_PERIOD_2 || lockPeriod == LOCK_PERIOD_3,
            "Invalid lock period"
        );

        _stakeTokenInternal(amount, lockPeriod, address(0));
        
        emit Staked(msg.sender, amount, lockPeriod);
    }

    /**
     * @notice Calculate rewards based on staked amount, APY, and time elapsed
     * @param stakedAmount Amount staked
     * @param fixedAPY Annual percentage yield
     * @param timeElapsed Time elapsed in seconds
     * @return Calculated rewards
     */
    function calculateElapsedRewards(
        uint256 stakedAmount,
        uint256 fixedAPY,
        uint256 timeElapsed
    ) internal pure returns (uint256) {
        if (stakedAmount == 0) {
            return 0; // No rewards if nothing is staked
        }

        // Calculate annualized rewards based on fixed APY
        uint256 annualRewards = (stakedAmount * fixedAPY * PRECISION_FACTOR) / 100;

        // Adjust rewards proportionally to elapsed time (in seconds)
        if (timeElapsed == 0) {
            return 0;
        }
        // Improved precision by using adding half divisor for rounding
        return (annualRewards * timeElapsed + (365 days * PRECISION_FACTOR / 2)) / (365 days * PRECISION_FACTOR);
    }

    /**
     * @notice Get accumulated reward per token for a specific lock period
     * @param lockPeriod The lock period
     * @return Accumulated reward per token
     */
    function getAccRewardPerTokenForLockPeriod(uint256 lockPeriod) internal view returns (uint256) {
        if (lockPeriod == LOCK_PERIOD_1) {
            return accRewardPerToken90Days;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            return accRewardPerToken180Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            return accRewardPerToken365Days;
        }
        return 0; // Default case; should never occur due to earlier validation
    }

    /**
     * @notice Unstake tokens and claim rewards
     * @param index Index of the stake to unstake
     */
    function unstakeToken(uint256 index) external nonReentrant whenNotPaused {
        require(index < stakes[msg.sender].length, "Invalid stake index");

        // Fetch the specific stake to be unstaked
        StakeInfo storage stake = stakes[msg.sender][index];
        require(stake.isActive, "Stake already unstaked");
        
        // Update rewards before processing the unstake
        updateRewards();

        uint256 stakedAmount = stake.amount;
        uint256 lockPeriod = stake.lockPeriod;
        uint256 startTime = stake.startTime;
        address referrer = stake.referrer;
        
        // Calculate elapsed time
        uint256 elapsedTime = block.timestamp - startTime;
        
        // Calculate rewards based on elapsed time and lock period
        uint256 fixedAPY = 0;
        if (lockPeriod == LOCK_PERIOD_1) {
            fixedAPY = FIXED_APY_90_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_180_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_365_DAYS;
        }
        
        // Calculate rewards
        uint256 rewards = calculateElapsedRewards(stakedAmount, fixedAPY, elapsedTime);
        
        // Calculate penalty if unstaking early
        uint256 penalty = 0;
        if (elapsedTime < lockPeriod) {
            penalty = calculatePenalty(stakedAmount, elapsedTime, lockPeriod);
        }
        
        // Apply penalty to rewards
        uint256 finalRewards = rewards > penalty ? rewards - penalty : 0;
        
        // For very short staking periods, apply penalty to principal
        uint256 returnAmount = stakedAmount;
        if (elapsedTime < 3 days) {
            // Apply 20% penalty to principal for very short staking periods
            uint256 principalPenalty = (stakedAmount * 20) / 100;
            returnAmount = stakedAmount - principalPenalty;
            
            // Add this penalty to the total penalty
            penalty += principalPenalty;
            
            // Emit event for tracking
            emit EarlyUnstakePenalty(msg.sender, stakedAmount, principalPenalty, returnAmount);
        }
        
        // Update total staked amounts
        totalStaked -= stakedAmount;
        totalStakedInPool -= stakedAmount;
        
        if (lockPeriod == LOCK_PERIOD_1) {
            totalStaked90Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked180Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked365Days -= stakedAmount;
        }
        
        // Mark stake as inactive
        stake.isActive = false;
        
        // Update referrer information if provided
        if (referrer != address(0)) {
            ReferrerInfo storage referrerInfo = referrers[referrer];
            referrerInfo.totalActiveStaked -= stakedAmount;
            referrerInfo.totalUnstaked += stakedAmount;
            
            if (lockPeriod == LOCK_PERIOD_1) {
                referrerInfo.totalActiveStaked90Days -= stakedAmount;
            } else if (lockPeriod == LOCK_PERIOD_2) {
                referrerInfo.totalActiveStaked180Days -= stakedAmount;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerInfo.totalActiveStaked365Days -= stakedAmount;
            }
            
            // Check if this was the last active stake from this referee
            bool hasActiveStakes = false;
            for (uint256 i = 0; i < stakes[msg.sender].length; i++) {
                if (stakes[msg.sender][i].isActive && stakes[msg.sender][i].referrer == referrer) {
                    hasActiveStakes = true;
                    break;
                }
            }
            
            if (!hasActiveStakes) {
                referrerInfo.activeReferredStakersCount--;
            }
            
            // Update referrer reward info
            for (uint256 i = 0; i < referrerRewards[referrer].length; i++) {
                if (referrerRewards[referrer][i].referee == msg.sender && 
                    referrerRewards[referrer][i].stakeId == index) {
                    // Mark as inactive since the stake has been unstaked
                    referrerRewards[referrer][i].isActive = false;
                    
                    // Calculate unclaimed rewards to deduct
                    uint256 unclaimedReward = referrerRewards[referrer][i].totalReward - 
                                             referrerRewards[referrer][i].claimedReward;
                    
                    // Deduct from unclaimed rewards
                    if (referrerInfo.unclaimedRewards >= unclaimedReward) {
                        referrerInfo.unclaimedRewards -= unclaimedReward;
                    } else {
                        referrerInfo.unclaimedRewards = 0;
                    }
                    
                    // Deduct from total rewards in pool
                    if (totalRewardsInPool >= unclaimedReward) {
                        totalRewardsInPool -= unclaimedReward;
                    }
                    
                    break;
                }
            }
        }
        
        // Execute external interactions after state changes
        // Check if the pool has sufficient allowance for this contract
        if (token.allowance(stakePool, address(this)) < returnAmount) {
            revert InsufficientApproval();
        }
        
        // Transfer staked tokens back to user
        token.safeTransferFrom(stakePool, msg.sender, returnAmount);
        
        // Transfer rewards if any
        if (finalRewards > 0) {
            // Check if pool has sufficient balance for rewards
            uint256 poolBalance = token.balanceOf(rewardPool);
            uint256 availableForRewards = poolBalance;
            
            if (availableForRewards < finalRewards) {
                emit UnableToDistributeRewards(msg.sender, availableForRewards, stakedAmount, finalRewards, lockPeriod);
            } else {
                // Update tracking before transfer
                totalRewardsInPool -= finalRewards;
                
                // Transfer rewards
                token.safeTransferFrom(rewardPool, msg.sender, finalRewards);
            }
        }
        
        emit Unstaked(msg.sender, stakedAmount, finalRewards, penalty);
        
        emit RewardDistributionLog(
            msg.sender,
            stakedAmount,
            finalRewards,
            penalty,
            token.balanceOf(rewardPool) - totalRewardsInPool, // Available rewards
            lockPeriod,
            elapsedTime
        );
    }

    /**
     * @notice Calculate penalty for early unstaking
     * @param stakedAmount Amount staked
     * @param elapsedTime Time elapsed since staking
     * @param lockPeriod Lock period
     * @return Penalty amount
     */
    function calculatePenalty(
        uint256 stakedAmount,
        uint256 elapsedTime,
        uint256 lockPeriod
    ) internal pure returns (uint256) {
        // For very short staking periods (less than 3 days), apply a flat 95% penalty
        if (elapsedTime < 3 days) {
            return (stakedAmount * 95) / 100;
        }
        
        // Calculate remaining percentage of lock period
        uint256 remainingTime = lockPeriod - elapsedTime;
        uint256 remainingPercentage = (remainingTime * 100) / lockPeriod;
        
        // Apply graduated penalties based on remaining percentage
        if (remainingPercentage > 90) {
            return (stakedAmount * 90) / 100;
        } else if (remainingPercentage > 75) {
            return (stakedAmount * 75) / 100;
        } else if (remainingPercentage > 60) {
            return (stakedAmount * 60) / 100;
        } else if (remainingPercentage > 45) {
            return (stakedAmount * 45) / 100;
        } else if (remainingPercentage > 30) {
            return (stakedAmount * 30) / 100;
        } else if (remainingPercentage > 15) {
            return (stakedAmount * 20) / 100;
        } else {
            return (stakedAmount * 10) / 100;
        }
    }

    /**
     * @notice Calculate projected APY based on available rewards
     * @param additionalStake Additional amount to be staked
     * @param lockPeriod Lock period
     * @return Projected APY
     */
    function calculateProjectedAPY(uint256 additionalStake, uint256 lockPeriod) public view returns (uint256) {
        uint256 fixedAPY = 0;
        uint256 totalNeededRewards = 0;
        uint256 totalStakedForPeriod = 0;
        
        if (lockPeriod == LOCK_PERIOD_1) {
            fixedAPY = FIXED_APY_90_DAYS;
            totalStakedForPeriod = totalStaked90Days;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_180_DAYS;
            totalStakedForPeriod = totalStaked180Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_365_DAYS;
            totalStakedForPeriod = totalStaked365Days;
        }
        
        // Calculate total staked amount including the additional stake
        uint256 newTotalStaked = totalStakedForPeriod + additionalStake;
        
        // Calculate rewards needed for the fixed APY
        totalNeededRewards = (newTotalStaked * fixedAPY) / 100;
        
        // Get available rewards in the reward pool
        uint256 availableRewards = totalRewardsInPool;
        
        // Calculate projected APY based on available rewards
        if (availableRewards >= totalNeededRewards) {
            return fixedAPY; // Can satisfy the fixed APY
        } else if (newTotalStaked == 0) {
            return 0; // Avoid division by zero
        } else {
            // Ensure we return at least 1 (0.01%) if there are any available rewards
            uint256 calculatedAPY = (availableRewards * 100) / newTotalStaked;
            return calculatedAPY > 0 ? calculatedAPY : (availableRewards > 0 ? 1 : 0);
        }
    }

    /**
     * @notice Check if the reward pool has sufficient balance to satisfy the fixed APY
     * @param lockPeriod Lock period to check
     * @return Whether the reward pool has sufficient balance
     */
    function canSatisfyFixedAPY(uint256 lockPeriod) external view returns (bool) {
        uint256 fixedAPY = 0;
        uint256 totalStakedForPeriod = 0;
        
        if (lockPeriod == LOCK_PERIOD_1) {
            fixedAPY = FIXED_APY_90_DAYS;
            totalStakedForPeriod = totalStaked90Days;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_180_DAYS;
            totalStakedForPeriod = totalStaked180Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_365_DAYS;
            totalStakedForPeriod = totalStaked365Days;
        }
        
        // Calculate rewards needed for the fixed APY
        uint256 totalNeededRewards = (totalStakedForPeriod * fixedAPY) / 100;
        
        // Get available rewards in the reward pool
        uint256 availableRewards = totalRewardsInPool;
        
        return availableRewards >= totalNeededRewards;
    }

    /**
     * @notice Process pending rewards for a user
     * @param user Address of the user
     * @return Total pending rewards
     */
    function processPendingRewards(address user) external nonReentrant whenNotPaused returns (uint256) {
        // Update rewards before processing
        updateRewards();
        
        uint256 totalPendingRewards = 0;
        
        // Calculate pending rewards for each stake
        for (uint256 i = 0; i < stakes[user].length; i++) {
            StakeInfo storage stake = stakes[user][i];
            if (stake.isActive) {
                uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(stake.lockPeriod);
                uint256 pendingReward = (stake.amount * (accRewardPerToken - stake.rewardDebt)) / PRECISION_FACTOR;
                totalPendingRewards += pendingReward;
                
                // Update reward debt to current accumulated rewards
                stake.rewardDebt = accRewardPerToken;
            }
        }
        
        if (totalPendingRewards > 0) {
            // Check if pool has sufficient balance for rewards
            uint256 poolBalance = token.balanceOf(rewardPool);
            uint256 availableForRewards = poolBalance;
            
            if (availableForRewards < totalPendingRewards) {
                emit UnableToDistributeRewards(user, availableForRewards, 0, totalPendingRewards, 0);
                return 0;
            } else {
                // Update tracking before transfer
                totalRewardsInPool -= totalPendingRewards;
                
                // Transfer rewards
                token.safeTransferFrom(rewardPool, user, totalPendingRewards);
                return totalPendingRewards;
            }
        }
        
        return 0;
    }
}
