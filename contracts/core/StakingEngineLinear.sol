// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Top‐level pool interface
interface IPool {
    function transferTokens(uint256 amount) external returns (bool);
    function receiveTokens(address from, uint256 amount) external returns (bool);
}

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "../governance/libraries/ProposalTypes.sol";

/*
Staking Periods and Rewards
User cannot claim rewards before the staking priod is over
| Lock Period | Duration | Fixed APY | Referrer Reward | 
|-------------|----------|-----------|-----------------| 
| LOCK_PERIOD_2 | 365 days | 15% | 4% |
| LOCK_PERIOD_3 | 730 days | 18% | 6% |
| LOCK_PERIOD_4 | 1095 days | 24% | 8% |
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
/// @dev Upgradeable version of the staking contract with separate stake and reward pool addresses
contract StakingEngineLinear is 
    Initializable, 
    AccessControlUpgradeable, 
    ReentrancyGuardUpgradeable, 
    PausableUpgradeable,
    UUPSUpgradeable 
{
    using SafeERC20 for IERC20;

    // Define roles for access control
    // bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");


    // Lock periods in seconds
    uint32 public constant LOCK_PERIOD_2 = 365 days;
    uint32 public constant LOCK_PERIOD_3 = 730 days;
    uint32 public constant LOCK_PERIOD_4 = 1095 days;

    // Fixed APY percentages for each lock period
    uint256 public constant FIXED_APY_365_DAYS = 15; // 15% for 365 days
    uint256 public constant FIXED_APY_730_DAYS = 18; // 18% for 730 days (2 years)
    uint256 public constant FIXED_APY_1095_DAYS = 24; // 24% for 1095 days (3 years)

    // Referrer reward percentages for each lock period
    uint256 public constant REFERRER_REWARD_PERCENT_365_DAYS = 4; // 4% for 365 days
    uint256 public constant REFERRER_REWARD_PERCENT_730_DAYS = 6; // 6% for 730 days (2 years)
    uint256 public constant REFERRER_REWARD_PERCENT_1095_DAYS = 8; // 8% for 1095 days (3 years)

    // Precision factor for calculations to avoid rounding errors
    uint256 public constant PRECISION_FACTOR = 1e18;
    
    // Maximum number of stakes to process in a single operation
    uint256 public constant MAX_STAKES_TO_PROCESS = 100;

    // Referrer reward claim period
    uint256 public constant REFERRER_CLAIM_PERIOD = 1 days;

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
        uint256 totalActiveStaked365Days; // Total active staked for 365 days
        uint256 totalActiveStaked730Days; // Total active staked for 730 days (2 years)
        uint256 totalActiveStaked1095Days; // Total active staked for 1095 days (3 years)
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
    uint256 public accRewardPerToken365Days;
    uint256 public accRewardPerToken730Days;
    uint256 public accRewardPerToken1095Days;
    
    uint256 public totalStaked365Days;
    uint256 public totalStaked730Days;
    uint256 public totalStaked1095Days;

    // --- New variables for global queries ---
    // List of all staker addresses (unique, append-only)
    address[] internal allStakerAddresses;
    mapping(address => bool) internal isKnownStaker;
    // For each lock period, a list of staker addresses (unique, append-only)
    mapping(uint256 => address[]) internal stakerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) internal isStakerInPeriod;
    // List of all referrer addresses (unique, append-only)
    address[] internal allReferrerAddresses;
    mapping(address => bool) internal isKnownReferrer;
    // For each lock period, a list of referrer addresses (unique, append-only)
    mapping(uint256 => address[]) internal referrerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) internal isReferrerInPeriod;

    // Added state variables for upgrade management
    address public pendingImplementation;
    address public upgradeProposer;
    uint256 public upgradeProposalTime;
    uint256 public constant UPGRADE_TIMELOCK = 2 days;

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

    event UpgradeProposed(address indexed proposer, address indexed implementation, uint256 proposalTime);
    event UpgradeApproved(address indexed approver, address indexed implementation);
    event UpgradeCancelled(address indexed canceller, address indexed implementation);
    event  APYCannotBeSatisfied(uint8 stakingPeriod, uint256 projectedAPY, uint256 minimumAPY);

    error OperationFailed(uint256 code);
    error TotalStakedTooLow(uint256 totalStaked, uint256 required);
    error InvalidStorageTokenAddress();
    error NoReferrerRewardsAvailable();
    error InvalidTokenAddress();
    error InvalidReferrerAddress();
    error InsufficientApproval();
    error NoClaimableRewards();
    error ClaimPeriodNotReached();
    error NotAuthorizedForUpgradeProposal();
    error NotAuthorizedForUpgradeApproval();
    error NoUpgradeProposalPending();
    error UpgradeTimelockNotExpired();
    error InvalidImplementationAddress();
    // G-08 FIX: Custom errors to replace string error messages
    error ZeroAmount();
    error InvalidLockPeriod();
    error MaxActiveStakesReached();
    error CannotReferYourself();
    error ReferrerCannotBeContract();
    error InvalidStakeIndex();
    error StakeAlreadyUnstaked();
    error LockPeriodNotEnded();
    error StakeNotActive();
    error InsufficientRewardsInPool();
    error NoReferrerRewardExists();
    error InvalidRewardIndex();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializer for the upgradeable contract
     * @param _token Address of the StorageToken
     * @param _stakePool Address of the stake pool
     * @param _rewardPool Address of the reward pool
     * @param initialOwner Address of the initial owner
     * @param initialAdmin Address of the initial admin
     */
    function initialize(
        address _token,
        address _stakePool,
        address _rewardPool,
        address initialOwner,
        address initialAdmin
    ) external initializer {
        require(
            _token != address(0) && 
            _stakePool != address(0) && 
            _rewardPool != address(0) && 
            initialOwner != address(0) && 
            initialAdmin != address(0), 
            "Zero address not allowed"
        );

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(ProposalTypes.OWNER_ROLE, initialOwner);
        _grantRole(ProposalTypes.ADMIN_ROLE, initialAdmin);


        token = IERC20(_token);
        stakePool = _stakePool;
        rewardPool = _rewardPool;
        stakePoolContract = IPool(_stakePool);
        rewardPoolContract = IPool(_rewardPool);
        
        // Initialize tracking variables
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
        
        emit RewardsAdded(amount);
    }

    /**
     * @notice Get excess rewards (rewards beyond what's needed for current stakes)
     * @return Amount of excess rewards
     */
    function getExcessRewards() public view returns (uint256) {
        uint256 requiredRewards = calculateRequiredRewards();
        uint256 poolBalance = token.balanceOf(rewardPool);
        if (poolBalance > requiredRewards) {
            return poolBalance - requiredRewards;
        }
        return 0;
    }

    /**
     * @notice Calculate rewards required for current stakes
     * @return Amount of rewards required
     */
    function calculateRequiredRewards() public view returns (uint256) {
        // Calculate required rewards based on current stakes and APY
        uint256 required365Days = (totalStaked365Days * FIXED_APY_365_DAYS) / 100;
        uint256 required730Days = (totalStaked730Days * FIXED_APY_730_DAYS) / 100;
        uint256 required1095Days = (totalStaked1095Days * FIXED_APY_1095_DAYS) / 100;
        
        return required365Days + required730Days + required1095Days;
    }

    /**
     * @notice Get detailed pool status
     * @return totalPoolBalance Expected total balance in pool
     * @return stakedAmount Amount of staked tokens
     * @return rewardsAmount Amount of reward tokens
     */
    function getPoolStatus() external view returns (
        uint256 totalPoolBalance,
        uint256 stakedAmount,
        uint256 rewardsAmount
    ) {
        totalPoolBalance = token.balanceOf(stakePool) + token.balanceOf(rewardPool);
        stakedAmount = token.balanceOf(stakePool);
        rewardsAmount = token.balanceOf(rewardPool);
        
        return (totalPoolBalance, stakedAmount, rewardsAmount);
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
        uint256 rewardsLength = rewards.length;
        
        for (uint256 i = 0; i < rewardsLength; i++) {
            // C-01 FIX: Include inactive rewards (totalReward was capped at unstake time)
            if (rewards[i].totalReward > 0) {
                uint256 totalClaimable;
                if (rewards[i].isActive) {
                    // Active stake: calculate proportional reward up to now or lock end
                    uint256 lockEnd = rewards[i].startTime + rewards[i].lockPeriod;
                    uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
                    uint256 timeElapsed = nowOrEnd - rewards[i].startTime;
                    totalClaimable = (rewards[i].totalReward * timeElapsed) / rewards[i].lockPeriod;
                } else {
                    // Inactive stake: totalReward was already capped, full amount is claimable
                    totalClaimable = rewards[i].totalReward;
                }
                
                uint256 alreadyClaimed = rewards[i].claimedReward;
                if (totalClaimable > alreadyClaimed) {
                    claimable += totalClaimable - alreadyClaimed;
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
        if (totalStaked365Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked365Days, FIXED_APY_365_DAYS, timeElapsed);
            accRewardPerToken365Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked365Days;
        }
        
        if (totalStaked730Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked730Days, FIXED_APY_730_DAYS, timeElapsed);
            accRewardPerToken730Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked730Days;
        }
        
        if (totalStaked1095Days > 0) {
            uint256 rewardsForPeriod = calculateElapsedRewards(totalStaked1095Days, FIXED_APY_1095_DAYS, timeElapsed);
            accRewardPerToken1095Days += (rewardsForPeriod * PRECISION_FACTOR) / totalStaked1095Days;
        }
        
        lastUpdateTime = block.timestamp;
    }

    /**
     * @notice Internal function to stake tokens
     * @param amount The amount to stake
     * @param lockPeriod The lock period (180, 365, or 730 days)
     * @param referrer Optional address of the referrer
     */
    function _stakeTokenInternal(uint256 amount, uint256 lockPeriod, address referrer) internal {
        
        // Check if the user has sufficient allowance for this contract
        if (token.allowance(msg.sender, address(this)) < amount) {
            revert InsufficientApproval();
        }
        
        // Check if there are sufficient rewards available for the APY
        uint256 projectedAPY = calculateProjectedAPY(amount, lockPeriod);
        uint256 minimumAPY = 0;
        
        // Use direct assignment instead of conditionals to save gas
        if (lockPeriod == LOCK_PERIOD_2) {
            minimumAPY = FIXED_APY_365_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            minimumAPY = FIXED_APY_730_DAYS;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            minimumAPY = FIXED_APY_1095_DAYS;
        }
        
        if (projectedAPY < minimumAPY) {
            emit APYCannotBeSatisfied(uint8(lockPeriod / (30 days)), projectedAPY, minimumAPY);
        }

        // Update rewards before processing the stake
        updateRewards();

        // Cache array length to save gas on multiple reads
        uint256 userStakeCount = stakes[msg.sender].length;
        uint256 pendingRewards = 0;
        
        // Calculate pending rewards for existing stakes using shared calculation function
        if (userStakeCount > 0) {
            for (uint256 i = 0; i < userStakeCount; i++) {
                StakeInfo storage stake = stakes[msg.sender][i];
                if (stake.isActive) {
                    uint256 pendingReward = _calculateClaimableReward(stake);
                    if (pendingReward > 0) {
                        pendingRewards += pendingReward;

                        // Update reward debt to current claimable amount
                        // Calculate the new rewardDebt value
                        uint256 lockEnd = stake.startTime + stake.lockPeriod;
                        uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
                        uint256 timeElapsed = nowOrEnd - stake.startTime;

                        uint256 fixedAPY = 0;
                        if (stake.lockPeriod == LOCK_PERIOD_2) fixedAPY = FIXED_APY_365_DAYS;
                        else if (stake.lockPeriod == LOCK_PERIOD_3) fixedAPY = FIXED_APY_730_DAYS;
                        else if (stake.lockPeriod == LOCK_PERIOD_4) fixedAPY = FIXED_APY_1095_DAYS;

                        uint256 totalReward = (stake.amount * fixedAPY * stake.lockPeriod) / (100 * 365 days);
                        uint256 claimable = (totalReward * timeElapsed) / stake.lockPeriod;

                        stake.rewardDebt = claimable;
                    }
                }
            }
        }

        // Add new stake with rewardDebt initialized to 0 (no rewards claimed yet)
        stakes[msg.sender].push(
            StakeInfo({
                amount: amount,
                rewardDebt: 0, // Initialize to 0 for linear reward system
                lockPeriod: lockPeriod,
                startTime: block.timestamp,
                referrer: referrer,
                isActive: true
            })
        );
        
        // Update total staked amounts - batch updates to save gas
        totalStaked += amount;
        
        // Update the appropriate period total
        if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked365Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked730Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            totalStaked1095Days += amount;
        }
        
        // --- Track all stakers globally and per period ---
        // Only do these checks if necessary, combine operations
        if (!isKnownStaker[msg.sender]) {
            isKnownStaker[msg.sender] = true;
            allStakerAddresses.push(msg.sender);
        }
        
        if (!isStakerInPeriod[lockPeriod][msg.sender]) {
            isStakerInPeriod[lockPeriod][msg.sender] = true;
            stakerAddressesByPeriod[lockPeriod].push(msg.sender);
        }
        
        // Update referrer information if provided - do this after staker updates
        if (referrer != address(0)) {
            // --- Track all referrers globally and per period ---
            // Combine these checks with referrer info updates to save gas
            bool isNewReferrer = false;
            bool isNewReferrerForPeriod = false;
            
            if (!isKnownReferrer[referrer]) {
                isKnownReferrer[referrer] = true;
                allReferrerAddresses.push(referrer);
                isNewReferrer = true;
            }
            
            if (!isReferrerInPeriod[lockPeriod][referrer]) {
                isReferrerInPeriod[lockPeriod][referrer] = true;
                referrerAddressesByPeriod[lockPeriod].push(referrer);
                isNewReferrerForPeriod = true;
            }
            
            // Get referrer info once to save gas on multiple storage reads/writes
            ReferrerInfo storage referrerInfo = referrers[referrer];
            
            // Handle new referee relationship
            if (!isReferred[referrer][msg.sender]) {
                isReferred[referrer][msg.sender] = true;
                referredStakers[referrer].push(msg.sender);
                referrerInfo.referredStakersCount++;
                referrerInfo.activeReferredStakersCount++;
            }
            
            // Update referrer staking statistics in batch
            referrerInfo.totalReferred += amount;
            referrerInfo.totalActiveStaked += amount;
            
            // Update period-specific stats for referrer
            if (lockPeriod == LOCK_PERIOD_2) {
                referrerInfo.totalActiveStaked365Days += amount;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerInfo.totalActiveStaked730Days += amount;
            } else if (lockPeriod == LOCK_PERIOD_4) {
                referrerInfo.totalActiveStaked1095Days += amount;
            }
            
            // Calculate referrer reward percentage once
            uint256 referrerRewardPercent;
            if (lockPeriod == LOCK_PERIOD_2) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_365_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_730_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_4) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_1095_DAYS;
            }
            
            // Only process referrer rewards if there's actually a percentage
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
                
                // Batch updates to referrer info
                referrerInfo.unclaimedRewards += totalReferrerReward;
                referrerRewardsByPeriod[referrer][lockPeriod] += totalReferrerReward;
                
                emit ReferrerRewardUpdated(referrer, msg.sender, stakes[msg.sender].length - 1, totalReferrerReward, lockPeriod);
            }
        }
        
        // Execute external interactions after state changes
        // Transfer staked tokens to pool
        token.safeTransferFrom(msg.sender, stakePool, amount);
        stakePoolContract.receiveTokens(msg.sender, amount);
        
        // Process pending rewards if any
        if (pendingRewards > 0) {
            uint256 poolBalance = token.balanceOf(rewardPool);
            
            if (poolBalance < pendingRewards) {
                emit UnableToDistributeRewards(msg.sender, poolBalance, amount, pendingRewards, lockPeriod);
            } else {
                // Transfer rewards
                rewardPoolContract.transferTokens(pendingRewards);
                token.safeTransfer(msg.sender, pendingRewards);
            }
        }
    }

    /**
     * @dev Stakes tokens with an optional referrer
     * @param amount The amount to stake
     * @param lockPeriod The lock period (180, 365, or 730 days)
     * @param referrer Optional address of the referrer
     */
    function stakeTokenWithReferrer(uint256 amount, uint256 lockPeriod, address referrer) external virtual nonReentrant whenNotPaused {
        if (token.allowance(msg.sender, address(this)) < amount) {
            revert InsufficientApproval();
        }
        // G-08 FIX: Use custom errors instead of string messages
        if (amount == 0) revert ZeroAmount();
        if (lockPeriod != LOCK_PERIOD_2 && lockPeriod != LOCK_PERIOD_3 && lockPeriod != LOCK_PERIOD_4) {
            revert InvalidLockPeriod();
        }

        // G-01 FIX: Cache storage array to avoid redundant SLOAD operations
        StakeInfo[] storage userStakes = stakes[msg.sender];
        uint256 userStakesLength = userStakes.length;
        uint256 activeStakes = 0;
        for (uint256 i = 0; i < userStakesLength; i++) {
            if (userStakes[i].isActive) {
                activeStakes++;
            }
        }
        if (activeStakes >= 100) revert MaxActiveStakesReached();
        
        // Make the zero address handling explicit
        if (referrer == address(0)) {
            // Zero address is treated as "no referrer"
            _stakeTokenInternal(amount, lockPeriod, address(0));
            emit Staked(msg.sender, amount, lockPeriod);
            return;
        }
        
        // Referrer cannot be the same as the staker
        if (referrer == msg.sender) revert CannotReferYourself();
        
        // Additional validation to check referrer is not a contract
        uint256 size;
        assembly { size := extcodesize(referrer) }
        if (size > 0) revert ReferrerCannotBeContract();

        _stakeTokenInternal(amount, lockPeriod, referrer);
        
        emit StakedWithReferrer(msg.sender, referrer, amount, lockPeriod);
    }

    /**
     * @notice Stake tokens without a referrer
     * @param amount The amount to stake
     * @param lockPeriod The lock period (180, 365, or 730 days)
     */
    function stakeToken(uint256 amount, uint256 lockPeriod) external virtual nonReentrant whenNotPaused {
        if (token.allowance(msg.sender, address(this)) < amount) {
            revert InsufficientApproval();
        }
        // G-08 FIX: Use custom errors instead of string messages
        if (amount == 0) revert ZeroAmount();
        if (lockPeriod != LOCK_PERIOD_2 && lockPeriod != LOCK_PERIOD_3 && lockPeriod != LOCK_PERIOD_4) {
            revert InvalidLockPeriod();
        }
        // G-01 FIX: Cache storage array to avoid redundant SLOAD operations
        StakeInfo[] storage userStakes = stakes[msg.sender];
        uint256 userStakesLength = userStakes.length;
        uint256 activeStakes = 0;
        for (uint256 i = 0; i < userStakesLength; i++) {
            if (userStakes[i].isActive) {
                activeStakes++;
            }
        }
        if (activeStakes >= 100) revert MaxActiveStakesReached();

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
        // H-02 FIX: Improved precision by performing multiplication before division
        uint256 annualRewards = (stakedAmount * fixedAPY) / 100;

        // Adjust rewards proportionally to elapsed time (in seconds)
        if (timeElapsed == 0) {
            return 0;
        }
        
        // H-02 FIX: Proper rounding - add half of divisor scaled to the numerator
        uint256 divisor = 365 days;
        uint256 numerator = annualRewards * timeElapsed;
        // Round to nearest by adding half the divisor
        return (numerator + (divisor / 2)) / divisor;
    }

    /**
     * @notice Get accumulated reward per token for a specific lock period
     * @param lockPeriod The lock period
     * @return Accumulated reward per token
     */
    function getAccRewardPerTokenForLockPeriod(uint256 lockPeriod) internal view returns (uint256) {
        if (lockPeriod == LOCK_PERIOD_2) {
            return accRewardPerToken365Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            return accRewardPerToken730Days;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            return accRewardPerToken1095Days;
        }
        return 0; // Default case; should never occur due to earlier validation
    }

    /**
     * @notice Calculate claimable rewards for a specific stake using linear reward system
     * @param stake The stake information
     * @return claimableReward Amount of claimable rewards for the stake
     */
    function _calculateClaimableReward(StakeInfo storage stake) internal view returns (uint256 claimableReward) {
        if (!stake.isActive) return 0;

        uint256 lockEnd = stake.startTime + stake.lockPeriod;
        uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
        uint256 timeElapsed = nowOrEnd - stake.startTime;

        uint256 fixedAPY = 0;
        if (stake.lockPeriod == LOCK_PERIOD_2) fixedAPY = FIXED_APY_365_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_3) fixedAPY = FIXED_APY_730_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_4) fixedAPY = FIXED_APY_1095_DAYS;

        uint256 totalReward = (stake.amount * fixedAPY * stake.lockPeriod) / (100 * 365 days);
        uint256 claimable = (totalReward * timeElapsed) / stake.lockPeriod;
        uint256 alreadyClaimed = stake.rewardDebt;

        if (claimable > alreadyClaimed) {
            claimableReward = claimable - alreadyClaimed;
        } else {
            claimableReward = 0;
        }
    }

    /**
     * @notice Unstake tokens and claim rewards
     * @param index Index of the stake to unstake
     */
    function unstakeToken(uint256 index) external nonReentrant whenNotPaused {
        // G-08 FIX: Use custom errors instead of string messages
        if (index >= stakes[msg.sender].length) revert InvalidStakeIndex();
        StakeInfo storage stake = stakes[msg.sender][index];
        if (!stake.isActive) revert StakeAlreadyUnstaked();
        if (block.timestamp < stake.startTime + stake.lockPeriod) revert LockPeriodNotEnded();

        updateRewards();

        uint256 stakedAmount = stake.amount;
        uint256 lockPeriod = stake.lockPeriod;
        address referrer = stake.referrer;

        // Mark stake as inactive
        stake.isActive = false;

        // Update total staked amounts
        totalStaked -= stakedAmount;
        if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked365Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked730Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            totalStaked1095Days -= stakedAmount;
        }

        // Update referrer info if any
        if (referrer != address(0)) {
            ReferrerInfo storage referrerInfo = referrers[referrer];
            referrerInfo.totalActiveStaked -= stakedAmount;
            referrerInfo.totalUnstaked += stakedAmount;
            if (lockPeriod == LOCK_PERIOD_2) {
                referrerInfo.totalActiveStaked365Days -= stakedAmount;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerInfo.totalActiveStaked730Days -= stakedAmount;
            } else if (lockPeriod == LOCK_PERIOD_4) {
                referrerInfo.totalActiveStaked1095Days -= stakedAmount;
            }
            // Mark all referrer rewards for this stake as inactive
            // C-01 FIX: Before deactivating, cap totalReward to actual earned amount so referrer doesn't lose unclaimed rewards
            ReferrerRewardInfo[] storage rewards = referrerRewards[referrer];
            uint256 rewardsLength = rewards.length;
            for (uint256 i = 0; i < rewardsLength; i++) {
                if (rewards[i].referee == msg.sender && rewards[i].stakeId == index) {
                    ReferrerRewardInfo storage info = rewards[i];
                    // Calculate the final claimable amount up to now (or lock end)
                    uint256 lockEnd = info.startTime + info.lockPeriod;
                    uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
                    uint256 timeElapsed = nowOrEnd - info.startTime;
                    uint256 finalClaimable = (info.totalReward * timeElapsed) / info.lockPeriod;
                    // Cap totalReward to actual earned amount so referrer can still claim what they earned
                    info.totalReward = finalClaimable;
                    info.isActive = false;
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
        // G-08 FIX: Use custom errors instead of string messages
        if (stakeIndex >= stakes[msg.sender].length) revert InvalidStakeIndex();
        StakeInfo storage stake = stakes[msg.sender][stakeIndex];
        if (!stake.isActive) revert StakeNotActive();
        uint256 lockEnd = stake.startTime + stake.lockPeriod;
        uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
        uint256 timeElapsed = nowOrEnd - stake.startTime;
        uint256 fixedAPY = 0;
        if (stake.lockPeriod == LOCK_PERIOD_2) fixedAPY = FIXED_APY_365_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_3) fixedAPY = FIXED_APY_730_DAYS;
        else if (stake.lockPeriod == LOCK_PERIOD_4) fixedAPY = FIXED_APY_1095_DAYS;
        uint256 totalReward = (stake.amount * fixedAPY * stake.lockPeriod) / (100 * 365 days);
        uint256 claimable = (totalReward * timeElapsed) / stake.lockPeriod;
        // Track claimed rewards in rewardDebt
        uint256 alreadyClaimed = stake.rewardDebt;
        if (claimable <= alreadyClaimed) revert NoClaimableRewards();
        uint256 toClaim = claimable - alreadyClaimed;
        // Update rewardDebt
        stake.rewardDebt = claimable;
        // Transfer rewards
        if (token.balanceOf(rewardPool) < toClaim) revert InsufficientRewardsInPool();
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
        // C-01 FIX: Allow claiming from inactive rewards (referee may have unstaked but referrer still has unclaimed rewards)
        // The totalReward was capped at unstake time, so we can safely allow claiming
        // G-08 FIX: Use custom errors instead of string messages
        if (info.totalReward == 0) revert NoReferrerRewardExists();
        
        uint256 claimable;
        if (info.isActive) {
            // Active stake: calculate proportional reward up to now or lock end
            uint256 lockEnd = info.startTime + info.lockPeriod;
            uint256 nowOrEnd = block.timestamp < lockEnd ? block.timestamp : lockEnd;
            uint256 timeElapsed = nowOrEnd - info.startTime;
            claimable = (info.totalReward * timeElapsed) / info.lockPeriod;
        } else {
            // Inactive stake: totalReward was already capped at unstake time, so full amount is claimable
            claimable = info.totalReward;
        }
        
        uint256 alreadyClaimed = info.claimedReward;
        if (claimable <= alreadyClaimed) revert NoClaimableRewards();
        uint256 toClaim = claimable - alreadyClaimed;
        info.claimedReward = claimable;
        if (token.balanceOf(rewardPool) < toClaim) revert InsufficientRewardsInPool();
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
        
        if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_365_DAYS;
            totalStakedForPeriod = totalStaked365Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_730_DAYS;
            totalStakedForPeriod = totalStaked730Days;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            fixedAPY = FIXED_APY_1095_DAYS;
            totalStakedForPeriod = totalStaked1095Days;
        }
        
        // Calculate total staked amount including the additional stake
        uint256 newTotalStaked = totalStakedForPeriod + additionalStake;
        
        // Calculate rewards needed for the fixed APY
        totalNeededRewards = (newTotalStaked * fixedAPY) / 100;
        
        // Get available rewards in the reward pool
        uint256 availableRewards = token.balanceOf(rewardPool);
        
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
        
        if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_365_DAYS;
            totalStakedForPeriod = totalStaked365Days;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_730_DAYS;
            totalStakedForPeriod = totalStaked730Days;
        } else if (lockPeriod == LOCK_PERIOD_4) {
            fixedAPY = FIXED_APY_1095_DAYS;
            totalStakedForPeriod = totalStaked1095Days;
        }
        
        // Calculate rewards needed for the fixed APY
        uint256 totalNeededRewards = (totalStakedForPeriod * fixedAPY) / 100;
        
        // Get available rewards in the reward pool
        uint256 availableRewards = token.balanceOf(rewardPool);
        
        return availableRewards >= totalNeededRewards;
    }

    /**
     * @notice Check pending rewards for a user
     * @param user Address of the user
     * @return Total pending rewards
     */
    function checkPendingRewards(address user) external view returns (uint256) {
        uint256 totalPendingRewards = 0;

        // Calculate pending rewards for each stake using shared calculation function
        for (uint256 i = 0; i < stakes[user].length; i++) {
            StakeInfo storage stake = stakes[user][i];
            if (stake.isActive) {
                totalPendingRewards += _calculateClaimableReward(stake);
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

    /**
     * @notice Get a single referrer reward by index
     * @param referrer Address of the referrer
     * @param index Index of the referrer reward
     * @return ReferrerRewardInfo struct for the given index
     */
    function getReferrerRewardByIndex(address referrer, uint256 index) external view returns (ReferrerRewardInfo memory) {
        // G-08 FIX: Use custom errors instead of string messages
        if (index >= referrerRewards[referrer].length) revert InvalidRewardIndex();
        return referrerRewards[referrer][index];
    }

    /**
     * @notice Get a single staker reward (stake info) by index
     * @param staker Address of the staker
     * @param index Index of the stake
     * @return StakeInfo struct for the given index
     */
    function getStakerRewardByIndex(address staker, uint256 index) external view returns (StakeInfo memory) {
        // G-08 FIX: Use custom errors instead of string messages
        if (index >= stakes[staker].length) revert InvalidStakeIndex();
        return stakes[staker][index];
    }

    /**
     * @notice View the claimable staker reward for a given stake index (does not transfer)
     * @param staker Address of the staker
     * @param stakeIndex Index of the stake to view rewards for
     * @return toClaim Amount of claimable rewards for the given stake
     */
    function getClaimableStakerReward(address staker, uint256 stakeIndex) external view returns (uint256 toClaim) {
        // G-08 FIX: Use custom errors instead of string messages
        if (stakeIndex >= stakes[staker].length) revert InvalidStakeIndex();
        StakeInfo storage stake = stakes[staker][stakeIndex];
        return _calculateClaimableReward(stake);
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
     * @param lockPeriod The lock period (use LOCK_PERIOD_2, _3, or _4)
     */
    function getStakerAddressesByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        return stakerAddressesByPeriod[lockPeriod];
    }
    /**
     * @notice Get staked amounts for each staker for a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_2, _3, or _4)
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
     * @param lockPeriod The lock period (use LOCK_PERIOD_2, _3, or _4)
     */
    function getReferrerAddressesByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        return referrerAddressesByPeriod[lockPeriod];
    }
    /**
     * @notice Get referrers who referred someone in a specific period
     * @param lockPeriod The lock period (use LOCK_PERIOD_2, _3, or _4)
     * @return referrers array (only those who actually referred at least one staker in that period)
     */
    function getActiveReferrersByPeriod(uint256 lockPeriod) external view returns (address[] memory) {
        address[] memory referrers1 = referrerAddressesByPeriod[lockPeriod];
        // Optionally filter to only those with at least one active referral in this period
        // (already handled by tracking in _stakeTokenInternal)
        return referrers1;
    }

    /**
     * @notice View all stakes for a user (for testing)
     */
    function getStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }

    /**
     * @notice Proposes a new implementation address for upgrade
     * @dev Can only be called by admin
     * @param newImplementation Address of the new implementation contract
     */
    function proposeUpgrade(address newImplementation) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (newImplementation == address(0)) revert InvalidImplementationAddress();

        // Set the pending implementation and record proposer and time
        pendingImplementation = newImplementation;
        upgradeProposer = msg.sender;
        upgradeProposalTime = block.timestamp;

        emit UpgradeProposed(msg.sender, newImplementation, block.timestamp);
    }

    /**
     * @notice Cancels a pending implementation upgrade
     * @dev Can be called by owner or the admin who proposed the upgrade
     */
    function cancelUpgrade() external {
        // Only the original proposer (admin) or any owner can cancel
        if (msg.sender != upgradeProposer && !hasRole(ProposalTypes.OWNER_ROLE, msg.sender)) {
            revert NotAuthorizedForUpgradeProposal();
        }
        
        if (pendingImplementation == address(0)) revert NoUpgradeProposalPending();

        address implementation = pendingImplementation;
        
        // Clear the upgrade proposal data
        pendingImplementation = address(0);
        upgradeProposer = address(0);
        upgradeProposalTime = 0;

        emit UpgradeCancelled(msg.sender, implementation);
    }

    /**
     * @notice Authorizes an upgrade to a new implementation
     * @dev Internal function that's part of the UUPS pattern
     */
    function _authorizeUpgrade(address newImplementation) 
        internal
        onlyRole(ProposalTypes.OWNER_ROLE)
        override 
    {
        // The authorization is handled by the approveUpgrade function
        // This internal function is called automatically during the upgrade process
        if (pendingImplementation == address(0)) revert NoUpgradeProposalPending();
        if (pendingImplementation != newImplementation) revert InvalidImplementationAddress();
        if (block.timestamp < upgradeProposalTime + UPGRADE_TIMELOCK) revert UpgradeTimelockNotExpired();

        emit UpgradeApproved(msg.sender, newImplementation);

        // Clear the upgrade proposal data after approval
        pendingImplementation = address(0);
        upgradeProposer = address(0);
        upgradeProposalTime = 0;
    }
}
