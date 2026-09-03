// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MessagingParams, MessagingReceipt, MessagingFee, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { ILayerZeroReceiver } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroReceiver.sol";

/// @title MockLZEndpointV2
/// @notice Minimal in-memory LayerZero EndpointV2 stand-in for local tests.
/// @dev TEST ONLY — never deploy.
///
///      Hand-rolled deliberately. LayerZero's own `EndpointV2Mock` (in the
///      test-devtools-evm-hardhat package) transitively imports lz-evm-messagelib-v2, which pins
///      OpenZeppelin contracts ^4.8.1 as a HARD dependency. Hardhat resolves Solidity imports
///      relative to the importing file, so that would pull OZ 4.x into the same compile graph as
///      this repo's OZ 5.3.0 and produce duplicate/incompatible artifacts.
///
///      Implements only the surface OApp actually touches: setDelegate, quote, send, and manual
///      delivery. Messages are QUEUED rather than auto-delivered so tests can assert intermediate
///      state (e.g. that supply is reduced on the source chain before the destination credits) and
///      can exercise the retry path after a failed delivery.
contract MockLZEndpointV2 {
    /// @notice This endpoint's LayerZero endpoint id.
    uint32 public immutable eid;

    /// @notice Flat native fee returned by {quote}, settable per test.
    uint256 public nativeFee = 1e15;

    /// @notice OApp => its configured delegate.
    mapping(address => address) public delegates;

    /// @notice Destination eid => the endpoint instance representing that chain in-process.
    mapping(uint32 => address) public destEndpoint;

    struct QueuedMessage {
        uint32 srcEid;
        address sender;      // source OApp
        address receiver;    // destination OApp
        bytes32 guid;
        uint64 nonce;
        bytes message;
        bool delivered;
    }

    /// @notice All messages inbound to OApps on THIS endpoint.
    QueuedMessage[] public queue;

    /// @dev Per (srcEid, sender) outbound nonce counter.
    mapping(uint32 => mapping(address => uint64)) public outboundNonce;

    event PacketQueued(uint256 indexed index, uint32 dstEid, address indexed sender, bytes32 guid);
    event PacketDelivered(uint256 indexed index, address indexed receiver);

    error NoDestinationEndpoint(uint32 dstEid);
    error AlreadyDelivered(uint256 index);

    constructor(uint32 _eid) {
        eid = _eid;
    }

    // --- test wiring -----------------------------------------------------

    /// @notice Pair this endpoint with the endpoint representing `_dstEid`.
    function setDestLzEndpoint(uint32 _dstEid, address _endpoint) external {
        destEndpoint[_dstEid] = _endpoint;
    }

    function setNativeFee(uint256 _fee) external {
        nativeFee = _fee;
    }

    function queueLength() external view returns (uint256) {
        return queue.length;
    }

    // --- ILayerZeroEndpointV2 subset -------------------------------------

    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({ nativeFee: nativeFee, lzTokenFee: 0 });
    }

    /// @notice Accept an outbound message and queue it on the paired destination endpoint.
    function send(
        MessagingParams calldata _params,
        address /* _refundAddress */
    ) external payable returns (MessagingReceipt memory) {
        address dst = destEndpoint[_params.dstEid];
        if (dst == address(0)) revert NoDestinationEndpoint(_params.dstEid);

        uint64 nonce = ++outboundNonce[_params.dstEid][msg.sender];
        bytes32 guid = keccak256(abi.encodePacked(eid, _params.dstEid, msg.sender, nonce));

        MockLZEndpointV2(dst).receivePacket(
            eid,
            msg.sender,
            address(uint160(uint256(_params.receiver))),
            guid,
            nonce,
            _params.message
        );

        return MessagingReceipt({
            guid: guid,
            nonce: nonce,
            fee: MessagingFee({ nativeFee: msg.value, lzTokenFee: 0 })
        });
    }

    /// @notice Called by the paired source endpoint to enqueue an inbound message.
    function receivePacket(
        uint32 _srcEid,
        address _sender,
        address _receiver,
        bytes32 _guid,
        uint64 _nonce,
        bytes calldata _message
    ) external {
        queue.push(
            QueuedMessage({
                srcEid: _srcEid,
                sender: _sender,
                receiver: _receiver,
                guid: _guid,
                nonce: _nonce,
                message: _message,
                delivered: false
            })
        );
        emit PacketQueued(queue.length - 1, _srcEid, _sender, _guid);
    }

    /// @notice Deliver a queued message to its destination OApp.
    /// @dev Mirrors the real endpoint's ordering: the message is marked delivered BEFORE the OApp
    ///      call, so that if the OApp reverts the whole transaction rolls back and the message
    ///      remains undelivered and retryable — exactly the real `_clearPayload` semantics that
    ///      make a blacklisted/paused destination a delay rather than a loss.
    function deliver(uint256 _index) external payable {
        QueuedMessage storage m = queue[_index];
        if (m.delivered) revert AlreadyDelivered(_index);
        m.delivered = true;

        ILayerZeroReceiver(m.receiver).lzReceive{ value: msg.value }(
            Origin({ srcEid: m.srcEid, sender: bytes32(uint256(uint160(m.sender))), nonce: m.nonce }),
            m.guid,
            m.message,
            address(this),
            bytes("")
        );

        emit PacketDelivered(_index, m.receiver);
    }

    /// @notice Convenience: deliver the oldest undelivered message.
    function deliverNext() external {
        for (uint256 i = 0; i < queue.length; i++) {
            if (!queue[i].delivered) {
                this.deliver(i);
                return;
            }
        }
        revert("no pending message");
    }
}
