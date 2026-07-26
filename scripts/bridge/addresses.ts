// Single source of truth for LayerZero v2 + FULA bridge addresses.
//
// VERIFY BEFORE MAINNET USE against the official list:
//   https://docs.layerzero.network/v2/deployments/deployed-contracts
// LayerZero occasionally adds/rotates message libraries and DVNs.

export interface LzChain {
  /** hardhat network name */
  network: string;
  /** LayerZero endpoint id (v2) */
  eid: number;
  /** EndpointV2 */
  endpoint: string;
  sendUln302: string;
  receiveUln302: string;
  executor: string;
  /** FULA StorageToken proxy on this chain (undefined on testnets until deployed) */
  token?: string;
}

export const CHAINS: Record<string, LzChain> = {
  ethereum: {
    network: "ethereum",
    eid: 30101,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0xbB2Ea70C9E858123480642Cf96acbcCE1372dCe1",
    receiveUln302: "0xc02Ab410f0734EFa3F14628780e6e695156024C2",
    executor: "0x173272739Bd7Aa6e4e214714048a9fE699453059",
    token: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
  },
  base: {
    network: "base",
    eid: 30184,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    sendUln302: "0xB5320B0B3a13cC860893E2Bd79FCd7e13484Dda2",
    receiveUln302: "0xc70AB6f32772f59fBfc23889Caf4Ba3376C84bAf",
    executor: "0x2CCA08ae69E0C44b18a57Ab2A87644234dAebaE4",
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  },
  sepolia: {
    network: "sepolia",
    eid: 40161,
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    sendUln302: "0xcc1ae8Cf5D3904Cef3360A9532B477529b177cCE",
    receiveUln302: "0xdAf00F5eE2158dD58E0d3857851c432E34A3A851",
    executor: "0x718B92b5CB0a5552039B593faF724D182A881eDA",
  },
  "base-sepolia": {
    network: "base-sepolia",
    eid: 40245,
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    sendUln302: "0xC1868e054425D378095A003EcbA3823a5D0135C9",
    receiveUln302: "0x12523de19dc41c91F7d2093E0CFbB76b17012C8d",
    executor: "0x8A3D588D9f6AC041476b094f97FF94ec30169d3D",
  },
};

/**
 * DVNs per chain.
 *
 * SECURITY: never configure a single DVN. A 1-of-1 configuration is what enabled the
 * ~$292M Kelp/rsETH loss in April 2026, and LayerZero now bans it. Use at least two
 * INDEPENDENT operators. The `requiredDVNs` array passed to setConfig must be sorted
 * ascending and deduplicated or UlnBase reverts with LZ_ULN_Unsorted.
 */
export const DVNS: Record<string, Record<string, string>> = {
  ethereum: {
    layerzero: "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
    nethermind: "0xF4064220871e3B94Ca6aB3b0CEE8e29178bF47dE",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
    horizen: "0x2f0BA3DbB93CF087e32c15Aab46726FDb4Fb24cf",
    polyhedra: "0xE014fe8c4d5C23EDB7AC4011F226e869ac7Ef5CC",
  },
  base: {
    layerzero: "0xB1473AC9f58FB27597a21710da9D1071841E8163",
    nethermind: "0xcd37CA043f8479064e10635020c65FfC005d36f6",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
    horizen: "0x3a4636E9AB975d28d3Af808b4e1c9fd936374E30",
    polyhedra: "0xE014fe8c4d5C23EDB7AC4011F226e869ac7Ef5CC",
  },
  // TESTNETS: only the LayerZero Labs DVN operates on these lanes. Read from the live default
  // ULN config on 2026-07-26 via `scripts/bridge/readLzDefaults.ts` (requiredDVNCount == 1 in
  // both directions) rather than copied from a doc page.
  sepolia: {
    layerzero: "0x8eebf8b423B73bFCa51a1Db4B7354AA0bFCA9193",
  },
  "base-sepolia": {
    layerzero: "0xe1a12515F9AB2764b887bF60B923Ca494EBbB2d6",
  },
};

/** Default policy: two independent required DVNs. */
export const DEFAULT_REQUIRED_DVNS = ["layerzero", "nethermind"];

/**
 * Networks where a SINGLE required DVN is tolerated.
 *
 * Testnets only, and only because LayerZero runs just one DVN there — a 1-of-1 set cannot be
 * avoided, and refusing outright would make the Stage-0 rehearsal impossible. The rehearsal still
 * exercises everything that matters mechanically: the ABI encoding, the ascending-sorted
 * requiredDVNs rule, and the send-side-A == receive-side-B symmetry that R-07 is about.
 *
 * NEVER add a mainnet here. A 1-of-1 DVN configuration is what enabled the ~$292M Kelp/rsETH loss.
 */
const SINGLE_DVN_ALLOWED = new Set(["sepolia", "base-sepolia"]);

export function requiredDvnAddresses(network: string, names?: string[]): string[] {
  const table = DVNS[network];
  if (!table) throw new Error(`No DVN table for network "${network}"`);

  // On a single-DVN testnet, default to whatever that network actually has rather than to the
  // mainnet ["layerzero","nethermind"] policy, which would throw on an unknown name.
  const wanted = names ?? (SINGLE_DVN_ALLOWED.has(network) ? Object.keys(table) : DEFAULT_REQUIRED_DVNS);

  const addrs = wanted.map((n) => {
    const a = table[n];
    if (!a) throw new Error(`Unknown DVN "${n}" on ${network}`);
    return a;
  });

  if (addrs.length < 2) {
    if (!SINGLE_DVN_ALLOWED.has(network)) {
      throw new Error(
        `Refusing to build a DVN config with fewer than 2 required DVNs on "${network}". ` +
          `A 1-of-1 DVN set is the configuration behind the ~$292M Kelp loss.`
      );
    }
    console.warn(
      `\n  WARNING: ${network} has only ${addrs.length} DVN (${addrs.join(", ")}).\n` +
        `  Permitted because it is a TESTNET and LayerZero operates no second DVN there.\n` +
        `  This configuration must NEVER be used on mainnet.\n`
    );
  }

  // Ascending, deduplicated — UlnBase reverts LZ_ULN_Unsorted otherwise.
  return [...new Set(addrs.map((a) => a.toLowerCase()))].sort();
}

export function chainFor(network: string): LzChain {
  const c = CHAINS[network];
  if (!c) throw new Error(`No LayerZero config for network "${network}"`);
  return c;
}
