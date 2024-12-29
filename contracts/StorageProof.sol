// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./interfaces/IStorageProof.sol";
import "./StorageToken.sol";
import "./interfaces/IRewardEngine.sol";
import "./interfaces/IStoragePool.sol";

abstract contract StorageProof is IStorageProof, IStoragePool, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable, AccessControlUpgradeable {
    uint256 public constant IMPLEMENTATION_VERSION = 1;
    bytes32 public constant PROOF_MANAGER_ROLE = keccak256("PROOF_MANAGER_ROLE");
    StorageToken public token;
    IRewardEngine public rewardEngine;
    
    mapping(uint256 => mapping(string => Claim)) public claims;
    mapping(string => mapping(address => UploadRequest)) public uploads;
    mapping(string => RemovalRequest) public removals;
    mapping(address => uint256) public TotalStorage; // Total storage quota for each user
    mapping(address => uint256) public UsedStorage;  // Used storage for each user
    mapping(string => address[]) public cidUploaders; // Maps a CID to its list of uploaders
    mapping(string => mapping(address => bool)) public cidCountedForUploader; // Tracks if a CID is counted towards an uploader's UsedStorage
    mapping(string => mapping(address => Challenge)) public challenges; // Tracks challenges issued for CIDs
    mapping(uint256 => IStoragePool.Pool) public pools;

    string[] public toBeRemovedCIDs; // List of CIDs marked for removal due to insufficient quota
    uint256 public miningRewardPerDay;
    uint256 public lastRewardDistribution;
    uint256 private constant MAX_TIME_DRIFT = 1 hours;

    function initialize(address _token, address initialOwner, address _rewardEngine) public reinitializer(1) {
        require(initialOwner != address(0), "Invalid owner address");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner); // Owner has admin role
        _grantRole(PROOF_MANAGER_ROLE, initialOwner); // Assign initial roles
        token = StorageToken(_token);
        lastRewardDistribution = block.timestamp;
        rewardEngine = IRewardEngine(_rewardEngine);
    }

    function emergencyPauseProof() external onlyOwner {
        _pause();
        emit EmergencyAction("Contract paused", block.timestamp);
    }

    function emergencyUnpauseProof() external onlyOwner {
        _unpause();
        emit EmergencyAction("Contract unpaused", block.timestamp);
    }

    modifier whenInitialized() {
        require(address(token) != address(0), "Contract not initialized");
        _;
    }

    modifier validateCIDs(string[] memory cids) {
        require(cids.length > 0, "Empty CID array");
        require(cids.length <= 300, "Too many CIDs");
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

    function getUploadRequest(string memory cid, address uploader) external view returns (UploadRequest memory) {
        return uploads[cid][uploader];
    }

    function isValidTimestamp(uint256 timestamp) internal view returns (bool) {
        return timestamp <= block.timestamp + MAX_TIME_DRIFT;
    }

    // - Get storage implementation
    function reserveStorageSpace(uint256 amount) external {
        require(amount > 0, "Invalid amount");
        require(msg.sender != address(0), "Invalid sender");
        require(token.balanceOf(msg.sender) >= amount, "Insufficient balance");
        require(token.transferFrom(msg.sender, address(this), amount), "Transfer failed");
    }

    // This method allows a user to submit a request to upload files to a data pool.
    // It validates the user's storage quota, ensures no duplicate upload requests or existing uploads for the same CID,
    // and calculates or uses the provided upload size while associating CIDs with their holders.
    function submitUploadRequest(
        string[] memory cids,
        uint8 replicationFactor,
        uint32 poolId,
        uint256 reportedSize // File size in bytes, provided by the user or 0 to estimate
    ) external whenNotPaused validateCIDs(cids) {
        require(replicationFactor > 0 && replicationFactor <= 12, "Invalid replication factor");
        require(cids.length > 0, "Empty CID array");

        // Calculate total file size: use provided `reportedSize` or estimate based on number of CIDs
        uint256 totalEstimatedSize = reportedSize > 0 ? reportedSize : cids.length * 256; // Assume each CID represents 256 bytes if size is not provided

        // Validate user's storage quota (TotalStorage - UsedStorage should accommodate estimated size)
        require(UsedStorage[msg.sender] + totalEstimatedSize <= TotalStorage[msg.sender], "Insufficient storage quota");

        for (uint256 i = 0; i < cids.length; i++) {
            string memory cid = cids[i];

            // If the CID is marked for removal, remove it from the removal list
            if (removals[cid].timestamp > 0) {
                delete removals[cid];
            }

            // Ensure no duplicate upload requests or existing uploads for the same CID
            require(uploads[cid][msg.sender].timestamp == 0, "Duplicate upload request");
            require(claims[poolId][cid].timestamp == 0, "CID already uploaded");

            // Create a new upload request for this CID
            UploadRequest storage request = uploads[cid][msg.sender];
            request.replicationFactor = replicationFactor;
            request.poolId = poolId;
            request.uploader = msg.sender;
            request.timestamp = block.timestamp;
            request.uploadSize = totalEstimatedSize; // Store calculated or provided file size

            // Associate this CID with the uploader (msg.sender)
            cidUploaders[cid].push(msg.sender);

            emit UploadRequested(cid, msg.sender, poolId);
        }
    }

    // This method allows a user to submit claims for multiple CIDs.
    // It validates uploader storage quotas, updates UsedStorage for uploaders, and handles edge cases like insufficient quota.
    function submitClaim(
        string[] memory cids,
        uint32 poolId,
        uint256[] memory actualSizes // Actual sizes of each CID in bytes
    ) external nonReentrant whenNotPaused validateCIDs(cids) {
        require(cids.length > 0, "No CIDs provided");
        require(cids.length == actualSizes.length, "Mismatched CIDs and sizes");

        // Ensure the claim submitter is a current member of the pool
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0, "Not a member of the pool");

        uint256 cidsLength = cids.length;

        // Check if there are any unresolved challenges for the storer
        for (uint256 i = 0; i < cidsLength; i++) {
            string memory cid = cids[i];
            if (challenges[cid][msg.sender].challengeTimestamp > 0) {
                require(
                    block.timestamp <= challenges[cid][msg.sender].challengeTimestamp + pool.maxChallengeResponsePeriod,
                    "Unresolved challenge exists"
                );
            }
        }

        for (uint256 i = 0; i < cidsLength; i++) {
            string memory cid = cids[i];
            uint256 size = actualSizes[i];
            require(size > 0, "Invalid CID size");

            // Check if the CID is marked for removal
            if (removals[cid].timestamp > 0) {
                continue; // Skip processing this CID
            }

            // Retrieve all uploaders for this CID
            address[] storage uploaders = cidUploaders[cid];
            bool quotaSatisfied = false;

            for (uint256 j = 0; j < uploaders.length; j++) {
                address uploader = uploaders[j];

                // Check if the CID is already counted towards this uploader's UsedStorage
                if (!cidCountedForUploader[cid][uploader]) {
                    // Ensure uploader has enough available quota
                    if (UsedStorage[uploader] + size <= TotalStorage[uploader]) {
                        // Update UsedStorage for this uploader
                        UsedStorage[uploader] += size;
                        cidCountedForUploader[cid][uploader] = true;
                        quotaSatisfied = true;
                    }
                } else {
                    quotaSatisfied = true; // Already counted towards this uploader's quota
                }
            }

            // If no uploader has sufficient quota, mark the CID for removal
            if (!quotaSatisfied) {
                removals[cid] = RemovalRequest({
                    cids: new string[](1),
                    uploader: address(0), // No specific uploader responsible
                    poolId: poolId,
                    timestamp: block.timestamp
                });
                removals[cid].cids[0] = cid;
                continue;
            }

            // Store claim details for the storer (claim submitter)
            Claim storage claim = claims[poolId][cid];
            claim.cid = cid;
            claim.timestamp = uint40(block.timestamp);
            claim.storer = msg.sender;
            claim.poolId = poolId;

            emit ClaimSubmitted(cid, msg.sender, poolId);

            // Distribute rewards via RewardEngine after storing the claim
            rewardEngine.distributeRewards(cid, msg.sender, poolId);
        }

        emit ClaimBatchProcessed(poolId, msg.sender, cidsLength);
    }

    // This method issues a challenge to verify that a storer is actually storing a CID.
    function submitChallenge(string memory cid) external onlyRole(PROOF_MANAGER_ROLE) {
        require(bytes(cid).length > 0, "Invalid CID");

        address[] memory storers = cidUploaders[cid];
        require(storers.length > 0, "No storers found for this CID");

        // Generate a random byte range for the challenge
        uint256 byteRangeStart = uint256(keccak256(abi.encodePacked(block.timestamp, cid))) % 1024;
        uint256 byteRangeEnd = byteRangeStart + 256;

        for (uint256 i = 0; i < storers.length; i++) {
            address storer = storers[i];

            challenges[cid][storer] = Challenge({
                challengeTimestamp: block.timestamp,
                byteRangeStart: byteRangeStart,
                byteRangeEnd: byteRangeEnd,
                storer: storer
            });

            emit ChallengeIssued(cid, storer, byteRangeStart, byteRangeEnd);
        }
    }

    // This method allows a storer to submit proof in response to a challenge.
    function submitProof(
        string memory cid,
        uint32 poolId,
        bytes32 proofHash // Cryptographic hash of the challenged data
    ) external nonReentrant whenNotPaused validateCID(cid) {
        // Ensure the claim submitter is a current member of the pool
        Pool storage pool = pools[poolId];
        require(pool.members[msg.sender].joinDate > 0, "Not a member of the pool");

        Challenge storage challenge = challenges[cid][msg.sender];
        
        require(challenge.challengeTimestamp > 0, "No active challenge");
        require(block.timestamp <= challenge.challengeTimestamp + 7 days, "Challenge expired");

        // Verify proof by comparing with expected hash derived from the challenge details
        bytes32 expectedHash = keccak256(abi.encodePacked(cid, challenge.byteRangeStart));
        if (proofHash != expectedHash) {
            // Penalize the storer for failing the verification
            pool.members[msg.sender].reputationScore -= pool.members[msg.sender].reputationScore > 0 ? 1 : 0;
            emit VerificationFailed(msg.sender, cid);
            
            return; // Exit without further processing
        }

        // Clear the challenge after successful proof submission
        delete challenges[cid][msg.sender];

        // Distribute rewards via RewardEngine module
        rewardEngine.penalizeStorer(cid, msg.sender);

        emit ProofSubmitted(cid, msg.sender);
    }

    // This method removes uploads for CIDs marked for removal.
    // It ensures proper cleanup of associated data and emits an event.
    function removeUpload(
        string[] memory cids,
        uint32 poolId
    ) external validateCIDs(cids) {
        require(cids.length > 0, "Empty CID array");

        for (uint256 i = 0; i < cids.length; i++) {
            string memory cid = cids[i];

            // Ensure the caller has permission to remove the upload or it is marked for removal
            require(
                uploads[cid][msg.sender].uploader == msg.sender || removals[cid].timestamp > 0,
                "Not authorized to remove"
            );

            // Remove from uploads mapping
            delete uploads[cid][msg.sender];

            // Remove from cidUploaders list
            address[] storage uploaders = cidUploaders[cid];
            for (uint256 j = 0; j < uploaders.length; j++) {
                if (uploaders[j] == msg.sender) {
                    uploaders[j] = uploaders[uploaders.length - 1];
                    uploaders.pop();
                    break;
                }
            }

            // Clear removal request if it exists
            if (removals[cid].timestamp > 0) {
                delete removals[cid];
            }

            emit RemovalRequested(new string[](1), msg.sender, poolId);
        }
    }


    function isRemoved(string memory cid) public view returns (bool) {
        return removals[cid].timestamp > 0;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}
