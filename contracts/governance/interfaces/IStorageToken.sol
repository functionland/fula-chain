// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStorageToken {
    /// @notice Events specific to token operations
    event BridgeOperationDetails(address indexed operator, uint8 operation, uint256 amount, uint256 chainId, uint256 timestamp);
    event TokensAllocatedToContract(uint256 indexed amount);
    event SupportedChainChanged(uint256 indexed chainId, address caller);
    event TransferFromContract(address indexed from, address indexed to, uint256 amount, address caller);
    event TokensMinted(address to, uint256 amount);
    event WalletWhitelistedOp(address indexed wallet, address caller, uint256 lockUntil, uint8 status); //status: 1 added, 2 removed
    event BlackListOp(address indexed account, address indexed by, uint8 status); //status: 1 added, status 2 removed
    event TreasuryDeployed(address indexed treasury);
    event PlatformFeeUpdated(uint256 newFee);

    error NotWhitelisted(address to);
    error LocktimeActive(address to);
    error ExceedsSupply(uint256 requested, uint256 supply);
    error LowAllowance(uint256 allowance, uint256 limit);
    error UsedNonce(uint256 nonce);
    error Unsupported(uint256 chain);
    error ExceedsMaximumSupply(uint256 requested, uint256 maxSupply);
    error AlreadyWhitelisted(address target);
    error InvalidChain(uint256 chainId);
    error BlacklistedAddress(address account);
    error AccountBlacklisted(address target);
    error AccountNotBlacklisted(address target);
    error FeeExceedsMax(uint256 fee);
}
