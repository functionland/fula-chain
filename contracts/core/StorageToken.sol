// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "../governance/Treasury.sol";
import "../governance/GovernanceModule.sol";
import "../governance/interfaces/IStorageToken.sol";

/// @title StorageToken
/// @notice ERC20 token with governance capabilities
/// @dev Inherits governance functionality from GovernanceModule
/// @dev Uses treasury/fee collection functionality from Treasury
/// @dev This is the main token contract
contract StorageToken is 
    GovernanceModule,
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    IStorageToken
{

    /// @notice Token constants
    uint256 private constant TOKEN_UNIT = 10**18;
    uint256 private constant TOTAL_SUPPLY = 2_000_000_000 * TOKEN_UNIT;
    uint256 private constant WHITELIST_LOCK_DURATION = 1 days;

    /// @notice Contract-local proposal types for bridge-minter administration.
    /// @dev `GovernanceModule.createProposal` dispatches any unrecognized `uint8` to
    ///      {_createCustomProposal}, and `UnifiedProposal.proposalType` is a raw `uint8`. These
    ///      values are therefore defined HERE rather than in `ProposalTypes.ProposalType`, so that
    ///      the shared `ProposalTypes` library and `GovernanceModule` — inherited by ~10 other live
    ///      contracts — do not have to change. Values 12/13 are reserved in ProposalTypes.sol.
    uint8 private constant PROPOSAL_SET_BRIDGE_MINTER = 12;
    uint8 private constant PROPOSAL_REMOVE_BRIDGE_MINTER = 13;

    mapping(uint256 => mapping(uint256 => uint8)) private _usedNonces;
    mapping(address => bool) public blacklisted;

    // @notice fee collection related storage
    Treasury public treasury;
    uint256 private constant MAX_BPS = 500; // 5%
    uint256 private platformFeeBps;

    PackedVars private packedVars;

    // ---------------------------------------------------------------------
    // Cross-chain bridge state (LayerZero OFT).
    //
    // STORAGE SAFETY: everything below is APPENDED after `packedVars` and must
    // never be reordered or removed. `StorageToken` is in the "Legacy" group
    // (first child slot 11) per contracts/UPGRADING.md, so there is no parent
    // `__gap` absorber; new state lands at slot 16 onward. See UPGRADING.md
    // before touching any declaration in this contract.
    // ---------------------------------------------------------------------

    /// @notice Authorization + accounting for a cross-chain bridge adapter.
    /// @dev Packs into a single slot (1 + 12 + 12 = 25 bytes).
    /// @param enabled Whether this address may call {mint} / {burn}.
    /// @param cap Ceiling on `netMinted`, in wei. Governance-set; the staged-rollout lever.
    /// @param netMinted (bridge mints - bridge burns). MAY be negative when this chain is a
    ///        net exporter, which is why it is signed. Bridge mints are not issuance: each is
    ///        1:1 backed by a burn on the source chain, so a monotonic counter would wrongly
    ///        strangle the bridge after enough round trips.
    struct BridgeMinter {
        bool enabled;
        uint96 cap;
        int96 netMinted;
    }

    /// @notice Addresses authorized to mint/burn for cross-chain transfers. Slot 16.
    mapping(address => BridgeMinter) public bridgeMinters;

    /// @notice Cumulative tokens destroyed via the permissionless {burn}/{burnFrom} entry points. Slot 17.
    /// @dev Tracked so that voluntary burns do not silently manufacture fresh headroom under
    ///      the `totalSupply()`-based supply cap. See {bridgeOp} and {mint}.
    uint256 public voluntarilyBurned;

    /// @dev Reserved for future upgrades. Slots 18..64.
    uint256[47] private __gap;

    /// @notice Initialize the token contract
    /// @param initialOwner Address of the initial owner
    /// @param initialAdmin Address of the initial admin
    /// @param initialMintedTokens Initial token supply to mint
    function initialize(
        address initialOwner, 
        address initialAdmin, 
        uint256 initialMintedTokens
    ) public reinitializer(1) {
        // Validate addresses
        if (initialOwner == address(0) || initialAdmin == address(0)) revert InvalidAddress();
        if (initialMintedTokens > TOTAL_SUPPLY) revert ExceedsSupply(initialMintedTokens, TOTAL_SUPPLY);
        
        // Initialize ERC20 and Permit
        __ERC20_init("Functionland Fula", "FULA");
        
        // Initialize governance module (handles UUPSUpgradeable, Ownable, ReentrancyGuard, 
        // Pausable, AccessControlEnumerable, role grants, and timelocks)
        __GovernanceModule_init(initialOwner, initialAdmin);

        // Deploy Treasury
        treasury = new Treasury(address(this), initialAdmin);
        platformFeeBps = 0;
        
        // Initialize mint and proposal settings
        PackedVars storage vars = packedVars;
        if ((vars.flags & INITIATED) == 0) {
            _mint(address(this), initialMintedTokens);
            proposalCount = 0;
            emit TokensAllocatedToContract(initialMintedTokens);
            emit TokensMinted(address(this), initialMintedTokens);
            emit TreasuryDeployed(address(treasury));
            vars.flags |= INITIATED;
        }
    }


    /// @notice Returns the maximum token supply
    function maxSupply() public pure returns (uint256) {
        unchecked {
            return TOTAL_SUPPLY;
        }
    }

    /// @notice _checkWhitelisted checks to ensure only white-listed recipients and only after time lock period are allowed to receive tokens from contract
    /// @param to the address that is the receiver of tokens from contract
    function _checkWhitelisted(address to) internal view {
        // Use TimeConfig struct for whitelist lock time
        ProposalTypes.TimeConfig storage timeConfig = timeConfigs[to];
        uint64 lockTime = timeConfig.whitelistLockTime;
        
        if (lockTime == 0) revert NotWhitelisted(to);
        if (block.timestamp < lockTime) revert LocktimeActive(to);
    }

    /// @notice blocking transfers from/to blacklisted wallets and transfer the platform to treasury from the transaction
    /// @dev The platform fee applies to TRANSFERS ONLY. It must never be charged on a mint
    ///      (`from == address(0)`) or a burn (`to == address(0)`), both of which route through
    ///      this hook in OpenZeppelin v5 (`_mint` -> `_update(0, to, v)`, `_burn` -> `_update(from, 0, v)`).
    ///      Charging it there is not merely a fee leak, it breaks supply conservation:
    ///        - burn: `super._update(from, treasury, fee)` is a plain TRANSFER, so `burn(x)` would
    ///          destroy only `x - fee` while a bridge credits the full `x` on the destination chain,
    ///          inflating global supply by up to MAX_BPS (5%) on every hop, round-trippable.
    ///        - mint: the recipient would silently receive `amount - fee`.
    ///      The blacklist checks stay outside the branch so they still apply to mints and burns.
    ///      `blacklisted[address(0)]` can never be set (see {_blacklistOp} and {_createCustomProposal}),
    ///      so the zero address is never spuriously blocked.
    function _update(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20Upgradeable) {
        if (blacklisted[from]) revert BlacklistedAddress(from);
        if (blacklisted[to]) revert BlacklistedAddress(to);
        uint256 feeBps = platformFeeBps;
        if (feeBps > 0 && from != address(0) && to != address(0)) {
            uint256 fee = (amount * feeBps) / 10000;
            super._update(from, address(treasury), fee);
            super._update(from, to, amount - fee);
        } else {
            super._update(from, to, amount);
        }
    }

    /// @notice sets the fee in percentage, that is taken from transactions and stored in treasury for burning, development, growth
    /// @param _platformFeeBps is the percentage fee
    function _setPlatformFee(uint256 _platformFeeBps) 
        internal 
        whenNotPaused
    {
        if(_platformFeeBps > MAX_BPS) revert FeeExceedsMax(_platformFeeBps);
        platformFeeBps = _platformFeeBps;
        emit PlatformFeeUpdated(_platformFeeBps);
    }

    /// @notice Manages the blacklist to block wallets from transferring tokens both receive and send
    /// @param account is hte wallet to blacklist
    /// @param status 1 adds to blacklist and 0 removes
    function _blacklistOp(address account, uint8 status) 
        internal
        whenNotPaused 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
    {
        if(account == address(0)) revert InvalidAddress();
        blacklisted[account] = (status == 1 ? true : false);
        emit BlackListOp(account, msg.sender, status);
    }

    /// @notice Transfer from caller to an address if contract is not paused
    function transfer(address to, uint256 amount) 
        public 
        virtual 
        override 
        whenNotPaused 
        nonReentrant
        returns (bool) 
    {
        // Combine validation checks into a single require to save gas
        if (to == address(0)) revert InvalidAddress();
        if (amount <= 0) revert AmountMustBePositive();
        
        return super.transfer(to, amount);
    }

    /// @notice Transfer tokens from contract to whitelisted address
    function transferFromContract(address to, uint256 amount) 
        external 
        virtual 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        returns (bool) 
    {
        if (amount <= 0) revert AmountMustBePositive();
        _checkWhitelisted(to);
        
        uint256 contractBalance = balanceOf(address(this));
        if (amount > contractBalance) revert ExceedsSupply(amount, contractBalance);
        
        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.ADMIN_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);
        
        _transfer(address(this), to, amount);
        emit TransferFromContract(address(this), to, amount, msg.sender);
        _updateActivityTimestamp();
        return true;
    }

    // ---------------------------------------------------------------------
    // LayerZero OFT bridge: IMintableBurnable surface
    // ---------------------------------------------------------------------

    /// @notice Mint tokens credited by an inbound cross-chain transfer.
    /// @dev Implements `IMintableBurnable.mint`. MUST return bool: the adapter's external call is
    ///      ABI-decoded as `returns (bool)`, and empty returndata would revert every inbound transfer.
    ///      Reverts on failure; never returns false.
    ///      Reverting here is SAFE and non-destructive: a failed `lzReceive` restores the inbound
    ///      payload hash, so anyone may permissionlessly retry once the blocking condition (pause,
    ///      blacklist, cap) clears. A revert delays a transfer, it never destroys one.
    /// @param to Recipient of the minted tokens.
    /// @param amount Amount to mint, in wei.
    /// @return success Always true; failures revert.
    function mint(address to, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (bool)
    {
        BridgeMinter storage minter = bridgeMinters[msg.sender];
        if (!minter.enabled) revert NotBridgeMinter(msg.sender);
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert AmountMustBePositive();

        // Absolute per-chain backstop. `voluntarilyBurned` is added back so that permissionless
        // burns cannot manufacture fresh mint headroom against the cap.
        if (totalSupply() + voluntarilyBurned + amount > TOTAL_SUPPLY) {
            revert ExceedsMaximumSupply(amount, TOTAL_SUPPLY);
        }

        // Per-minter net position ceiling: the primary, governance-tunable blast-radius control.
        int256 net = int256(minter.netMinted) + int256(amount);
        if (net > int256(uint256(minter.cap))) revert BridgeMintCapExceeded(net, minter.cap);
        minter.netMinted = int96(net);

        _mint(to, amount);
        _updateActivityTimestamp();
        emit BridgeMint(msg.sender, to, amount);
        return true;
    }

    /// @notice Burn tokens being sent out by an outbound cross-chain transfer.
    /// @dev Implements `IMintableBurnable.burn`. MUST return bool (see {mint}).
    ///      SECURITY: this burns from `from` with NO allowance check, which is what
    ///      `MintBurnOFTAdapter._debit` requires (it passes the message sender). Consequently an
    ///      authorized bridge minter can burn ANY holder's balance. Only ever authorize immutable,
    ///      non-upgradeable, source-verified adapter contracts; {_createCustomProposal} enforces
    ///      that the target is a contract, and authorization requires full governance approval.
    /// @param from Holder whose tokens are burned.
    /// @param amount Amount to burn, in wei.
    /// @return success Always true; failures revert.
    function burn(address from, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (bool)
    {
        BridgeMinter storage minter = bridgeMinters[msg.sender];
        if (!minter.enabled) revert NotBridgeMinter(msg.sender);
        if (from == address(0)) revert InvalidAddress();
        if (amount == 0) revert AmountMustBePositive();

        // May go negative: this chain is then a net exporter of supply.
        minter.netMinted = int96(int256(minter.netMinted) - int256(amount));

        _burn(from, amount);
        _updateActivityTimestamp();
        emit BridgeBurn(msg.sender, from, amount);
        return true;
    }

    /// @notice Burn caller's own tokens.
    /// @dev Overridden ONLY to record `voluntarilyBurned`; guards are intentionally left as
    ///      inherited (see contracts/UPGRADING.md — deliberate scope boundary). Without this
    ///      accounting a holder could burn tokens to create fresh headroom under the
    ///      `totalSupply()`-based supply cap used by {mint} and {bridgeOp}.
    function burn(uint256 value) public virtual override {
        voluntarilyBurned += value;
        super.burn(value);
    }

    /// @notice Burn tokens from `account` using the caller's allowance.
    /// @dev See {burn(uint256)} for why this is overridden.
    function burnFrom(address account, uint256 value) public virtual override {
        voluntarilyBurned += value;
        super.burnFrom(account, value);
    }

    /// @notice Bridge mint function for cross-chain transfers for minting tokens or burning tokens to be minted on another chain
    /// @custom:deprecated Superseded by the LayerZero OFT adapter path ({mint}/{burn} + {bridgeMinters}).
    ///                    Retained for operational continuity; scheduled for removal in a follow-up upgrade.
    /// @param amount is the amount ot burn or mint
    /// @param chain is the id of the chain to burn or mint tokens on
    /// @param nonce is the pre-defined one-time code for this operation on this chain
    /// @param op mint is 1 and burn is 2
    function bridgeOp(uint256 amount, uint256 chain, uint256 nonce, uint8 op) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.BRIDGE_OPERATOR_ROLE)
    {
        if (_usedNonces[chain][nonce] == 0) revert UsedNonce(nonce);
        if (amount == 0) revert AmountMustBePositive();
        
        // `voluntarilyBurned` is added back so permissionless burns cannot manufacture mint headroom.
        uint256 currentSupply = totalSupply() + voluntarilyBurned;
        if ((op == 1 && currentSupply + amount > TOTAL_SUPPLY) || (op ==2 && balanceOf(address(this)) < amount)) revert ExceedsMaximumSupply(amount, balanceOf(address(this)));

        ProposalTypes.RoleConfig storage roleConfig = roleConfigs[ProposalTypes.BRIDGE_OPERATOR_ROLE];
        if (amount > roleConfig.transactionLimit) revert LowAllowance(roleConfig.transactionLimit, amount);

        if (op == uint8(1))  {
            _mint(address(this), amount);
            delete _usedNonces[chain][nonce];
        } else if (op == uint8(2)) {
            _burn(address(this), amount);
            delete _usedNonces[chain][nonce];
        } else 
            revert Unsupported(chain);

        _updateActivityTimestamp();
        emit BridgeOperationDetails(msg.sender, op, amount, chain, block.timestamp);
    }

    /// @notice override method to handle the proposals related to Token only, such as Adding and Removing from whitelist, Blacklist management, treasury management
    /// @param proposalType is defined in ProposalTypes.sol
    /// @param target is the wallet address for the operation
    /// @param amount is for treasury operation: the fee
    function _createCustomProposal(
        uint8 proposalType,
        uint40,
        address target,
        bytes32,
        uint96 amount,
        address
    ) internal virtual override returns (bytes32) {
        if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist) || 
            proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            ProposalTypes.TimeConfig storage targetTimeConfig = timeConfigs[target];
            if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
                if (targetTimeConfig.whitelistLockTime != 0) revert AlreadyWhitelisted(target);
            } else if (proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
                if (targetTimeConfig.whitelistLockTime == 0) revert NotWhitelisted(target);
            }
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);
        } else if (proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist) || 
             proposalType == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist)) {
            if (target == address(0)) revert InvalidAddress();
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);

            // Check current blacklist status
            if (proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist)) {
                if (blacklisted[target]) revert AccountBlacklisted(target);
            } else {
                if (!blacklisted[target]) revert AccountNotBlacklisted(target);
            }
        } else if (proposalType == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee)) {
            if (amount > MAX_BPS) revert FeeExceedsMax(amount);
        } else if (proposalType == PROPOSAL_SET_BRIDGE_MINTER) {
            if (target == address(0)) revert InvalidAddress();
            // A bridge minter can burn ANY holder's balance without allowance (see {burn}).
            // Restricting to contracts blocks authorizing an EOA, which would be catastrophic.
            if (target.code.length == 0) revert MinterMustBeContract(target);
            // A zero cap would authorize a minter that can never mint; reject as operator error.
            if (amount == 0) revert AmountMustBePositive();
            // Bound the cap to int96 range. {mint} checks `net <= cap` and then downcasts to
            // int96, and an explicit int256->int96 conversion TRUNCATES SILENTLY in Solidity.
            // `cap` is a uint96 (max ~7.9e28) while int96 tops out at ~3.96e28, so without this
            // a cap above int96 max would let `netMinted` wrap negative and silently reset cap
            // consumption. Unreachable today (TOTAL_SUPPLY is 2e27) but the invariant is cheap
            // to pin here rather than depend on the supply cap never changing.
            if (amount > uint96(uint256(int256(type(int96).max)))) revert BridgeMintCapTooHigh(amount);
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);
            // NOTE: deliberately allowed on an already-enabled minter — re-issuing is how
            // governance RAISES the cap during staged rollout.
        } else if (proposalType == PROPOSAL_REMOVE_BRIDGE_MINTER) {
            if (target == address(0)) revert InvalidAddress();
            if (!bridgeMinters[target].enabled) revert NotBridgeMinter(target);
            if (pendingProposals[target].proposalType != 0) revert ExistingActiveProposal(target);
        }

        if (proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist) ||
            proposalType == uint8(ProposalTypes.ProposalType.RemoveWhitelist) ||
            proposalType == uint8(ProposalTypes.ProposalType.AddToBlacklist) ||
            proposalType == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist) ||
            proposalType == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee) ||
            proposalType == PROPOSAL_SET_BRIDGE_MINTER ||
            proposalType == PROPOSAL_REMOVE_BRIDGE_MINTER
        ) {
            bytes32 proposalId = _createProposalId(
                proposalType,
                keccak256(abi.encodePacked(target, block.timestamp))
            );

            ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
            _initializeProposal(
                proposal,
                target
            );
            
            proposal.proposalType = proposalType;
            // Persist the amount for the value-carrying proposal types.
            // BUGFIX: `ChangeTreasuryFee` previously never stored `amount`, so execution always
            // read `proposal.amount == 0` and silently set the platform fee to 0 regardless of
            // what was proposed. The new bridge-minter cap depends on the same field.
            if (proposalType == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee) ||
                proposalType == PROPOSAL_SET_BRIDGE_MINTER
            ) {
                proposal.amount = amount;
            }
            pendingProposals[target].proposalType = proposalType;

            return proposalId;
        }
        
        revert InvalidProposalType(proposalType);
    }

    /// @notice removes the expired proposals and related storage variables
    function _handleCustomProposalExpiry(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        if (proposal.proposalType == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[proposal.target];
            delete timeConfig.whitelistLockTime;
        }
    }

    /// @notice executers the proposals that are related to this contract
    function _executeCustomProposal(bytes32 proposalId) internal virtual override {
        ProposalTypes.UnifiedProposal storage proposal = proposals[proposalId];
        
        // Cache commonly used values
        address target = proposal.target;
        uint8 proposalTypeVal = uint8(proposal.proposalType);
        
        if (proposalTypeVal == uint8(ProposalTypes.ProposalType.AddWhitelist)) {
            // Pack time configurations into TimeConfig struct
            ProposalTypes.TimeConfig storage timeConfig = timeConfigs[target];
            timeConfig.whitelistLockTime = uint64(block.timestamp + WHITELIST_LOCK_DURATION);
            emit WalletWhitelistedOp(target, msg.sender, timeConfig.whitelistLockTime, 1);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.RemoveWhitelist)) {
            delete timeConfigs[target].whitelistLockTime;
            emit WalletWhitelistedOp(target, msg.sender, 0, 2);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.AddToBlacklist)) {
            _blacklistOp(target, 1);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.RemoveFromBlacklist)) {
            _blacklistOp(target, 2);
        } else if (proposalTypeVal == uint8(ProposalTypes.ProposalType.ChangeTreasuryFee)) {
            _setPlatformFee(proposal.amount);
        } else if (proposalTypeVal == PROPOSAL_SET_BRIDGE_MINTER) {
            BridgeMinter storage minter = bridgeMinters[target];
            minter.enabled = true;
            minter.cap = proposal.amount;
            emit BridgeMinterSet(target, proposal.amount, msg.sender);
        } else if (proposalTypeVal == PROPOSAL_REMOVE_BRIDGE_MINTER) {
            // Revoke authorization but PRESERVE `netMinted`: it is the accounting record of this
            // minter's net position. Zeroing it would lose the audit trail and, if the minter were
            // ever re-authorized, would reset its cap consumption to zero.
            bridgeMinters[target].enabled = false;
            emit BridgeMinterRemoved(target, msg.sender);
        }
        else {
            revert InvalidProposalType(proposalTypeVal);
        }
    }

    /// @notice Set supported chains for cross-chain operations. Nonce is a one-time code for mint or burn operation on the chain
    function setBridgeOpNonce(uint256 chainId, uint256 nonce) 
        external 
        whenNotPaused 
        nonReentrant 
        onlyRole(ProposalTypes.ADMIN_ROLE)
    {
        if (chainId <= 0) revert InvalidChain(chainId);
        _updateActivityTimestamp();
        _usedNonces[chainId][nonce] = 1;
        emit SupportedChainChanged(chainId, msg.sender);
    }

    /// @notice upgrade the contract that uses the Governance module and proposal system
    function _authorizeUpgrade(address newImplementation) 
        internal 
        nonReentrant
        whenNotPaused
        onlyRole(ProposalTypes.ADMIN_ROLE) 
        override 
    {
        // Delegate the authorization to the governance module
        if (! _checkUpgrade(newImplementation)) revert("UpgradeNotAuthorized");

    }
}
