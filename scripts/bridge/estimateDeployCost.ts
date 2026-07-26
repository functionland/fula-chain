// Read-only pre-flight: what will Phase A actually COST on this network?
// Sends nothing. On OP-stack chains (Base) it adds the L1 data-availability fee, which
// dominates for a ~24 KiB contract and is invisible to plain gas estimation.
//
//   npx hardhat run scripts/bridge/estimateDeployCost.ts --network sepolia
//   npx hardhat run scripts/bridge/estimateDeployCost.ts --network base-sepolia
import { ethers, network } from "hardhat";
import { chainFor } from "./addresses";

/** OP-stack GasPriceOracle predeploy — present on Base/Optimism, absent on L1. */
const GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const ORACLE_ABI = ["function getL1Fee(bytes _data) view returns (uint256)"];

async function l1Fee(data: string): Promise<bigint> {
  const code = await ethers.provider.getCode(GAS_ORACLE);
  if (code === "0x") return 0n; // not an OP-stack chain
  const oracle = new ethers.Contract(GAS_ORACLE, ORACLE_ABI, ethers.provider);
  try {
    return await oracle.getL1Fee(data);
  } catch {
    return 0n;
  }
}

/** Contract-creation intrinsic gas, used when eth_estimateGas refuses (e.g. insufficient funds). */
function intrinsicCreateGas(data: string): bigint {
  const bytes = Buffer.from(data.replace(/^0x/, ""), "hex");
  let cost = 21000n + 32000n; // tx base + CREATE
  for (const b of bytes) cost += b === 0 ? 4n : 16n; // calldata
  cost += 200n * BigInt(bytes.length); // code deposit
  return cost;
}

async function main() {
  const [deployer, admin2] = await ethers.getSigners();
  const cfg = chainFor(network.name);
  const fee = await ethers.provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 0n;

  console.log(`network   : ${network.name}`);
  console.log(`gasPrice  : ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`deployer  : ${deployer.address}  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  if (admin2) console.log(`admin2    : ${admin2.address}  ${ethers.formatEther(await ethers.provider.getBalance(admin2.address))} ETH`);

  const items: Array<{ name: string; data: string }> = [];

  const Token = await ethers.getContractFactory("StorageToken");
  items.push({ name: "StorageToken implementation", data: (await Token.getDeployTransaction()).data as string });

  // ERC1967Proxy(impl, initData) — the proxy itself plus the initialize() call (which also
  // deploys a Treasury), so this is the expensive one after the implementation.
  const initData = Token.interface.encodeFunctionData("initialize", [
    deployer.address, admin2 ? admin2.address : deployer.address, ethers.parseEther("1000000"),
  ]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  items.push({
    name: "ERC1967Proxy + initialize",
    data: (await Proxy.getDeployTransaction(ethers.ZeroAddress, initData)).data as string,
  });

  const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
  items.push({
    name: "FulaOFTAdapter",
    data: (await Adapter.getDeployTransaction(
      deployer.address, deployer.address, cfg.endpoint, deployer.address
    )).data as string,
  });

  let total = 0n;
  console.log(`\n${"step".padEnd(30)} ${"gas".padStart(10)} ${"L2 fee".padStart(14)} ${"L1 data fee".padStart(14)} ${"total".padStart(14)}`);
  for (const it of items) {
    let gas: bigint;
    try {
      gas = await ethers.provider.estimateGas({ from: deployer.address, data: it.data });
    } catch {
      gas = intrinsicCreateGas(it.data); // conservative floor when the node refuses to estimate
    }
    const l2 = gas * gasPrice;
    const l1 = await l1Fee(it.data);
    const sum = l2 + l1;
    total += sum;
    console.log(
      `${it.name.padEnd(30)} ${gas.toString().padStart(10)} ${ethers.formatEther(l2).slice(0, 12).padStart(14)} ${ethers.formatEther(l1).slice(0, 12).padStart(14)} ${ethers.formatEther(sum).slice(0, 12).padStart(14)}`
    );
  }

  // Wiring + governance: ~20 modest txs (setPeer, libraries, 2x setConfig, enforced options,
  // rate limits, quorum, tx limit, 2 proposals, 2 approvals, transferFromContract, the send...).
  const OTHER_TXS = 20n;
  const OTHER_GAS = 180000n;
  const otherL2 = OTHER_TXS * OTHER_GAS * gasPrice;
  const otherL1 = (await l1Fee("0x" + "aa".repeat(400))) * OTHER_TXS;
  console.log(`${"~20 wiring/governance txs".padEnd(30)} ${(OTHER_TXS * OTHER_GAS).toString().padStart(10)} ${ethers.formatEther(otherL2).slice(0, 12).padStart(14)} ${ethers.formatEther(otherL1).slice(0, 12).padStart(14)} ${ethers.formatEther(otherL2 + otherL1).slice(0, 12).padStart(14)}`);
  total += otherL2 + otherL1;

  const withMargin = (total * 250n) / 100n; // 2.5x headroom for gas spikes + LZ message fees
  console.log(`\nestimated total      : ${ethers.formatEther(total)} ETH`);
  console.log(`RECOMMENDED FUNDING  : ${ethers.formatEther(withMargin)} ETH  (2.5x margin, covers LayerZero message fees)`);

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(bal >= withMargin
    ? `\nOK — deployer balance ${ethers.formatEther(bal)} ETH is sufficient.`
    : `\n*** UNDERFUNDED: deployer has ${ethers.formatEther(bal)} ETH, wants ~${ethers.formatEther(withMargin)} ETH (short by ${ethers.formatEther(withMargin - bal)}).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
