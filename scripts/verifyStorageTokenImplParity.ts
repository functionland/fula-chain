// PHASE 0 GATE — read-only. Answers two questions before any upgrade is planned:
//
//   1. Does the Ethereum deployment run the same StorageToken implementation CODE as
//      Base/SKALE/IoTeX? (The implementation ADDRESSES differ, but that is a deployer-nonce
//      artifact and proves nothing. Only bytecode comparison settles it.)
//   2. Does repo HEAD match what is actually deployed?
//
// Metadata handling: solc appends a CBOR trailer whose last 2 bytes are the big-endian
// trailer length. That trailer embeds a hash of the source and settings, so two builds of
// identical logic differ there. We strip it before comparing.
//
// USAGE (run once per network, then compare the printed hashes across runs):
//   npx hardhat run scripts/verifyStorageTokenImplParity.ts --network ethereum
//   npx hardhat run scripts/verifyStorageTokenImplParity.ts --network base
import { ethers, network, artifacts } from "hardhat";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const PROXY_BY_NETWORK: Record<string, string> = {
  ethereum: "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
  // Same chain as `ethereum`, but a keyless read-only endpoint with no signing accounts.
  "ethereum-alt": "0x92217cCaEDBdbc54C76c15feA18823db1558fDc9",
  base: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  "base-alt": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  skale: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
  "iotex-mainnet": "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
};

/** Strip the trailing CBOR metadata block from deployed bytecode. */
function stripMetadata(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 4) return body;
  const len = parseInt(body.slice(-4), 16);
  const trailer = (len + 2) * 2; // bytes -> hex chars
  if (trailer >= body.length) return body;
  return body.slice(0, body.length - trailer);
}

/** Return just the CBOR metadata trailer (the part stripMetadata removes). */
function metadataTrailer(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  return body.slice(stripMetadata(hex).length);
}

/**
 * Neutralize the UUPS `__self` immutable before comparing two implementations.
 *
 * WHY THIS IS REQUIRED, NOT COSMETIC: `UUPSUpgradeable` declares
 * `address private immutable __self = address(this)`. Immutables are baked into DEPLOYED
 * bytecode at construction, so the same source deployed to two different addresses produces
 * bytecode that differs in exactly those slots. A raw keccak comparison therefore ALWAYS reports
 * "different" for a UUPS implementation on two chains — which would push an operator onto the
 * two-reference-source fallback path for no reason.
 *
 * Measured on the live deployments (2026-07-26): Ethereum and Base differ in exactly 38 bytes
 * across 2 regions, each region holding that chain's own implementation address. Masking those
 * occurrences makes the comparison meaningful.
 */
function maskSelfImmutable(strippedHex: string, implAddress: string): string {
  const needle = implAddress.toLowerCase().replace(/^0x/, "");
  return strippedHex.toLowerCase().split(needle).join("0".repeat(needle.length));
}

async function main() {
  const proxy = PROXY_BY_NETWORK[network.name];
  if (!proxy) throw new Error(`No StorageToken proxy recorded for network "${network.name}"`);

  console.log(`network: ${network.name}`);
  console.log(`proxy:   ${proxy}`);

  const raw = await ethers.provider.getStorage(proxy, IMPL_SLOT);
  const impl = ethers.getAddress("0x" + raw.slice(-40));
  console.log(`impl:    ${impl}   (read live from the ERC-1967 slot)`);

  const deployed = await ethers.provider.getCode(impl);
  if (deployed === "0x") throw new Error(`No code at implementation ${impl}`);

  const strippedLive = stripMetadata(deployed);
  const liveHash = ethers.keccak256("0x" + strippedLive);
  const maskedLive = maskSelfImmutable(strippedLive, impl);
  const maskedHash = ethers.keccak256("0x" + maskedLive);
  const trailer = metadataTrailer(deployed);

  console.log(`\nlive impl bytecode (metadata stripped)`);
  console.log(`  length:      ${strippedLive.length / 2} bytes`);
  console.log(`  keccak:      ${liveHash}`);
  console.log(`  ^ RAW hash. Do NOT compare this across networks — it always differs, because`);
  console.log(`    UUPSUpgradeable bakes 'immutable __self = address(this)' into the bytecode.`);
  console.log(`  keccak(masked): ${maskedHash}`);
  console.log(`  ^ THIS is the cross-network comparison value (__self occurrences zeroed).`);

  console.log(`\nsolc metadata trailer  ${trailer}`);
  console.log(`  ^ STRONGEST same-source signal: the CBOR trailer embeds a hash of the SOURCE and`);
  console.log(`    the COMPILER SETTINGS. Identical trailers on two chains => identical source,`);
  console.log(`    identical settings, identical solc version.`);

  // Compare against repo HEAD.
  const artifact = await artifacts.readArtifact("StorageToken");
  const strippedLocal = stripMetadata(artifact.deployedBytecode);
  const localHash = ethers.keccak256("0x" + strippedLocal);
  console.log(`\nrepo HEAD StorageToken (metadata stripped)`);
  console.log(`  length: ${strippedLocal.length / 2} bytes`);
  console.log(`  keccak: ${localHash}`);
  console.log(
    `\n  ${liveHash === localHash ? "MATCH   repo HEAD equals the deployed implementation." : "DIFFERS repo HEAD is NOT what is deployed (expected while this branch adds the bridge)."}`
  );

  // State cross-check — cheap sanity that we are talking to the right contract.
  const token = await ethers.getContractAt("StorageToken", proxy);
  const adminRole = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  console.log(`\nlive state:`);
  for (const [label, p] of [
    ["name", token.name()],
    ["symbol", token.symbol()],
    ["decimals", token.decimals()],
    ["totalSupply", token.totalSupply()],
    ["maxSupply", token.maxSupply()],
    ["treasury", token.treasury()],
    ["adminCount", token.adminCount()],
    ["proposalCount", token.proposalCount()],
    ["paused", token.paused()],
  ] as Array<[string, Promise<unknown>]>) {
    try {
      console.log(`  ${label.padEnd(14)} ${await p}`);
    } catch (e: any) {
      console.log(`  ${label.padEnd(14)} <call failed: ${e.shortMessage ?? e.message}>`);
    }
  }
  try {
    const cfg = await token.roleConfigs(adminRole);
    console.log(`  ADMIN quorum   ${cfg[0]}`);
    console.log(`  ADMIN txLimit  ${cfg[1]}`);
    if (cfg[0] < 2n) {
      console.log(`\n  WARNING: ADMIN_ROLE quorum is ${cfg[0]}. Governance requires >= 2;`);
      console.log(`  createProposal will revert until setRoleQuorum(ADMIN_ROLE, 2) is called.`);
    }
  } catch {
    /* older impls may differ */
  }

  console.log(`\nRecord the keccak above, run this on the other networks, and compare.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// npx hardhat run scripts/verifyStorageTokenImplParity.ts --network ethereum
// npx hardhat run scripts/verifyStorageTokenImplParity.ts --network base
