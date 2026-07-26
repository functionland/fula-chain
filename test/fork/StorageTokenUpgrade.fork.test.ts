// Fork tests: apply the StorageToken upgrade to REAL live mainnet state and assert that
// nothing observable changes, then exercise the bridge against real balances.
//
// These are the highest-fidelity tests in the repo — they use the real proxy, the real
// deployed implementation, real holder balances and the real admin set.
//
// They SKIP automatically unless FORK_RPC_URL is set, so `npx hardhat test` stays green
// without network access.
//
// USAGE:
//   FORK_RPC_URL=<base mainnet rpc>     FORK_TARGET=base     npx hardhat test test/fork/StorageTokenUpgrade.fork.test.ts
//   FORK_RPC_URL=<ethereum mainnet rpc> FORK_TARGET=ethereum npx hardhat test test/fork/StorageTokenUpgrade.fork.test.ts
//
// Pin FORK_BLOCK for reproducible runs.
import { expect } from "chai";
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
  StateSnapshot,
} from "../../scripts/bridge/live";

const FORK_ENABLED = !!process.env.FORK_RPC_URL;
const TARGET = (process.env.FORK_TARGET?.trim() || "base") as keyof typeof LIVE;

(FORK_ENABLED ? describe : describe.skip)(`StorageToken upgrade on forked ${TARGET}`, function () {
  this.timeout(600000);

  const live = LIVE[TARGET];
  let token: any;
  let admin1: any;
  let admin2: any;
  let snapBefore: StateSnapshot;
  let newImpl: string;
  let holders: string[];

  async function impersonate(addr: string) {
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [addr, "0x56BC75E2D63100000"],
    });
    return ethers.getSigner(addr);
  }

  async function passProposal(proposalType: number, target: string, amount: bigint = 0n) {
    const tx = await token
      .connect(admin1)
      .createProposal(proposalType, 0, target, ethers.ZeroHash, amount, ethers.ZeroAddress);
    const receipt = await tx.wait();
    const log = receipt.logs.find((l: any) => {
      try {
        return token.interface.parseLog(l)?.name === "ProposalCreated";
      } catch {
        return false;
      }
    });
    const id = token.interface.parseLog(log)!.args[0];
    await network.provider.send("evm_increaseTime", [MIN_PROPOSAL_EXECUTION_DELAY + 60]);
    await network.provider.send("evm_mine");
    await (await token.connect(admin2).approveProposal(id)).wait();
    return id;
  }

  before(async () => {
    if (!live) throw new Error(`Unknown FORK_TARGET "${TARGET}"`);
    token = await ethers.getContractAt("StorageToken", live.proxy);

    // Discover admins. StorageToken does NOT inherit AccessControlEnumerable, so
    // getRoleMemberCount reverts on the live contract; the recorded LIVE_ADMINS (read from the
    // `RoleGranted` logs emitted by `initialize`) are the reliable source. Env ADMIN1/ADMIN2
    // override for a chain whose admin set has since changed.
    let found: string[] = [];
    try {
      const count = await token.getRoleMemberCount(ADMIN_ROLE);
      for (let i = 0n; i < count; i++) found.push(await token.getRoleMember(ADMIN_ROLE, i));
    } catch {
      found = [];
    }
    if (found.length < 2) {
      const override = [process.env.ADMIN1?.trim(), process.env.ADMIN2?.trim()].filter(
        Boolean
      ) as string[];
      found = override.length >= 2 ? override : [...live.admins];
    }

    // Only keep addresses that really hold ADMIN_ROLE right now — a stale record must fail loudly
    // rather than silently impersonate a non-admin and produce a meaningless green run.
    const verified: string[] = [];
    for (const a of found) if (await token.hasRole(ADMIN_ROLE, a)) verified.push(a);
    expect(
      verified.length,
      `need 2 live ADMIN_ROLE holders; checked ${found.join(", ")} — set ADMIN1/ADMIN2 to override`
    ).to.be.gte(2);
    found = verified;

    admin1 = await impersonate(found[0]);
    admin2 = await impersonate(found[1]);

    holders = [live.proxy, found[0], found[1], await token.treasury()];
    snapBefore = await snapshotState(live.proxy, holders);

    if (snapBefore.paused) await (await token.connect(admin1).emergencyAction(2)).wait();
    if (snapBefore.adminQuorum < 2n) {
      await (await token.connect(admin1).setRoleQuorum(ADMIN_ROLE, 2)).wait();
    }
  });

  it("appended storage slots are unused on the live proxy", async () => {
    // This is the corruption gate: if these are non-zero, the new variables would
    // silently inherit pre-existing data.
    expect(BigInt(await ethers.provider.getStorage(live.proxy, SLOTS.bridgeMinters))).to.equal(0n);
    expect(BigInt(await ethers.provider.getStorage(live.proxy, SLOTS.voluntarilyBurned))).to.equal(0n);
    for (let s = SLOTS.gapStart; s <= SLOTS.gapEnd; s++) {
      expect(
        BigInt(await ethers.provider.getStorage(live.proxy, s)),
        `reserved gap slot ${s} must be zero`
      ).to.equal(0n);
    }
  });

  it("the deployed layout matches our slot expectations", async () => {
    const treasurySlot = ethers.getAddress(
      "0x" + (await ethers.provider.getStorage(live.proxy, SLOTS.treasury)).slice(-40)
    );
    expect(treasurySlot.toLowerCase()).to.equal((await token.treasury()).toLowerCase());
    expect(BigInt(await ethers.provider.getStorage(live.proxy, SLOTS.adminCount))).to.equal(
      await token.adminCount()
    );
    expect(BigInt(await ethers.provider.getStorage(live.proxy, SLOTS.proposalCount))).to.equal(
      await token.proposalCount()
    );
  });

  it("upgrades through the real governance flow", async () => {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    await upgrades.validateImplementation(StorageToken, {
      kind: "uups",
      unsafeAllow: ["constructor"],
    });
    newImpl = String(
      await upgrades.deployImplementation(StorageToken, {
        kind: "uups",
        unsafeAllow: ["constructor"],
      })
    );

    await passProposal(PROPOSAL.UPGRADE, newImpl);
    await (await token.connect(admin1).upgradeToAndCall(newImpl, "0x")).wait();

    expect((await readImplementation(live.proxy)).toLowerCase()).to.equal(newImpl.toLowerCase());
  });

  it("changes NO pre-existing state", async () => {
    const after = await snapshotState(live.proxy, holders);
    const diffs = diffSnapshots(snapBefore, after);
    expect(diffs, `state changed across upgrade:\n${diffs.join("\n")}`).to.deep.equal([]);
  });

  it("exposes the new bridge storage, zero-initialized", async () => {
    expect(await token.voluntarilyBurned()).to.equal(0n);
    const m = await token.bridgeMinters(ethers.ZeroAddress);
    expect(m.enabled).to.be.false;
    expect(m.cap).to.equal(0n);
    expect(m.netMinted).to.equal(0n);
  });

  it("still rejects minting from an unauthorized caller after the upgrade", async () => {
    await expect(token.connect(admin1).mint(admin1.address, 1n)).to.be.revertedWithCustomError(
      token,
      "NotBridgeMinter"
    );
  });

  describe("bridge operations on real state", () => {
    let caller: any;
    const cap = ethers.parseEther("1000000");

    before(async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      caller = await Caller.deploy(live.proxy);
      await caller.waitForDeployment();
      await passProposal(PROPOSAL.SET_BRIDGE_MINTER, await caller.getAddress(), cap);
      expect((await token.bridgeMinters(await caller.getAddress())).enabled).to.be.true;
    });

    it("mint moves totalSupply by exactly the amount and credits in full", async () => {
      const to = ethers.Wallet.createRandom().address;
      const amount = ethers.parseEther("1234.5678");
      const supply0 = await token.totalSupply();

      await caller.callMint(to, amount);

      expect(await token.totalSupply()).to.equal(supply0 + amount);
      expect(await token.balanceOf(to)).to.equal(amount);
    });

    it("burn restores supply exactly (round trip is supply-neutral)", async () => {
      const to = ethers.Wallet.createRandom().address;
      const amount = ethers.parseEther("500");
      const supply0 = await token.totalSupply();

      await caller.callMint(to, amount);
      await caller.callBurn(to, amount);

      expect(await token.totalSupply()).to.equal(supply0);
      expect(await token.balanceOf(to)).to.equal(0n);
    });

    it("takes no treasury fee on mint or burn", async () => {
      const treasury = await token.treasury();
      const to = ethers.Wallet.createRandom().address;
      const amount = ethers.parseEther("100");

      const t0 = await token.balanceOf(treasury);
      await caller.callMint(to, amount);
      await caller.callBurn(to, amount);
      expect(await token.balanceOf(treasury)).to.equal(t0);
    });

    it("enforces the per-minter cap", async () => {
      const to = ethers.Wallet.createRandom().address;
      await expect(caller.callMint(to, cap * 2n)).to.be.revertedWithCustomError(
        token,
        "BridgeMintCapExceeded"
      );
    });

    it("does not disturb existing holder balances", async () => {
      const snap = await snapshotState(live.proxy, holders);
      for (const h of holders) {
        expect(snap.balances[h.toLowerCase()]).to.equal(snapBefore.balances[h.toLowerCase()]);
      }
    });

    it("normal transfers still work after the upgrade", async () => {
      // Move a small amount from the largest holder we know about.
      const from = holders.find((h) => snapBefore.balances[h.toLowerCase()] > ethers.parseEther("1"));
      if (!from) {
        console.log("      (no known holder with a balance to test transfer; skipping)");
        return;
      }
      const signer = await impersonate(from);
      const to = ethers.Wallet.createRandom().address;
      const amount = ethers.parseEther("1");
      // `transfer` is whenNotPaused + nonReentrant on this contract.
      await (await token.connect(signer).transfer(to, amount)).wait();
      expect(await token.balanceOf(to)).to.equal(amount);
    });
  });
});
