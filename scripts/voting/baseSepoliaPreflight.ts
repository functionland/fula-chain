// READ-ONLY pre-flight for the CommunityVoting live rehearsal on Base Sepolia.
//
// Sends no transactions and costs nothing. Run this before anything else: the rehearsal wallets
// are deliberately low on gas, so every assumption is worth checking while checking is free.
//
//   npx hardhat run scripts/voting/baseSepoliaPreflight.ts --network base-sepolia
import hre, { ethers } from "hardhat";

const TOKEN = "0x32d6929c9F552068D54481FeAe75674fD29F337e";
const EXPECTED_ADMIN_1 = "0x694451c22627eff3Dd8C2D7002197e69FC687e7C";
const EXPECTED_ADMIN_2 = "0x68d36F6A4898C31292bdFE60B4219009C647a1bD";
const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

/** StorageToken keeps platformFeeBps private; read it straight from its storage slot. */
const FEE_SLOT = 14;

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network       : ${hre.network.name} (chainId ${net.chainId})`);
  if (net.chainId !== 84532n) throw new Error(`Expected Base Sepolia (84532), got ${net.chainId}`);

  const signers = await ethers.getSigners();
  console.log(`signers       : ${signers.length}`);
  if (signers.length < 2) {
    throw new Error(
      "Need TWO signers. Governance quorum is 2 and createProposal auto-approves for its " +
        "proposer, so a second distinct admin must approve. Set PK_TEST and ADMIN_PK_TEST."
    );
  }
  const [a1, a2] = signers;

  console.log(`\n--- wallets ---`);
  let lowGas = false;
  for (const [label, signer, expected] of [
    ["admin1", a1, EXPECTED_ADMIN_1],
    ["admin2", a2, EXPECTED_ADMIN_2],
  ] as const) {
    const bal = await ethers.provider.getBalance(signer.address);
    const match = signer.address.toLowerCase() === expected.toLowerCase() ? "OK" : "MISMATCH";
    console.log(`${label} : ${signer.address}  [${match}]  ${ethers.formatEther(bal)} ETH`);
    if (match === "MISMATCH") throw new Error(`${label} is not the expected wallet`);
    if (bal < ethers.parseEther("0.0003")) lowGas = true;
  }

  console.log(`\n--- token ${TOKEN} ---`);
  const token = await ethers.getContractAt("StorageToken", TOKEN);
  const [symbol, decimals, supply, paused] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
    token.paused(),
  ]);
  console.log(`symbol/dec    : ${symbol} / ${decimals}`);
  console.log(`totalSupply   : ${ethers.formatEther(supply)}`);
  console.log(`paused        : ${paused}`);
  if (symbol !== "FULA") throw new Error(`Expected FULA, found ${symbol}`);

  const feeRaw = await ethers.provider.getStorage(TOKEN, FEE_SLOT);
  console.log(`platformFeeBps: ${BigInt(feeRaw)}`);

  const quorum = (await token.roleConfigs(ADMIN_ROLE)).quorum;
  console.log(`token quorum  : ${quorum}`);
  for (const [label, signer] of [["admin1", a1], ["admin2", a2]] as const) {
    const hasRole = await token.hasRole(ADMIN_ROLE, signer.address);
    console.log(`${label} ADMIN_ROLE : ${hasRole}`);
  }

  console.log(`\n--- FULA availability (the gating question) ---`);
  const block = await ethers.provider.getBlock("latest");
  const now = block!.timestamp;
  console.log(`chain time    : ${fmtTime(now)}`);
  console.log(`contract-held : ${ethers.formatEther(await token.balanceOf(TOKEN))} FULA`);

  let spendableNow = 0n;
  for (const [label, signer] of [["admin1", a1], ["admin2", a2]] as const) {
    const bal = await token.balanceOf(signer.address);
    spendableNow += bal;
    const tc = await token.timeConfigs(signer.address);
    const unlock = Number(tc.whitelistLockTime);
    const state =
      unlock === 0
        ? "NOT whitelisted"
        : now >= unlock
        ? `whitelisted, UNLOCKED (since ${fmtTime(unlock)})`
        : `whitelisted, locked until ${fmtTime(unlock)}  (${Math.ceil((unlock - now) / 3600)}h away)`;
    console.log(`${label} : ${ethers.formatEther(bal)} FULA  |  ${state}`);
  }

  console.log(`\n--- what this means for the rehearsal ---`);
  // Governance-layer checks need no FULA at all; the voting flow does.
  const CREATE_COST = ethers.parseEther("150000"); // 50k burn fee + 100k deposit, at defaults
  if (spendableNow >= CREATE_COST) {
    console.log(`Wallets hold enough FULA to create a subject (needs ${ethers.formatEther(CREATE_COST)}).`);
    console.log(`FULL rehearsal possible: governance layer AND the create -> vote -> claim flow.`);
  } else {
    console.log(`Wallets hold ${ethers.formatEther(spendableNow)} FULA; creating a subject needs`);
    console.log(`${ethers.formatEther(CREATE_COST)} at default parameters.`);
    console.log(`=> The GOVERNANCE layer is still fully testable now (it touches no tokens):`);
    console.log(`   deploy, initialize, setRoleQuorum, the Recovery block, every parameter bound,`);
    console.log(`   canonical-field enforcement, and proposal creation/approval.`);
    console.log(`=> The voting flow waits on FULA reaching a wallet.`);
  }

  if (lowGas) {
    console.log(`\nWARNING: at least one wallet is under 0.0003 ETH. Enough for a few calls, not a campaign.`);
  }

  console.log(`\n--- deployment cost estimate ---`);
  const Factory = await ethers.getContractFactory("CommunityVoting");
  const implTx = await Factory.getDeployTransaction();
  const implGas = await ethers.provider.estimateGas({ ...implTx, from: a1.address });
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  // Implementation + ERC1967 proxy + initialize; the proxy leg is far smaller than the impl.
  const totalGas = implGas + 700_000n;
  console.log(`impl gas      : ${implGas}`);
  console.log(`gas price     : ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`est. total    : ~${ethers.formatEther(totalGas * gasPrice)} ETH for impl + proxy`);

  const a1Bal = await ethers.provider.getBalance(a1.address);
  if (a1Bal < totalGas * gasPrice) {
    console.log(`\nWARNING: admin1 balance ${ethers.formatEther(a1Bal)} ETH may not cover deployment.`);
  } else {
    console.log(`admin1 can cover it (${ethers.formatEther(a1Bal)} ETH available).`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
