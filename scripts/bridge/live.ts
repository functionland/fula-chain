// Shared constants and helpers for working against the LIVE StorageToken deployments.
// Used by the fork rehearsal, the fork tests, and the mainnet pre-deploy checks so all
// three agree on addresses, slots and what "unchanged state" means.
import { ethers } from "hardhat";

/** ERC-1967 implementation slot. */
export const IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
export const BRIDGE_OPERATOR_ROLE = ethers.keccak256(
  ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE")
);

/** Governance proposal types. 12/13 are contract-local to StorageToken. */
export const PROPOSAL = {
  ADD_ROLE: 1,
  UPGRADE: 3,
  ADD_WHITELIST: 5,
  ADD_BLACKLIST: 9,
  REMOVE_BLACKLIST: 10,
  CHANGE_TREASURY_FEE: 11,
  SET_BRIDGE_MINTER: 12,
  REMOVE_BRIDGE_MINTER: 13,
} as const;

export const ROLE_CHANGE_DELAY = 24 * 60 * 60;
export const MIN_PROPOSAL_EXECUTION_DELAY = 24 * 60 * 60;
export const PROPOSAL_TIMEOUT = 48 * 60 * 60;

/**
 * Live StorageToken proxies and the implementation each currently points at.
 * Source: scripts/checkProxyStorage.ts.
 *
 * NOTE: Ethereum's IMPLEMENTATION address equals the PROXY address on Base/SKALE/IoTeX.
 * That is a deployer-nonce coincidence (same deployer, same nonce, different chains) and is
 * NOT evidence the chains run different code. Use verifyStorageTokenImplParity.ts to compare
 * actual bytecode.
 */
export const LIVE: Record<
  string,
  { proxy: string; expectedImpl: string; chainId: number }
> = {
  ethereum: {
    proxy: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
    expectedImpl: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    chainId: 1,
  },
  base: {
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    expectedImpl: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
    chainId: 8453,
  },
  skale: {
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    expectedImpl: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
    chainId: 2046399126,
  },
  "iotex-mainnet": {
    proxy: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    expectedImpl: "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb",
    chainId: 4689,
  },
};

/**
 * Storage slots of the CURRENTLY DEPLOYED StorageToken ("Legacy" group; first child slot 11).
 * GovernanceModule occupies 0..10. See contracts/UPGRADING.md.
 */
export const SLOTS = {
  adminCount: 0,
  proposals: 1,
  pendingProposals: 2,
  timeConfigs: 3,
  roleConfigs: 4,
  upgradeProposals: 5,
  proposalIndex: 6,
  proposalCount: 7,
  proposalRegistry: 8,
  govPackedVars: 9,
  pendingOwnerRequest: 10,
  usedNonces: 11,
  blacklisted: 12,
  treasury: 13,
  platformFeeBps: 14,
  tokenPackedVars: 15,
  // Appended by this upgrade — MUST currently read as zero on every live proxy.
  bridgeMinters: 16,
  voluntarilyBurned: 17,
  gapStart: 18,
  gapEnd: 64,
} as const;

/** A snapshot of everything that must be byte-identical across an upgrade. */
export interface StateSnapshot {
  name: string;
  symbol: string;
  decimals: bigint;
  totalSupply: bigint;
  maxSupply: bigint;
  treasury: string;
  adminCount: bigint;
  proposalCount: bigint;
  paused: boolean;
  owner: string;
  adminQuorum: bigint;
  adminTxLimit: bigint;
  contractBalance: bigint;
  balances: Record<string, bigint>;
  rawSlots: Record<number, string>;
}

export async function snapshotState(
  proxy: string,
  extraHolders: string[] = []
): Promise<StateSnapshot> {
  const token = await ethers.getContractAt("StorageToken", proxy);

  const balances: Record<string, bigint> = {};
  for (const h of extraHolders) {
    balances[h.toLowerCase()] = await token.balanceOf(h);
  }

  const rawSlots: Record<number, string> = {};
  for (const s of [
    SLOTS.adminCount,
    SLOTS.proposalCount,
    SLOTS.treasury,
    SLOTS.platformFeeBps,
    SLOTS.tokenPackedVars,
    SLOTS.bridgeMinters,
    SLOTS.voluntarilyBurned,
  ]) {
    rawSlots[s] = await ethers.provider.getStorage(proxy, s);
  }

  const roleCfg = await token.roleConfigs(ADMIN_ROLE);

  return {
    name: await token.name(),
    symbol: await token.symbol(),
    decimals: BigInt(await token.decimals()),
    totalSupply: await token.totalSupply(),
    maxSupply: await token.maxSupply(),
    treasury: await token.treasury(),
    adminCount: await token.adminCount(),
    proposalCount: await token.proposalCount(),
    paused: await token.paused(),
    owner: await token.owner(),
    adminQuorum: BigInt(roleCfg[0]),
    adminTxLimit: BigInt(roleCfg[1]),
    contractBalance: await token.balanceOf(proxy),
    balances,
    rawSlots,
  };
}

/** Compare two snapshots. Returns a list of human-readable differences (empty = identical). */
export function diffSnapshots(before: StateSnapshot, after: StateSnapshot): string[] {
  const diffs: string[] = [];
  const scalarKeys: Array<keyof StateSnapshot> = [
    "name",
    "symbol",
    "decimals",
    "totalSupply",
    "maxSupply",
    "treasury",
    "adminCount",
    "proposalCount",
    "paused",
    "owner",
    "adminQuorum",
    "adminTxLimit",
    "contractBalance",
  ];
  for (const k of scalarKeys) {
    const a = before[k];
    const b = after[k];
    const an = typeof a === "string" ? a.toLowerCase() : a;
    const bn = typeof b === "string" ? b.toLowerCase() : b;
    if (an !== bn) diffs.push(`${String(k)}: ${a} -> ${b}`);
  }
  for (const [addr, bal] of Object.entries(before.balances)) {
    if (after.balances[addr] !== bal) {
      diffs.push(`balance[${addr}]: ${bal} -> ${after.balances[addr]}`);
    }
  }
  // Slots 16/17 are newly used by this upgrade, so they are allowed to change from zero.
  for (const [slot, val] of Object.entries(before.rawSlots)) {
    const n = Number(slot);
    if (n === SLOTS.bridgeMinters || n === SLOTS.voluntarilyBurned) continue;
    if (after.rawSlots[n] !== val) {
      diffs.push(`slot ${n}: ${val} -> ${after.rawSlots[n]}`);
    }
  }
  return diffs;
}

/** Strip solc's trailing CBOR metadata so two builds of the same logic compare equal. */
export function stripMetadata(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 4) return body;
  const len = parseInt(body.slice(-4), 16);
  const trailer = (len + 2) * 2;
  if (trailer >= body.length || Number.isNaN(len)) return body;
  return body.slice(0, body.length - trailer);
}

export async function readImplementation(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

export function fmt(n: bigint): string {
  return `${ethers.formatEther(n)} FULA`;
}
