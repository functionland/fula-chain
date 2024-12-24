// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./interfaces/IStorageProof.sol";
import "./StorageToken.sol";

contract StorageProof is IStorageProof, OwnableUpgradeable, UUPSUpgradeable {
    StorageToken public token;
    mapping(uint256 => mapping(string => Proof)) public proofs;
    mapping(address => mapping(string => UploadRequest)) public uploads;
    mapping(string => RemovalRequest) public removals;
    uint256 public storageCostPerTBYear;
    uint256 public miningRewardPerDay;
    uint256 public lastRewardDistribution;

    function initialize(address _token) public initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        token = StorageToken(_token);
    }

    // - Set storage cost implementation
    function setStorageCost(uint256 costPerTBYear) external onlyOwner {
        storageCostPerTBYear = costPerTBYear;
        emit StorageCostSet(costPerTBYear);
    }

    // - Get storage implementation
    function getStorage(uint256 amount) external {
        require(token.balanceOf(msg.sender) >= amount, "Insufficient balance");
        token.transferFrom(msg.sender, address(this), amount);
    }

    // - Upload requests implementation
    function submitUploadRequest(
        string[] memory cids,
        uint256 replicationFactor,
        uint256 poolId
    ) external {
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
        uint256 poolId
    ) external {
        require(!isRemoved(cid), "CID marked for removal");
        UploadRequest storage request = uploads[msg.sender][cid];
        require(request.currentReplications < request.replicationFactor, "Max replications reached");
        
        Proof storage proof = proofs[poolId][cid];
        proof.cid = cid;
        proof.timestamp = block.timestamp;
        proof.storer = msg.sender;
        proof.poolId = poolId;
        request.currentReplications++;
        
        _releaseTokens(cid, msg.sender);
        emit ProofSubmitted(cid, msg.sender, poolId);
    }

    // - Remove upload implementation
    function removeUpload(
        string[] memory cids,
        uint256 poolId
    ) external {
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
}
