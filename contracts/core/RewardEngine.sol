// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./StorageToken.sol";
import "../governance/interfaces/IRewardEngine.sol";
import "../governance/interfaces/IStorageProof.sol";
import "../governance/interfaces/IStoragePool.sol";

abstract contract RewardEngine is OwnableUpgradeable, IRewardEngine, IStorageProof, IStoragePool {
    StorageToken public token;
    IStorageProof public storageProof;
    IStoragePool public storagePool;

    uint256 public constant INITIAL_MINING_REWARDS_PER_YEAR = 120_000_000 ether;
    uint256 public constant HALVING_PERIOD = 2 * 365 * 24 * 60 * 60; // 2 years in seconds
    uint256 public constant LARGE_PROVIDER_THRESHOLD = 2 ether; // 2TB in bytes
    uint256 public constant LARGE_PROVIDER_MULTIPLIER = 2;

    uint256 public miningRewardsPerYear;
    uint256 public lastHalvingTime;
    
    mapping(address => uint256) public lastRewardDistributionTime;
    mapping(address => uint8) public reputationScores;
    mapping(address => FailedVerification[]) public failedVerifications;

    struct FailedVerification {
        string cid;
        uint256 timestamp;
    }

    event RewardsDistributed(
        string indexed cid, 
        address indexed storer, 
        uint256 miningReward, 
        uint256 storageReward
    );
    event ReputationUpdated(address indexed storer, uint8 newScore);
    event MiningRewardsUpdated(uint256 newYearlyReward);

    function initialize(
        address _token, 
        address initialOwner, 
        address _storageProof, 
        address _storagePool
    ) public reinitializer(1) {
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        token = StorageToken(_token);
        storageProof = IStorageProof(_storageProof);
        storagePool = IStoragePool(_storagePool);
        miningRewardsPerYear = INITIAL_MINING_REWARDS_PER_YEAR;
        lastHalvingTime = block.timestamp;
    }

    function distributeRewards(
        string[] memory cids, 
        uint256 totalStoredSize, 
        address storer, 
        uint32 poolId
    ) external override onlyOwner {
        require(storer != address(0), "Invalid storer address");
        
        // Calculate mining rewards
        uint256 miningReward = _calculateMiningReward(storer);
        
        // Calculate storage rewards
        uint256 storageReward = _calculateStorageReward(
            totalStoredSize,
            storer,
            poolId
        );
        
        uint256 totalReward = miningReward + storageReward;
        require(token.balanceOf(address(this)) >= totalReward, "Insufficient balance");
        
        // Update last distribution time
        lastRewardDistributionTime[storer] = block.timestamp;
        
        // Transfer rewards
        bool success = token.transfer(storer, totalReward);
        require(success, "Token transfer failed");
        
        emit RewardsDistributed(cids[0], storer, miningReward, storageReward);
    }

    function _calculateMiningReward(
        address storer
    ) internal view returns (uint256) {
        // Verify storer is a member of any pool
        require(storagePool.isMemberOfAnyPool(storer), "Not a pool member");

        // Check if halving should occur
        uint256 currentPeriod = (block.timestamp - lastHalvingTime) / HALVING_PERIOD;
        uint256 effectiveYearlyReward = miningRewardsPerYear >> currentPeriod;

        // Get total members across all pools
        uint256 totalMembers = storagePool.getTotalMembers();
        require(totalMembers > 0, "No active members");

        // Calculate daily reward per member
        uint256 dailyReward = effectiveYearlyReward / 365;
        uint256 rewardPerMember = dailyReward / totalMembers;

        return rewardPerMember;
    }

    function _calculateStorageReward(
        uint256 totalStoredSize,
        address storer,
        uint32 poolId
    ) internal view returns (uint256) {
        uint256 storageCostPerTBYear = storagePool.getStorageCost(poolId);
        require(storageCostPerTBYear > 0, "Invalid storage cost");
        
        // Calculate time since last distribution
        uint256 lastDistribution = lastRewardDistributionTime[storer];
        uint256 timeElapsed = lastDistribution > 0 ? 
            block.timestamp - lastDistribution : 
            1 days;
        
        // Calculate daily reward per TB
        uint256 dailyRewardPerTB = storageCostPerTBYear / 365;
        
        // Convert totalStoredSize to TB and calculate reward
        uint256 storedTB = totalStoredSize / 1 ether; // Assuming 1 ether = 1TB
        return (dailyRewardPerTB * storedTB * timeElapsed) / 1 days;
    }

    function setMiningRewardsPerYear(uint256 newYearlyReward) external onlyOwner {
        require(newYearlyReward > 0, "Invalid reward amount");
        miningRewardsPerYear = newYearlyReward;
        lastHalvingTime = block.timestamp;
        emit MiningRewardsUpdated(newYearlyReward);
    }
}
