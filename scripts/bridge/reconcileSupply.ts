// DAILY SUPPLY RECONCILIATION — the canary for the entire constant-supply property.
//
// Read-only. Queries every live chain directly (it does NOT use --network, because it must talk to
// all of them in one run) and checks the invariants that would break first if the bridge ever
// minted tokens it did not burn.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Under the escrow design the bridge cannot mint or burn at
// all, so ANY change in global supply is by definition NOT the bridge — which makes this a very
// sharp instrument: there is no legitimate bridge activity for a supply movement to hide behind.
// A delta here means either `bridgeOp` was used (a deliberate, separately-authorised operation) or
// something is wrong.
//
// The escrow balances are the second half of the picture. `escrow_A + escrow_B` is conserved by
// ordinary bridging — every transfer moves the same amount from one side to the other — so a fall
// in the TOTAL escrowed is the signal that matters, and it is what a drain would look like.
//
// KEEP THE ADAPTER ADDRESSES BELOW CURRENT. This script silently watched a two-generation-old
// adapter after the escrow redesign and reported a permanent false "escrow is EMPTY" alarm while
// being blind to the real one. Watching the wrong address is worse than watching nothing.
//
// USAGE:
//   npx hardhat run scripts/bridge/reconcileSupply.ts
//
//   Optional env:
//     ETHEREUM_RPC / BASE_RPC / SKALE_RPC / IOTEX_RPC   override the default endpoints
//     ETHEREUM_ADAPTER / BASE_ADAPTER                   adapter addresses (once deployed)
//     STATE_FILE=path                                   history file (default .reconcile/state.json)
//     STRICT=1                                          exit non-zero on warnings too
//
// EXIT CODES:  0 = clean (warnings may still print) · 1 = ALARM, investigate immediately
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

const TOTAL_SUPPLY = 2_000_000_000n * 10n ** 18n;

/** ERC20 + StorageToken + bridge accounting surface, as raw selectors we can call anywhere. */
const TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function paused() view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

interface ChainCfg {
  name: string;
  rpc: string;
  proxy: string;
  /** Adapter address, once one is deployed and authorized on this chain. */
  adapter?: string;
  /** Whether this chain participates in the LayerZero bridge. */
  bridged: boolean;
}

/**
 * Stage-0 testnet deployment (see scripts/bridge/testnet-deployments.md). Selected with TESTNET=1.
 * Both chains share the same addresses — same fresh deployer, same nonce sequence.
 * Run reconciliation here THROUGHOUT the rehearsal, not just on mainnet: the rehearsal is the only
 * chance to see supply conservation and the escrow balances respond to real cross-chain traffic
 */
const TESTNET_CHAINS: ChainCfg[] = [
  {
    name: "Sepolia",
    rpc: process.env.SEPOLIA_RPC?.trim() || "https://ethereum-sepolia.publicnode.com",
    proxy: "0x32d6929c9F552068D54481FeAe75674fD29F337e",
    // CURRENT escrow adapter. Superseded, and must never be watched here:
    // 0xf3AC78cB… and 0x1491E7d1… (mint/burn), 0x1E90000F… (escrow, pre-inbound-limiter).
    // Watching a stale address is worse than watching none: it reports a permanent false
    // "escrow is EMPTY" alarm while staying silent if the REAL escrow were drained.
    adapter: process.env.SEPOLIA_ADAPTER?.trim() || "0x1a93D27cE441e86D3Fe0B2c3C7f76a9B6BA936f3",
    bridged: true,
  },
  {
    name: "BaseSep",
    rpc: process.env.BASE_SEPOLIA_RPC?.trim() || "https://base-sepolia-rpc.publicnode.com",
    proxy: "0x32d6929c9F552068D54481FeAe75674fD29F337e",
    // Superseded here: 0xf3AC78cB…, 0x967d8062… (mint/burn), 0xd07B62b5… (pre-inbound-limiter).
    adapter:
      process.env.BASE_SEPOLIA_ADAPTER?.trim() || "0x6bE953e030C23F4728446112aeD4AdB6ace19eD6",
    bridged: true,
  },
];

const MAINNET_CHAINS: ChainCfg[] = [
  {
    name: "Ethereum",
    rpc: process.env.ETHEREUM_RPC?.trim() || "https://ethereum-rpc.publicnode.com",
    proxy: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
    adapter: process.env.ETHEREUM_ADAPTER?.trim(),
    bridged: true,
  },
  {
    name: "Base",
    rpc: process.env.BASE_RPC?.trim() || "https://mainnet.base.org",
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    adapter: process.env.BASE_ADAPTER?.trim(),
    bridged: true,
  },
  {
    name: "SKALE",
    rpc: process.env.SKALE_RPC?.trim() || "https://mainnet.skalenodes.com/v1/elated-tan-skat",
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    bridged: false,
  },
  {
    name: "IoTeX",
    rpc: process.env.IOTEX_RPC?.trim() || "https://babel-api.mainnet.iotex.io",
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    bridged: false,
  },
];

/** TESTNET=1 reconciles the Stage-0 rehearsal instead of mainnet. */
const IS_TESTNET = process.env.TESTNET?.trim() === "1";
const CHAINS: ChainCfg[] = IS_TESTNET ? TESTNET_CHAINS : MAINNET_CHAINS;
/** The 2B cap is a property of the token, so it applies on the testnet mirror too. */

interface Snapshot {
  name: string;
  reachable: boolean;
  error?: string;
  totalSupply: string;
  paused?: boolean;
  /** FULA held by the lock/release adapter on this chain, i.e. what it can pay out inbound. */
  escrow?: string;
}

interface StateFile {
  timestamp: string;
  snapshots: Snapshot[];
  globalSupply: string;
}

const ONE = 10n ** 18n;
function fmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / ONE;
  const frac = a % ONE;
  const s = whole.toLocaleString("en-US") + (frac ? ` + ${frac} wei` : "");
  return neg ? `-${s}` : s;
}

const alarms: string[] = [];
const warnings: string[] = [];

async function readChain(c: ChainCfg): Promise<Snapshot> {
  const snap: Snapshot = { name: c.name, reachable: false, totalSupply: "0" };
  try {
    const provider = new ethers.JsonRpcProvider(c.rpc);
    const token = new ethers.Contract(c.proxy, TOKEN_ABI, provider);

    snap.totalSupply = (await token.totalSupply()).toString();
    snap.reachable = true;

    try {
      snap.paused = await token.paused();
    } catch {
      /* older impls */
    }
    if (c.adapter) {
      snap.escrow = (await token.balanceOf(c.adapter)).toString();
    }
  } catch (e: any) {
    snap.error = e.shortMessage ?? e.message ?? String(e);
  }
  return snap;
}

/**
 * Load the previous run's state.
 *
 * Distinguishes "no baseline yet" (legitimate first run) from "baseline exists but is unreadable"
 * (a problem). Those must NOT be conflated: an earlier version of this function caught every error
 * and returned null, so a corrupt state file silently disabled the delta check and the script still
 * printed "RECONCILED". A canary that can be switched off by a malformed file is not a canary.
 */
function loadPrevious(file: string): StateFile | null {
  if (!fs.existsSync(file)) return null; // genuine first run

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e: any) {
    alarms.push(
      `State file ${file} EXISTS but could not be read (${e.message}). The run-over-run delta ` +
        `check has NOT been performed. Fix or delete the file — do not ignore this.`
    );
    return null;
  }

  try {
    // Tolerate a UTF-8 BOM, which some editors and shells prepend and JSON.parse rejects.
    return JSON.parse(raw.replace(/^﻿/, "")) as StateFile;
  } catch (e: any) {
    alarms.push(
      `State file ${file} EXISTS but is not valid JSON (${e.message}). The run-over-run delta ` +
        `check has NOT been performed. Fix or delete the file — do not ignore this.`
    );
    return null;
  }
}

async function main() {
  const stateFile =
    process.env.STATE_FILE?.trim() ||
    path.join(".reconcile", IS_TESTNET ? "state-testnet.json" : "state.json");
  const strict = process.env.STRICT?.trim() === "1";

  console.log(`FULA cross-chain supply reconciliation${IS_TESTNET ? "  [TESTNET]" : ""}`);
  console.log(`run at: ${new Date().toISOString()}\n`);

  const snapshots = await Promise.all(CHAINS.map(readChain));

  // ---------------------------------------------------------------- per-chain table
  console.log(
    `${"chain".padEnd(10)} ${"totalSupply".padStart(26)} ${"escrowed".padStart(22)}  paused`
  );
  console.log("-".repeat(70));
  for (const s of snapshots) {
    if (!s.reachable) {
      console.log(`${s.name.padEnd(10)} UNREACHABLE — ${s.error}`);
      continue;
    }
    console.log(
      `${s.name.padEnd(10)} ${fmt(BigInt(s.totalSupply)).padStart(26)} ` +
        `${(s.escrow !== undefined ? fmt(BigInt(s.escrow)) : "n/a").padStart(22)}  ${s.paused ?? "?"}`
    );
  }

  const unreachable = snapshots.filter((s) => !s.reachable);
  if (unreachable.length) {
    warnings.push(
      `${unreachable.length} chain(s) unreachable (${unreachable.map((s) => s.name).join(", ")}) — ` +
        `totals below EXCLUDE them and are therefore not a complete reconciliation.`
    );
  }

  const reachable = snapshots.filter((s) => s.reachable);
  const globalSupply = reachable.reduce((a, s) => a + BigInt(s.totalSupply), 0n);

  console.log(`\nglobal totalSupply (reachable chains): ${fmt(globalSupply)} FULA`);
  console.log(`global hard cap:                       ${fmt(TOTAL_SUPPLY)} FULA`);
  console.log(`headroom:                              ${fmt(TOTAL_SUPPLY - globalSupply)} FULA`);

  // ================================================================
  // CHECK 1 — global supply must never exceed the hard cap.
  // ================================================================
  if (globalSupply > TOTAL_SUPPLY) {
    alarms.push(
      `GLOBAL SUPPLY EXCEEDS THE 2B CAP by ${fmt(globalSupply - TOTAL_SUPPLY)} FULA. ` +
        `Supply has been created that should be impossible. Halt the bridge immediately.`
    );
  }

  // ================================================================
  // CHECK 2 — ESCROW LIQUIDITY. With lock/release, a chain can only pay out inbound transfers
  // from tokens it already custodies. Liquidity — not a mint cap — is what determines whether
  // inbound transfers succeed, so this is the operational canary.
  // ================================================================
  const withEscrow = snapshots.filter((s) => s.reachable && s.escrow !== undefined);
  const bridgedChains = CHAINS.filter((c) => c.bridged);

  if (withEscrow.length === 0) {
    console.log(
      `\nescrow liquidity: NOT CHECKED — no adapter addresses configured.\n` +
        `  Set ETHEREUM_ADAPTER / BASE_ADAPTER once the adapters are live.`
    );
    warnings.push("escrow liquidity not checked — adapter addresses not configured.");
  } else {
    console.log(`\nescrow held by adapters:`);
    let totalEscrow = 0n;
    for (const s of withEscrow) {
      const e = BigInt(s.escrow!);
      totalEscrow += e;
      console.log(`  ${s.name.padEnd(10)} ${fmt(e).padStart(24)} FULA`);
      if (e === 0n) {
        alarms.push(
          `${s.name}: escrow is EMPTY. Every inbound transfer to ${s.name} will revert ` +
            `InsufficientLiquidity and park until it is funded. Users are stuck (not losing funds, ` +
            `but stuck) for as long as this lasts.`
        );
      }
    }
    console.log(`  ${"TOTAL".padEnd(10)} ${fmt(totalEscrow).padStart(24)} FULA locked across the bridge`);
    if (withEscrow.length < bridgedChains.length) {
      warnings.push(
        `Escrow checked on ${withEscrow.length} of ${bridgedChains.length} bridged chains — ` +
          `configure an adapter address for every bridged chain.`
      );
    }
  }

  // ================================================================
  // CHECK 4 — delta vs the previous run.
  // Global supply may legitimately fall (voluntary burns) but must never rise except by a
  // matching bridgeOp mint. Any rise not explained is unexplained supply creation.
  // ================================================================
  const hadStateFile = fs.existsSync(stateFile);
  const previous = loadPrevious(stateFile);
  if (!previous) {
    // Only call it a baseline when there genuinely was no file. If one existed but could not be
    // read, `loadPrevious` has already raised an alarm and saying "establishing baseline" here
    // would paper over it.
    console.log(
      hadStateFile
        ? `\nprevious state at ${stateFile} was UNUSABLE — delta check skipped (see alarm below).`
        : `\nno previous state at ${stateFile} — establishing baseline.`
    );
  } else {
    const prevSupply = BigInt(previous.globalSupply);
    const delta = globalSupply - prevSupply;

    console.log(`\nsince ${previous.timestamp}:`);
    console.log(`  global supply delta:      ${fmt(delta)} FULA`);

    // THE INVARIANT IS STRICTER THAN UNDER MINT/BURN. A lock/release bridge cannot change supply
    // at all — it only moves tokens between users and escrow. So ANY movement is caused by
    // something OUTSIDE the bridge, and every such cause is worth a human look:
    //   increase -> a bridgeOp(op=1) mint by a BRIDGE_OPERATOR (the legacy admin path)
    //   decrease -> a voluntary burn(), burnFrom(), or a bridgeOp(op=2) burn
    // None of these are bridge activity. If none of them happened, the number is unexplained.
    if (delta !== 0n) {
      alarms.push(
        `GLOBAL SUPPLY MOVED by ${fmt(delta)} FULA since the last run. The lock/release bridge ` +
          `CANNOT change supply — it never mints or burns — so this came from somewhere else. ` +
          `Expected causes: a bridgeOp mint/burn by a BRIDGE_OPERATOR, or a holder calling ` +
          `burn()/burnFrom(). Confirm one of those explains it exactly; if not, treat it as an ` +
          `incident.`
      );
    } else {
      console.log(`  => UNCHANGED, exactly as a lock/release bridge requires.`);
    }

    // Escrow movement is normal and is the signal of real bridge usage.
    const prevEscrow = previous.snapshots.reduce((a, s) => a + BigInt(s.escrow || "0"), 0n);
    const nowEscrow = reachable.reduce((a, s) => a + BigInt(s.escrow || "0"), 0n);
    if (prevEscrow !== 0n || nowEscrow !== 0n) {
      console.log(`  total escrow delta:       ${fmt(nowEscrow - prevEscrow)} FULA`);
      console.log(
        `  => escrow moving is normal: it rises on the side users send FROM and falls on the side\n` +
          `     they send TO. A persistent one-way drift means one chain will eventually run dry.`
      );
    }
  }

  // ---------------------------------------------------------------- persist
  const state: StateFile = {
    timestamp: new Date().toISOString(),
    snapshots,
    globalSupply: globalSupply.toString(),
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`\nstate written to ${stateFile}`);

  // ---------------------------------------------------------------- verdict
  console.log(`\n${"=".repeat(72)}`);
  for (const w of warnings) console.log(`WARNING  ${w}`);
  for (const a of alarms) console.log(`ALARM    ${a}`);

  if (alarms.length) {
    console.log(`${"=".repeat(72)}`);
    console.log(`${alarms.length} ALARM(S) — investigate immediately.`);
    process.exit(1);
  }
  if (warnings.length && strict) {
    console.log(`${"=".repeat(72)}`);
    console.log(`${warnings.length} warning(s), STRICT=1 — failing.`);
    process.exit(1);
  }
  console.log(`RECONCILED — supply invariants hold.${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
  console.log(`${"=".repeat(72)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// npx hardhat run scripts/bridge/reconcileSupply.ts
