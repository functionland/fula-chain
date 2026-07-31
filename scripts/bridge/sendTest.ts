// Bridge FULA from this chain to the peer chain through the FulaOFTAdapter.
//
// This is the ONE script a token holder needs. It is also what Stage 0 Phase D uses to run the
// first real cross-chain transfer and to measure `lzReceive` gas.
//
// WHAT A HOLDER DOES: one transaction, on the SOURCE chain only. No `approve` is needed — the
// adapter burns the caller's balance directly (`approvalRequired()` is false). Destination gas is
// paid by the LayerZero executor out of the native fee collected here, so you need no gas and no
// transaction on the destination chain.
//
// USAGE:
//   ADAPTER=0x.. REMOTE=base-sepolia AMOUNT=1.5 \
//     npx hardhat run scripts/bridge/sendTest.ts --network sepolia
//
//   Optional:
//     TO=0x..          recipient on the destination chain (default: the sender)
//     EXACT=1          revert rather than silently truncating sub-0.000001 dust
//     FEE_BUFFER_BPS   pad the quoted native fee (default 500 = 5%); the endpoint refunds the excess
//     DRY_RUN=1        quote only, send nothing
import { ethers, network } from "hardhat";
import { chainFor } from "./addresses";

async function main() {
  const local = chainFor(network.name);
  const remoteName = process.env.REMOTE?.trim();
  if (!remoteName) throw new Error("REMOTE not set (the peer network name, e.g. REMOTE=base)");
  const remote = chainFor(remoteName);

  const adapterAddr = process.env.ADAPTER?.trim();
  if (!adapterAddr) throw new Error("ADAPTER not set");

  const amountRaw = process.env.AMOUNT?.trim();
  if (!amountRaw) throw new Error("AMOUNT not set (in whole FULA, e.g. AMOUNT=1.5)");
  const amountLD = ethers.parseEther(amountRaw);

  const dryRun = process.env.DRY_RUN === "1";
  const exact = process.env.EXACT === "1";
  const bufferBps = BigInt(process.env.FEE_BUFFER_BPS?.trim() || "500");

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer configured for this network");
  const to = process.env.TO?.trim() || signer.address;
  if (!ethers.isAddress(to)) throw new Error(`TO is not a valid address: ${to}`);

  const adapter = await ethers.getContractAt("FulaOFTAdapter", adapterAddr);
  const token = await ethers.getContractAt("StorageToken", await adapter.token());

  console.log(`network:   ${network.name} (eid ${local.eid})  ->  ${remoteName} (eid ${remote.eid})`);
  console.log(`adapter:   ${adapterAddr}`);
  console.log(`token:     ${await adapter.token()}`);
  console.log(`sender:    ${signer.address}`);
  console.log(`recipient: ${to}${to === signer.address ? "  (self)" : ""}`);
  console.log(`amount:    ${ethers.formatEther(amountLD)} FULA`);

  // --- dust ------------------------------------------------------------
  // sharedDecimals is 6 while FULA has 18, so transfers are quantised to 1e12 wei. The remainder
  // is NOT destroyed and NOT sent — it simply stays in the sender's wallet.
  const rate: bigint = await adapter.decimalConversionRate();
  const dust = amountLD % rate;
  if (dust !== 0n) {
    console.log(
      `\n  note: ${ethers.formatEther(dust)} FULA of dust will stay in your wallet ` +
        `(transfers are quantised to ${ethers.formatEther(rate)} FULA).`
    );
    if (exact) console.log(`  EXACT=1 is set, so this send will revert instead.`);
  }

  const balance: bigint = await token.balanceOf(signer.address);
  console.log(`balance:   ${ethers.formatEther(balance)} FULA`);
  if (balance < amountLD) {
    throw new Error(
      `Insufficient FULA: have ${ethers.formatEther(balance)}, need ${ethers.formatEther(amountLD)}`
    );
  }

  const sendParam = {
    dstEid: remote.eid,
    to: ethers.zeroPadValue(to, 32),
    amountLD,
    // `minAmountLD` is a slippage floor. Setting it equal to the amount makes any dust truncation
    // a revert instead of a silent round-down.
    minAmountLD: exact ? amountLD : 0n,
    extraOptions: "0x", // enforced options supply the destination gas floor
    composeMsg: "0x", // this adapter rejects composed messages
    oftCmd: "0x",
  };

  // --- quote -----------------------------------------------------------
  // `quoteSend` reverts SlippageExceeded (EXACT=1 + dust) and NoPeer (unwired lane) here, before
  // any state changes. It does NOT check the rate limit, so a quote can succeed while the send
  // reverts RateLimitExceeded — that failure is source-side and burns nothing.
  const fee = await adapter.quoteSend(sendParam, false);
  const padded = (fee.nativeFee * (10000n + bufferBps)) / 10000n;
  console.log(`\nquoted fee: ${ethers.formatEther(fee.nativeFee)} ${network.name.includes("base") ? "ETH" : "ETH"}`);
  console.log(`paying:     ${ethers.formatEther(padded)}  (+${bufferBps} bps buffer; the endpoint refunds the excess)`);

  const nativeBal = await ethers.provider.getBalance(signer.address);
  if (nativeBal < padded) {
    throw new Error(
      `Insufficient native balance for the LayerZero fee: have ${ethers.formatEther(nativeBal)}, need ${ethers.formatEther(padded)}`
    );
  }

  // Show what the rate limiter will allow, so a RateLimitExceeded is predictable rather than a surprise.
  try {
    const [inFlight, canSend] = await adapter.getAmountCanBeSent(remote.eid);
    console.log(`rate limit: ${ethers.formatEther(canSend)} FULA currently sendable (in flight ${ethers.formatEther(inFlight)})`);
    if (canSend < amountLD) {
      console.log(`  ⚠ this send exceeds the currently available allowance and will revert RateLimitExceeded.`);
      console.log(`    Nothing is burned when that happens — wait for the bucket to refill and retry.`);
    }
  } catch {
    /* older adapters may not expose it */
  }

  // Destination liquidity: this is a lock/release bridge, so the far side can only pay out what
  // it already holds. Warn before spending a fee on a transfer that will park on arrival.
  console.log(
    `\nNOTE: this is a LOCK/RELEASE bridge. Your tokens are escrowed here and an equal amount is\n` +
      `released from the adapter's balance on ${remoteName}. Nothing is minted or burned, so the\n` +
      `global supply never changes. If the destination adapter is short of liquidity the message\n` +
      `PARKS and stays retryable — your tokens are recoverable, not lost.`
  );

  if (dryRun) {
    console.log(`\nDRY_RUN=1 — not sending.`);
    return;
  }

  // --- approve ---------------------------------------------------------
  // An escrow adapter pulls tokens with transferFrom, so it needs an allowance.
  // `approvalRequired()` is true — this is the one extra transaction versus a mint/burn bridge.
  const allowance: bigint = await token.allowance(signer.address, adapterAddr);
  if (allowance < amountLD) {
    console.log(`\napproving ${ethers.formatEther(amountLD)} FULA to the adapter ...`);
    const atx = await token.approve(adapterAddr, amountLD);
    await atx.wait();
    console.log(`  ok (${atx.hash})`);
  } else {
    console.log(`\nallowance already sufficient (${ethers.formatEther(allowance)} FULA)`);
  }

  // --- send ------------------------------------------------------------
  const supplyBefore: bigint = await token.totalSupply();
  const escrowBefore: bigint = await adapter.availableLiquidity();
  const tx = await adapter.send(
    sendParam,
    { nativeFee: padded, lzTokenFee: 0n },
    signer.address, // refund address for the unused portion of the fee
    { value: padded }
  );
  console.log(`\nsent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`mined in block ${receipt!.blockNumber}, gas used ${receipt!.gasUsed}`);

  const supplyAfter: bigint = await token.totalSupply();
  const escrowAfter: bigint = await adapter.availableLiquidity();
  console.log(`\nsource totalSupply: ${ethers.formatEther(supplyBefore)} -> ${ethers.formatEther(supplyAfter)}`);
  console.log(
    supplyAfter === supplyBefore
      ? `  UNCHANGED, as it must be — this bridge never mints or burns.`
      : `  *** SUPPLY MOVED. That should be impossible for a lock/release bridge. Investigate. ***`
  );
  console.log(`escrow here:        ${ethers.formatEther(escrowBefore)} -> ${ethers.formatEther(escrowAfter)}`);
  console.log(`locked into escrow: ${ethers.formatEther(escrowAfter - escrowBefore)} FULA`);

  // Surface the GUID so delivery can be followed.
  const guid = receipt!.logs
    .map((l) => {
      try {
        return adapter.interface.parseLog(l as any);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "OFTSent")?.args?.guid;
  if (guid) console.log(`GUID:               ${guid}`);
  console.log(`\nTrack delivery: https://testnet.layerzeroscan.com/tx/${tx.hash}`);
  console.log(`(use layerzeroscan.com for mainnet)`);
  console.log(
    `\nThe destination mint happens in a separate transaction executed by the LayerZero executor.\n` +
      `If it reverts (recipient blacklisted, token paused, minter cap reached) the message PARKS and\n` +
      `stays retryable forever — the tokens are not lost. Clear the condition and re-execute.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// ADAPTER=0x.. REMOTE=base-sepolia AMOUNT=1.5 npx hardhat run scripts/bridge/sendTest.ts --network sepolia
// ADAPTER=0x.. REMOTE=sepolia      AMOUNT=1.5 npx hardhat run scripts/bridge/sendTest.ts --network base-sepolia
