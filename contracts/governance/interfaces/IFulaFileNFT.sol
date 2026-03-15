// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFulaFileNFT {
    // ========================================================================
    // EVENTS
    // ========================================================================

    event NftMinted(
        address indexed creator,
        uint256 indexed firstTokenId,
        uint256 count,
        string metadataCid,
        uint256 fulaPerNft,
        string eventName
    );

    event ClaimOfferCreated(
        bytes32 indexed linkHash,
        uint256 indexed tokenId,
        address sender,
        address claimer,
        uint256 expiresAt
    );

    event NftClaimed(
        bytes32 indexed linkHash,
        uint256 indexed tokenId,
        address claimer
    );

    event ClaimOfferCancelled(
        bytes32 indexed linkHash,
        uint256 indexed tokenId,
        address sender,
        address cancelledBy
    );

    event NftBurned(
        uint256 indexed tokenId,
        address indexed burner,
        uint256 amount,
        uint256 fulaReleased,
        address creator
    );

    event BaseUriUpdated(string newBaseUri);

    event GasDeposited(bytes32 indexed linkHash, uint256 amount);
    event GasReimbursed(bytes32 indexed linkHash, address relayer, uint256 amount);
    event GasWithdrawn(bytes32 indexed linkHash, address creator, uint256 amount);
    event NftTransferredBack(bytes32 indexed linkHash, uint256 indexed tokenId, address holder, address creator);
    event MetaNonceUsed(address indexed signer, uint256 newNonce);
    event MinGasDepositUpdated(uint256 newMin);

    // ========================================================================
    // ERRORS
    // ========================================================================

    // InvalidAddress() is inherited from GovernanceModule
    error InsufficientBalance(uint256 available, uint256 required);
    error InvalidTokenId(uint256 tokenId);
    error InvalidCidLength();
    error ClaimNotFound(bytes32 linkHash);
    error ClaimExpired(bytes32 linkHash);
    error AlreadyClaimed(bytes32 linkHash);
    error OfferCancelled(bytes32 linkHash);
    error OfferNotActive(bytes32 linkHash);
    error NotClaimRecipient(address caller, address expected);
    error NotAuthorizedToCancel(address caller);
    error ZeroAmount();
    error InvalidExpiryTime(uint256 expiresAt);
    error ExpiryTooFar(uint256 expiresAt, uint256 maxExpiry);
    error ExceedsMaxMintCount(uint256 count, uint256 max);
    error EventNameTooLong(uint256 length, uint256 max);
    error EventNameEmpty();
    error RoyaltyTooHigh(uint96 royaltyBps, uint96 maxBps);
    error ExternalTokensRejected();
    error UpgradeNotAuthorized();
    error MetaTxExpired();
    error InvalidNonce();
    error InvalidMetaSignature();
    error ReimbursementFailed();
    error OfferStillActive(bytes32 linkHash);
    error DepositTooLow(uint256 sent, uint256 minimum);
    error ClaimKeyExists();
}
