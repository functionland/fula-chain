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
  base: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
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
  console.log(`\nlive impl bytecode (metadata stripped)`);
  console.log(`  length: ${strippedLive.length / 2} bytes`);
  console.log(`  keccak: ${liveHash}`);
  console.log(`  ^ compare this value across networks to answer "same implementation?"`);

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
