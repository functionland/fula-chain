// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockFeeOnTransferToken
/// @notice A token that deliberately delivers LESS than requested on every transfer.
/// @dev TEST ONLY — never deploy.
///
///      Exists to prove `FulaOFTAdapter`'s escrow assertions actually fire. This reproduces the
///      exact failure mode the real token would exhibit if `platformFeeBps` were ever raised above
///      zero: `safeTransferFrom` would move `amount` out of the sender but deliver only
///      `amount - fee` to the escrow, while the adapter told LayerZero the full `amount` was sent.
///      The destination would then release the full amount, and repeated transfers would silently
///      drain the escrow. `EscrowInvariantViolated` is what turns that leak into a revert.
contract MockFeeOnTransferToken is ERC20 {
    /// @notice Basis points skimmed off every transfer.
    uint256 public feeBps;
    /// @notice Where the skim goes, so total supply is unchanged (it is a transfer, not a burn).
    address public feeSink;

    constructor(uint256 _feeBps) ERC20("FeeOnTransfer", "FEE") {
        feeBps = _feeBps;
        feeSink = address(0xFEE);
    }

    function setFeeBps(uint256 _feeBps) external {
        feeBps = _feeBps;
    }

    function mintFree(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Splits every transfer, exactly as StorageToken's `_update` would with a non-zero fee.
    function _update(address from, address to, uint256 value) internal virtual override {
        if (feeBps > 0 && from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10000;
            super._update(from, feeSink, fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
