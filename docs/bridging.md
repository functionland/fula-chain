# Bridging FULA between Ethereum and Base

FULA moves between chains through a LayerZero v2 adapter. This page is for token holders. For the
design rationale see `docs/bridge-design.md`; for operations see `scripts/bridge/README.md`.

## What actually happens

The bridge is **lock and release**. It does **not** mint or burn.

1. You send FULA to the adapter on the source chain. It holds them.
2. LayerZero delivers a message to the destination chain.
3. The adapter there sends you an equal amount **out of tokens it already holds**.

**No FULA is ever created or destroyed, and the token contract is not involved beyond an ordinary
ERC-20 transfer.** The adapter has no minting power, no special role, and no ability to touch your
balance beyond the allowance you grant it. Total FULA across all chains is constant, always.

## How to bridge

Two transactions, both on the **source** chain. You need no gas and no transaction on the
destination chain — the LayerZero executor pays that out of the fee you already paid.

```ts
const adapter = await ethers.getContractAt("FulaOFTAdapter", ADAPTER_ADDRESS);
const token   = await ethers.getContractAt("StorageToken", await adapter.token());

const sendParam = {
  dstEid:      40245,                                  // destination LayerZero eid (NOT a chainId)
  to:          ethers.zeroPadValue(recipient, 32),     // recipient, left-padded to 32 bytes
  amountLD:    ethers.parseEther("100"),               // amount, 18 decimals
  minAmountLD: ethers.parseEther("100"),               // slippage floor — see "Dust" below
  extraOptions: "0x",                                  // enforced options supply destination gas
  composeMsg:   "0x",                                  // must be empty — composed sends are rejected
  oftCmd:       "0x",
};

// 1. Approve. The adapter pulls your tokens with transferFrom.
await token.approve(ADAPTER_ADDRESS, sendParam.amountLD);

// 2. Quote, then send with the fee as msg.value.
const fee = await adapter.quoteSend(sendParam, false);
await adapter.send(sendParam, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, refundAddress, {
  value: fee.nativeFee,
});
```

Or use the script:

```
ADAPTER=0x.. REMOTE=base AMOUNT=100 npx hardhat run scripts/bridge/sendTest.ts --network ethereum
```

Add `DRY_RUN=1` to quote without sending, `EXACT=1` to refuse dust truncation, and `TO=0x..` to send
to someone else.

## Endpoint IDs

LayerZero eids are **not** chain IDs.

| Chain | eid |
|---|---|
| Ethereum | 30101 |
| Base | 30184 |
| Sepolia | 40161 |
| Base Sepolia | 40245 |

## Things worth knowing

**Approval is required.** `approvalRequired()` returns `true`. FULA has no `permit`, so this is a
genuine second transaction.

**Dust.** Transfers are quantised to 0.000001 FULA (the bridge carries 6 decimals internally, FULA
has 18). Anything finer is **left in your wallet** — never destroyed, never sent. Set
`minAmountLD == amountLD` to revert rather than silently round down. An amount *entirely* below
0.000001 is rejected with `ZeroAmountAfterDust` rather than sending an empty message.

**The fee.** `msg.value` must equal the `nativeFee` you declare, exactly. Quote immediately before
sending; if gas prices move between your quote and inclusion the transaction reverts. Declaring a
little more than the quote is safe — the endpoint refunds the excess to your refund address in the
same transaction.

**Zero address is rejected.** Sending to `bytes32(0)` reverts rather than delivering to a burn
address.

## When a transfer does not go through

| Symptom | What happened | What to do |
|---|---|---|
| `RateLimitExceeded` on send | The lane's shared throughput allowance is used up | **Nothing was taken from you.** Retry shortly — the allowance refills continuously. |
| Sent fine, but delivery fails with `InboundRateLimitExceeded` | The destination caps how much it will release per window — a deliberate safety bound, not a fault | **Your tokens are safe.** The message stays valid and delivers itself once the allowance refills. No action needed. |
| `ZeroAmountAfterDust` | Amount below 0.000001 FULA | Send a larger amount. |
| `ERC20InsufficientAllowance` | No approval | Approve first. |
| `NoPeer` | The lane is not wired, or was halted | Wait — this is an operator action. |
| Sent, but nothing arrived | Delivery is blocked on the destination | See below. Your tokens are safe. |

**If a transfer is stuck after sending, it is delayed, not lost.** A failed delivery leaves the
message committed on the destination and it can be retried by anyone, forever. Causes:

- **`InsufficientLiquidity`** — the destination adapter does not currently hold enough to pay you.
  This is specific to a lock/release bridge. It resolves when the operators top up that side, and
  the message then delivers automatically on retry.
- **Recipient blacklisted, or the token paused** on the destination.
- **Out of gas** in destination execution.

Track any transfer at [layerzeroscan.com](https://layerzeroscan.com) using the source transaction
hash (use `testnet.layerzeroscan.com` for Sepolia).

## The honest limitation

Because the bridge releases from a pre-funded balance rather than minting, **a chain can only pay
out what it holds.** If far more value flows one direction than the other, the receiving side's
balance runs down and transfers into it park until it is replenished.

This is the deliberate trade for a bridge that never mints: no contract anywhere has the power to
create FULA, and nothing can touch your tokens without your allowance. Liquidity is an operational
duty rather than a risk to your funds — a parked transfer is recoverable in full.

There is a second, related limit you may meet: each chain caps how much it will release per rolling
window. That bound exists so that if a message were ever wrongly authorised, it could not empty the
escrow in one transaction. It applies to everyone equally, and a transfer that exceeds it is
**delayed, never lost** — the message stays valid and goes through once the window refills.
