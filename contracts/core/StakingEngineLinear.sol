// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Top‐level pool interface
interface IPool {
    function transferTokens(uint256 amount) external returns (bool);
    function receiveTokens(address from, uint256 amount) external returns (bool);
}

// Interface for admin actions callable by governance
import "../governance/interfaces/IStakingEngineAdminActions.sol"; 

// OpenZeppelin imports
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import "../governance/libraries/ProposalTypes.sol"; 

import "hardhat/console.sol";

/// @title StakingEngineLinear
/// @notice Handles token staking with different lock periods and rewards.
/// @dev Upgradeable (UUPS) version, admin actions controlled by an external Governance contract.
contract StakingEngineLinear is 
    Initializable, 
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IStakingEngineAdminActions
{
    using SafeERC20 for IERC20;

    // --- State Variables --- 

    // Governance contract address
    address public governanceContract;

    // Paused state (previously from Pausable)
    bool private _paused;

    // Lock periods, APYs, etc. (Constants remain the same)
    uint32 public constant LOCK_PERIOD_1 = 90 days;
    uint32 public constant LOCK_PERIOD_2 = 180 days;
    uint32 public constant LOCK_PERIOD_3 = 365 days;
    uint256 public constant FIXED_APY_90_DAYS = 2;
    uint256 public constant FIXED_APY_180_DAYS = 6;
    uint256 public constant FIXED_APY_365_DAYS = 15;
    uint256 public constant REFERRER_REWARD_PERCENT_90_DAYS = 0;
    uint256 public constant REFERRER_REWARD_PERCENT_180_DAYS = 1;
    uint256 public constant REFERRER_REWARD_PERCENT_365_DAYS = 4;
    uint256 public constant PRECISION_FACTOR = 1e18;
    uint256 public constant MAX_STAKES_TO_PROCESS = 100;
    uint256 public constant REFERRER_CLAIM_PERIOD = 1 days;

    // Structs (remain the same)
    struct StakeInfo {
        uint256 amount;
        uint256 rewardDebt;
        uint256 lockPeriod;
        uint256 startTime;
        address referrer;
        bool isActive;
    }
    struct ReferrerInfo {
        uint256 totalReferred;
        uint256 totalReferrerRewards;
        uint256 unclaimedRewards;
        uint256 lastClaimTime;
        uint256 referredStakersCount;
        uint256 activeReferredStakersCount;
        uint256 totalActiveStaked;
        uint256 totalUnstaked;
        uint256 totalActiveStaked90Days;
        uint256 totalActiveStaked180Days;
        uint256 totalActiveStaked365Days;
    }
    struct ReferrerRewardInfo {
        uint256 stakeId;
        uint256 amount;
        uint256 lockPeriod;
        uint256 startTime;
        uint256 endTime;
        uint256 totalReward;
        uint256 claimedReward;
        uint256 nextClaimTime;
        bool isActive;
        address referee;
    }

    // Mappings and state variables for staking/referral logic (remain the same)
    mapping(address => StakeInfo[]) public stakes;
    mapping(address => ReferrerInfo) public referrers;
    mapping(address => ReferrerRewardInfo[]) public referrerRewards;
    mapping(address => address[]) public referredStakers;
    mapping(address => mapping(address => bool)) public isReferred;
    mapping(address => mapping(uint256 => uint256)) public referrerRewardsByPeriod;
    uint256 public totalStaked;
    uint256 public lastUpdateTime;
    IERC20 public token;
    address public stakePool;
    address public rewardPool;
    IPool public stakePoolContract;
    IPool public rewardPoolContract;
    uint256 public accRewardPerToken90Days;
    uint256 public accRewardPerToken180Days;
    uint256 public accRewardPerToken365Days;
    uint256 public totalStaked90Days;
    uint256 public totalStaked180Days;
    uint256 public totalStaked365Days;
    address[] private allStakerAddresses;
    mapping(address => bool) private isKnownStaker;
    mapping(uint256 => address[]) private stakerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) private isStakerInPeriod;
    address[] private allReferrerAddresses;
    mapping(address => bool) private isKnownReferrer;
    mapping(uint256 => address[]) private referrerAddressesByPeriod;
    mapping(uint256 => mapping(address => bool)) private isReferrerInPeriod;

    // --- Events --- (Keep relevant events, remove governance-specific ones if any)
    event GovernanceContractSet(address indexed governance);
    event Paused(address account);
    event Unpaused(address account);
    event RewardsAdded(uint256 amount);
    event RewardsWithdrawn(uint256 amount);
    event Staked(address indexed user, uint256 amount, uint256 lockPeriod);
    event StakedWithReferrer(address indexed user, address indexed referrer, uint256 amount, uint256 lockPeriod);
    event Unstaked(address indexed user, uint256 amount, uint256 distributedReward, uint256 penalty);
    event MissedRewards(address indexed user, uint256 amount);
    event ReferrerRewardsClaimed(address indexed referrer, uint256 amount);
    event ReferrerRewardUpdated(address indexed referrer, address indexed referee, uint256 stakeId, uint256 amount, uint256 lockPeriod);
    event TokensTransferredToStorageToken(address indexed from, uint256 amount);
    event RewardDistributionLog(address indexed user, uint256 amount, uint256 pendingRewards, uint256 penalty, uint256 rewardPoolBalance, uint256 lockPeriod, uint256 elapsedTime);
    event UnableToDistributeRewards(address indexed user, uint256 rewardPoolBalance, uint256 stakedAmount, uint256 finalRewards, uint256 lockPeriod);
    // event EmergencyAction(string action, uint256 timestamp); // Replaced by Paused/Unpaused
    event PoolBalanceReconciled(uint256 amount, bool isExcess);
    // UUPS events
    event Initialized(uint8 version);

    // --- Errors --- (Keep relevant errors)
    error UnauthorizedGovernanceAction();
    error AlreadyInitialized();
    error InvalidAddress();
    error InvalidTokenAddress();
    error InvalidReferrerAddress();
    error InsufficientApproval();
    error NoClaimableRewards();
    error ClaimPeriodNotReached();
    error InvalidAmount();
    error InvalidLockPeriod();
    error StakeNotFound();
    error LockPeriodNotOver();
    error TransferFailed();
    error PausedState(); // For whenNotPaused
    error NotPausedState(); // For whenPaused
    error NoReferrerRewardsAvailable();
    // Remove errors specific to GovernanceModule if they are not used here

    // --- Modifiers --- 

    /**
     * @dev Modifier to restrict functions to only the governance contract.
     */
    modifier onlyGovernance() {
        if (msg.sender != governanceContract) revert UnauthorizedGovernanceAction();
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     */
    modifier whenNotPaused() {
        if (_paused) revert PausedState();
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is paused.
     */
    modifier whenPaused() {
        if (!_paused) revert NotPausedState();
        _;
    }

    // --- Initializer --- 

    /**
     * @notice Initializes the contract (replaces constructor for upgradeability).
     * @param _token Address of the StorageToken.
     * @param _stakePool Address of the stake pool.
     * @param _rewardPool Address of the reward pool.
     * @param _governanceContract Address of the deployed ConcreteGovernance contract.
     */
    function initialize(
        address _token,
        address _stakePool,
        address _rewardPool,
        address _governanceContract
    ) external initializer { // Use OZ initializer modifier
        // __ReentrancyGuard_init(); // ReentrancyGuard has no initializer
        __UUPSUpgradeable_init(); // Initialize UUPS

        if (
            _token == address(0) || 
            _stakePool == address(0) || 
            _rewardPool == address(0) || 
            _governanceContract == address(0)
        ) revert InvalidAddress();

        // Validate token address
        try IERC20(_token).totalSupply() returns (uint256) {} catch {
            revert InvalidTokenAddress();
        }

        token = IERC20(_token);
        stakePool = _stakePool;
        rewardPool = _rewardPool;
        stakePoolContract = IPool(_stakePool);
        rewardPoolContract = IPool(_rewardPool);
        governanceContract = _governanceContract;
        
        lastUpdateTime = block.timestamp;
        _paused = false; // Ensure initial state is not paused

        emit GovernanceContractSet(_governanceContract);
    }

    // --- Administrative Functions (Callable by Governance) --- 

    /**
     * @notice Pauses the contract. Only callable by the governance contract.
     */
    function pause() external override onlyGovernance whenNotPaused {
        _paused = true;
        emit Paused(msg.sender); // msg.sender is the governance contract
    }

    /**
     * @notice Unpauses the contract. Only callable by the governance contract.
     */
    function unpause() external override onlyGovernance whenPaused {
        _paused = false;
        emit Unpaused(msg.sender); // msg.sender is the governance contract
    }

    /**
     * @notice Add rewards to the pool. Only callable by the governance contract.
     * @dev Assumes tokens are approved/transferred to the governance contract first.
     * @param amount Amount of rewards to add.
     */
    function addRewardsToPool(uint256 amount) external override onlyGovernance {
        // Governance contract calls this, so transfer from governance to reward pool
        token.safeTransferFrom(msg.sender, rewardPool, amount);
        // Notify reward pool (if needed)
        try rewardPoolContract.receiveTokens(msg.sender, amount) {} catch {
            // Optional: handle failure to notify pool, though transfer succeeded
        }
        emit RewardsAdded(amount);
    }

    /**
     * @notice Sets a new governance contract address.
     * @dev Critical function, ensure only current governance can call this.
     * @param _newGovernanceContract The address of the new governance contract.
     */
    function setGovernanceContract(address _newGovernanceContract) external onlyGovernance {
        if (_newGovernanceContract == address(0)) revert InvalidAddress();
        governanceContract = _newGovernanceContract;
        emit GovernanceContractSet(_newGovernanceContract);
    }

    // --- Core Staking/Referral Logic (Largely Unchanged) --- 
    // Includes stake, unstake, stakeWithReferrer, claimReferrerRewards, etc.
    // Ensure `nonReentrant` and `whenNotPaused` modifiers are applied correctly.

    /**
     * @notice Stake tokens with a specific lock period.
     * @param amount Amount of tokens to stake.
     * @param lockPeriod Duration to lock tokens (must match predefined periods).
     */
    function stake(uint256 amount, uint256 lockPeriod)
        external
        whenNotPaused // Apply pause check
        nonReentrant // Apply reentrancy guard
    {
        address user = msg.sender;
        if (amount == 0) revert InvalidAmount();
        if (lockPeriod != LOCK_PERIOD_1 && lockPeriod != LOCK_PERIOD_2 && lockPeriod != LOCK_PERIOD_3) {
            revert InvalidLockPeriod();
        }

        uint256 allowance = token.allowance(user, address(this));
        if (allowance < amount) revert InsufficientApproval();
        token.safeTransferFrom(user, stakePool, amount);

        try stakePoolContract.receiveTokens(user, amount) {} catch {
            // Optional: handle failure to notify pool
        }

        _addStake(user, amount, lockPeriod, address(0));
        _updateStakeTotals(lockPeriod, amount, true);
        totalStaked += amount;
        _addStakerToLists(user, lockPeriod);

        emit Staked(user, amount, lockPeriod);
        emit TokensTransferredToStorageToken(user, amount);
    }

    /**
     * @notice Stake tokens with a referrer.
     * @param amount Amount of tokens to stake.
     * @param lockPeriod Duration to lock tokens (must match predefined periods).
     * @param referrer Address of the referrer.
     */
    function stakeWithReferrer(uint256 amount, uint256 lockPeriod, address referrer)
        external
        whenNotPaused
        nonReentrant
    {
        address user = msg.sender;
        if (amount == 0) revert InvalidAmount();
        if (lockPeriod != LOCK_PERIOD_1 && lockPeriod != LOCK_PERIOD_2 && lockPeriod != LOCK_PERIOD_3) {
            revert InvalidLockPeriod();
        }
        if (referrer == address(0) || referrer == user) revert InvalidReferrerAddress();

        uint256 allowance = token.allowance(user, address(this));
        if (allowance < amount) revert InsufficientApproval();
        token.safeTransferFrom(user, stakePool, amount);

        try stakePoolContract.receiveTokens(user, amount) {} catch {
             // Optional: handle failure to notify pool
        }

        uint256 stakeId = _addStake(user, amount, lockPeriod, referrer);
        _updateStakeTotals(lockPeriod, amount, true);
        totalStaked += amount;
        _updateReferrerStatsOnStake(referrer, user, amount, lockPeriod, stakeId);
        _addStakerToLists(user, lockPeriod);
        _addReferrerToLists(referrer, lockPeriod);

        emit StakedWithReferrer(user, referrer, amount, lockPeriod);
        emit TokensTransferredToStorageToken(user, amount);
    }

    /**
     * @notice Unstake tokens after the lock period or with penalty.
     * @param stakeIndex Index of the stake to unstake.
     */
    function unstake(uint256 stakeIndex)
        external
        whenNotPaused
        nonReentrant
    {
        address user = msg.sender;
        if (stakeIndex >= stakes[user].length) revert StakeNotFound();
        StakeInfo storage stakeToUnstake = stakes[user][stakeIndex];
        if (!stakeToUnstake.isActive) revert StakeNotFound();

        uint256 stakeAmount = stakeToUnstake.amount;
        uint256 lockPeriod = stakeToUnstake.lockPeriod;
        uint256 startTime = stakeToUnstake.startTime;
        uint256 elapsedTime = block.timestamp - startTime;
        uint256 penalty = 0;
        uint256 pendingRewards = 0;

        if (elapsedTime < lockPeriod) {
            uint256 fixedAPY = _getFixedAPY(lockPeriod);
            uint256 remainingTime = lockPeriod - elapsedTime;
            penalty = (stakeAmount * fixedAPY * remainingTime) / (365 days * 100 * 2); // Half penalty
            pendingRewards = 0;
        } else {
            pendingRewards = calculatePendingRewards(stakeAmount, lockPeriod, startTime, block.timestamp);
            penalty = 0;
        }

        stakeToUnstake.isActive = false;
        _updateStakeTotals(lockPeriod, stakeAmount, false);
        totalStaked -= stakeAmount;

        // --- Interactions --- 
        bool successPrincipal = false;
        try stakePoolContract.transferTokens(stakeAmount) returns (bool success) {
            successPrincipal = success;
        } catch { /* Ignore error, proceed */ }

        if (!successPrincipal) {
            stakeToUnstake.isActive = true;
            _updateStakeTotals(lockPeriod, stakeAmount, true);
            totalStaked += stakeAmount;
            revert TransferFailed();
        }
        token.safeTransfer(user, stakeAmount); // Transfer principal from this contract to user

        uint256 rewardPoolBalance = token.balanceOf(rewardPool);
        uint256 finalRewardToDistribute = 0;

        if (pendingRewards > 0) {
            if (rewardPoolBalance >= pendingRewards) {
                finalRewardToDistribute = pendingRewards;
                bool successReward = false;
                try rewardPoolContract.transferTokens(finalRewardToDistribute) returns (bool success) {
                    successReward = success;
                } catch { /* Ignore error */ }

                if (successReward) {
                    token.safeTransfer(user, finalRewardToDistribute);
                } else {
                    emit UnableToDistributeRewards(user, rewardPoolBalance, stakeAmount, finalRewardToDistribute, lockPeriod);
                    finalRewardToDistribute = 0;
                }
            } else {
                emit UnableToDistributeRewards(user, rewardPoolBalance, stakeAmount, pendingRewards, lockPeriod);
                finalRewardToDistribute = 0;
            }
        }

        if (penalty > 0) {
            // Transfer penalty from stake pool to reward pool
            bool successPenalty = false;
            try stakePoolContract.transferTokens(penalty) returns (bool success) {
                 successPenalty = success;
            } catch { /* Ignore error */ }

            if (successPenalty) {
                token.safeTransfer(rewardPool, penalty); // Transfer from this contract to reward pool
                try rewardPoolContract.receiveTokens(address(this), penalty) {} catch { /* Ignore error */ }
            } else {
                 emit RewardDistributionLog(user, stakeAmount, pendingRewards, penalty, rewardPoolBalance, lockPeriod, elapsedTime); // Log failure context
                 penalty = 0;
            }
        }

        emit Unstaked(user, stakeAmount, finalRewardToDistribute, penalty);
        emit RewardDistributionLog(user, stakeAmount, pendingRewards, penalty, rewardPoolBalance, lockPeriod, elapsedTime);
    }

    /**
     * @notice Claim available rewards for a referrer.
     */
    function claimReferrerRewards() external whenNotPaused nonReentrant {
        address referrer = msg.sender;
        ReferrerInfo storage referrerInfo = referrers[referrer];
        uint256 totalClaimable = 0;
        uint256 rewardCount = referrerRewards[referrer].length;

        // Consider adding pagination or limiting loop iterations (e.g., MAX_STAKES_TO_PROCESS)
        for (uint256 i = 0; i < rewardCount; i++) {
            ReferrerRewardInfo storage reward = referrerRewards[referrer][i];
            if (reward.isActive && block.timestamp >= reward.nextClaimTime) {
                uint256 claimableForThis = reward.totalReward - reward.claimedReward;
                if (claimableForThis > 0) {
                    uint256 periodsPassed = (block.timestamp - reward.nextClaimTime) / REFERRER_CLAIM_PERIOD + 1;
                    uint256 rewardPerPeriod = reward.totalReward * REFERRER_CLAIM_PERIOD / reward.lockPeriod;
                    uint256 amountToClaimNow = periodsPassed * rewardPerPeriod;
                    
                    if (reward.claimedReward + amountToClaimNow > reward.totalReward) {
                        amountToClaimNow = reward.totalReward - reward.claimedReward;
                    }

                    if (amountToClaimNow > 0) {
                        totalClaimable += amountToClaimNow;
                        reward.claimedReward += amountToClaimNow;
                        reward.nextClaimTime = reward.nextClaimTime + (periodsPassed * REFERRER_CLAIM_PERIOD);
                        // Optional: Mark inactive if fully claimed
                        // if (reward.claimedReward == reward.totalReward) { reward.isActive = false; }
                    }
                }
            }
        }

        if (totalClaimable == 0) revert NoReferrerRewardsAvailable();

        // Update global unclaimed rewards (ensure consistency)
        if (referrerInfo.unclaimedRewards < totalClaimable) {
             totalClaimable = referrerInfo.unclaimedRewards; // Cap at tracked amount
        }
        referrerInfo.unclaimedRewards -= totalClaimable;
        referrerInfo.lastClaimTime = block.timestamp;

        uint256 rewardPoolBalance = token.balanceOf(rewardPool);
        if (rewardPoolBalance < totalClaimable) {
            // Revert state changes (complex due to loop, consider alternative designs)
            referrerInfo.unclaimedRewards += totalClaimable;
            // Need to revert loop changes here - difficult!
            revert TransferFailed(); // InsufficientRewardPoolBalance
        }

        bool success = false;
        try rewardPoolContract.transferTokens(totalClaimable) returns (bool s) {
            success = s;
        } catch { /* Ignore error */ }

        if (!success) {
            referrerInfo.unclaimedRewards += totalClaimable;
            // Revert loop changes - difficult!
            revert TransferFailed();
        }
        token.safeTransfer(referrer, totalClaimable); // Transfer from this contract to referrer

        emit ReferrerRewardsClaimed(referrer, totalClaimable);
    }

    // --- Internal Helper Functions (Unchanged) --- 
    // _addStake, _updateStakeTotals, _addStakerToLists, _addReferrerToLists, 
    // _updateReferrerStatsOnStake, calculatePendingRewards, _getFixedAPY, etc.
    // These remain the same as in the original contract.

    function _addStake(address user, uint256 amount, uint256 lockPeriod, address referrer) internal returns (uint256 stakeId) {
        stakeId = stakes[user].length;
        stakes[user].push(StakeInfo({
            amount: amount,
            rewardDebt: 0,
            lockPeriod: lockPeriod,
            startTime: block.timestamp,
            referrer: referrer,
            isActive: true
        }));
        return stakeId;
    }

    function _updateStakeTotals(uint256 lockPeriod, uint256 amount, bool isAdding) internal {
        if (lockPeriod == LOCK_PERIOD_1) {
            totalStaked90Days = isAdding ? totalStaked90Days + amount : totalStaked90Days - amount;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked180Days = isAdding ? totalStaked180Days + amount : totalStaked180Days - amount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked365Days = isAdding ? totalStaked365Days + amount : totalStaked365Days - amount;
        }
    }

    function _addStakerToLists(address user, uint256 lockPeriod) internal {
        if (!isKnownStaker[user]) {
            isKnownStaker[user] = true;
            allStakerAddresses.push(user);
        }
        if (!isStakerInPeriod[lockPeriod][user]) {
            isStakerInPeriod[lockPeriod][user] = true;
            stakerAddressesByPeriod[lockPeriod].push(user);
        }
    }

    function _addReferrerToLists(address referrer, uint256 lockPeriod) internal {
        if (!isKnownReferrer[referrer]) {
            isKnownReferrer[referrer] = true;
            allReferrerAddresses.push(referrer);
        }
        if (!isReferrerInPeriod[lockPeriod][referrer]) {
            isReferrerInPeriod[lockPeriod][referrer] = true;
            referrerAddressesByPeriod[lockPeriod].push(referrer);
        }
    }

    function _updateReferrerStatsOnStake(address referrer, address referee, uint256 amount, uint256 lockPeriod, uint256 stakeId) internal {
        ReferrerInfo storage referrerInfo = referrers[referrer];
        if (!isReferred[referrer][referee]) {
            isReferred[referrer][referee] = true;
            referredStakers[referrer].push(referee);
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
        uint256 referrerRewardPercent = getReferrerRewardPercent(lockPeriod);
        if (referrerRewardPercent > 0) {
            uint256 totalRewardForReferrer = (amount * referrerRewardPercent) / 100;
            referrerInfo.totalReferrerRewards += totalRewardForReferrer;
            referrerInfo.unclaimedRewards += totalRewardForReferrer;
            referrerRewards[referrer].push(ReferrerRewardInfo({
                stakeId: stakeId,
                amount: amount,
                lockPeriod: lockPeriod,
                startTime: block.timestamp,
                endTime: block.timestamp + lockPeriod,
                totalReward: totalRewardForReferrer,
                claimedReward: 0,
                nextClaimTime: block.timestamp + REFERRER_CLAIM_PERIOD,
                isActive: true,
                referee: referee
            }));
            emit ReferrerRewardUpdated(referrer, referee, stakeId, totalRewardForReferrer, lockPeriod);
        }
    }

    function calculatePendingRewards(uint256 _amount, uint256 _lockPeriod, uint256 _startTime, uint256 _currentTime) public pure returns (uint256) {
        uint256 elapsedTime = _currentTime - _startTime;
        if (elapsedTime > _lockPeriod) {
            elapsedTime = _lockPeriod;
        }
        uint256 fixedAPY = _getFixedAPY(_lockPeriod);
        if (fixedAPY == 0) return 0;
        uint256 rewards = (_amount * fixedAPY * elapsedTime) / (365 days * 100);
        return rewards;
    }

    function _getFixedAPY(uint256 lockPeriod) internal pure returns (uint256) {
        if (lockPeriod == LOCK_PERIOD_1) return FIXED_APY_90_DAYS;
        if (lockPeriod == LOCK_PERIOD_2) return FIXED_APY_180_DAYS;
        if (lockPeriod == LOCK_PERIOD_3) return FIXED_APY_365_DAYS;
        return 0;
    }

    function getReferrerRewardPercent(uint256 lockPeriod) public pure returns (uint256) {
        if (lockPeriod == LOCK_PERIOD_1) return REFERRER_REWARD_PERCENT_90_DAYS;
        if (lockPeriod == LOCK_PERIOD_2) return REFERRER_REWARD_PERCENT_180_DAYS;
        if (lockPeriod == LOCK_PERIOD_3) return REFERRER_REWARD_PERCENT_365_DAYS;
        return 0;
    }

    // --- View Functions (Unchanged) --- 
    // getUserStakes, getUserTotalStaked, getTotalStaked, getReferrerStats, etc.
    // These remain the same as in the original contract.

    function getUserStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }
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
    function getReferrerStats(address referrer) external view returns (ReferrerInfo memory) {
        return referrers[referrer];
    }
    function getReferredStakers(address referrer) external view returns (address[] memory) {
        return referredStakers[referrer];
    }
    function getReferrerRewards(address referrer) external view returns (ReferrerRewardInfo[] memory) {
        return referrerRewards[referrer];
    }
    function getClaimableReferrerRewards(address referrer) public view returns (uint256) {
        uint256 claimable = 0;
        ReferrerRewardInfo[] memory rewards = referrerRewards[referrer];
        for (uint256 i = 0; i < rewards.length; i++) {
            if (rewards[i].isActive && block.timestamp >= rewards[i].nextClaimTime) {
                uint256 timeSinceLastClaim = block.timestamp - (rewards[i].nextClaimTime - REFERRER_CLAIM_PERIOD);
                uint256 claimPeriodsPassed = timeSinceLastClaim / REFERRER_CLAIM_PERIOD;
                if (claimPeriodsPassed > 0) {
                    uint256 rewardPerPeriod = rewards[i].totalReward * REFERRER_CLAIM_PERIOD / rewards[i].lockPeriod;
                    uint256 amountToClaimNow = claimPeriodsPassed * rewardPerPeriod;
                    if (rewards[i].claimedReward + amountToClaimNow > rewards[i].totalReward) {
                        amountToClaimNow = rewards[i].totalReward - rewards[i].claimedReward;
                    }
                    if (amountToClaimNow > 0) {
                        claimable += amountToClaimNow;
                    }
                }
            }
        }
        return claimable;
    }
    function getExcessRewards() public view returns (uint256) {
        uint256 requiredRewards = calculateRequiredRewards();
        uint256 poolBalance = token.balanceOf(rewardPool);
        if (poolBalance > requiredRewards) {
            return poolBalance - requiredRewards;
        }
        return 0;
    }
    function calculateRequiredRewards() public view returns (uint256) {
        uint256 required90Days = (totalStaked90Days * FIXED_APY_90_DAYS) / 100;
        uint256 required180Days = (totalStaked180Days * FIXED_APY_180_DAYS) / 100;
        uint256 required365Days = (totalStaked365Days * FIXED_APY_365_DAYS) / 100;
        return required90Days + required180Days + required365Days;
    }
    function getPoolStatus() external view returns (uint256 totalPoolBalance, uint256 stakedAmount, uint256 rewardsAmount) {
        totalPoolBalance = token.balanceOf(stakePool) + token.balanceOf(rewardPool);
        stakedAmount = token.balanceOf(stakePool);
        rewardsAmount = token.balanceOf(rewardPool);
        return (totalPoolBalance, stakedAmount, rewardsAmount);
    }
    function paused() public view returns (bool) {
        return _paused;
    }

    // --- UUPS Upgradeability --- 

    /**
     * @notice Authorizes an upgrade. Only callable by the governance contract.
     * @dev Implements the authorization logic for UUPS upgrades.
     */
    function authorizeUpgrade(address newImplementation) external override onlyGovernance {
        _authorizeUpgrade(newImplementation);
    }

    /**
     * @dev Internal function that checks upgrade authorization.
     *      Called by UUPSUpgradeable during upgradeTo.
     *      Requires msg.sender to be the governance contract.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyGovernance {
        // This internal function is called by OZ UUPSUpgradeable's upgradeTo function.
        // The onlyGovernance modifier ensures only the governance contract can trigger an upgrade.
    }

}

