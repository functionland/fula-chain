// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../governance/GovernanceModule.sol";

/// @title StakingEngine
/// @notice Handles token staking with different lock periods and rewards
/// @dev Inherits governance functionality from GovernanceModule
contract StakingEngine is ERC20Upgradeable, GovernanceModule {
    using SafeERC20 for IERC20;

    uint32 public constant LOCK_PERIOD_1 = 90 days;
    uint32 public constant LOCK_PERIOD_2 = 180 days;
    uint32 public constant LOCK_PERIOD_3 = 365 days;

    uint256 public constant FIXED_APY_90_DAYS = 2; // 2% for 90 days
    uint256 public constant FIXED_APY_180_DAYS = 6; // 9% for 180 days
    uint256 public constant FIXED_APY_365_DAYS = 15; // 23% for 365 days

    // Referrer reward percentages for each lock period
    uint256 public constant REFERRER_REWARD_PERCENT_90_DAYS = 1; // 5% for 90 days
    uint256 public constant REFERRER_REWARD_PERCENT_180_DAYS = 2; // 7% for 180 days
    uint256 public constant REFERRER_REWARD_PERCENT_365_DAYS = 4; // 10% for 365 days

    struct StakeInfo {
        uint256 amount;
        uint256 rewardDebt; // Tracks user's share of accumulated rewards
        uint256 lockPeriod;
        uint256 startTime; // Track when the stake was created
        address referrer; // Address of the referrer (if any)
    }

    struct ReferrerInfo {
        uint256 totalReferred;
        uint256 totalReferrerRewards;
        uint256 unclaimedRewards;
    }

    mapping(address => StakeInfo[]) public stakes;
    mapping(address => ReferrerInfo) public referrers;
    mapping(address => mapping(uint256 => uint256)) public referrerRewardsByPeriod;
    
    uint256 public totalStaked;
    uint256 public lastUpdateTime;

    IERC20 public token;

    address public rewardPoolAddress; // Address holding reward pool tokens
    address public stakingPoolAddress; // Address holding staked tokens

    uint256 public accRewardPerToken90Days;
    uint256 public accRewardPerToken180Days;
    uint256 public accRewardPerToken365Days;

    uint256 totalStaked90Days;
    uint256 totalStaked180Days;
    uint256 totalStaked365Days;

    event RewardsAdded(uint256 amount);
    event Staked(address indexed user, uint256 amount, uint256 lockPeriod);
    event StakedWithReferrer(address indexed user, address indexed referrer, uint256 amount, uint256 lockPeriod);
    event Unstaked(address indexed user, uint256 amount, uint256 distributedReward, uint256 penalty);
    event MissedRewards(address indexed user, uint256 amount);
    event ReferrerRewardsClaimed(address indexed referrer, uint256 amount, uint256 lockPeriod);
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

    error OperationFailed(uint256 code);
    error TotalStakedTooLow(uint256 totalStaked, uint256 required);
    error APYCannotBeSatisfied(uint8 stakingPeriod, uint256 projectedAPY, uint256 minimumAPY);
    error InvalidStorageTokenAddress();
    error NoReferrerRewardsAvailable();

    /**
     * @notice Initialize the contract
     * @param _token Address of the StorageToken
     * @param _rewardPoolAddress Address of the reward pool
     * @param _stakingPoolAddress Address of the staking pool
     * @param initialOwner Address of the initial owner
     * @param initialAdmin Address of the initial admin
     */
    function initialize(
        address _token,
        address _rewardPoolAddress,
        address _stakingPoolAddress,
        address initialOwner,
        address initialAdmin
    ) public reinitializer(1) {
        require(
            _token != address(0) && 
            _rewardPoolAddress != address(0) && 
            _stakingPoolAddress != address(0) && 
            initialOwner != address(0) && 
            initialAdmin != address(0), 
            "Invalid address"
        );

        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard, 
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);
        
        token = IERC20(_token);
        rewardPoolAddress = _rewardPoolAddress;
        stakingPoolAddress = _stakingPoolAddress;

        lastUpdateTime = block.timestamp;

        // Removed unlimited token approval which is a security risk
    }

    function emergencyPauseRewardDistribution() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _pause();
        emit EmergencyAction("Rewards Distribution paused", block.timestamp);
    }

    function emergencyUnpauseRewardDistribution() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        _unpause();
        emit EmergencyAction("Rewards Distribution unpaused", block.timestamp);
    }

    function getUserStakes(address user) external view returns (StakeInfo[] memory) {
        return stakes[user];
    }

    /**
     * @dev Transfers tokens from this contract to the StorageToken contract only
     * @param amount The amount of tokens to transfer
     */
    function transferToStorageToken(uint256 amount) external onlyRole(ProposalTypes.ADMIN_ROLE) nonReentrant {
        require(amount > 0, "Amount must be greater than zero");
        require(token.balanceOf(address(this)) >= amount, "Insufficient balance");
        
        // Transfer tokens directly to the StorageToken contract
        token.safeTransfer(address(token), amount);
        
        emit TokensTransferredToStorageToken(address(this), amount);
    }

    /**
     * @dev Internal function for staking tokens with shared logic
     * @param amount The amount to stake
     * @param lockPeriod The lock period (90, 180, or 365 days)
     * @param referrer Optional address of the referrer
     */
    function _stakeTokenInternal(uint256 amount, uint256 lockPeriod, address referrer) internal {
        // Update rewards before processing the stake
        updateRewards();

        // Calculate projected APY after adding this stake
        uint256 projectedAPY = calculateProjectedAPY(amount, lockPeriod);
        if (
            lockPeriod == LOCK_PERIOD_1 && projectedAPY < FIXED_APY_90_DAYS
        ) {
            revert APYCannotBeSatisfied(1, projectedAPY, FIXED_APY_90_DAYS);
        }
        if (
            lockPeriod == LOCK_PERIOD_2 && projectedAPY < FIXED_APY_180_DAYS
        ) {
            revert APYCannotBeSatisfied(2, projectedAPY, FIXED_APY_180_DAYS);
        }
        if (
            lockPeriod == LOCK_PERIOD_3 && projectedAPY < FIXED_APY_365_DAYS
        ) {
            revert APYCannotBeSatisfied(3, projectedAPY, FIXED_APY_365_DAYS);
        }

        // Calculate pending rewards for all existing stakes of the user
        uint256 pendingRewards = calculatePendingRewards(msg.sender);
        
        // Add new stake entry for this user
        stakes[msg.sender].push(
            StakeInfo({
                amount: amount,
                rewardDebt: calculateRewardDebt(amount, lockPeriod),
                lockPeriod: lockPeriod,
                startTime: block.timestamp,
                referrer: referrer
            })
        );

        // Update total staked for the specific lock period
        if (lockPeriod == LOCK_PERIOD_1) {
            totalStaked90Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            totalStaked180Days += amount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            totalStaked365Days += amount;
        }

        // Update global total staked
        totalStaked += amount;

        // Update referrer information if provided
        if (referrer != address(0)) {
            referrers[referrer].totalReferred += amount;
        }
        
        // Execute external interactions after state changes
        // Transfer staked tokens to staking pool
        token.safeTransferFrom(msg.sender, stakingPoolAddress, amount);
        
        if (pendingRewards > 0) {
            token.safeTransferFrom(rewardPoolAddress, msg.sender, pendingRewards);
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
        
        // Referrer cannot be the same as the staker
        if (referrer != address(0)) {
            require(referrer != msg.sender, "Cannot refer yourself");
            // Additional validation to check referrer is not a contract
            uint256 size;
            assembly { size := extcodesize(referrer) }
            require(size == 0, "Referrer cannot be a contract");
        }

        _stakeTokenInternal(amount, lockPeriod, referrer);
        
        if (referrer != address(0)) {
            emit StakedWithReferrer(msg.sender, referrer, amount, lockPeriod);
        } else {
            emit Staked(msg.sender, amount, lockPeriod);
        }
    }

    function stakeToken(uint256 amount, uint256 lockPeriod) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be greater than zero");
        require(
            lockPeriod == LOCK_PERIOD_1 || lockPeriod == LOCK_PERIOD_2 || lockPeriod == LOCK_PERIOD_3,
            "Invalid lock period"
        );

        _stakeTokenInternal(amount, lockPeriod, address(0));
        
        emit Staked(msg.sender, amount, lockPeriod);
    }

    function calculateElapsedRewards(
        uint256 stakedAmount,
        uint256 fixedAPY,
        uint256 timeElapsed
    ) internal pure returns (uint256) {
        if (stakedAmount == 0) {
            return 0; // No rewards if nothing is staked
        }

        // Calculate annualized rewards based on fixed APY
        uint256 annualRewards = (stakedAmount * fixedAPY) / 100;

        // Adjust rewards proportionally to elapsed time (in seconds)
        if (timeElapsed == 0) {
            return 0;
        }
        // Improved precision by using adding half divisor for rounding
        return (annualRewards * timeElapsed + (365 days / 2)) / 365 days;
    }

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

    function unstakeToken(uint256 index) external nonReentrant whenNotPaused {
        require(index < stakes[msg.sender].length, "Invalid stake index");

        // Fetch the specific stake to be unstaked
        StakeInfo storage stake = stakes[msg.sender][index];
        uint256 stakedAmount = stake.amount;
        uint256 lockPeriod = stake.lockPeriod;
        address referrer = stake.referrer;
        require(stakedAmount > 0, "No active stake");

        // Update rewards before processing unstaking
        updateRewards();

        // Calculate pending rewards for this specific stake
        uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(lockPeriod);
        uint256 pendingRewards = (stakedAmount * accRewardPerToken) / 1e18 - stake.rewardDebt;

        // Apply penalty if unstaking early
        uint256 elapsedTime = block.timestamp - stake.startTime;
        uint256 penalty = calculatePenalty(lockPeriod, elapsedTime, stakedAmount);

        // Ensure penalties only apply to pending rewards
        uint256 finalRewards = 0;
        uint256 distributedReward = 0;
        if (pendingRewards > penalty) {
            finalRewards = pendingRewards - penalty;
        }

        // Update state: reduce total staked amounts
        if (totalStaked < stakedAmount) {
            revert TotalStakedTooLow(totalStaked, stakedAmount);
        }

        totalStaked -= stakedAmount;
        if (lockPeriod == LOCK_PERIOD_1) {
            if (totalStaked90Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked90Days, stakedAmount);
            }
            totalStaked90Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            if (totalStaked180Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked180Days, stakedAmount);
            }
            totalStaked180Days -= stakedAmount;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            if (totalStaked365Days < stakedAmount) {
                revert TotalStakedTooLow(totalStaked365Days, stakedAmount);
            }
            totalStaked365Days -= stakedAmount;
        }

        // Calculate referrer rewards if the stake has a referrer and the full lock period has elapsed
        if (referrer != address(0) && elapsedTime >= lockPeriod) {
            uint256 referrerRewardPercent;
            if (lockPeriod == LOCK_PERIOD_1) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_90_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_2) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_180_DAYS;
            } else if (lockPeriod == LOCK_PERIOD_3) {
                referrerRewardPercent = REFERRER_REWARD_PERCENT_365_DAYS;
            }
            
            uint256 referrerReward = (stakedAmount * referrerRewardPercent) / 100;
            referrers[referrer].unclaimedRewards += referrerReward;
            referrerRewardsByPeriod[referrer][lockPeriod] += referrerReward;
        }

        // Remove this specific stake by replacing it with the last element in the array
        uint256 lastIndex = stakes[msg.sender].length - 1;
        if (index != lastIndex) {
            stakes[msg.sender][index] = stakes[msg.sender][lastIndex];
        }
        stakes[msg.sender].pop(); // Remove the last element
        
        emit RewardDistributionLog(
            msg.sender,
            stakedAmount,
            pendingRewards,
            penalty,
            token.balanceOf(rewardPoolAddress),
            lockPeriod,
            elapsedTime
        );

        // Execute external interactions after state changes
        // Transfer staked tokens (principal) back to user from staking pool
        if (token.balanceOf(stakingPoolAddress) < stakedAmount) {
            revert TotalStakedTooLow(token.balanceOf(stakingPoolAddress), stakedAmount);
        }
        token.safeTransferFrom(stakingPoolAddress, msg.sender, stakedAmount);

        // Transfer final rewards from distribution address to user if available
        if (finalRewards > 0) {
            uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);

            if (rewardPoolBalance < finalRewards) {
                emit UnableToDistributeRewards(msg.sender, rewardPoolBalance, stakedAmount, finalRewards, lockPeriod);
            } else {
                token.safeTransferFrom(rewardPoolAddress, msg.sender, finalRewards);
                distributedReward = finalRewards;
            }
        } else {
            emit MissedRewards(msg.sender, penalty); // Log missed rewards due to penalties
        }

        emit Unstaked(msg.sender, stakedAmount, distributedReward, penalty);
    }

    /**
     * @dev Allows a referrer to claim their accumulated rewards
     * @param lockPeriod The lock period to claim rewards for (90, 180, or 365 days)
     */
    function claimReferrerRewards(uint256 lockPeriod) external nonReentrant whenNotPaused {
        require(
            lockPeriod == LOCK_PERIOD_1 || lockPeriod == LOCK_PERIOD_2 || lockPeriod == LOCK_PERIOD_3,
            "Invalid lock period"
        );
        
        uint256 rewardsForPeriod = referrerRewardsByPeriod[msg.sender][lockPeriod];
        require(rewardsForPeriod > 0, "No rewards available for this period");
        
        // Reset rewards for this period
        referrerRewardsByPeriod[msg.sender][lockPeriod] = 0;
        referrers[msg.sender].unclaimedRewards -= rewardsForPeriod;
        referrers[msg.sender].totalReferrerRewards += rewardsForPeriod;
        
        // Transfer rewards from reward pool to referrer
        uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);
        if (rewardPoolBalance < rewardsForPeriod) {
            revert NoReferrerRewardsAvailable();
        }
        
        token.safeTransferFrom(rewardPoolAddress, msg.sender, rewardsForPeriod);
        
        emit ReferrerRewardsClaimed(msg.sender, rewardsForPeriod, lockPeriod);
    }

    /**
     * @dev Returns the total unclaimed rewards for a referrer
     * @param referrer The address of the referrer
     */
    function getReferrerUnclaimedRewards(address referrer) external view returns (uint256) {
        return referrers[referrer].unclaimedRewards;
    }

    /**
     * @dev Returns the unclaimed rewards for a referrer by lock period
     * @param referrer The address of the referrer
     * @param lockPeriod The lock period (90, 180, or 365 days)
     */
    function getReferrerRewardsByPeriod(address referrer, uint256 lockPeriod) external view returns (uint256) {
        return referrerRewardsByPeriod[referrer][lockPeriod];
    }

    /**
     * @dev Returns the referrer info for a given address
     * @param referrer The address of the referrer
     */
    function getReferrerInfo(address referrer) external view returns (ReferrerInfo memory) {
        return referrers[referrer];
    }

    function updateRewards() internal {
        if (totalStaked > 0) {
            uint256 timeElapsed = block.timestamp - lastUpdateTime;

            // Fetch current reward pool balance
            uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);

            // Calculate rewards for each lock period using centralized logic
            uint256 rewardsFor90Days = totalStaked90Days > 0 ? calculateElapsedRewards(
                totalStaked90Days,
                FIXED_APY_90_DAYS,
                timeElapsed
            ) : 0;
            uint256 rewardsFor180Days = totalStaked180Days > 0 ? calculateElapsedRewards(
                totalStaked180Days,
                FIXED_APY_180_DAYS,
                timeElapsed
            ) : 0;
            uint256 rewardsFor365Days = totalStaked365Days > 0 ? calculateElapsedRewards(
                totalStaked365Days,
                FIXED_APY_365_DAYS,
                timeElapsed
            ) : 0;

            // Total new rewards to distribute across all stakes
            uint256 newRewards = rewardsFor90Days + rewardsFor180Days + rewardsFor365Days;

            // Ensure we do not exceed available reward pool balance
            if (newRewards > rewardPoolBalance) {
                // Proportionally adjust rewards based on available balance
                rewardsFor90Days = rewardPoolBalance * rewardsFor90Days / newRewards;
                rewardsFor180Days = rewardPoolBalance * rewardsFor180Days / newRewards;
                rewardsFor365Days = rewardPoolBalance * rewardsFor365Days / newRewards;
                newRewards = rewardPoolBalance;
            }

            // Update accumulated rewards per token for each lock period
            if (totalStaked90Days > 0 && rewardsFor90Days > 0) {
                accRewardPerToken90Days += (rewardsFor90Days * 1e18) / totalStaked90Days;
            }
            if (totalStaked180Days > 0 && rewardsFor180Days > 0) {
                accRewardPerToken180Days += (rewardsFor180Days * 1e18) / totalStaked180Days;
            }
            if (totalStaked365Days > 0 && rewardsFor365Days > 0) {
                accRewardPerToken365Days += (rewardsFor365Days * 1e18) / totalStaked365Days;
            }

            lastUpdateTime = block.timestamp; // Update last update timestamp
        }
    }

    function calculateRewardsForPeriod(
        uint256 stakedAmount,
        uint256 fixedAPY,
        uint256 timeElapsed,
        uint256 rewardPoolBalance
    ) public pure returns (uint256) {
        if (rewardPoolBalance == 0) {
            return 0; // No rewards if reward pool is empty
        }

        return calculateElapsedRewards(stakedAmount, fixedAPY, timeElapsed);
    }

    function calculatePendingRewards(address user) public view returns (uint256) {
        uint256 pendingRewards = 0;
        uint256 stakesLength = stakes[user].length;
        
        // Add a limit to prevent excessive gas consumption
        uint256 maxIterations = 100; // Arbitrary limit, adjust based on gas analysis
        uint256 iterations = stakesLength < maxIterations ? stakesLength : maxIterations;
        
        for (uint256 i = 0; i < iterations; i++) {
            StakeInfo memory stake = stakes[user][i];

            // Get accumulated rewards per token for the stake's lock period
            uint256 accRewardPerToken = getAccRewardPerTokenForLockPeriod(stake.lockPeriod);

            // Calculate pending rewards for this specific stake
            pendingRewards += (stake.amount * accRewardPerToken) / 1e18 - stake.rewardDebt;
        }

        return pendingRewards;
    }

    function calculateRewardDebt(uint256 amount, uint256 lockPeriod) internal view returns (uint256) {
        if (lockPeriod == LOCK_PERIOD_1) {
            return (amount * accRewardPerToken90Days) / 1e18;
        } else if (lockPeriod == LOCK_PERIOD_2) {
            return (amount * accRewardPerToken180Days) / 1e18;
        } else if (lockPeriod == LOCK_PERIOD_3) {
            return (amount * accRewardPerToken365Days) / 1e18;
        }
        return 0; // Default case; should never occur due to earlier validation
    }

    function calculateProjectedAPY(uint256 additionalStake, uint256 lockPeriod)
        public
        view
        returns (uint256)
    {
        uint256 rewardPoolBalance = token.balanceOf(rewardPoolAddress);
        if (rewardPoolBalance == 0) {
            return 0; // No rewards available if reward pool is empty
        }
        
        if (totalStaked == 0 && additionalStake == 0) {
            return 0; // Avoid division by zero
        }

        // Define reward multipliers based on lock periods
        uint256 fixedAPY;
        if (lockPeriod == LOCK_PERIOD_1) {
            fixedAPY = FIXED_APY_90_DAYS; // 2%
        } else if (lockPeriod == LOCK_PERIOD_2) {
            fixedAPY = FIXED_APY_180_DAYS; // 9%
        } else if (lockPeriod == LOCK_PERIOD_3) {
            fixedAPY = FIXED_APY_365_DAYS; // 23%
        } else {
            revert("Invalid lock period");
        }

        // Calculate projected APY as a percentage
        uint256 neededNewRewards = calculateElapsedRewards(additionalStake, fixedAPY, lockPeriod);
        uint256 neededCurrentRewards1 = calculateElapsedRewards(totalStaked90Days, fixedAPY, LOCK_PERIOD_1);
        uint256 neededCurrentRewards2 = calculateElapsedRewards(totalStaked180Days, fixedAPY, LOCK_PERIOD_2);
        uint256 neededCurrentRewards3 = calculateElapsedRewards(totalStaked365Days, fixedAPY, LOCK_PERIOD_3);
        if (neededNewRewards + neededCurrentRewards1 + neededCurrentRewards2 + neededCurrentRewards3 <= token.balanceOf(rewardPoolAddress) ) {
            return fixedAPY;
        } else {
            return 0;
        }
    }

    function calculatePenalty(uint256 lockPeriod, uint256 elapsedTime, uint256 stakedAmount) internal pure returns (uint256) {
        // If the full lock period has elapsed, no penalty applies
        if (elapsedTime >= lockPeriod) return 0;

        // Calculate the percentage of time remaining in the lock period
        uint256 remainingPercentage = ((lockPeriod - elapsedTime) * 1e18) / lockPeriod;

        // Apply a dynamic penalty scaling based on how early unstaking occurs
        uint256 penaltyRate;
        if (remainingPercentage > 75 * 1e16) { // >75% time remaining
            penaltyRate = 50; // 50% penalty on staked amount
        } else if (remainingPercentage > 50 * 1e16) { // >50% time remaining
            penaltyRate = 30; // 30% penalty on staked amount
        } else if (remainingPercentage > 25 * 1e16) { // >25% time remaining
            penaltyRate = 15; // 15% penalty on staked amount
        } else {
            penaltyRate = 5; // Minimal penalty for near-completion
        }

        // Calculate the penalty as a percentage of the staked amount
        uint256 penalty = (stakedAmount * penaltyRate) / 100;

        return penalty;
    }

    /**
     * @notice Authorize contract upgrade using governance module
     * @param newImplementation Address of the new implementation
     */
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

    /**
     * @notice Handle custom proposal execution
     */
    function _executeCustomProposal(bytes32) internal override {
        // No custom proposals in StakingEngine
        revert("No custom proposals supported");
    }

    /**
     * @notice Create a custom proposal
     * @dev This function is required by GovernanceModule but not used in StakingEngine
     */
    function _createCustomProposal(
        uint8,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal override returns (bytes32) {
        // No custom proposals in StakingEngine
        revert("No custom proposals supported");
    }
}