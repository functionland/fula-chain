// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./StorageToken.sol";
import "./interfaces/IRewardEngine.sol";
import "./interfaces/IStorageProof.sol";
import "./interfaces/IStoragePool.sol";

abstract contract RewardEngine is OwnableUpgradeable, IRewardEngine, IStorageProof, IStoragePool {
    StorageToken public token;
    IStorageProof public storageProof;
    IStoragePool public storagePool;

    mapping(address => uint8) public reputationScores; // Reputation scores for storers (default: 500)
    mapping(address => FailedVerification[]) public failedVerifications; // Tracks failed verifications

    struct FailedVerification {
        string cid;
        uint256 timestamp;
    }

    event RewardsDistributed(string indexed cid, address indexed storer);
    event ReputationUpdated(address indexed storer, uint8 newScore);

    function initialize(address _token, address initialOwner, address _storageProof, address _storagePool) public reinitializer(1) {
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        token = StorageToken(_token);
        storageProof = IStorageProof(_storageProof);
        storagePool = IStoragePool(_storagePool); // Initialize the storagePool
    }

    function distributeRewards(string memory cid, address storer, uint32 poolId) external override onlyOwner {
        require(storer != address(0), "Invalid storer address");
        uint256 storageCostPerTBYear = storagePool.getStorageCost(poolId); // Get the storage cost from IStoragePool
        require(storageCostPerTBYear >= 0, "Invalid storage cost");
        UploadRequest memory request = storageProof.getUploadRequest(cid, msg.sender);
        require(request.timestamp > 0, "Upload request does not exist");
        require(block.timestamp >= request.timestamp, "Invalid timestamp");
        
        // Calculate tokens to release based on proof period (1 day)
        uint256 tokensToRelease = storageCostPerTBYear / 365;
        require(tokensToRelease > 0, "Invalid token release amount");
        require(token.balanceOf(address(this)) >= tokensToRelease, "Insufficient contract balance");
        // Transfer tokens from contract to storer
        bool success = token.transfer(storer, tokensToRelease);
        require(success, "Token Transfer failed");
        emit RewardsDistributed(cid, storer);
    }

    function penalizeStorer(string memory cid, address storer) external override onlyOwner {
        FailedVerification[] storage failures = failedVerifications[storer];

        // Remove old failed verifications (older than 7 days)
        uint256 i = 0;
        while (i < failures.length) {
            if (failures[i].timestamp + 7 days < block.timestamp) {
                failures[i] = failures[failures.length - 1];
                failures.pop();
            } else {
                i++;
            }
        }

        // Add the current failed verification
        failures.push(FailedVerification({
            cid: cid,
            timestamp: block.timestamp
        }));

        // Reduce reputation score by 1 (minimum score: 0)
        uint8 currentScore = reputationScores[storer];
        reputationScores[storer] = currentScore > 0 ? currentScore - 1 : 0;

        emit ReputationUpdated(storer, reputationScores[storer]);
    }
}
