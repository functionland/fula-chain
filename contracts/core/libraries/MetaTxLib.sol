// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MetaTxLib
/// @notice External library for EIP-712 meta-transaction verification.
/// @dev Deployed separately. FulaFileNFT calls via delegatecall (library keyword),
///      so this bytecode does NOT count toward FulaFileNFT's 24KB limit.
library MetaTxLib {
    using ECDSA for bytes32;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CLAIM_META_TYPEHASH = keccak256(
        "ClaimNFTMeta(bytes32 claimKey,address claimer,uint256 deadline,uint256 nonce)");
    bytes32 internal constant BURN_META_TYPEHASH = keccak256(
        "BurnMeta(bytes32 claimKey,uint256 tokenId,uint256 amount,address holder,uint256 deadline,uint256 nonce)");
    bytes32 internal constant TRANSFER_BACK_META_TYPEHASH = keccak256(
        "TransferBackMeta(bytes32 claimKey,uint256 tokenId,address holder,uint256 deadline,uint256 nonce)");

    error MetaTxExpired();
    error InvalidNonce();
    error InvalidMetaSignature();

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("FulaFileNFT"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    function verifyClaimSig(
        bytes32 claimKey,
        address claimer,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig,
        uint256 expectedNonce
    ) internal view returns (bool) {
        if (block.timestamp > deadline) revert MetaTxExpired();
        if (nonce != expectedNonce) revert InvalidNonce();
        bytes32 structHash = keccak256(abi.encode(
            CLAIM_META_TYPEHASH, claimKey, claimer, deadline, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (digest.recover(sig) != claimer) revert InvalidMetaSignature();
        return true;
    }

    function verifyBurnSig(
        bytes32 claimKey,
        uint256 tokenId,
        uint256 amount,
        address holder,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig,
        uint256 expectedNonce
    ) internal view returns (bool) {
        if (block.timestamp > deadline) revert MetaTxExpired();
        if (nonce != expectedNonce) revert InvalidNonce();
        bytes32 structHash = keccak256(abi.encode(
            BURN_META_TYPEHASH, claimKey, tokenId, amount, holder, deadline, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (digest.recover(sig) != holder) revert InvalidMetaSignature();
        return true;
    }

    function verifyTransferBackSig(
        bytes32 claimKey,
        uint256 tokenId,
        address holder,
        uint256 deadline,
        uint256 nonce,
        bytes calldata sig,
        uint256 expectedNonce
    ) internal view returns (bool) {
        if (block.timestamp > deadline) revert MetaTxExpired();
        if (nonce != expectedNonce) revert InvalidNonce();
        bytes32 structHash = keccak256(abi.encode(
            TRANSFER_BACK_META_TYPEHASH, claimKey, tokenId, holder, deadline, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        if (digest.recover(sig) != holder) revert InvalidMetaSignature();
        return true;
    }
}
