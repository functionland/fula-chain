// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "./interfaces/IStorageProof.sol";
import "./StorageToken.sol";

contract StorageProof is IStorageProof, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    uint256 public constant IMPLEMENTATION_VERSION = 1;
    StorageToken public token;
    mapping(uint256 => mapping(string => Proof)) public proofs;
    mapping(address => mapping(string => UploadRequest)) public uploads;
    mapping(string => RemovalRequest) public removals;
    uint256 public storageCostPerTBYear;
    uint256 public miningRewardPerDay;
    uint256 public lastRewardDistribution;
    uint256 private constant MAX_TIME_DRIFT = 1 hours;

    function initialize(address _token) public reinitializer(1) {
        __Ownable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        token = StorageToken(_token);
    }

    function emergencyPause() external onlyOwner {
        _pause();
    }

    function emergencyUnpause() external onlyOwner {
        _unpause();
    }

    modifier whenInitialized() {
        require(address(token) != address(0), "Contract not initialized");
        _;
    }

    modifier validateCIDs(string[] memory cids) {
        require(cids.length > 0, "Empty CID array");
        for(uint i = 0; i < cids.length; i++) {
            // Inline the validation logic to save gas instead of calling validateCID
            require(bytes(cids[i]).length > 0, "Invalid CID");
            require(bytes(cids[i]).length <= 100, "CID too long");
        }
        _;
    }

    modifier validateCID(string memory _cid) {
        require(bytes(_cid).length > 0, "Invalid CID");
        require(bytes(_cid).length <= 512, "CID too long"); // Set appropriate max length
        _;
    }

    function isValidTimestamp(uint256 timestamp) internal view returns (bool) {
        return timestamp <= block.timestamp + MAX_TIME_DRIFT;
    }

    // - Set storage cost implementation
    function setStorageCost(uint256 costPerTBYear) external onlyOwner {
        require(costPerTBYear > 0, "Invalid cost");
        require(costPerTBYear <= type(uint256).max / 365, "Cost too high"); // Prevent overflow
        storageCostPerTBYear = costPerTBYear;
        emit StorageCostSet(costPerTBYear);
    }

    // - Get storage implementation
    function getStorage(uint256 amount) external {
        require(amount > 0, "Invalid amount");
        require(msg.sender != address(0), "Invalid sender");
        require(token.balanceOf(msg.sender) >= amount, "Insufficient balance");
        token.transferFrom(msg.sender, address(this), amount);
    }

    // - Upload requests implementation
    function submitUploadRequest(
        string[] memory cids,
        uint8 replicationFactor,
        uint32 poolId
    ) external validateCIDs(cids) {
        uint256 cidsLength = cids.length;
        require(cidsLength > 0, "Empty CID array");
        UploadRequest storage request = uploads[msg.sender][cids[0]];
        request.cids = cids;
        request.replicationFactor = replicationFactor;
        request.poolId = poolId;
        request.uploader = msg.sender;
        request.timestamp = block.timestamp;
        
        emit UploadRequested(cids, msg.sender, poolId);
    }

    // - Proof engine implementation
    function submitProof(
        string memory cid,
        uint32 poolId
    ) external nonReentrant whenNotPaused validateCID(cid) {
        require(!isRemoved(cid), "CID marked for removal");
        require(isValidTimestamp(block.timestamp), "Invalid timestamp");
        
        UploadRequest storage request = uploads[msg.sender][cid];
        require(request.timestamp > 0, "Upload request does not exist");
        require(request.currentReplications < request.replicationFactor, "Max replications reached");
        
        Proof storage proof = proofs[poolId][cid];
        proof.cid = cid;
        proof.timestamp = uint40(block.timestamp);
        proof.storer = msg.sender;
        proof.poolId = uint32(poolId);
        request.currentReplications++;
        
        uint256 tokensToRelease = storageCostPerTBYear / 365;
        require(token.transfer(msg.sender, tokensToRelease), "Token transfer failed");
        
        emit ProofSubmitted(cid, msg.sender, poolId);
        emit ProofStateUpdated(cid, msg.sender, poolId, block.timestamp, request.currentReplications);
    }

    // - Remove upload implementation
    function removeUpload(
        string[] memory cids,
        uint32 poolId
    ) external validateCIDs(cids) {
        RemovalRequest storage removal = removals[cids[0]];
        removal.cids = cids;
        removal.uploader = msg.sender;
        removal.poolId = poolId;
        removal.timestamp = block.timestamp;
        
        emit RemovalRequested(cids, msg.sender, poolId);
    }

    function isRemoved(string memory cid) public view returns (bool) {
        return removals[cid].timestamp > 0;
    }

    function _releaseTokens(string memory cid, address storer) internal {
        UploadRequest storage request = uploads[msg.sender][cid];
        require(request.timestamp > 0, "Upload request does not exist");
        
        // Calculate tokens to release based on proof period (1 day)
        uint256 tokensToRelease = storageCostPerTBYear / 365;
        
        // Transfer tokens from contract to storer
        token.transfer(storer, tokensToRelease);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}
