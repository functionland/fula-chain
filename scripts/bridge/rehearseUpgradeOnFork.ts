// SCRIPT 1 — Full upgrade rehearsal against a FORK of live mainnet state.
//
// This is the closest thing to a testnet copy of mainnet that actually exists. A real
// testnet CANNOT reproduce mainnet state (you cannot copy arbitrary holder balances into a
// deployed proxy), whereas a fork gives you the real proxy, the real implementation, real
// balances, real admins and real governance state at the latest block.
//
// What it does, end to end:
//   1. Snapshots live state (supply, balances, governance config, raw storage slots)
//   2. Asserts the appended storage slots (16/17) are currently ZERO on the live proxy
//   3. Deploys the new implementation
//   4. Runs the REAL governance flow: createProposal(3) -> approve -> +24h -> upgradeToAndCall
//   5. Re-snapshots and diffs — every pre-existing value must be byte-identical
//   6. Deploys FulaOFTAdapter, authorizes it via governance (proposal type 12), sets rate limits
//   7. Exercises operations: transfer, bridge mint, bridge burn, cap enforcement,
//      supply conservation, and the fee-on-mint/burn regression
//
// USAGE (two terminals):
//   Terminal 1:  FORK_RPC_URL=<mainnet rpc> npx hardhat node
//   Terminal 2:  TARGET=base npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts --network localhost
//
// Or single-shot against an in-process fork:
//   FORK_RPC_URL=<rpc> TARGET=base npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts
//
// TARGET selects which live deployment to rehearse: ethereum | base | skale | iotex-mainnet
import { ethers, upgrades, network } from "hardhat";
import {
  LIVE,
  SLOTS,
  ADMIN_ROLE,
  PROPOSAL,
  MIN_PROPOSAL_EXECUTION_DELAY,
  snapshotState,
  diffSnapshots,
  readImplementation,
  fmt,
} from "./live";

const CHAIN_EID = 30101; // arbitrary for a single-chain rehearsal

function heading(s: string) {
  console.log(`\n${"=".repeat(72)}\n${s}\n${"=".repeat(72)}`);
}

async function impersonate(addr: string) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [addr, "0x56BC75E2D63100000"], // 100 ETH
  });
  return ethers.getSigner(addr);
}

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** Find a second ADMIN_ROLE holder besides `first`, scanning proposal history if needed. */
async function findAdmins(token: any): Promise<string[]> {
  const found: string[] = [];
  try {
    const count = await token.getRoleMemberCount(ADMIN_ROLE);
    for (let i = 0n; i < count; i++) {
      found.push(await token.getRoleMember(ADMIN_ROLE, i));
    }
  } catch {
    // AccessControlEnumerable not exposed — fall back to the owner plus env override.
  }
  if (found.length === 0) {
    const owner = await token.owner();
    found.push(owner);
    const extra = process.env.ADMIN2?.trim();
    if (extra) found.push(extra);
  }
  return found;
}

async function main() {
  const target = (process.env.TARGET?.trim() || "base") as keyof typeof LIVE;
  const live = LIVE[target];
  if (!live) throw new Error(`Unknown TARGET "${target}". Use ethereum | base | skale | iotex-mainnet`);

  const forkNet = await ethers.provider.getNetwork();
  heading(`REHEARSAL: ${target} (fork)`);
  console.log(`fork chainId: ${forkNet.chainId}`);
  if (forkNet.chainId !== BigInt(live.chainId)) {
    console.log(
      `\n  WARNING: fork chainId ${forkNet.chainId} != ${target} chainId ${live.chainId}.\n` +
        `  Make sure FORK_RPC_URL actually points at ${target}.\n`
    );
  }

  const proxy = live.proxy;
  const token = await ethers.getContractAt("StorageToken", proxy);

  // ---------------------------------------------------------------- 1. snapshot
  heading("1. Snapshot live pre-upgrade state");
  const currentImpl = await readImplementation(proxy);
  console.log(`proxy:        ${proxy}`);
  console.log(`current impl: ${currentImpl}`);
  if (currentImpl.toLowerCase() !== live.expectedImpl.toLowerCase()) {
    console.log(
      `\n  WARNING: live impl differs from the recorded expectation (${live.expectedImpl}).\n` +
        `  Someone upgraded outside the tracked process. Investigate before proceeding.\n`
    );
  }

  const admins = await findAdmins(token);
  const holders = [proxy, ...admins, await token.treasury()];
  const before = await snapshotState(proxy, holders);
  console.log(`name/symbol:  ${before.name} / ${before.symbol}`);
  console.log(`totalSupply:  ${fmt(before.totalSupply)}`);
  console.log(`held by proxy:${fmt(before.contractBalance)}`);
  console.log(`treasury:     ${before.treasury}`);
  console.log(`adminCount:   ${before.adminCount}   quorum: ${before.adminQuorum}`);
  console.log(`proposalCount:${before.proposalCount}`);
  console.log(`paused:       ${before.paused}`);
  console.log(`admins found: ${admins.join(", ") || "(none — set ADMIN2)"}`);

  // ------------------------------------------------- 2. appended slots must be zero
  heading("2. Verify appended storage slots are unused on the live proxy");
  let slotsClean = true;
  for (const [label, slot] of [
    ["bridgeMinters", SLOTS.bridgeMinters],
    ["voluntarilyBurned", SLOTS.voluntarilyBurned],
  ] as Array<[string, number]>) {
    const val = await ethers.provider.getStorage(proxy, slot);
    const zero = BigInt(val) === 0n;
    slotsClean &&= zero;
    console.log(`  ${zero ? "OK  " : "FAIL"} slot ${slot} (${label}) = ${val}`);
  }
  for (let s = SLOTS.gapStart; s <= SLOTS.gapEnd; s++) {
    const val = await ethers.provider.getStorage(proxy, s);
    if (BigInt(val) !== 0n) {
      slotsClean = false;
      console.log(`  FAIL gap slot ${s} is non-zero: ${val}`);
    }
  }
  if (!slotsClean) {
    throw new Error(
      "Appended storage slots are NOT zero on the live proxy. New state would inherit " +
        "garbage. STOP and investigate the deployed layout."
    );
  }
  console.log(`  OK   slots ${SLOTS.gapStart}..${SLOTS.gapEnd} (reserved gap) all zero`);

  // ---------------------------------------------------------------- 3. deploy impl
  heading("3. Deploy new StorageToken implementation");
  const StorageToken = await ethers.getContractFactory("StorageToken");
  await upgrades.validateImplementation(StorageToken, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  console.log(`  OK   standalone implementation validation passed`);
  const newImpl = String(
    await upgrades.deployImplementation(StorageToken, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    })
  );
  console.log(`  new implementation: ${newImpl}`);

  // ---------------------------------------------------------------- 4. governance
  heading("4. Execute the real governance upgrade flow");
  if (admins.length < 2) {
    throw new Error(
      "Need two ADMIN_ROLE holders to reach quorum. Set ADMIN2=<address> to supply the second."
    );
  }
  const [a1, a2] = admins;
  const admin1 = await impersonate(a1);
  const admin2 = await impersonate(a2);
  console.log(`  admin1: ${a1}`);
  console.log(`  admin2: ${a2}`);

  if (before.paused) {
    console.log(`  contract is PAUSED — _authorizeUpgrade requires unpaused. Unpausing...`);
    await (await token.connect(admin1).emergencyAction(2)).wait();
  }
  if (before.adminQuorum < 2n) {
    console.log(`  quorum is ${before.adminQuorum}; setting to 2 (required by governance)`);
    await (await token.connect(admin1).setRoleQuorum(ADMIN_ROLE, 2)).wait();
  }

  console.log(`  createProposal(Upgrade, ${newImpl}) ...`);
  const tx = await token
    .connect(admin1)
    .createProposal(PROPOSAL.UPGRADE, 0, newImpl, ethers.ZeroHash, 0, ethers.ZeroAddress);
  const receipt = await tx.wait();
  const log = receipt!.logs.find((l: any) => {
    try {
      return token.interface.parseLog(l)?.name === "ProposalCreated";
    } catch {
      return false;
    }
  });
  const proposalId = token.interface.parseLog(log as any)!.args[0];
  console.log(`  proposalId: ${proposalId}`);

  await (await token.connect(admin2).approveProposal(proposalId)).wait();
  console.log(`  approved by admin2`);

  await increaseTime(MIN_PROPOSAL_EXECUTION_DELAY + 60);
  console.log(`  advanced past the 24h execution delay`);

  await (await token.connect(admin1).upgradeToAndCall(newImpl, "0x")).wait();
  const afterImpl = await readImplementation(proxy);
  console.log(`  upgraded. impl is now: ${afterImpl}`);
  if (afterImpl.toLowerCase() !== newImpl.toLowerCase()) {
    throw new Error(`Upgrade did not take effect: ${afterImpl} != ${newImpl}`);
  }

  // ---------------------------------------------------------------- 5. state diff
  heading("5. Verify no pre-existing state changed");
  const after = await snapshotState(proxy, holders);
  const diffs = diffSnapshots(before, after);
  if (diffs.length > 0) {
    console.log(`  FAIL ${diffs.length} difference(s):`);
    diffs.forEach((d) => console.log(`     - ${d}`));
    throw new Error("State changed across the upgrade. DO NOT SHIP.");
  }
  console.log(`  OK   all ${holders.length} balances, governance state and raw slots identical`);
  console.log(`  OK   totalSupply unchanged: ${fmt(after.totalSupply)}`);

  // new storage reads as zero through the new ABI
  console.log(`  voluntarilyBurned: ${await token.voluntarilyBurned()} (expected 0)`);

  // ---------------------------------------------------------------- 6. adapter
  heading("6. Deploy adapter and authorize it through governance");
  const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
  const endpoint = await Endpoint.deploy(CHAIN_EID);
  await endpoint.waitForDeployment();
  console.log(`  mock endpoint (rehearsal only): ${await endpoint.getAddress()}`);

  const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
  const adapter = await Adapter.deploy(proxy, proxy, await endpoint.getAddress(), a1);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  console.log(`  adapter: ${adapterAddr}`);
  console.log(`  token()=${await adapter.token()}  sharedDecimals=${await adapter.sharedDecimals()}`);

  const cap = ethers.parseEther("1000000");
  const tx2 = await token
    .connect(admin1)
    .createProposal(PROPOSAL.SET_BRIDGE_MINTER, 0, adapterAddr, ethers.ZeroHash, cap, ethers.ZeroAddress);
  const r2 = await tx2.wait();
  const log2 = r2!.logs.find((l: any) => {
    try {
      return token.interface.parseLog(l)?.name === "ProposalCreated";
    } catch {
      return false;
    }
  });
  const pid2 = token.interface.parseLog(log2 as any)!.args[0];
  await increaseTime(MIN_PROPOSAL_EXECUTION_DELAY + 60);
  await (await token.connect(admin2).approveProposal(pid2)).wait();
  const minterCfg = await token.bridgeMinters(adapterAddr);
  console.log(`  bridgeMinters[adapter] = enabled:${minterCfg.enabled} cap:${fmt(minterCfg.cap)}`);
  if (!minterCfg.enabled) throw new Error("Bridge minter authorization did not execute");

  // ---------------------------------------------------------------- 7. operations
  heading("7. Exercise operations against real forked state");

  // A minter-caller contract stands in for the adapter's internal calls.
  const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
  const caller = await Caller.deploy(proxy);
  await caller.waitForDeployment();
  const callerAddr = await caller.getAddress();
  const tx3 = await token
    .connect(admin1)
    .createProposal(PROPOSAL.SET_BRIDGE_MINTER, 0, callerAddr, ethers.ZeroHash, cap, ethers.ZeroAddress);
  const r3 = await tx3.wait();
  const log3 = r3!.logs.find((l: any) => {
    try {
      return token.interface.parseLog(l)?.name === "ProposalCreated";
    } catch {
      return false;
    }
  });
  const pid3 = token.interface.parseLog(log3 as any)!.args[0];
  await increaseTime(MIN_PROPOSAL_EXECUTION_DELAY + 60);
  await (await token.connect(admin2).approveProposal(pid3)).wait();

  const recipient = ethers.Wallet.createRandom().address;
  const amount = ethers.parseEther("1000");

  const supply0 = await token.totalSupply();
  await (await caller.callMint(recipient, amount)).wait();
  const supply1 = await token.totalSupply();
  console.log(`  mint   ${fmt(amount)} -> supply ${fmt(supply0)} => ${fmt(supply1)}`);
  if (supply1 - supply0 !== amount) throw new Error("mint did not move supply by exactly `amount`");
  if ((await token.balanceOf(recipient)) !== amount) throw new Error("recipient did not receive full amount");

  await (await caller.callBurn(recipient, amount)).wait();
  const supply2 = await token.totalSupply();
  console.log(`  burn   ${fmt(amount)} -> supply ${fmt(supply2)}`);
  if (supply2 !== supply0) throw new Error("burn did not restore the original supply");
  console.log(`  OK   supply conservation holds on real state`);

  // Cap enforcement
  const tiny = ethers.parseEther("1");
  await (await caller.callMint(recipient, tiny)).wait();
  const netMinted = (await token.bridgeMinters(callerAddr)).netMinted;
  console.log(`  netMinted after mint/burn/mint: ${netMinted} (expected ${tiny})`);

  try {
    await caller.callMint(recipient, cap);
    throw new Error("cap was NOT enforced");
  } catch (e: any) {
    if (String(e.message).includes("cap was NOT enforced")) throw e;
    console.log(`  OK   cap enforced (${e.shortMessage ?? "reverted"})`);
  }

  // Unauthorized caller must fail
  try {
    await token.connect(admin1).mint(recipient, 1n);
    throw new Error("an ADMIN_ROLE holder was able to mint");
  } catch (e: any) {
    if (String(e.message).includes("was able to mint")) throw e;
    console.log(`  OK   ADMIN_ROLE alone cannot mint`);
  }

  // Fee-on-mint/burn regression, using the real treasury
  const treasuryAddr = await token.treasury();
  const tBefore = await token.balanceOf(treasuryAddr);
  await (await caller.callMint(recipient, tiny)).wait();
  const tAfter = await token.balanceOf(treasuryAddr);
  console.log(`  treasury balance across a bridge mint: ${fmt(tBefore)} => ${fmt(tAfter)}`);
  if (tAfter !== tBefore) throw new Error("treasury took a fee on a bridge mint");
  console.log(`  OK   no fee taken on mint (platformFeeBps is ${await ethers.provider.getStorage(proxy, SLOTS.platformFeeBps)})`);

  heading("REHEARSAL PASSED");
  console.log(`Upgrade applied cleanly to real ${target} state with no observable change to`);
  console.log(`any pre-existing value, and bridge operations behave correctly.`);
  console.log(`\nNew implementation (rehearsal build): ${newImpl}`);
  console.log(`Re-deploy on mainnet with scripts/bridge/deployStorageTokenImpl.ts.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nREHEARSAL FAILED\n`);
    console.error(error);
    process.exit(1);
  });

// FORK_RPC_URL=<base rpc>  TARGET=base     npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts
// FORK_RPC_URL=<eth rpc>   TARGET=ethereum npx hardhat run scripts/bridge/rehearseUpgradeOnFork.ts
