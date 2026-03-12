// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../governance/GovernanceModule.sol";
import "../governance/interfaces/IFulaFileNFT.sol";

/// @title FulaFileNFT
/// @notice ERC1155 NFT contract that accepts FULA (StorageToken) as payment for minting.
/// @dev Inherits GovernanceModule for UUPS upgradeability + governance proposal system.
///      Locks FULA per mint; burning releases FULA to the token's original creator (not the burner).
///      Tokens are organized by creator events/categories with paginated queries.
contract FulaFileNFT is
    GovernanceModule,
    ERC1155Upgradeable,
    ERC1155SupplyUpgradeable,
    IFulaFileNFT
{
    using SafeERC20 for IERC20;

    // ========================================================================
    // CONSTANTS
    // ========================================================================

    uint256 public constant MAX_MINT_COUNT = 1000;
    uint256 public constant MAX_CLAIM_DURATION = 365 days;
    uint256 public constant MAX_CID_LENGTH = 256;
    uint256 public constant MAX_EVENT_NAME_LENGTH = 128;

    // ========================================================================
    // STATE
    // ========================================================================

    IERC20 public storageToken;
    uint256 private _nextTokenId;
    string private _baseUri;
    uint256 public totalLockedFula;
    uint256 private _claimNonce;

    struct TokenInfo {
        address creator;
        string metadataCid;
        string eventName;
        uint256 fulaPerNft;
        uint256 initialMintCount;
    }
    mapping(uint256 => TokenInfo) public tokenInfo;

    /// @dev status: 0=active, 1=claimed, 2=cancelled
    struct ClaimOffer {
        uint256 tokenId;
        address sender;
        address claimer;
        uint256 expiresAt;
        uint8 status;
    }
    mapping(bytes32 => ClaimOffer) public claimOffers;

    mapping(address => string[]) private _creatorEvents;
    mapping(address => mapping(bytes32 => bool)) private _eventCreated;
    mapping(address => mapping(bytes32 => uint256[])) private _eventTokenIds;

    uint256[40] private __gap;

    // ========================================================================
    // INITIALIZER
    // ========================================================================

    function initialize(
        address initialOwner,
        address initialAdmin,
        address _storageToken,
        string memory baseUri
    ) public reinitializer(1) {
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();
        if (_storageToken == address(0)) revert InvalidAddress();

        __ERC1155_init(baseUri);
        __GovernanceModule_init(initialOwner, initialAdmin);

        storageToken = IERC20(_storageToken);
        _baseUri = baseUri;
        _nextTokenId = 1;
        proposalCount = 0;
    }

    // ========================================================================
    // MINTING
    // ========================================================================

    function mintWithFula(
        string calldata eventName,
        string calldata metadataCid,
        uint256 fulaPerNft,
        uint256 count
    ) external whenNotPaused nonReentrant returns (uint256 firstTokenId) {
        if (count == 0) revert ZeroAmount();
        if (count > MAX_MINT_COUNT) revert ExceedsMaxMintCount(count, MAX_MINT_COUNT);

        uint256 cidLen = bytes(metadataCid).length;
        if (cidLen == 0 || cidLen > MAX_CID_LENGTH) revert InvalidCidLength();

        uint256 eventNameLen = bytes(eventName).length;
        if (eventNameLen == 0) revert EventNameEmpty();
        if (eventNameLen > MAX_EVENT_NAME_LENGTH) revert EventNameTooLong(eventNameLen, MAX_EVENT_NAME_LENGTH);

        uint256 totalFula = fulaPerNft * count;
        if (totalFula > 0) {
            storageToken.safeTransferFrom(msg.sender, address(this), totalFula);
            totalLockedFula += totalFula;
        }

        firstTokenId = _nextTokenId;
        _nextTokenId++;

        tokenInfo[firstTokenId] = TokenInfo({
            creator: msg.sender,
            metadataCid: metadataCid,
            eventName: eventName,
            fulaPerNft: fulaPerNft,
            initialMintCount: count
        });

        _mint(msg.sender, firstTokenId, count, "");

        bytes32 eventKey = keccak256(bytes(eventName));
        if (!_eventCreated[msg.sender][eventKey]) {
            _eventCreated[msg.sender][eventKey] = true;
            _creatorEvents[msg.sender].push(eventName);
        }
        _eventTokenIds[msg.sender][eventKey].push(firstTokenId);

        emit NftMinted(msg.sender, firstTokenId, count, metadataCid, fulaPerNft, eventName);
    }

    // ========================================================================
    // CLAIM OFFERS
    // ========================================================================

    function createClaimOffer(
        uint256 tokenId,
        address claimer,
        uint256 expiresAt
    ) external whenNotPaused nonReentrant returns (bytes32 linkHash) {
        if (expiresAt <= block.timestamp) revert InvalidExpiryTime(expiresAt);
        uint256 maxExpiry = block.timestamp + MAX_CLAIM_DURATION;
        if (expiresAt > maxExpiry) revert ExpiryTooFar(expiresAt, maxExpiry);
        if (balanceOf(msg.sender, tokenId) == 0) {
            revert InsufficientBalance(0, 1);
        }
        if (tokenInfo[tokenId].creator == address(0)) revert InvalidTokenId(tokenId);

        _claimNonce++;
        linkHash = keccak256(abi.encodePacked(tokenId, msg.sender, claimer, expiresAt, _claimNonce));

        claimOffers[linkHash] = ClaimOffer({
            tokenId: tokenId,
            sender: msg.sender,
            claimer: claimer,
            expiresAt: expiresAt,
            status: 0
        });

        _safeTransferFrom(msg.sender, address(this), tokenId, 1, "");

        emit ClaimOfferCreated(linkHash, tokenId, msg.sender, claimer, expiresAt);
    }

    function claimNFT(bytes32 linkHash) external whenNotPaused nonReentrant {
        ClaimOffer storage offer = claimOffers[linkHash];
        if (offer.sender == address(0)) revert ClaimNotFound(linkHash);
        if (offer.status == 1) revert AlreadyClaimed(linkHash);
        if (offer.status == 2) revert OfferCancelled(linkHash);
        if (block.timestamp > offer.expiresAt) revert ClaimExpired(linkHash);
        if (offer.claimer != address(0) && msg.sender != offer.claimer) {
            revert NotClaimRecipient(msg.sender, offer.claimer);
        }

        offer.status = 1;
        offer.claimer = msg.sender; // Store actual claimer address

        _safeTransferFrom(address(this), msg.sender, offer.tokenId, 1, "");

        emit NftClaimed(linkHash, offer.tokenId, msg.sender);
    }

    // ========================================================================
    // BURN (releases locked FULA to the CREATOR, not the burner)
    // ========================================================================

    /// @notice Burn NFTs and release locked FULA to the token's original creator.
    function burn(address account, uint256 id, uint256 value)
        external
        whenNotPaused
        nonReentrant
    {
        if (account != msg.sender && !isApprovedForAll(account, msg.sender)) {
            revert ERC1155MissingApprovalForAll(msg.sender, account);
        }
        _burn(account, id, value);

        TokenInfo storage info = tokenInfo[id];
        uint256 fulaToRelease = info.fulaPerNft * value;
        if (fulaToRelease > 0) {
            totalLockedFula -= fulaToRelease;
            storageToken.safeTransfer(info.creator, fulaToRelease);
        }
        emit NftBurned(id, account, value, fulaToRelease, info.creator);
    }

    // ========================================================================
    // READ FUNCTIONS
    // ========================================================================

    function getTokenInfo(uint256 tokenId) external view returns (
        address creator,
        string memory metadataCid,
        string memory eventName,
        uint256 fulaPerNft,
        uint256 initialMintCount
    ) {
        TokenInfo storage info = tokenInfo[tokenId];
        if (info.creator == address(0)) revert InvalidTokenId(tokenId);
        return (info.creator, info.metadataCid, info.eventName, info.fulaPerNft, info.initialMintCount);
    }

    function getClaimOffer(bytes32 linkHash) external view returns (
        uint256 tokenId,
        address sender,
        address claimer,
        uint256 expiresAt,
        uint8 status
    ) {
        ClaimOffer storage offer = claimOffers[linkHash];
        return (offer.tokenId, offer.sender, offer.claimer, offer.expiresAt, offer.status);
    }

    function getCreatorEvents(address creator) external view returns (string[] memory) {
        return _creatorEvents[creator];
    }

    function getEventTokens(
        address creator,
        string calldata eventName,
        uint256 offset,
        uint256 limit
    ) external view returns (uint256[] memory) {
        bytes32 eventKey = keccak256(bytes(eventName));
        uint256[] storage tokens = _eventTokenIds[creator][eventKey];
        uint256 total = tokens.length;
        if (offset >= total) return new uint256[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 resultLen = end - offset;
        uint256[] memory result = new uint256[](resultLen);
        for (uint256 i = 0; i < resultLen;) {
            result[i] = tokens[offset + i];
            unchecked { i++; }
        }
        return result;
    }

    function getEventTokenCount(
        address creator,
        string calldata eventName
    ) external view returns (uint256) {
        bytes32 eventKey = keccak256(bytes(eventName));
        return _eventTokenIds[creator][eventKey].length;
    }

    /// @notice Contract-level name for block explorers (ERC1155 has no standard name).
    function name() public pure returns (string memory) {
        return "FulaFileNFT";
    }

    /// @notice Contract-level symbol for block explorers.
    function symbol() public pure returns (string memory) {
        return "FFNFT";
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        TokenInfo storage info = tokenInfo[tokenId];
        if (info.creator == address(0)) revert InvalidTokenId(tokenId);
        return string(abi.encodePacked(_baseUri, info.metadataCid));
    }

    // ========================================================================
    // CLAIM OFFER MANAGEMENT
    // ========================================================================

    function cancelClaimOffer(bytes32 linkHash) external whenNotPaused nonReentrant {
        ClaimOffer storage offer = claimOffers[linkHash];
        if (offer.sender == address(0)) revert ClaimNotFound(linkHash);
        if (offer.status != 0) revert OfferNotActive(linkHash);

        bool isAdmin = hasRole(ProposalTypes.ADMIN_ROLE, msg.sender);
        bool isSender = msg.sender == offer.sender;
        bool isExpired = block.timestamp > offer.expiresAt;

        if (!isAdmin && !isSender && !isExpired) {
            revert NotAuthorizedToCancel(msg.sender);
        }

        offer.status = 2;

        _safeTransferFrom(address(this), offer.sender, offer.tokenId, 1, "");

        emit ClaimOfferCancelled(linkHash, offer.tokenId, offer.sender, msg.sender);
    }

    // ========================================================================
    // ADMIN FUNCTIONS
    // ========================================================================

    function setBaseUri(string calldata newBaseUri) external onlyRole(ProposalTypes.ADMIN_ROLE) whenNotPaused {
        _baseUri = newBaseUri;
        emit BaseUriUpdated(newBaseUri);
    }

    function recoverERC20(
        address token,
        uint256 amount,
        address to
    ) external onlyRole(ProposalTypes.ADMIN_ROLE) whenNotPaused nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (token == address(storageToken)) {
            uint256 balance = storageToken.balanceOf(address(this));
            uint256 surplus = balance > totalLockedFula ? balance - totalLockedFula : 0;
            if (amount > surplus) revert InsufficientBalance(surplus, amount);
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ========================================================================
    // GOVERNANCE OVERRIDES
    // ========================================================================

    function _authorizeUpgrade(address newImplementation)
        internal
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        if (!_checkUpgrade(newImplementation)) revert UpgradeNotAuthorized();
    }

    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address,
        bytes32,
        uint96,
        address
    ) internal virtual override returns (bytes32) {
        revert InvalidProposalType(proposalType);
    }

    function _executeCustomProposal(bytes32) internal virtual override {}

    function _handleCustomProposalExpiry(bytes32) internal virtual override {}

    // ========================================================================
    // REQUIRED OVERRIDES
    // ========================================================================

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155Upgradeable, ERC1155SupplyUpgradeable) {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /// @notice Allow the contract to receive its own ERC1155 tokens (for claim escrow).
    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes memory
    ) public view returns (bytes4) {
        if (msg.sender != address(this)) revert ExternalTokensRejected();
        return this.onERC1155Received.selector;
    }

}
