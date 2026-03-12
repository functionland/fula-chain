// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

interface IFulaFileNFTClaim {
    function claimNFT(bytes32 linkHash) external;
    function burn(address account, uint256 id, uint256 value) external;
}

/// @notice Test helper contract that attempts reentrancy attacks on FulaFileNFT.
/// @dev Used in test suite to verify nonReentrant guards work correctly.
contract ReentrancyAttacker is ERC165, IERC1155Receiver {
    IFulaFileNFTClaim public immutable target;
    bytes32 public attackLinkHash;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(address _target) {
        target = IFulaFileNFTClaim(_target);
    }

    /// @notice Attempt to claim and reenter during the ERC1155 receive callback
    function attackClaim(bytes32 linkHash) external {
        attackLinkHash = linkHash;
        reentered = false;
        reentrySucceeded = false;
        target.claimNFT(linkHash);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes memory
    ) external override returns (bytes4) {
        if (!reentered) {
            reentered = true;
            // Attempt reentry — should fail due to nonReentrant
            try target.claimNFT(attackLinkHash) {
                reentrySucceeded = true;
            } catch {
                // Expected: ReentrancyGuardReentrantCall
            }
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) external pure override returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
