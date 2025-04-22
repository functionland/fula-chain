// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Top‐level pool interface
interface IPool {
    function transferTokens(uint256 amount) external returns (bool);
    function receiveTokens(address from, uint256 amount) external returns (bool);
}

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "../governance/libraries/ProposalTypes.sol";

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
contract StakingEngineLinear is ERC20, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // Define roles for access control
    // bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
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
    IPool public stakePoolContract;
    IPool public rewardPoolContract;

    // Tracking variables for internal accounting
    uint256 public totalStakedInPool;    // Total tokens staked by users
    uint256 public totalRewardsInPool;   // Total tokens allocated for rewards

    uint256 public accRewardPerToken90Days;
    uint256 public accRewardPerToken180Days;
    uint256 public accRewardPerToken365Days;

    uint256 public totalStaked90Days;
    uint256 public totalStaked180Days;
    uint256 public totalStaked365Days;

    // --- New variables for global queries ---
    // List of all staker addresses (unique, append-only)
    address[] private allStakerAddresses;
    mapping(address => bool) private isKnownStaker;
    // For each lock period, a list of staker addresses (unique, append-only)
    mapping(uint256 => address[]) private stakerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) private isStakerInPeriod;
    // List of all referrer addresses (unique, append-only)
    address[] private allReferrerAddresses;
    mapping(address => bool) private isKnownReferrer;
    // For each lock period, a list of referrer addresses (unique, append-only)
    mapping(uint256 => address[]) private referrerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) private isReferrerInPeriod;

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
        _grantRole(ProposalTypes.ADMIN_ROLE, initialOwner); // Grant ADMIN_ROLE to owner as well
        _grantRole(ProposalTypes.ADMIN_ROLE, initialAdmin);
        _setRoleAdmin(ProposalTypes.ADMIN_ROLE, OWNER_ROLE);
        
        token = IERC20(_token);
        stakePool = _stakePool;
        rewardPool = _rewardPool;
        stakePoolContract = IPool(_stakePool);
        rewardPoolContract = IPool(_rewardPool);
        
        // Initialize tracking variables
        totalStakedInPool = 0;
        totalRewardsInPool = 0;
        lastUpdateTime = block.timestamp;
    }

    /**
     * @notice Emergency pause reward distribution
     * @dev Can only be called by admin
     */
    function emergencyPauseRewardDistribution() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _pause();
        emit EmergencyAction("Rewards Distribution paused", block.timestamp);
    }

    /**
     * @notice Emergency unpause reward distribution
     * @dev Can only be called by admin
     */
    function emergencyUnpauseRewardDistribution() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction("Rewards Distribution unpaused", block.timestamp);
    }

    /**
     * @notice Add rewards to the pool
     * @param amount Amount of rewards to add
     */
    function addRewardsToPool(uint256 amount) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        // Transfer tokens from sender to pool
        token.safeTransferFrom(msg.sender, rewardPool, amount);
        rewardPoolContract.receiveTokens(msg.sender, amount);
        
        // Update tracking
        totalRewardsInPool += amount;
        
        emit RewardsAdded(amount);
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
    function reconcilePoolBalance() external onlyRole(ProposalTypes.ADMIN_ROLE) {
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
        
        // --- Track all stakers globally and per period ---
        if (!isKnownStaker[msg.sender]) {
            isKnownStaker[msg.sender] = true;
            allStakerAddresses.push(msg.sender);
        }
        if (!isStakerInPeriod[lockPeriod][msg.sender]) {
            isStakerInPeriod[lockPeriod][msg.sender] = true;
            stakerAddressesByPeriod[lockPeriod].push(msg.sender);
        }
        
        // --- Track all referrers globally and per period ---
        if (referrer != address(0)) {
            if (!isKnownReferrer[referrer]) {
                isKnownReferrer[referrer] = true;
                allReferrerAddresses.push(referrer);
            }
            if (!isReferrerInPeriod[lockPeriod][referrer]) {
                isReferrerInPeriod[lockPeriod][referrer] = true;
                referrerAddressesByPeriod[lockPeriod].push(referrer);
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
        stakePoolContract.receiveTokens(msg.sender, amount);
        
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
                rewardPoolContract.transferTokens(pendingRewards);
                token.safeTransfer(msg.sender, pendingRewards);
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
        StakeInfo storage stake = stakes[msg.sender][index];
        require(stake.isActive, "Stake already unstaked");
        require(block.timestamp >= stake.startTime + stake.lockPeriod, "Cannot unstake before lock period ends");

        updateRewards();

        uint256 stakedAmount = stake.amount;
        uint256 lockPeriod = stake.lockPeriod;
        address referrer = stake.referrer;

        // Mark stake as inactive
        stake.isActive = false;

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

        // Update referrer info if any
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
            // Mark all referrer rewards for this stake as inactive
            for (uint256 i = 0; i < referrerRewards[referrer].length; i++) {
                if (referrerRewards[referrer][i].referee == msg.sender && referrerRewards[referrer][i].stakeId == index) {
                    referrerRewards[referrer][i].isActive = false;
                    break;
                }
            }
        }

        // Transfer staked tokens back to user
        stakePoolContract.transferTokens(stakedAmount);
        token.safeTransfer(msg.sender, stakedAmount);
        emit Unstaked(msg.sender, stakedAmount, 0, 0);
    }

    /**
     * @notice Claim staker rewards linearly up to lock period
     * @param stakeIndex Index of the stake to claim rewards for
     */
    function claimStakerReward(uint256 stakeIndex) external nonReentrant whenNotPaused {
        require(stakeIndex < stakes[msg.sender].length, "Invalid stake index");
        StakeInfo storage stake = stakes[msg.sender][stakeIndex];
        require(stake.isActive, "Stake not active");
        uint256 lockEnd = stake.startTime + stake.lockPeriod;
        uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
        uint256 timeElapsed = nowOrEnd - stake.startTime;
        uint256 fixedAPY = 0;
        if (stake.lockPeriod == LOCK_PERIOD_1) fixedAPY = FIXED_APY_90_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_2) fixedAPY = FIXED_APY_180_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_3) fixedAPY = FIXED_APY_365_DAYS;
        uint256 totalReward = (stake.amount * fixedAPY * stake.lockPeriod) / (100 * 365 days);
        uint256 claimable = (totalReward * timeElapsed) / stake.lockPeriod;
        // Track claimed rewards in rewardDebt
        uint256 alreadyClaimed = stake.rewardDebt;
        require(claimable > alreadyClaimed, "No claimable rewards");
        uint256 toClaim = claimable - alreadyClaimed;
        // Update rewardDebt
        stake.rewardDebt = claimable;
        // Transfer rewards
        require(token.balanceOf(rewardPool) >= toClaim, "Insufficient rewards in pool");
        totalRewardsInPool -= toClaim;
        rewardPoolContract.transferTokens(toClaim);
        token.safeTransfer(msg.sender, toClaim);
        emit RewardDistributionLog(msg.sender, stake.amount, toClaim, 0, token.balanceOf(rewardPool), stake.lockPeriod, timeElapsed);
    }

    /**
     * @notice Claim referrer rewards linearly up to lock period
     * @param rewardIndex Index of the referrer reward to claim
     */
    function claimReferrerReward(uint256 rewardIndex) external nonReentrant whenNotPaused {
        ReferrerRewardInfo storage info = referrerRewards[msg.sender][rewardIndex];
        require(info.isActive, "Referrer reward not active");
        uint256 lockEnd = info.startTime + info.lockPeriod;
        uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
        uint256 timeElapsed = nowOrEnd - info.startTime;
        uint256 claimable = (info.totalReward * timeElapsed) / info.lockPeriod;
        uint256 alreadyClaimed = info.claimedReward;
        require(claimable > alreadyClaimed, "No claimable rewards");
        uint256 toClaim = claimable - alreadyClaimed;
        info.claimedReward = claimable;
        require(token.balanceOf(rewardPool) >= toClaim, "Insufficient rewards in pool");
        totalRewardsInPool -= toClaim;
        rewardPoolContract.transferTokens(toClaim);
        token.safeTransfer(msg.sender, toClaim);
        emit ReferrerRewardsClaimed(msg.sender, toClaim);
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
     * @notice Check pending rewards for a user
     * @param user Address of the user
     * @return Total pending rewards
     */
    function checkPendingRewards(address user) external view returns (uint256) {
        uint256 totalPendingRewards = 0;
        
        // Calculate pending rewards for each stake
        for (uint256 i = 0; i < stakes[user].length; i++) {
            StakeInfo storage stake = stakes[user][i];
            if (stake.isActive) {
                uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(stake.lockPeriod);
                uint256 pendingReward = (stake.amount * (accRewardPerToken - stake.rewardDebt)) / PRECISION_FACTOR;
                totalPendingRewards += pendingReward;
            }
        }
        
        if (totalPendingRewards > 0) {
            // Check if pool has sufficient balance for rewards
            uint256 poolBalance = token.balanceOf(rewardPool);
            uint256 availableForRewards = poolBalance;
            
            if (availableForRewards < totalPendingRewards) {
                return 0;
            } else {
                return totalPendingRewards;
            }
        }
        
        return 0;
    }

    // --- View functions for global queries ---
    /**
     * @notice Get all staker addresses
     */
    function getAllStakerAddresses() external view returns (address[] memory) {
        return allStakerAddresses;
    }
    /**
     * @notice Get all staker addresses for a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_1, _2, or _3)
     */
    function getStakerAddressesByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        return stakerAddressesByPeriod[lockPeriod];
    }
    /**
     * @notice Get staked amounts for each staker for a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_1, _2, or _3)
     * @return stakerAddresses, amounts arrays
     */
    function getStakedAmountsByPeriod(uint256 lockPeriod) external view returns (address[] memory, uint256[] memory) {
        address[] memory stakers = stakerAddressesByPeriod[lockPeriod];
        uint256[] memory amounts = new uint256[](stakers.length);
        for (uint256 i = 0; i < stakers.length; i++) {
            uint256 total = 0;
            StakeInfo[] storage s = stakes[stakers[i]];
            for (uint256 j = 0; j < s.length; j++) {
                if (s[j].lockPeriod == lockPeriod && s[j].isActive) {
                    total += s[j].amount;
                }
            }
            amounts[i] = total;
        }
        return (stakers, amounts);
    }
    /**
     * @notice Get all referrer addresses
     */
    function getAllReferrerAddresses() external view returns (address[] memory) {
        return allReferrerAddresses;
    }
    /**
     * @notice Get all referrer addresses for a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_1, _2, or _3)
     */
    function getReferrerAddressesByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        return referrerAddressesByPeriod[lockPeriod];
    }
    /**
     * @notice Get referrers who referred someone in a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_1, _2, or _3)
     * @return referrers array (only those who actually referred at least one staker in that period)
     */
    function getActiveReferrersByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        address[] memory referrers = referrerAddressesByPeriod[lockPeriod];
        // Optionally filter to only those with at least one active referral in this period
        // (already handled by tracking in _stakeTokenInternal)
        return referrers;
    }

    /**
     * @notice View all stakes for a user (for testing)
     */
    function getStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }
}
