# Seeding and rebalancing escrow liquidity

A lock/release bridge can only pay out what it already holds. This is the operational procedure for
putting FULA into an adapter, and the accounting rules that keep it safe.

Read `docs/bridge-audit-escrow.md` first — the sizing of the inbound rate limit depends on how much
you seed, and the two must be set together.

---

## 1. How much, and on which side

Bridging A→B **locks on A and releases on B**, so a net flow toward a chain **drains that chain's**
escrow. To support 200M net flowing Ethereum→Base, the **Base** adapter needs 200M.

Two independent limits govern this, and they are often confused:

| | Bounds | Fails where |
|---|---|---|
| Outbound rate limit | flow **rate** | source side, nothing locked, retry shortly |
| Escrow liquidity | **cumulative net** flow | destination, parks with `InsufficientLiquidity` |
| Inbound rate limit | how much escrow **one message** can remove | destination, parks, retries when refilled |

Past the cumulative net figure, transfers park while the rate limiter is still perfectly happy. Size
liquidity from expected net *imbalance*, not from the throttle.

**`escrow_A + escrow_B` is conserved.** Every transfer moves the same amount from one side's escrow
to the other's, so the seed is a one-time capital allocation sized to worst-case imbalance, not a
per-period budget. Flow in the opposite direction automatically refills the drained side.

⚠️ **There is no withdraw function. Seeded liquidity cannot be pulled back out directly.** It can
only be moved by bridging it to the other chain through the normal lane. Treat the seed as a
long-term commitment, and prefer starting smaller and topping up over front-loading the maximum.

## 2. Route A — fund from circulating supply (simplest; prefer this)

If the team already holds enough FULA in a wallet on the destination chain, just send it:

```
ERC20.transfer(adapterAddress, amount)
```

A plain transfer checks only the blacklist. **No whitelist, no governance, no role, no nonce, and no
supply accounting is involved.** The adapter needs no privilege of any kind and gains none by
holding tokens.

## 3. Route B — fund from the token contract's own balance

The token contract's balance is reachable only through `transferFromContract`, which requires
`ADMIN_ROLE`, a **whitelisted** recipient, and a per-call transaction limit.

1. **Whitelist the recipient** — governance proposal (2-of-N, 24h to execute), then a further **24h
   whitelist lock** before the address can receive. Budget 48h.
   - You may whitelist the adapter directly, or whitelist a team wallet and relay with a plain
     `transfer`. Whitelisting grants only "may receive from the token contract" — it is not a role
     and confers no power — so either is safe. Relaying keeps the adapter's standing in the token
     exactly zero, which is the cleaner story for an audit.
2. **`transferFromContract(recipient, amount)`**, respecting `roleConfigs[ADMIN_ROLE].transactionLimit`.

Live limits: **500,000,000 per call on Ethereum**, **50,000,000 on Base**. A 200M seed on Base is
therefore **four calls** regardless of recipient.

## 4. Route C — move supply between chains first (`bridgeOp`)

Needed when the destination chain has no spare FULA. **Base's token contract holds only ~4,239
FULA**, so Base liquidity cannot come from its treasury — it must come from circulating supply
(Route A) or from moving supply across with `bridgeOp`.

`bridgeOp` burns on one chain and mints on another. It is pre-existing, Hashlock-audited
functionality and has been used in production before (see `docs/bridge-verification.md`).

**Preconditions — already satisfied on both chains:** `BRIDGE_OPERATOR_ROLE` is held by
`0xc048089D2e1681e5B54dB985749D68970F8c199D` on Ethereum and Base, and has never been revoked. No
new role grant is required.

**Procedure:**

1. **Register a nonce on each chain** — `setBridgeOpNonce(chainId, nonce)`. Requires `ADMIN_ROLE`,
   executes immediately (not a proposal). Each nonce is **single-use** and consumed by `bridgeOp`.
2. **Burn on the source chain** — `bridgeOp(amount, chainId, nonce, 2)`. Burns from the **token
   contract's own balance**, so the source contract must hold at least `amount`.
3. **Mint on the destination chain** — `bridgeOp(amount, chainId, nonce, 1)`. Mints to
   `address(this)` — **into the token contract, not a wallet**.
4. **Move it to the adapter** — this is now Route B, with all of its whitelist and per-call limits.

Per-call limits for `bridgeOp`: **100,000,000 on Ethereum**, **500,000,000 on Base**. Moving 200M out
of Ethereum is therefore **two burns and two nonces**.

### ⚠️ Always burn first, then mint

The burn and the mint are **independent operator actions with no on-chain link between them**.
Nothing enforces that a mint is backed by a corresponding burn.

- Burn first: a failure leaves global supply **too low** — conservative, recoverable, no cap risk.
- Mint first: a failure leaves global supply **too high** — an unbacked increase that breaches the
  accounting the whole design depends on.

Run `scripts/bridge/reconcileSupply.ts` immediately before and after every `bridgeOp`, and record
both outputs. This is exactly the failure it exists to catch.

## 5. After seeding — do not skip these

1. **Check the inbound limit against what you actually seeded.**

   The standing configuration is a flat **20,000,000 / 24h against a 200,000,000 seed** — 10%, on
   both testnet and mainnet. At those numbers nothing needs changing.

   ⚠️ **If you seed less than the limit, the limiter silently stops working.** `_credit` checks
   liquidity *before* the inbound limit, so a limit at or above escrow can never fire: anything
   larger than escrow already reverted `InsufficientLiquidity`, and anything small enough to pass is
   by definition under the limit. It is inert, not merely weak. So if you seed materially less than
   200M, lower the limit to 10–25% of the actual seed. `setInboundRateLimits` is owner-callable.

2. **Run `verifyOAppConfig.ts`** on both chains. It prints the limit as a percentage of escrow,
   **fails** if the limit is at or above escrow (inert), and notes if it is merely above 25%.
3. **Send a small real transfer end to end** before announcing anything.
4. **Then call `lockPeers()`** on both adapters. Irreversible — do it only after the lane is proven,
   and understand that afterwards neither adapter can be replaced without redeploying both and
   migrating liquidity. Until it is called, whoever owns the adapter can repoint a lane and drain the
   entire escrow.

## 6. Rebalancing later

If flow is persistently one-directional, the destination escrow drains and the source accumulates.
To refill the drained side, **bridge tokens in the opposite direction**: hold FULA on the accumulated
side, send it across, and the lock refills that side's escrow while releasing on the other.

No withdraw function is needed for this and none exists. The operator's tokens are not spent — they
simply end up on the other chain.

Monitor `availableLiquidity()` on both adapters continuously. When it approaches zero, inbound
transfers begin parking — recoverable in full, but users are stuck until it is topped up.
