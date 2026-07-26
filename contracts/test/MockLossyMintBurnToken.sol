// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";

/// @title MockLossyMintBurnToken
/// @notice A token that deliberately mints/burns LESS than requested, simulating a fee-on-mint bug.
/// @dev TEST ONLY — never deploy.
///      Used to prove that FulaOFTAdapter's supply-invariant checks actually fire. This is the
///      exact failure mode the un-fixed StorageToken._update had: burning less than requested while
///      the destination chain credits the full amount, silently inflating global supply.
contract MockLossyMintBurnToken is ERC20, IMintableBurnable {
    /// @notice Basis points skimmed off every mint and burn.
    uint256 public lossBps;

    constructor(uint256 _lossBps) ERC20("Lossy", "LOSS") {
        lossBps = _lossBps;
    }

    function setLossBps(uint256 _lossBps) external {
        lossBps = _lossBps;
    }

    function mintFree(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function mint(address _to, uint256 _amount) external override returns (bool) {
        _mint(_to, _amount - (_amount * lossBps) / 10000);
        return true;
    }

    function burn(address _from, uint256 _amount) external override returns (bool) {
        _burn(_from, _amount - (_amount * lossBps) / 10000);
        return true;
    }
}
