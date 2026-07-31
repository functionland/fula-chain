// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OFTAdapter } from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";
import {
    SendParam,
    OFTReceipt,
    MessagingReceipt,
    MessagingFee
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { RateLimiter } from "@layerzerolabs/oapp-evm/contracts/oapp/utils/RateLimiter.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FulaOFTAdapter
/// @notice LayerZero v2 OFT adapter for FULA (StorageToken), enabling permissionless cross-chain
///         transfers with no per-transfer admin action and no project-run relayer.
///
/// @dev LOCK-AND-RELEASE ESCROW — **the token contract is not modified in any way.**
///
///      Outbound: the caller's tokens are pulled into this contract and held.
///      Inbound:  tokens already held by this contract are transferred to the recipient.
///
///      Nothing is ever minted or burned ALONG THE BRIDGE PATH, so no operation reachable through
///      this contract can change global supply — the conservation is structural, not an accounting
///      invariant that has to be maintained. Even a total compromise of this adapter cannot breach
///      the 2,000,000,000 hard cap; it can only reach what is escrowed here.
///
///      SCOPE THAT CLAIM HONESTLY, THOUGH. It is a statement about the bridge, not about FULA in
///      general. StorageToken remains a UUPS proxy upgradeable by ADMIN_ROLE governance, and it
///      still exposes `bridgeOp` to BRIDGE_OPERATOR_ROLE. Token governance therefore sits ABOVE
///      this contract in the trust stack and could, by upgrading the token, reach the escrowed
///      balance directly. The real ordering of risk for escrowed funds is:
///      token governance > LayerZero DVN configuration > this contract's code.
///
///      WHY THIS RATHER THAN MINT/BURN. A `MintBurnOFTAdapter` would require granting this
///      contract authority to mint FULA and — because `MintBurnOFTAdapter._debit` passes the
///      message sender straight through — authority to burn ANY holder's balance without an
///      allowance. That means upgrading a live token holding ~1.47B FULA, adding a permanent
///      burn-anyone primitive, and accepting that a compromised adapter could mint up to its cap
///      and dilute every holder globally. Escrow removes all of that: a compromise here can only
///      reach what is escrowed, and holders who never used the bridge are untouched.
///
///      THE COST, STATED PLAINLY: each side must be pre-funded. Tokens can only be released on a
///      chain if this contract already holds them there. If flow is one-directional the source
///      side accumulates and the destination side drains, and inbound transfers revert once the
///      balance is exhausted. That is an operational rebalancing duty, and it is the price of not
///      touching the token.
///
///      DELIBERATELY IMMUTABLE AND NON-UPGRADEABLE. Deploy with a plain ContractFactory, never
///      with the OpenZeppelin hardhat-upgrades plugin. This contract custodies user funds; an
///      upgradeable escrow would place that custody behind a mutable implementation pointer.
///
///      OWNERSHIP — READ THIS BEFORE ASSUMING ESCROW MEANS "NO RUG". `_owner` is BOTH the OZ
///      `Ownable` owner and the LayerZero delegate, and it holds a DIRECT PATH TO THE ESCROW:
///
///        1. `setPeer` is inherited, owner-controlled, and mutable. Pointing a lane at an
///           attacker-controlled address lets that address send a well-formed OFT message which
///           passes `OAppReceiver` authentication — because it now IS the trusted peer — and
///           releases up to the ENTIRE escrow to any recipient. No DVN compromise required.
///        2. As delegate it can reconfigure the security stack (including the receive library
///           and DVN set) and can permanently destroy in-flight messages via
///           `endpoint.burn`/`nilify`, stranding funds already locked on the source chain.
///
///      So removing the withdraw function does NOT remove the owner's ability to take escrowed
///      funds; it only makes the path indirect. What escrow genuinely buys is a BOUND: the owner
///      can reach what is escrowed and nothing more, and holders who never used the bridge are
///      untouched — as opposed to mint/burn, where a compromised adapter could dilute every
///      holder on every chain.
///
///      The owner MUST therefore be a TimelockController or multisig, never an EOA. The timelock
///      delay is what makes a malicious `setPeer` observable before it executes, and that is the
///      control the whole design leans on.
contract FulaOFTAdapter is OFTAdapter, RateLimiter, Ownable2Step {
    /// @notice Thrown when the escrow did not move exactly the expected amount.
    /// @param expected The amount the adapter told LayerZero was moved.
    /// @param actual The amount that actually moved.
    error EscrowInvariantViolated(uint256 expected, uint256 actual);

    /// @notice Thrown when the adapter holds too little to satisfy an inbound transfer.
    /// @param needed Amount the message asks to release.
    /// @param available Amount currently escrowed.
    error InsufficientLiquidity(uint256 needed, uint256 available);

    /// @notice Thrown by the disabled {renounceOwnership}.
    error OwnershipCannotBeRenounced();

    /// @notice Thrown when a transfer names the zero address as its cross-chain recipient.
    error ZeroRecipient();

    /// @notice Thrown when a transfer carries a composed message, which this adapter does not support.
    error ComposeNotSupported();

    /// @notice Thrown when a transfer names the DESTINATION ADAPTER itself as its recipient.
    error RecipientIsBridgeAdapter();

    /// @notice Thrown when a transfer nominates the zero address to receive the fee refund.
    error ZeroRefundAddress();

    /// @notice Thrown when the requested amount rounds to zero after dust removal.
    /// @param requested The amount asked for, all of which was below the transferable granularity.
    error ZeroAmountAfterDust(uint256 requested);

    /// @notice Thrown when an inbound release would exceed the inbound allowance for its lane.
    /// @param requested Amount the message asks to release.
    /// @param available Amount the inbound bucket currently permits.
    error InboundRateLimitExceeded(uint256 requested, uint256 available);

    /// @notice Thrown by {setPeer} once {lockPeers} has been called.
    error PeersAreLocked();

    /// @notice Thrown when an inbound rate limit is configured with a zero window.
    error ZeroWindow();

    /// @notice Emitted when inbound rate limits are (re)configured.
    event InboundRateLimitsChanged(RateLimitConfig[] configs);

    /// @notice Emitted when accumulated inbound usage is cleared.
    event InboundRateLimitsReset(uint32[] eids);

    /// @notice Emitted once, when the peer set is frozen permanently.
    event PeersLocked();

    /// @notice INBOUND allowance per source chain, a separate bucket from the outbound one.
    /// @dev Deliberately NOT the inherited `rateLimits` mapping. That one is netted — `_inflow`
    ///      subtracts inbound volume from the OUTBOUND bucket — which is the right accounting for
    ///      throttling flow but is useless as a theft bound, because an attacker draining the
    ///      escrow never sends anything back to offset. This bucket is GROSS: every release
    ///      consumes it and nothing but time refills it.
    mapping(uint32 srcEid => RateLimit limit) public inboundRateLimits;

    /// @notice Once true, {setPeer} reverts forever and the peer set can never change again.
    bool public peersLocked;

    /// @param _token FULA StorageToken proxy on this chain.
    /// @param _lzEndpoint LayerZero EndpointV2 on this chain.
    /// @param _owner Contract owner AND LayerZero delegate. MUST be a timelock/multisig.
    /// @dev `Ownable(_owner)` is required explicitly: `OAppCore` inherits OZ v5 `Ownable` but its
    ///      constructor does not invoke it, and OZ v5 `Ownable` has a mandatory constructor
    ///      argument — so without this the contract would not compile.
    constructor(
        address _token,
        address _lzEndpoint,
        address _owner
    ) OFTAdapter(_token, _lzEndpoint, _owner) Ownable(_owner) {}

    // ---------------------------------------------------------------------
    // Liquidity
    // ---------------------------------------------------------------------

    /// @notice Tokens currently escrowed here, i.e. the maximum this chain can release inbound.
    /// @dev Monitor this. When it approaches zero, inbound transfers to this chain begin to fail
    ///      (they park retryably rather than being lost, but users are stuck until it is topped up).
    function availableLiquidity() external view returns (uint256) {
        return IERC20(token()).balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Rate limiting
    // ---------------------------------------------------------------------

    /// @notice Configure per-destination outbound rate limits.
    /// @dev MANDATORY WIRING STEP — the rate limiter is FAIL-CLOSED. `RateLimiter` returns
    ///      `amountCanBeSent == 0` for any `dstEid` that was never explicitly configured, so a
    ///      freshly deployed adapter REVERTS every outbound transfer with `RateLimitExceeded`
    ///      until this is called.
    ///      For an intentionally unlimited lane set `limit` to `type(uint192).max` — the field is
    ///      a uint192, so `type(uint256).max` does not fit.
    ///
    ///      SEMANTICS: a LEAKY BUCKET, not a per-calendar-day quota. `limit = L, window = W`
    ///      permits L immediately, then refills continuously at L/W per second. It is also a
    ///      SINGLE bucket shared by every user of the lane, not a per-sender allowance, so one
    ///      large transfer can consume the window and make others revert until it refills.
    ///      Setting `limit` to 0 is the fastest kill switch: outbound halts on the next block.
    function setRateLimits(RateLimitConfig[] calldata _configs) external onlyOwner {
        _setRateLimits(_configs);
    }

    /// @notice Clear accumulated rate-limit usage for the given destinations.
    function resetRateLimits(uint32[] calldata _eids) external onlyOwner {
        _resetRateLimits(_eids);
    }

    /// @notice Configure per-source INBOUND rate limits — the bound on how much escrow one
    ///         compromise can remove before anyone can react.
    /// @dev WHY THIS EXISTS. Every other check in this contract validates arithmetic, not
    ///      authenticity: the balance-delta assertions, the recipient checks and the dust check all
    ///      assume the message is honest. If the DVN set attests to a packet that should not exist,
    ///      or the owner repoints a lane at an attacker, `_credit` will faithfully release whatever
    ///      the message asks for — up to the entire escrow, in one transaction. That is precisely
    ///      how the KelpDAO rsETH adapter lost ~$292M in April 2026 with no buggy contract
    ///      anywhere. This bucket is the only thing that bounds the loss.
    ///
    ///      SIZING. Size it against the ESCROW BALANCE on this chain, not against supply. The
    ///      bucket starts FULL, so `limit` IS the amount an attacker takes instantly before any
    ///      refill — treat it as the first-tranche loss and aim for 10-25% of escrow. It must
    ///      still sit above real daily inbound volume, because legitimate excess PARKS.
    ///
    ///      FAIL-CLOSED, exactly like the outbound limiter: an unconfigured `srcEid` permits
    ///      nothing, so inbound messages park (retryably — never lost) until this is called.
    ///      Setting `limit` to 0 is an immediate release kill switch that needs no token pause.
    ///
    ///      NAMING TRAP: `RateLimitConfig.dstEid` is reused verbatim from `RateLimiter`, but here
    ///      it is read as a **source** eid — the chain a release arrives FROM. Identical either way
    ///      on a two-chain bridge, since both lanes use the same remote eid; anyone extending this
    ///      to a third chain must key by the ORIGIN of the inbound message, not the destination.
    function setInboundRateLimits(RateLimitConfig[] calldata _configs) external onlyOwner {
        for (uint256 i = 0; i < _configs.length; i++) {
            // Reject a zero window. `RateLimiter` divides by `window > 0 ? window : 1`, so a zero
            // window makes `decay = limit * secondsElapsed` — the bucket refills completely every
            // second and the bound stops bounding anything. On the OUTBOUND limiter that is merely
            // a throttle misconfiguration; here it silently disables the only control that stands
            // between a forged message and the whole escrow, so it must not be reachable by typo.
            if (_configs[i].window == 0) revert ZeroWindow();

            RateLimit storage rl = inboundRateLimits[_configs[i].dstEid];

            // Checkpoint the CURRENT decayed usage before swapping the rate in, so a new
            // limit/window is never applied retroactively to already-elapsed time. This mirrors
            // what `RateLimiter._setRateLimits` does via `_outflow(eid, 0)`.
            (uint256 decayed, ) = _amountCanBeSent(rl.amountInFlight, rl.lastUpdated, rl.limit, rl.window);
            rl.amountInFlight = uint192(decayed);
            rl.lastUpdated = uint64(block.timestamp);

            rl.limit = _configs[i].limit;
            rl.window = _configs[i].window;
        }
        emit InboundRateLimitsChanged(_configs);
    }

    /// @notice Clear accumulated INBOUND usage for the given source chains.
    /// @dev The mirror of {resetRateLimits}, which only ever touched the outbound bucket — the
    ///      inherited `_resetRateLimits` writes `rateLimits`, not `inboundRateLimits`, so without
    ///      this an operator whose inbound bucket was consumed by a legitimate large batch had no
    ///      lever at all: only waiting out the window, or raising the limit and thereby weakening
    ///      the bound permanently.
    ///
    ///      This grants no new authority. The owner can already raise the limit, so being able to
    ///      clear usage is strictly weaker than powers it already has — it just avoids having to
    ///      damage the configured bound to recover from a transient one.
    function resetInboundRateLimits(uint32[] calldata _eids) external onlyOwner {
        for (uint256 i = 0; i < _eids.length; i++) {
            RateLimit storage rl = inboundRateLimits[_eids[i]];
            rl.amountInFlight = 0;
            rl.lastUpdated = uint64(block.timestamp);
        }
        emit InboundRateLimitsReset(_eids);
    }

    /// @notice How much may still be released from `_srcEid` right now.
    function getAmountCanBeReceived(
        uint32 _srcEid
    ) external view returns (uint256 currentAmountInFlight, uint256 amountCanBeReceived) {
        RateLimit storage rl = inboundRateLimits[_srcEid];
        return _amountCanBeSent(rl.amountInFlight, rl.lastUpdated, rl.limit, rl.window);
    }

    /// @dev Consume inbound allowance, reverting if the release exceeds it. Reverting is
    ///      NON-DESTRUCTIVE — the payload hash survives, so an over-limit message simply retries
    ///      once the bucket refills.
    function _consumeInbound(uint32 _srcEid, uint256 _amount) internal {
        RateLimit storage rl = inboundRateLimits[_srcEid];
        (uint256 current, uint256 canBeReceived) = _amountCanBeSent(
            rl.amountInFlight,
            rl.lastUpdated,
            rl.limit,
            rl.window
        );
        if (_amount > canBeReceived) revert InboundRateLimitExceeded(_amount, canBeReceived);

        // Safe narrowing: the check above bounds `current + _amount` by `limit`, itself a uint192.
        rl.amountInFlight = uint192(current + _amount);
        rl.lastUpdated = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Peer set
    // ---------------------------------------------------------------------

    /// @notice Freeze the peer set PERMANENTLY. One-way and irreversible.
    /// @dev Closes the single largest privileged attack path on this contract. `setPeer` decides
    ///      which remote address is trusted, and `EndpointV2.send` is permissionless — so an owner
    ///      who repoints a lane at an address they control can have that address emit a GENUINE
    ///      source-chain packet (honest DVNs will attest to it, because it really happened) that
    ///      releases the entire escrow here, having locked nothing. No DVN compromise required.
    ///
    ///      Call this once both lanes are wired and a real transfer has been observed end to end.
    ///      Peers legitimately never change for a fixed two-chain bridge. THE COST: after this, an
    ///      adapter on either side can never be replaced without redeploying both and migrating
    ///      liquidity. That is the intended trade — a standing drain path is worse.
    ///
    ///      WHAT THIS DOES **NOT** DO. It does not make a compromised owner harmless. The owner is
    ///      also the LayerZero delegate, so it can still `setDelegate` to itself, repoint the
    ///      receive library and DVN set, and have a malicious verifier attest to a FORGED packet
    ///      whose sender matches the now-frozen peer — which passes the peer check and drains the
    ///      escrow just the same. Locking removes the cheap, single-transaction, no-collusion
    ///      route; it does not remove the trust placed in the owner. The inbound rate limit is
    ///      what bounds the residual, which is why the two controls belong together.
    function lockPeers() external onlyOwner {
        peersLocked = true;
        emit PeersLocked();
    }

    /// @notice Set the trusted peer OApp for `_eid`. Blocked once {lockPeers} has been called.
    function setPeer(uint32 _eid, bytes32 _peer) public virtual override onlyOwner {
        if (peersLocked) revert PeersAreLocked();
        _setPeer(_eid, _peer);
    }

    // ---------------------------------------------------------------------
    // Ownership: two-step, and permanently non-renounceable
    // ---------------------------------------------------------------------

    /// @notice Ownership transfer is DELIBERATELY TWO-STEP (`Ownable2Step`).
    /// @dev The owner is the only party that can rotate a dead or compromised DVN, and is also the
    ///      LayerZero delegate. A single-step transfer to a mistyped or uncontrolled address would
    ///      lose both irrecoverably. Two-step means a wrong nominee simply never accepts.
    function transferOwnership(address newOwner) public virtual override(Ownable, Ownable2Step) onlyOwner {
        Ownable2Step.transferOwnership(newOwner);
    }

    /// @inheritdoc Ownable2Step
    /// @dev ALSO re-points the LayerZero delegate at the new owner. `OAppCore.setDelegate` is a
    ///      SEPARATE `onlyOwner` entry point that ownership transfer does not touch, so without
    ///      this an ownership handover would silently leave the OLD owner as delegate — retaining
    ///      the single most dangerous power over this contract: `endpoint.burn`/`nilify`, which
    ///      permanently destroy in-flight messages and strand funds already locked on the source
    ///      chain. Relying on the new owner to remember a follow-up `setDelegate` call is exactly
    ///      the kind of operational step that gets skipped once.
    ///
    ///      THE GUARD IS `address(this).code.length`, NOT `address(endpoint) != address(0)`:
    ///      `endpoint` is `immutable` in `OAppCore`, and Solidity forbids reading an immutable
    ///      during construction, so the obvious-looking check does not compile. `Ownable(_owner)`
    ///      invokes this override before the contract has any code, so the length test skips that
    ///      constructor pass — where `OAppCore` sets the initial delegate itself — and fires only
    ///      on a genuine `acceptOwnership`.
    function _transferOwnership(address newOwner) internal virtual override(Ownable, Ownable2Step) {
        Ownable2Step._transferOwnership(newOwner);

        if (address(this).code.length > 0) {
            endpoint.setDelegate(newOwner);
        }
    }

    /// @notice DISABLED — always reverts.
    /// @dev This contract is immutable and custodies escrowed user funds. An ownerless escrow could
    ///      never rotate a dead DVN, so every transfer already locked on the source chain would
    ///      become permanently unreleasable on the destination. Renouncing looks like
    ///      decentralization but here it converts a recoverable outage into unrecoverable loss.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }

    // ---------------------------------------------------------------------
    // Send-side input validation
    // ---------------------------------------------------------------------

    /// @notice Send tokens to the peer chain.
    /// @dev Overridden ONLY to reject two inputs the stock implementation accepts silently:
    ///      1. `to == bytes32(0)` — would lock tokens here and release them to `0xdead` on the
    ///         destination, an unrecoverable loss with no revert to warn the user.
    ///      2. A non-empty `composeMsg` — composed sends switch to SEND_AND_CALL, for which no
    ///         enforced options are configured, so the destination gas floor would not apply.
    ///      Both checks run BEFORE `_debit`, so a rejected transfer locks nothing.
    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata _fee,
        address _refundAddress
    ) external payable virtual override returns (MessagingReceipt memory, OFTReceipt memory) {
        if (_sendParam.to == bytes32(0)) revert ZeroRecipient();
        if (_sendParam.composeMsg.length != 0) revert ComposeNotSupported();

        // Naming the peer adapter as the recipient produces a PERMANENTLY undeliverable message:
        // on arrival `_credit` would `safeTransfer` the escrow to itself, so the measured delta is
        // zero, `EscrowInvariantViolated` reverts, and it reverts identically on every retry — the
        // tokens stay locked here with no recovery path. `peers[dstEid]` IS the destination
        // adapter, so this is checkable at send time even though the two chains have different
        // addresses. Cannot false-positive: an unset peer is bytes32(0), already rejected above.
        if (_sendParam.to == peers[_sendParam.dstEid]) revert RecipientIsBridgeAdapter();

        // Overpaying is normal — callers are told to pad `msg.value` above the quote because the
        // fee can move between quoting and mining, and the endpoint refunds the difference. It
        // refunds with a bare `.call`, which to the zero address SUCCEEDS and burns the excess.
        if (_refundAddress == address(0)) revert ZeroRefundAddress();

        return _send(_sendParam, _fee, _refundAddress);
    }

    // ---------------------------------------------------------------------
    // Escrow accounting
    // ---------------------------------------------------------------------

    /// @notice Lock tokens on the source chain and record outbound rate-limit usage.
    /// @dev Wraps `OFTAdapter._debit` with a hard escrow assertion.
    ///
    ///      WHY THE ASSERTION IS NOT OPTIONAL: the base implementation assumes a LOSSLESS token and
    ///      simply trusts that `safeTransferFrom` moved `amountSentLD`. StorageToken applies a
    ///      configurable platform fee inside `_update`, currently 0 on every chain. If governance
    ///      ever raised it, this contract would receive `amount - fee` while telling LayerZero the
    ///      full `amount` — and the destination would release the full amount. Repeated, that
    ///      silently drains the escrow until inbound transfers start failing. This check turns that
    ///      regression into an immediate revert instead of a slow leak.
    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal virtual override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        uint256 balanceBefore = IERC20(token()).balanceOf(address(this));

        (amountSentLD, amountReceivedLD) = super._debit(_from, _amountLD, _minAmountLD, _dstEid);

        // Reject a transfer that rounds to nothing. `_removeDust` truncates to the 1e12 shared-
        // decimal granularity, so any amount below that becomes zero — and an ERC20 transfer of
        // zero SUCCEEDS. Without this the user would pay a LayerZero fee to deliver an empty
        // message, and `_outflow(_dstEid, 0)` would pass even with the rate limit set to zero,
        // quietly bypassing the kill switch. The mint/burn design blocked this only incidentally,
        // via the token's own AmountMustBePositive check; escrow has no such backstop.
        if (amountSentLD == 0) revert ZeroAmountAfterDust(_amountLD);

        uint256 locked = IERC20(token()).balanceOf(address(this)) - balanceBefore;
        if (locked != amountSentLD) revert EscrowInvariantViolated(amountSentLD, locked);

        // Consume outbound allowance only after the lock is confirmed exact. Reverting here
        // reverts the lock too, so exceeding the limit costs gas but never tokens — which is why
        // the throttle belongs on the outbound side.
        _outflow(_dstEid, amountSentLD);
    }

    /// @notice Release escrowed tokens to the recipient and record inbound rate-limit usage.
    /// @dev Wraps `OFTAdapter._credit` with the mirror-image assertion, plus an explicit liquidity
    ///      check so an under-funded adapter fails with a diagnosable error rather than a bare
    ///      ERC20 revert.
    ///
    ///      Reverting here is NON-DESTRUCTIVE: a failed `lzReceive` leaves the inbound payload hash
    ///      intact, so the message can be permissionlessly retried once liquidity is restored. An
    ///      empty escrow delays transfers; it does not lose them.
    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 _srcEid
    ) internal virtual override returns (uint256 amountReceivedLD) {
        uint256 escrowed = IERC20(token()).balanceOf(address(this));
        if (escrowed < _amountLD) revert InsufficientLiquidity(_amountLD, escrowed);

        // NOTE: `OFTAdapter._credit` does NOT redirect a zero recipient to `0xdead` — that
        // redirect lives only in `OFT._credit`, where it exists because `_mint` rejects the zero
        // address. A lock/release adapter just calls `safeTransfer(_to, ...)` verbatim. Rejecting
        // it here is purely for diagnosability: the transfer would revert inside the token anyway
        // (its `transfer` override rejects `to == address(0)`), but as an opaque token-level error
        // on a message that can never be delivered. Our own `send` already blocks this, so only a
        // compromised or non-conforming peer could produce it.
        if (_to == address(0)) revert ZeroRecipient();

        // Defense in depth. `send` already blocks naming the peer adapter as recipient, but that
        // only constrains messages WE originate; a non-conforming or compromised peer could still
        // deliver one. Failing with a named error beats failing with a confusing
        // `EscrowInvariantViolated(x, 0)` from a self-transfer that moved nothing.
        if (_to == address(this)) revert RecipientIsBridgeAdapter();

        // Bound the release BEFORE touching the escrow. This is the authenticity backstop: every
        // other check here assumes the message is honest, and this one does not.
        _consumeInbound(_srcEid, _amountLD);

        uint256 balanceBefore = IERC20(token()).balanceOf(_to);

        super._credit(_to, _amountLD, _srcEid);

        uint256 credited = IERC20(token()).balanceOf(_to) - balanceBefore;
        if (credited != _amountLD) revert EscrowInvariantViolated(_amountLD, credited);

        _inflow(_srcEid, _amountLD);
        return _amountLD;
    }
}
