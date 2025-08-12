// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StakingEngineLinear.sol";

/**
 * @title StakingEngineLinearWithMigration
 * @notice Extended version of StakingEngineLinear with secure migration functions
 * @dev This contract adds migration capabilities with enhanced security measures
 */
contract StakingEngineLinearWithMigration is StakingEngineLinear {
    
    // Migration state
    bool public migrationMode;
    bool public migrationModeEverEnabled; // Track if migration was ever enabled
    mapping(address => bool) public migratedUsers;
    uint256 public totalMigratedStakes;
    
    // Events
    event MigrationModeEnabled();
    event MigrationModeDisabled();
    event StakeMigrated(address indexed user, uint256 stakeIndex, uint256 amount, uint256 lockPeriod);
    
    // Errors
    error MigrationModeActive();
    error MigrationModeInactive();
    error UserAlreadyMigrated();
    error InvalidMigrationData();
    error MigrationModeAlreadyUsed();
    
    /// @notice Enable migration mode - disables normal staking operations
    function enableMigrationMode() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (migrationModeEverEnabled) revert MigrationModeAlreadyUsed();
        migrationMode = true;
        migrationModeEverEnabled = true;
        _pause();
        emit MigrationModeEnabled();
    }
    
    /// @notice Disable migration mode - re-enables normal staking operations
    function disableMigrationMode() external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (!migrationMode) revert MigrationModeInactive();
        migrationMode = false;
        _unpause();
        emit MigrationModeDisabled();
    }
    
    /// @notice Migrate multiple stakes for a user in a single transaction
    function migrateMultipleStakes(
        address user,
        uint256[] calldata amounts,
        uint256[] calldata rewardDebts,
        uint256[] calldata lockPeriods,
        uint256[] calldata startTimes,
        address[] calldata referrers,
        bool[] calldata isActiveFlags
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (!migrationMode) revert MigrationModeInactive();
        if (migratedUsers[user]) revert UserAlreadyMigrated();
        
        uint256 length = amounts.length;
        require(length == rewardDebts.length && length == lockPeriods.length && length == startTimes.length && length == referrers.length && length == isActiveFlags.length, "Invalid migration data");
        
        // Base index of the first migrated stake for this user
        uint256 baseIndex = stakes[user].length;

        uint256 totalAmount90 = 0;
        uint256 totalAmount180 = 0;
        uint256 totalAmount365 = 0;
        uint256 totalAmountAll = 0;
        
        for (uint256 i = 0; i < length; i++) {
            require(amounts[i] > 0, "Amount must be greater than zero");
            require(lockPeriods[i] == LOCK_PERIOD_1 || lockPeriods[i] == LOCK_PERIOD_2 || lockPeriods[i] == LOCK_PERIOD_3, "Invalid lock period");
            
            stakes[user].push(
                StakeInfo({
                    amount: amounts[i],
                    rewardDebt: rewardDebts[i],
                    lockPeriod: lockPeriods[i],
                    startTime: startTimes[i],
                    referrer: referrers[i],
                    isActive: isActiveFlags[i]
                })
            );
            
            // Only count amounts toward active totals when the migrated stake is active
            if (isActiveFlags[i]) {
                totalAmountAll += amounts[i];
                if (lockPeriods[i] == LOCK_PERIOD_1) {
                    totalAmount90 += amounts[i];
                } else if (lockPeriods[i] == LOCK_PERIOD_2) {
                    totalAmount180 += amounts[i];
                } else if (lockPeriods[i] == LOCK_PERIOD_3) {
                    totalAmount365 += amounts[i];
                }
            }
            
            emit StakeMigrated(user, stakes[user].length - 1, amounts[i], lockPeriods[i]);
        }
        
        if (!isKnownStaker[user]) {
            isKnownStaker[user] = true;
            allStakerAddresses.push(user);
        }
        
        for (uint256 i = 0; i < length; i++) {
            // Only track staker in period lists if at least one active stake exists in that period
            if (isActiveFlags[i] && !isStakerInPeriod[lockPeriods[i]][user]) {
                isStakerInPeriod[lockPeriods[i]][user] = true;
                stakerAddressesByPeriod[lockPeriods[i]].push(user);
            }
        }
        
        totalStaked += totalAmountAll;
        totalStaked90Days += totalAmount90;
        totalStaked180Days += totalAmount180;
        totalStaked365Days += totalAmount365;
        
        migratedUsers[user] = true;
        totalMigratedStakes += length;
        
        for (uint256 i = 0; i < length; i++) {
            address referrer = referrers[i];
            if (referrer != address(0)) {
                // Add to global referrer tracking
                if (!isKnownReferrer[referrer]) {
                    isKnownReferrer[referrer] = true;
                    allReferrerAddresses.push(referrer);
                }
                
                // Add to period-specific referrer tracking
                uint256 lockPeriod = lockPeriods[i];
                // Only add to period list if the migrated stake is active
                if (isActiveFlags[i] && !isReferrerInPeriod[lockPeriod][referrer]) {
                    isReferrerInPeriod[lockPeriod][referrer] = true;
                    referrerAddressesByPeriod[lockPeriod].push(referrer);
                }
                
                // Update referrer statistics (CRITICAL - was missing)
                // Note: Access inherited mapping directly since referrers parameter shadows mapping name
                ReferrerInfo storage referrerInfo = StakingEngineLinear.referrers[referrer];
                
                // Handle new referee relationship
                if (!isReferred[referrer][user]) {
                    isReferred[referrer][user] = true;
                    referredStakers[referrer].push(user);
                    // Count total referred stakers always, but only increment active count if stake is active
                    referrerInfo.referredStakersCount++;
                    if (isActiveFlags[i]) {
                        referrerInfo.activeReferredStakersCount++;
                    }
                }
                
                // Update referrer staking statistics
                referrerInfo.totalReferred += amounts[i];
                if (isActiveFlags[i]) {
                    referrerInfo.totalActiveStaked += amounts[i];
                }
                
                // Update period-specific stats for referrer
                if (isActiveFlags[i]) {
                    if (lockPeriod == LOCK_PERIOD_1) {
                        referrerInfo.totalActiveStaked90Days += amounts[i];
                    } else if (lockPeriod == LOCK_PERIOD_2) {
                        referrerInfo.totalActiveStaked180Days += amounts[i];
                    } else if (lockPeriod == LOCK_PERIOD_3) {
                        referrerInfo.totalActiveStaked365Days += amounts[i];
                    }
                }
                
                // Calculate referrer reward percentage
                uint256 referrerRewardPercent;
                if (lockPeriod == LOCK_PERIOD_1) {
                    referrerRewardPercent = REFERRER_REWARD_PERCENT_90_DAYS;
                } else if (lockPeriod == LOCK_PERIOD_2) {
                    referrerRewardPercent = REFERRER_REWARD_PERCENT_180_DAYS;
                } else if (lockPeriod == LOCK_PERIOD_3) {
                    referrerRewardPercent = REFERRER_REWARD_PERCENT_365_DAYS;
                }
                
                // Create referrer reward entries (CRITICAL - was missing)
                if (referrerRewardPercent > 0) {
                    uint256 totalReferrerReward = (amounts[i] * referrerRewardPercent) / 100;
                    uint256 stakeIndex = baseIndex + i; // Correct stake index corresponding to this migrated stake
                    
                    // Add to referrer rewards array
                    referrerRewards[referrer].push(
                        ReferrerRewardInfo({
                            stakeId: stakeIndex, // Use the correct stake index in stakes[user]
                            amount: amounts[i],
                            lockPeriod: lockPeriod,
                            startTime: startTimes[i],
                            endTime: startTimes[i] + lockPeriod,
                            totalReward: totalReferrerReward,
                            claimedReward: 0,
                            nextClaimTime: startTimes[i] + REFERRER_CLAIM_PERIOD,
                            isActive: isActiveFlags[i],
                            referee: user
                        })
                    );
                    
                    // Update referrer info
                    referrerInfo.unclaimedRewards += totalReferrerReward;
                    referrerRewardsByPeriod[referrer][lockPeriod] += totalReferrerReward;
                }
            }
        }
    }
    
    /// @notice Add referrer to global tracking (admin only)
    function addReferrer(address ref, uint256 period) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (ref != address(0)) {
            if (!isKnownReferrer[ref]) {
                isKnownReferrer[ref] = true;
                allReferrerAddresses.push(ref);
            }
            if (!isReferrerInPeriod[period][ref]) {
                isReferrerInPeriod[period][ref] = true;
                referrerAddressesByPeriod[period].push(ref);
            }
        }
    }
    

    
    /**
     * @notice Set initial global staked amounts (for initialization only)
     * @dev Only admin can call this during migration mode. Use sparingly - prefer atomic updates in migration functions
     */
    function setInitialTotalStaked(
        uint256 _totalStaked,
        uint256 _totalStaked90Days,
        uint256 _totalStaked180Days,
        uint256 _totalStaked365Days
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        if (!migrationMode) revert MigrationModeInactive();
        
        totalStaked = _totalStaked;
        totalStaked90Days = _totalStaked90Days;
        totalStaked180Days = _totalStaked180Days;
        totalStaked365Days = _totalStaked365Days;
        

    }
    
    /// @notice Get migration status
    function getMigrationStatus() external view returns (
        bool inMigrationMode,
        uint256 totalMigrated,
        uint256 totalStakers
    ) {
        return (migrationMode, totalMigratedStakes, allStakerAddresses.length);
    }
    
    /// @notice Override stakeToken function to prevent staking during migration
    function stakeToken(uint256 amount, uint256 lockPeriod) external override nonReentrant whenNotPaused {
        if (migrationMode) revert MigrationModeActive();
        _stakeTokenInternal(amount, lockPeriod, address(0));
        emit Staked(msg.sender, amount, lockPeriod);
    }

    /// @notice Override stakeTokenWithReferrer function to prevent staking during migration
    function stakeTokenWithReferrer(uint256 amount, uint256 lockPeriod, address referrer) external override nonReentrant whenNotPaused {
        if (migrationMode) revert MigrationModeActive();
        _stakeTokenInternal(amount, lockPeriod, referrer);
        emit StakedWithReferrer(msg.sender, referrer, amount, lockPeriod);
    }
}
