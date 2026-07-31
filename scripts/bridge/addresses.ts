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
// ⚠️ EVERY OPERATOR RUNS SEVERAL DVN ADDRESSES PER CHAIN, AND ONLY SOME SERVE A GIVEN LANE.
// "LayerZero Labs" resolves to at least two live, non-deprecated addresses on both Ethereum and
// Base; so does "Nethermind". Picking the wrong one produces a configuration that looks perfect —
// the ULN digests match across chains, every simulation passes, `setConfig` succeeds — and then
// messages hang forever in status BLOCKED, because the DVNs you required are not watching this
// lane and never attest.
//
// THAT IS NOT HYPOTHETICAL: it happened on the first real mainnet transfer (2026-07-31). The
// original values here were copied from documentation. The values below were instead taken from
// the LIVE DEFAULT ULN CONFIG on each chain (`getUlnConfig(address(0), remoteEid)`) and confirmed
// against LayerZero's DVN metadata API, which is the only reliable source.
//
// IF YOU CHANGE THESE, VERIFY THE SAME WAY. Do not copy from a docs page.
export const DVNS: Record<string, Record<string, string>> = {
  ethereum: {
    // Both are in Ethereum's live default required set for the Base lane.
    layerzero: "0x589dEDbD617e0CBcB916A9223F4d1300c294236b",
    nethermind: "0xa59BA433ac34D2927232918Ef5B2eaAfcF130BA5",
    horizen: "0x380275805876Ff19055EA900CDb2B46a94ecF20D",
    canary: "0xa4fE5A5B9A846458a70Cd0748228aED3bF65c2cd",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
    polyhedra: "0xE014fe8c4d5C23EDB7AC4011F226e869ac7Ef5CC",
    // Superseded — do NOT use. Live contract, but does not serve the Ethereum<->Base lane.
    nethermindInactive: "0xF4064220871e3B94Ca6aB3b0CEE8e29178bF47dE",
  },
  base: {
    // Both appear in Base's on-chain default set for this lane (Nethermind in 16 of 16 lanes).
    layerzero: "0x9e059a54699a285714207b43B055483E78FAac25",
    nethermind: "0xcd37CA043f8479064e10635020c65FfC005d36f6",
    horizen: "0xa7b5189bcA84Cd304D8553977c7C614329750d99",
    canary: "0x554833698Ae0FB22ECC90B01222903fD62CA4B47",
    googleCloud: "0xD56e4eAb23cb81f43168F9F45211Eb027b9aC7cc",
    polyhedra: "0xE014fe8c4d5C23EDB7AC4011F226e869ac7Ef5CC",
    // Superseded — do NOT use. This is what was wrongly configured on 2026-07-31.
    layerzeroInactive: "0xB1473AC9f58FB27597a21710da9D1071841E8163",
    // NO on-chain provenance: appears in 0 of 24 default configs on Base. It attested one packet
    // and the metadata API labels it "Nethermind", but that is off-chain evidence only. Rejected.
    nethermindUnverified: "0x658947bc7956aea0067a62cf87ab02ae199ef3f3",
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
 * THRESHOLD VERIFICATION — the DVN set is configured as OPTIONAL DVNs with a threshold, not as a
 * fixed list of REQUIRED ones.
 *
 * WHY. Requiring exactly two named DVNs means either of them going offline, rotating addresses or
 * dropping the lane hangs EVERY message permanently — the failure is silent (status BLOCKED) and
 * only recoverable by a governance config change. That is a standing liveness risk that no amount
 * of address-checking removes.
 *
 * With `optionalDVNThreshold = 2` over the four operators LayerZero itself runs on this lane, any
 * two attestations verify a message. Security is unchanged — still two independent verifiers, the
 * property whose absence caused the ~$292M Kelp loss — but three of the four can disappear before
 * the bridge stalls.
 *
 * `verifyOAppConfig` computes `effective = requiredDVNCount + optionalDVNThreshold`, so this still
 * satisfies the "at least 2 independent verifiers" gate.
 *
 * EVERY address below appears in the chain's own on-chain default ULN config for this lane —
 * confirmed by reading `getUlnConfig(address(0), remoteEid)`, not from documentation and not from
 * any off-chain API. An earlier revision proposed 0x658947bc… on Base on the strength of a
 * metadata lookup plus one observed attestation; it appears in ZERO of 24 on-chain default configs
 * and was removed.
 */
export const THRESHOLD_DVNS: Record<string, { operators: string[]; threshold: number }> = {
  ethereum: { operators: ["layerzero", "nethermind", "horizen", "canary"], threshold: 2 },
  base: { operators: ["layerzero", "nethermind", "horizen", "canary"], threshold: 2 },
};

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
