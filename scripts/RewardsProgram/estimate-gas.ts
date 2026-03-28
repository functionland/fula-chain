import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60 + 1;

function toBytes12(str: string): string {
  const bytes = ethers.toUtf8Bytes(str);
  const padded = new Uint8Array(12);
  padded.set(bytes);
  return ethers.hexlify(padded);
}

function toBytes8(str: string): string {
  const bytes = ethers.toUtf8Bytes(str);
  const padded = new Uint8Array(8);
  padded.set(bytes);
  return ethers.hexlify(padded);
}

async function main() {
  const [owner, admin, pa1, tl1, cl1, cl2] = await ethers.getSigners();
  const TOTAL_SUPPLY = ethers.parseEther("2000000000");
  const USER_TOKENS = ethers.parseEther("1000000");
  const ZA = ethers.ZeroAddress;
  const ZH = ethers.ZeroHash;

  // --- Deploy (mirrors test beforeEach) ---
  const StorageToken = await ethers.getContractFactory("StorageToken");
  const storageToken = (await upgrades.deployProxy(
    StorageToken, [owner.address, admin.address, TOTAL_SUPPLY],
    { kind: "uups", initializer: "initialize" }
  )) as any;
  await storageToken.waitForDeployment();

  const StakingPool = await ethers.getContractFactory("StakingPool");
  const stakingPool = (await upgrades.deployProxy(
    StakingPool, [await storageToken.getAddress(), owner.address, admin.address],
    { kind: "uups", initializer: "initialize" }
  )) as any;
  await stakingPool.waitForDeployment();

  const RP = await ethers.getContractFactory("RewardsProgram");
  const rp = (await upgrades.deployProxy(
    RP,
    [await storageToken.getAddress(), await stakingPool.getAddress(), owner.address, admin.address],
    { kind: "uups", initializer: "initialize" }
  )) as any;
  await rp.waitForDeployment();

  // Set staking engine
  await stakingPool.connect(owner).setStakingEngine(await rp.getAddress());

  // Governance params
  await time.increase(DAY);
  await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
  await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
  await stakingPool.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
  await time.increase(DAY);
  await stakingPool.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
  await rp.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
  await time.increase(DAY);
  await rp.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

  // Whitelist helper
  async function whitelist(addr: string) {
    const tx = await storageToken.connect(owner).createProposal(5, 0, addr, ZH, 0, ZA);
    const r = await tx.wait();
    const pid = r?.logs[0]?.topics[1];
    await time.increase(DAY);
    await storageToken.connect(admin).approveProposal(pid!);
    await time.increase(DAY);
  }

  // Whitelist contracts & users
  await whitelist(owner.address);
  await whitelist(await stakingPool.getAddress());
  await whitelist(await rp.getAddress());

  for (const u of [pa1, tl1, cl1, cl2]) {
    await whitelist(u.address);
    await storageToken.connect(admin).transferFromContract(u.address, USER_TOKENS);
  }
  // Fund owner wallet too
  await storageToken.connect(admin).transferFromContract(owner.address, USER_TOKENS);

  // Approve RewardsProgram for token transfers
  const rpAddr = await rp.getAddress();
  for (const u of [owner, pa1, tl1, cl1]) {
    await storageToken.connect(u).approve(rpAddr, ethers.MaxUint256);
  }

  // --- GAS ESTIMATION ---
  const results: { method: string; gas: bigint; ethAt20Gwei: string }[] = [];

  async function est(label: string, txPromise: Promise<any>) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const gas = BigInt(receipt.gasUsed);
    const costWei = gas * 20n * 1_000_000_000n;
    results.push({ method: label, gas, ethAt20Gwei: (Number(costWei) / 1e18).toFixed(6) });
  }

  // -- WRITE FUNCTIONS --

  await est("createProgram", rp.connect(owner).createProgram(toBytes8("PROG1"), "Program One", "Description"));
  await est("createProgram (2nd)", rp.connect(owner).createProgram(toBytes8("PROG2"), "Program Two", "Desc2"));

  await est("updateProgram", rp.connect(owner).updateProgram(1, "Updated Name", "Updated Desc"));

  await est("assignProgramAdmin", rp.connect(owner).assignProgramAdmin(1, pa1.address, toBytes12("PA001"), ZH));

  const editCode = ethers.encodeBytes32String("secret123");
  const editCodeHash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [editCode]));
  await est("assignProgramAdmin (walletless+code)", rp.connect(owner).assignProgramAdmin(2, ZA, toBytes12("PA002"), editCodeHash));

  await est("addMember (TeamLeader)", rp.connect(pa1).addMember(1, tl1.address, toBytes12("TL001"), 2, ZH));
  await est("addMember (Client)", rp.connect(tl1).addMember(1, cl1.address, toBytes12("CL001"), 1, ZH));
  await est("addMember (walletless+editCode)", rp.connect(tl1).addMember(1, ZA, toBytes12("CL002"), 1, editCodeHash));

  await est("claimMember", rp.connect(cl2).claimMember(2, toBytes12("PA002"), editCode));

  await est("setEditCodeHash", rp.connect(tl1).setEditCodeHash(1, toBytes12("CL002"), editCodeHash));

  await est("setMemberWallet", rp.connect(tl1).setMemberWallet(1, toBytes12("CL002"), cl2.address));

  await est("updateMemberID", rp.connect(owner).updateMemberID(1, toBytes12("CL001"), toBytes12("CL999")));

  await est("addTokens (10000 FULA)", rp.connect(pa1).addTokens(1, ethers.parseEther("10000")));
  await est("addTokens (admin)", rp.connect(owner).addTokens(1, ethers.parseEther("10000")));

  await est("transferToSubMember (unlocked)", rp.connect(pa1).transferToSubMember(1, tl1.address, ethers.parseEther("1000"), false, 0));
  await est("transferToSubMember (locked)", rp.connect(pa1).transferToSubMember(1, tl1.address, ethers.parseEther("500"), true, 0));
  await est("transferToSubMember (timeLock 30d)", rp.connect(pa1).transferToSubMember(1, tl1.address, ethers.parseEther("500"), false, 30));

  // TL → Client transfer for parent transfer tests
  await rp.connect(tl1).transferToSubMember(1, cl1.address, ethers.parseEther("200"), false, 0);

  await est("transferToParent (direct)", rp.connect(cl1).transferToParent(1, tl1.address, ethers.parseEther("50")));
  await est("transferToParent (grandparent)", rp.connect(cl1).transferToParent(1, pa1.address, ethers.parseEther("50")));

  await est("withdraw", rp.connect(tl1).withdraw(1, ethers.parseEther("100")));

  // Withdraw with expired time-lock resolution
  await time.increase(31 * 86400);
  await est("withdraw (resolves expired lock)", rp.connect(tl1).withdraw(1, ethers.parseEther("100")));

  await est("removeMember", rp.connect(owner).removeMember(1, cl1.address));

  await est("deactivateProgram", rp.connect(owner).deactivateProgram(2));

  // -- VIEW FUNCTIONS (gas for on-chain calls from other contracts) --

  const g1 = await rp.getProgram.estimateGas(1);
  results.push({ method: "[view] getProgram", gas: g1, ethAt20Gwei: "free (view)" });

  const g2 = await rp.getMember.estimateGas(1, pa1.address);
  results.push({ method: "[view] getMember", gas: g2, ethAt20Gwei: "free (view)" });

  const g3 = await rp.getMemberByID.estimateGas(toBytes12("TL001"), 1);
  results.push({ method: "[view] getMemberByID", gas: g3, ethAt20Gwei: "free (view)" });

  const g4 = await rp.getBalance.estimateGas(1, pa1.address);
  results.push({ method: "[view] getBalance", gas: g4, ethAt20Gwei: "free (view)" });

  // --- PRINT ---

  console.log("\n" + "=".repeat(75));
  console.log("  REWARDS PROGRAM — GAS ESTIMATION REPORT");
  console.log("  (ETH cost at 20 gwei gas price)");
  console.log("=".repeat(75) + "\n");
  console.log("Method".padEnd(45) + "Gas".padStart(10) + "  ETH Cost");
  console.log("-".repeat(70));

  for (const r of results) {
    console.log(r.method.padEnd(45) + r.gas.toString().padStart(10) + "  " + r.ethAt20Gwei);
  }

  console.log("-".repeat(70));
  console.log("\nNotes:");
  console.log("- View functions are free when called from UI (off-chain)");
  console.log("- Actual cost = gas * network gas price");
  console.log("- Base chain: ~0.01 gwei → divide ETH costs by ~2000");
  console.log("- Use: ETH cost * ETH price for USD estimate\n");
}

main().catch(console.error);
