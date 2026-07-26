// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MintBurnOFTAdapter } from "@layerzerolabs/oft-evm/contracts/MintBurnOFTAdapter.sol";
import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";
import { RateLimiter } from "@layerzerolabs/oapp-evm/contracts/oapp/utils/RateLimiter.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FulaOFTAdapter
/// @notice LayerZero v2 OFT adapter for FULA (StorageToken), enabling permissionless
///         cross-chain transfers with no per-transfer admin action and no project-run relayer.
/// @dev Burn-on-source / mint-on-destination. Global supply across chains is conserved by
///      construction: `_debit` burns exactly `amountSentLD` and the destination credits exactly
///      `_toLD(_toSD(amountSentLD)) == amountSentLD`. Sub-`10**(18-6)` dust is never burned — it
///      remains in the sender's wallet — so a transfer can never destroy value.
///
///      DELIBERATELY IMMUTABLE AND NON-UPGRADEABLE. Deploy with a plain ContractFactory, never
///      with the OpenZeppelin hardhat-upgrades plugin. StorageToken grants this contract the power
///      to burn any holder's balance without allowance (see StorageToken.burn), so an upgradeable
///      adapter would place that power behind a mutable implementation pointer.
///
///      OWNERSHIP: `_owner` is BOTH the OZ `Ownable` owner and the LayerZero delegate. The
///      delegate can configure the security stack AND can permanently destroy in-flight messages
///      via `endpoint.burn`/`nilify` — i.e. destroy user funds already burned on the source chain.
///      It MUST therefore be a TimelockController or multisig, never an EOA.
contract FulaOFTAdapter is MintBurnOFTAdapter, RateLimiter {
    /// @notice Thrown when the underlying token did not move exactly the expected amount.
    /// @param expected The amount the adapter told LayerZero was moved.
    /// @param actual The amount the token actually moved.
    error SupplyInvariantViolated(uint256 expected, uint256 actual);

    /// @param _token FULA StorageToken proxy on this chain.
    /// @param _minterBurner Same StorageToken proxy — it implements IMintableBurnable directly.
    /// @param _lzEndpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Contract owner AND LayerZero delegate. MUST be a timelock/multisig.
    /// @dev `Ownable(_owner)` is required explicitly: `OAppCore` inherits OZ v5 `Ownable` but its
    ///      constructor never calls it, so without this the owner would default to the deployer.
    constructor(
        address _token,
        IMintableBurnable _minterBurner,
        address _lzEndpoint,
        address _owner
    ) MintBurnOFTAdapter(_token, _minterBurner, _lzEndpoint, _owner) Ownable(_owner) {}

    /// @notice Configure per-destination outbound rate limits.
    /// @dev MANDATORY WIRING STEP — the rate limiter is FAIL-CLOSED. `RateLimiter` returns
    ///      `amountCanBeSent == 0` for any `dstEid` that was never explicitly configured, so a
    ///      freshly deployed adapter REVERTS every outbound transfer with `RateLimitExceeded`
    ///      until this is called. That is the intended posture (a bridge that cannot move funds
    ///      until governance sets an explicit ceiling), but it means `setRateLimits` must be part
    ///      of go-live wiring alongside `setPeer`, not an afterthought.
    ///      For an intentionally unlimited lane, set `limit` to `type(uint256).max` explicitly.
    ///      Also the fastest kill switch: setting `limit` to 0 halts outbound on the next block.
    function setRateLimits(RateLimitConfig[] calldata _configs) external onlyOwner {
        _setRateLimits(_configs);
    }

    /// @notice Clear accumulated rate-limit usage for the given destinations.
    function resetRateLimits(uint32[] calldata _eids) external onlyOwner {
        _resetRateLimits(_eids);
    }

    /// @notice Burn tokens on the source chain and record outbound rate-limit usage.
    /// @dev Wraps `MintBurnOFTAdapter._debit` with a hard supply-conservation assertion.
    ///      The base implementation discards the token's return value and assumes a LOSSLESS
    ///      token. StorageToken applies a configurable platform fee inside `_update`, so if that
    ///      fee were ever to apply to burns, `burn(x)` would destroy less than `x` while the
    ///      destination minted the full `x` — silently inflating global supply, invisibly to
    ///      LayerZero. This check converts any such regression into a revert.
    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal virtual override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        uint256 supplyBefore = IERC20(token()).totalSupply();

        (amountSentLD, amountReceivedLD) = super._debit(_from, _amountLD, _minAmountLD, _dstEid);

        uint256 burned = supplyBefore - IERC20(token()).totalSupply();
        if (burned != amountSentLD) revert SupplyInvariantViolated(amountSentLD, burned);

        // Consume outbound allowance only after the burn is confirmed exact.
        _outflow(_dstEid, amountSentLD);
    }

    /// @notice Mint tokens on the destination chain and record inbound rate-limit usage.
    /// @dev Wraps `MintBurnOFTAdapter._credit` with the mirror-image assertion. The base
    ///      implementation returns `_amountLD` unconditionally, without verifying the recipient
    ///      actually received it.
    ///      Reverting here is non-destructive: a failed `lzReceive` leaves the inbound payload
    ///      hash intact, so the message can be permissionlessly retried.
    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal virtual override returns (uint256 amountReceivedLD) {
        // Mirror the base contract's zero-address redirect so the balance is read on the
        // address that actually gets credited.
        address recipient = _to == address(0) ? address(0xdead) : _to;
        uint256 balanceBefore = IERC20(token()).balanceOf(recipient);

        super._credit(_to, _amountLD, _srcEid);

        uint256 credited = IERC20(token()).balanceOf(recipient) - balanceBefore;
        if (credited != _amountLD) revert SupplyInvariantViolated(_amountLD, credited);

        _inflow(_srcEid, _amountLD);
        return _amountLD;
    }
}
