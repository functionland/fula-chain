// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";

/// @title MockBridgeMinterCaller
/// @notice Minimal contract that exercises StorageToken's IMintableBurnable surface.
/// @dev TEST ONLY — never deploy.
///      Exists because `SetBridgeMinter` proposals require a CONTRACT target (an EOA minter could
///      burn any holder's balance), so tests cannot authorize a plain signer.
contract MockBridgeMinterCaller {
    IMintableBurnable public immutable token;

    constructor(address _token) {
        token = IMintableBurnable(_token);
    }

    function callMint(address to, uint256 amount) external returns (bool) {
        return token.mint(to, amount);
    }

    function callBurn(address from, uint256 amount) external returns (bool) {
        return token.burn(from, amount);
    }
}
