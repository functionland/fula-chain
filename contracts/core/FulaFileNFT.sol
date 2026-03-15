// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";
import "../governance/NftGovernanceModule.sol";
import "../governance/interfaces/IFulaFileNFT.sol";
import "./libraries/MetaTxLib.sol";

/// @title FulaFileNFT
/// @notice ERC1155 NFT contract that accepts FULA (StorageToken) as payment for minting.
/// @dev Inherits NftGovernanceModule for UUPS upgradeability + lightweight governance.
///      Locks FULA per mint; burning releases FULA to the token's original creator (not the burner).
///      Tokens are organized by creator events/categories with paginated queries.
///      Supports gasless (meta-tx) claims on Base via creator-sponsored gas deposits.
contract FulaFileNFT is
    NftGovernanceModule,
    ERC1155Upgradeable,
    ERC1155SupplyUpgradeable,
    IERC2981,
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
    uint96 public constant MAX_ROYALTY_BPS = 10000; // 100% (basis points)

    // ========================================================================
    // STATE
    // ========================================================================

    IERC20 public storageToken;
    uint256 private _nextTokenId;
    string private _baseUri;
    uint256 public totalLockedFula;

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

    /// @dev Per-token royalty in basis points (e.g. 250 = 2.5%). Receiver is always the creator.
    mapping(uint256 => uint96) private _tokenRoyaltyBps;

    /// @dev Gas deposits for meta-tx claims (claimKey => ETH deposited by creator)
    mapping(bytes32 => uint256) public claimGasDeposits;
    /// @dev Replay-protection nonces for meta-tx signers
    mapping(address => uint256) public metaNonces;
    /// @dev Minimum ETH deposit required for gas-sponsored claims (0 = no minimum)
    uint256 public minGasDeposit;

    uint256[36] private __gap;

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
    }

    // ========================================================================
    // MINTING
    // ========================================================================

    function mintWithFula(
        string calldata eventName,
        string calldata metadataCid,
        uint256 fulaPerNft,
        uint256 count,
        uint96 royaltyBps
    ) external whenNotPaused nonReentrant returns (uint256 firstTokenId) {
        if (count == 0) revert ZeroAmount();
        if (count > MAX_MINT_COUNT) revert ExceedsMaxMintCount(count, MAX_MINT_COUNT);
        if (royaltyBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(royaltyBps, MAX_ROYALTY_BPS);

        uint256 cidLen = bytes(metadataCid).length;
        if (cidLen == 0 || cidLen > MAX_CID_LENGTH) revert InvalidCidLength();

        uint256 eventNameLen = bytes(eventName).length;
        if (eventNameLen == 0) revert EventNameEmpty();
        if (eventNameLen > MAX_EVENT_NAME_LENGTH) revert EventNameTooLong(eventNameLen, MAX_EVENT_NAME_LENGTH);

        uint256 totalFula = fulaPerNft * count;
        if (totalFula > 0) {
            totalLockedFula += totalFula; // CEI: update state before external call
            storageToken.safeTransferFrom(msg.sender, address(this), totalFula);
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

        if (royaltyBps > 0) {
            _tokenRoyaltyBps[firstTokenId] = royaltyBps;
        }

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
        uint256 expiresAt,
        bytes32 claimKey
    ) external payable whenNotPaused nonReentrant {
        if (expiresAt <= block.timestamp) revert InvalidExpiryTime(expiresAt);
        uint256 maxExpiry = block.timestamp + MAX_CLAIM_DURATION;
        if (expiresAt > maxExpiry) revert ExpiryTooFar(expiresAt, maxExpiry);
        if (balanceOf(msg.sender, tokenId) == 0) {
            revert InsufficientBalance(0, 1);
        }
        if (tokenInfo[tokenId].creator == address(0)) revert InvalidTokenId(tokenId);
        if (claimOffers[claimKey].sender != address(0)) revert ClaimKeyExists();

        claimOffers[claimKey] = ClaimOffer({
            tokenId: tokenId,
            sender: msg.sender,
            claimer: claimer,
            expiresAt: expiresAt,
            status: 0
        });

        _safeTransferFrom(msg.sender, address(this), tokenId, 1, "");

        // Store gas deposit if ETH sent (for gasless meta-tx claims on Base)
        if (msg.value > 0) {
            if (msg.value < minGasDeposit) revert DepositTooLow(msg.value, minGasDeposit);
            claimGasDeposits[claimKey] = msg.value;
            emit GasDeposited(claimKey, msg.value);
        }

        emit ClaimOfferCreated(claimKey, tokenId, msg.sender, claimer, expiresAt);
    }

    function claimNFT(bytes32 secret) external whenNotPaused nonReentrant {
        bytes32 claimKey = keccak256(abi.encodePacked(secret));
        ClaimOffer storage offer = claimOffers[claimKey];
        if (offer.sender == address(0)) revert ClaimNotFound(claimKey);
        if (offer.status == 1) revert AlreadyClaimed(claimKey);
        if (offer.status == 2) revert OfferCancelled(claimKey);
        if (block.timestamp > offer.expiresAt) revert ClaimExpired(claimKey);
        if (offer.claimer != address(0) && msg.sender != offer.claimer) {
            revert NotClaimRecipient(msg.sender, offer.claimer);
        }

        offer.status = 1;
        offer.claimer = msg.sender; // Store actual claimer address

        _safeTransferFrom(address(this), msg.sender, offer.tokenId, 1, "");

        emit NftClaimed(claimKey, offer.tokenId, msg.sender);
    }

    // ========================================================================
    // META-TX GASLESS FUNCTIONS (creator-sponsored gas on Base)
    // ========================================================================

    /// @notice Claim an NFT via meta-transaction (gasless for the claimer).
    /// @dev The claimer signs an EIP-712 message over claimKey; a relayer submits the secret and is reimbursed.
    function claimNFTMeta(
        bytes32 secret,
        address claimer,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        bytes32 claimKey = keccak256(abi.encodePacked(secret));
        MetaTxLib.verifyClaimSig(claimKey, claimer, deadline, nonce, sig, metaNonces[claimer]);
        metaNonces[claimer]++;
        emit MetaNonceUsed(claimer, metaNonces[claimer]);

        ClaimOffer storage offer = claimOffers[claimKey];
        if (offer.sender == address(0)) revert ClaimNotFound(claimKey);
        if (offer.status == 1) revert AlreadyClaimed(claimKey);
        if (offer.status == 2) revert OfferCancelled(claimKey);
        if (block.timestamp > offer.expiresAt) revert ClaimExpired(claimKey);
        if (offer.claimer != address(0) && claimer != offer.claimer) {
            revert NotClaimRecipient(claimer, offer.claimer);
        }

        offer.status = 1;
        offer.claimer = claimer;
        _safeTransferFrom(address(this), claimer, offer.tokenId, 1, "");
        emit NftClaimed(claimKey, offer.tokenId, claimer);

        _reimburseRelayer(claimKey);
    }

    /// @notice Burn an NFT via meta-transaction (gasless for the holder).
    function burnMeta(
        bytes32 claimKey,
        uint256 tokenId,
        uint256 amount,
        address holder,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        MetaTxLib.verifyBurnSig(claimKey, tokenId, amount, holder, deadline, nonce, sig, metaNonces[holder]);
        metaNonces[holder]++;
        emit MetaNonceUsed(holder, metaNonces[holder]);

        _burn(holder, tokenId, amount);

        TokenInfo storage info = tokenInfo[tokenId];
        uint256 fulaToRelease = info.fulaPerNft * amount;
        if (fulaToRelease > 0) {
            totalLockedFula -= fulaToRelease;
            storageToken.safeTransfer(info.creator, fulaToRelease);
        }
        emit NftBurned(tokenId, holder, amount, fulaToRelease, info.creator);

        _reimburseRelayer(claimKey);
    }

    /// @notice Transfer an NFT back to its creator via meta-transaction (gasless for the holder).
    function transferBackMeta(
        bytes32 claimKey,
        uint256 tokenId,
        address holder,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig
    ) external whenNotPaused nonReentrant {
        MetaTxLib.verifyTransferBackSig(claimKey, tokenId, holder, deadline, nonce, sig, metaNonces[holder]);
        metaNonces[holder]++;
        emit MetaNonceUsed(holder, metaNonces[holder]);

        address creator = tokenInfo[tokenId].creator;
        if (creator == address(0)) revert InvalidTokenId(tokenId);

        _safeTransferFrom(holder, creator, tokenId, 1, "");
        emit NftTransferredBack(claimKey, tokenId, holder, creator);

        _reimburseRelayer(claimKey);
    }

    /// @notice Withdraw unused gas deposit after a claim offer is no longer active.
    function withdrawGasDeposit(bytes32 linkHash) external nonReentrant {
        ClaimOffer storage offer = claimOffers[linkHash];
        if (msg.sender != offer.sender) revert NotAuthorizedToCancel(msg.sender);
        if (offer.status == 0) revert OfferStillActive(linkHash);
        uint256 deposit = claimGasDeposits[linkHash];
        if (deposit == 0) revert ZeroAmount();
        claimGasDeposits[linkHash] = 0;
        (bool ok,) = msg.sender.call{value: deposit}("");
        if (!ok) revert ReimbursementFailed();
        emit GasWithdrawn(linkHash, msg.sender, deposit);
    }

    /// @dev Reimburse the relay caller from the gas deposit for a claim link.
    /// @dev Safe: all callers are nonReentrant. CEI ordering also maintained.
    function _reimburseRelayer(bytes32 linkHash) internal {
        uint256 deposit = claimGasDeposits[linkHash];
        if (deposit == 0) return;
        uint256 gp = tx.gasprice;
        if (block.basefee > 0 && gp > 2 * block.basefee) gp = 2 * block.basefee;
        uint256 r = 150_000 * gp;
        if (r > deposit) r = deposit;
        claimGasDeposits[linkHash] -= r;
        (bool ok,) = msg.sender.call{value: r}("");
        if (!ok) revert ReimbursementFailed();
        emit GasReimbursed(linkHash, msg.sender, r);
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
    function name() external pure returns (string memory) {
        return "FulaFileNFT";
    }

    /// @notice Contract-level symbol for block explorers.
    function symbol() external pure returns (string memory) {
        return "FFNFT";
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        TokenInfo storage info = tokenInfo[tokenId];
        if (info.creator == address(0)) revert InvalidTokenId(tokenId);
        return string(abi.encodePacked(_baseUri, info.metadataCid));
    }

    /// @notice ERC-2981 royalty info. Royalty receiver is always the token creator.
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        override
        returns (address receiver, uint256 royaltyAmount)
    {
        TokenInfo storage info = tokenInfo[tokenId];
        if (info.creator == address(0)) revert InvalidTokenId(tokenId);
        uint96 bps = _tokenRoyaltyBps[tokenId];
        receiver = info.creator;
        royaltyAmount = (salePrice * bps) / 10000;
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

    function setMinGasDeposit(uint256 newMin) external onlyRole(ProposalTypes.ADMIN_ROLE) {
        minGasDeposit = newMin;
        emit MinGasDepositUpdated(newMin);
    }

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
        onlyRole(ProposalTypes.ADMIN_ROLE)
        override
    {
        if (!_checkUpgrade(newImplementation)) revert UpgradeNotAuthorized();
    }

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
        override(ERC1155Upgradeable, AccessControlUpgradeable, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC2981).interfaceId ||
            super.supportsInterface(interfaceId);
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

    /// @notice Reject batch transfers of external ERC1155 tokens.
    function onERC1155BatchReceived(
        address, address, uint256[] memory, uint256[] memory, bytes memory
    ) public pure returns (bytes4) {
        revert ExternalTokensRejected();
    }

}
