import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));

const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion hard cap
const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1 billion minted at deploy
const ONE_DAY = 24 * 60 * 60 + 1;

// Contract-local proposal types (defined in StorageToken.sol, not in ProposalTypes enum)
const PROPOSAL_ADD_WHITELIST = 5;
const PROPOSAL_CHANGE_TREASURY_FEE = 11;
const PROPOSAL_SET_BRIDGE_MINTER = 12;
const PROPOSAL_REMOVE_BRIDGE_MINTER = 13;

// LayerZero endpoint ids used for the two simulated chains
const EID_A = 30101; // stands in for Ethereum
const EID_B = 30184; // stands in for Base

/** Robust proposal-id extraction (mirrors TokenBridgeContract.test.ts). */
async function getProposalId(receipt: any, contract: any): Promise<string> {
  const log = receipt.logs.find((l: any) => {
    try {
      return contract.interface.parseLog(l)?.name === "ProposalCreated";
    } catch {
      return false;
    }
  });
  if (!log) throw new Error("ProposalCreated event not found");
  return contract.interface.parseLog(log)!.args[0];
}

/** Run a governance proposal end-to-end: create -> wait -> approve (auto-executes). */
async function runProposal(
  token: any,
  owner: SignerWithAddress,
  admin: SignerWithAddress,
  proposalType: number,
  target: string,
  amount: bigint = BigInt(0),
  role: BytesLike = ethers.ZeroHash
): Promise<string> {
  const tx = await token
    .connect(owner)
    .createProposal(proposalType, 0, target, role, amount, ZeroAddress);
  const proposalId = await getProposalId(await tx.wait(), token);
  await time.increase(ONE_DAY);
  await token.connect(admin).approveProposal(proposalId);
  return proposalId;
}

describe("FULA LayerZero OFT bridge", () => {
  let token: any;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let distributor: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;
  let bridgeOperator: SignerWithAddress;

  /** Deploy a StorageToken proxy with governance bootstrapped. */
  async function deployToken(): Promise<any> {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const t = await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    );
    await t.waitForDeployment();

    // Bootstrap role timelock, then quorum + limits.
    await time.increase(ONE_DAY);
    await t.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await t.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    return t;
  }

  /** Move `amount` out of the token contract to `to` (requires whitelisting). */
  async function fund(t: any, to: string, amount: bigint) {
    await runProposal(t, owner, admin, PROPOSAL_ADD_WHITELIST, to);
    await time.increase(ONE_DAY); // WHITELIST_LOCK_DURATION
    await t.connect(owner).transferFromContract(to, amount);
  }

  beforeEach(async () => {
    [owner, admin, distributor, user, other, bridgeOperator] = await ethers.getSigners();
    token = await deployToken();
  });

  // ===================================================================
  // The regression test for this entire change.
  // ===================================================================
  describe("_update: platform fee must never apply to mint or burn", () => {
    beforeEach(async () => {
      // Set a 5% platform fee (MAX_BPS). Requires the ChangeTreasuryFee amount fix.
      await runProposal(token, owner, admin, PROPOSAL_CHANGE_TREASURY_FEE, other.address, BigInt(500));
    });

    it("actually applies the proposed fee (regression: proposal.amount was never stored)", async () => {
      await fund(token, distributor.address, ethers.parseEther("1000"));
      const treasury = await token.treasury();
      const before = await token.balanceOf(treasury);

      await token.connect(distributor).transfer(user.address, ethers.parseEther("100"));

      // 5% of 100 = 5 to treasury, 95 to recipient.
      expect(await token.balanceOf(treasury)).to.equal(before + ethers.parseEther("5"));
      expect(await token.balanceOf(user.address)).to.equal(ethers.parseEther("95"));
    });

    it("bridge burn destroys the FULL amount, taking no fee", async () => {
      await fund(token, distributor.address, ethers.parseEther("1000"));
      const adapter = await authorizeEoaMinter(); // uses a contract minter
      await token.connect(distributor).transfer(user.address, ethers.parseEther("100"));

      const treasury = await token.treasury();
      const treasuryBefore = await token.balanceOf(treasury);
      const supplyBefore = await token.totalSupply();
      const userBefore = await token.balanceOf(user.address);
      const burnAmount = ethers.parseEther("50");

      await adapter.callBurn(user.address, burnAmount);

      // Supply must drop by exactly the burn amount — this is the supply-conservation invariant.
      expect(await token.totalSupply()).to.equal(supplyBefore - burnAmount);
      expect(await token.balanceOf(user.address)).to.equal(userBefore - burnAmount);
      // Treasury must not receive anything.
      expect(await token.balanceOf(treasury)).to.equal(treasuryBefore);
    });

    it("bridge mint credits the FULL amount, taking no fee", async () => {
      const adapter = await authorizeEoaMinter();
      const treasury = await token.treasury();
      const treasuryBefore = await token.balanceOf(treasury);
      const supplyBefore = await token.totalSupply();
      const mintAmount = ethers.parseEther("100");

      await adapter.callMint(user.address, mintAmount);

      expect(await token.balanceOf(user.address)).to.equal(mintAmount);
      expect(await token.totalSupply()).to.equal(supplyBefore + mintAmount);
      expect(await token.balanceOf(treasury)).to.equal(treasuryBefore);
    });
  });

  /** Deploy a minimal contract minter and authorize it (type 12 requires a contract target). */
  async function authorizeEoaMinter(cap: bigint = ethers.parseEther("100000000")): Promise<any> {
    const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
    const caller = await Caller.deploy(await token.getAddress());
    await caller.waitForDeployment();
    await runProposal(
      token,
      owner,
      admin,
      PROPOSAL_SET_BRIDGE_MINTER,
      await caller.getAddress(),
      cap
    );
    return caller;
  }

  // ===================================================================
  describe("bridge minter authorization", () => {
    it("rejects mint/burn from an unauthorized caller", async () => {
      await expect(token.connect(user).mint(user.address, 1n))
        .to.be.revertedWithCustomError(token, "NotBridgeMinter");
      await expect(token.connect(user)["burn(address,uint256)"](user.address, 1n))
        .to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });

    it("rejects mint even from ADMIN_ROLE and BRIDGE_OPERATOR_ROLE holders", async () => {
      // The owner holds ADMIN_ROLE, yet must not be able to mint.
      await expect(token.connect(owner).mint(owner.address, 1n))
        .to.be.revertedWithCustomError(token, "NotBridgeMinter");

      // Grant BRIDGE_OPERATOR_ROLE and confirm it confers no mint power. This is the
      // regression guard for the rejected "reuse BRIDGE_OPERATOR_ROLE" design.
      await runProposal(token, owner, admin, 1, bridgeOperator.address, BigInt(0), BRIDGE_OPERATOR_ROLE);
      expect(await token.hasRole(BRIDGE_OPERATOR_ROLE, bridgeOperator.address)).to.be.true;
      await expect(token.connect(bridgeOperator).mint(bridgeOperator.address, 1n))
        .to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });

    it("authorizes a contract minter through full governance and records the cap", async () => {
      const cap = ethers.parseEther("1000");
      const caller = await authorizeEoaMinter(cap);
      const entry = await token.bridgeMinters(await caller.getAddress());
      expect(entry.enabled).to.be.true;
      expect(entry.cap).to.equal(cap);
      expect(entry.netMinted).to.equal(0n);
    });

    it("does not execute before the 24h delay elapses", async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();
      const addr = await caller.getAddress();

      const tx = await token
        .connect(owner)
        .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, addr, ethers.ZeroHash, ethers.parseEther("1"), ZeroAddress);
      const id = await getProposalId(await tx.wait(), token);

      // Approve immediately — quorum is met but executionTime has not been reached.
      await token.connect(admin).approveProposal(id);
      expect((await token.bridgeMinters(addr)).enabled).to.be.false;

      await time.increase(ONE_DAY);
      await token.connect(owner).executeProposal(id);
      expect((await token.bridgeMinters(addr)).enabled).to.be.true;
    });

    it("rejects authorizing an EOA (a minter can burn any holder's balance)", async () => {
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, user.address, ethers.ZeroHash, ethers.parseEther("1"), ZeroAddress)
      ).to.be.revertedWithCustomError(token, "MinterMustBeContract");
    });

    it("rejects a zero cap and a zero address", async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, await caller.getAddress(), ethers.ZeroHash, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "AmountMustBePositive");

      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, ZeroAddress, ethers.ZeroHash, 1n, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "InvalidAddress");
    });

    it("rejects a cap above int96 max (guards the netMinted downcast)", async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();

      const INT96_MAX = 2n ** 95n - 1n;
      // cap is uint96, so a value above int96 max is expressible and would make the
      // `int96(net)` downcast in mint() truncate silently.
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, await caller.getAddress(), ethers.ZeroHash, INT96_MAX + 1n, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "BridgeMintCapTooHigh");

      // Exactly int96 max is accepted.
      await token
        .connect(owner)
        .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, await caller.getAddress(), ethers.ZeroHash, INT96_MAX, ZeroAddress);
    });

    it("revokes a minter and preserves its netMinted accounting", async () => {
      const caller = await authorizeEoaMinter(ethers.parseEther("1000"));
      const addr = await caller.getAddress();
      await caller.callMint(user.address, ethers.parseEther("100"));

      await runProposal(token, owner, admin, PROPOSAL_REMOVE_BRIDGE_MINTER, addr);

      const entry = await token.bridgeMinters(addr);
      expect(entry.enabled).to.be.false;
      expect(entry.netMinted).to.equal(ethers.parseEther("100")); // preserved audit trail
      await expect(caller.callMint(user.address, 1n))
        .to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });

    it("a revoked minter can neither mint NOR burn", async () => {
      // Revoking must close BOTH selectors. `burn` is the dangerous one — it takes tokens from an
      // arbitrary holder with no allowance — so a revoke that only stopped `mint` would leave the
      // worst capability live. Type 13 is the slowest kill switch but the only permanent one.
      await fund(token, distributor.address, ethers.parseEther("100"));
      const caller = await authorizeEoaMinter(ethers.parseEther("1000"));
      const addr = await caller.getAddress();
      await caller.callBurn(distributor.address, ethers.parseEther("1")); // works while enabled

      await runProposal(token, owner, admin, PROPOSAL_REMOVE_BRIDGE_MINTER, addr);

      await expect(caller.callMint(user.address, 1n)).to.be.revertedWithCustomError(
        token,
        "NotBridgeMinter"
      );
      await expect(
        caller.callBurn(distributor.address, 1n)
      ).to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });

    it("an expired proposal releases the target so it can be proposed again", async () => {
      // `_checkExpiredProposal` deletes `pendingProposals[target]` for every non-Upgrade type,
      // which should include the new 12/13. If it did NOT, an expired SetBridgeMinter would block
      // that adapter address from ever being authorized — an unrecoverable operational dead end
      // for an immutable, already-deployed adapter.
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();
      const addr = await caller.getAddress();

      await token
        .connect(owner)
        .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, addr, ethers.ZeroHash, 1n, ZeroAddress);
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, addr, ethers.ZeroHash, 2n, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "ExistingActiveProposal");

      // ProposalTypes.PROPOSAL_TIMEOUT is 3 days (NOT the 48h quoted in the design doc).
      await time.increase(3 * 24 * 60 * 60 + 1);
      await token.connect(owner).cleanupExpiredProposals(10);

      expect((await token.bridgeMinters(addr)).enabled, "expired proposal must not have executed")
        .to.be.false;

      // The address is free again, and a fresh proposal now succeeds end to end.
      await runProposal(token, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, addr, ethers.parseEther("7"));
      expect((await token.bridgeMinters(addr)).cap).to.equal(ethers.parseEther("7"));
    });

    it("rejects revoking a minter that was never authorized", async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_REMOVE_BRIDGE_MINTER, 0, await caller.getAddress(), ethers.ZeroHash, 0, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });

    it("blocks a second concurrent proposal on the same minter", async () => {
      const Caller = await ethers.getContractFactory("MockBridgeMinterCaller");
      const caller = await Caller.deploy(await token.getAddress());
      await caller.waitForDeployment();
      const addr = await caller.getAddress();

      await token
        .connect(owner)
        .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, addr, ethers.ZeroHash, 1n, ZeroAddress);
      await expect(
        token
          .connect(owner)
          .createProposal(PROPOSAL_SET_BRIDGE_MINTER, 0, addr, ethers.ZeroHash, 2n, ZeroAddress)
      ).to.be.revertedWithCustomError(token, "ExistingActiveProposal");
    });

    it("allows re-issuing on an enabled minter to raise the cap", async () => {
      const caller = await authorizeEoaMinter(ethers.parseEther("100"));
      const addr = await caller.getAddress();
      await runProposal(token, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, addr, ethers.parseEther("500"));
      expect((await token.bridgeMinters(addr)).cap).to.equal(ethers.parseEther("500"));
    });
  });

  // ===================================================================
  describe("mint cap enforcement", () => {
    it("enforces the per-minter net cap", async () => {
      const cap = ethers.parseEther("100");
      const caller = await authorizeEoaMinter(cap);
      await caller.callMint(user.address, cap);
      await expect(caller.callMint(user.address, 1n))
        .to.be.revertedWithCustomError(token, "BridgeMintCapExceeded");
    });

    it("frees cap headroom when tokens are bridged back out (netMinted decrements)", async () => {
      const cap = ethers.parseEther("100");
      const caller = await authorizeEoaMinter(cap);
      await caller.callMint(user.address, cap);
      await expect(caller.callMint(user.address, 1n))
        .to.be.revertedWithCustomError(token, "BridgeMintCapExceeded");

      await caller.callBurn(user.address, ethers.parseEther("40"));
      expect((await token.bridgeMinters(await caller.getAddress())).netMinted)
        .to.equal(ethers.parseEther("60"));

      // Headroom restored — this is why netMinted is signed rather than monotonic.
      await caller.callMint(user.address, ethers.parseEther("40"));
    });

    it("allows netMinted to go negative when the chain is a net exporter", async () => {
      await fund(token, distributor.address, ethers.parseEther("1000"));
      const caller = await authorizeEoaMinter();
      await caller.callBurn(distributor.address, ethers.parseEther("100"));
      expect((await token.bridgeMinters(await caller.getAddress())).netMinted)
        .to.equal(-ethers.parseEther("100"));
    });

    it("enforces the absolute TOTAL_SUPPLY backstop", async () => {
      const caller = await authorizeEoaMinter(TOTAL_SUPPLY);
      const remaining = TOTAL_SUPPLY - (await token.totalSupply());
      await expect(caller.callMint(user.address, remaining + 1n))
        .to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
      await caller.callMint(user.address, remaining); // exactly at the cap is fine
    });

    it("voluntary burns do not manufacture fresh mint headroom", async () => {
      await fund(token, distributor.address, ethers.parseEther("1000"));
      const caller = await authorizeEoaMinter(TOTAL_SUPPLY);

      const burnAmount = ethers.parseEther("500");
      await token.connect(distributor)["burn(uint256)"](burnAmount);
      expect(await token.voluntarilyBurned()).to.equal(burnAmount);

      // Headroom must be measured against totalSupply + voluntarilyBurned, so the burn
      // must NOT have increased what the bridge may mint.
      const remaining = TOTAL_SUPPLY - (await token.totalSupply()) - (await token.voluntarilyBurned());
      await expect(caller.callMint(user.address, remaining + 1n))
        .to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
    });

    it("lowering the cap below netMinted freezes minting until burns catch up", async () => {
      // Type 12 is deliberately re-issuable on an enabled minter — that is how governance RAISES
      // a cap during staged rollout. It can equally LOWER one, and because `netMinted` is
      // preserved, a cap below the current position freezes inbound transfers immediately.
      // Operators need to know this is the behaviour before they use it as a soft brake.
      const caller = await authorizeEoaMinter(ethers.parseEther("1000"));
      const addr = await caller.getAddress();
      await caller.callMint(user.address, ethers.parseEther("800"));

      await runProposal(
        token, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, addr, ethers.parseEther("500")
      );
      const entry = await token.bridgeMinters(addr);
      expect(entry.cap).to.equal(ethers.parseEther("500"));
      expect(entry.netMinted, "netMinted must survive a cap change").to.equal(
        ethers.parseEther("800")
      );

      await expect(caller.callMint(user.address, 1n)).to.be.revertedWithCustomError(
        token,
        "BridgeMintCapExceeded"
      );

      // Outbound traffic pulls netMinted back under the cap and inbound resumes — no upgrade
      // needed, which is what makes this a usable brake rather than a trap.
      await caller.callBurn(user.address, ethers.parseEther("400")); // netMinted -> 400
      await caller.callMint(user.address, ethers.parseEther("100")); // 500 == cap, allowed
      await expect(caller.callMint(user.address, 1n)).to.be.revertedWithCustomError(
        token,
        "BridgeMintCapExceeded"
      );
    });

    it("PINNED: voluntarilyBurned permanently consumes this chain's inbound headroom", async () => {
      // Documents a real, deliberate limitation rather than asserting it is desirable.
      //
      // `mint` gates on `totalSupply() + voluntarilyBurned + amount <= TOTAL_SUPPLY`. Both terms
      // are PER-CHAIN, but TOTAL_SUPPLY is the GLOBAL 2B cap, so the check is a conservative
      // approximation. It can never over-mint globally, but voluntary burns on this chain
      // permanently reduce how much this chain can ever receive — even though those burns
      // destroyed value and reduced global supply.
      //
      // Direction of failure is safe (inbound transfers park, retryable, no funds lost) and the
      // staged rollout caps are orders of magnitude below the threshold. Recovery would require
      // an upgrade. See the risk register in docs/bridge-design.md.
      const caller = await authorizeEoaMinter(TOTAL_SUPPLY);

      const headroom = TOTAL_SUPPLY - (await token.totalSupply());
      await caller.callMint(user.address, headroom); // this chain is now at the global cap
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);

      // Destroy half of it voluntarily. Global supply falls, but headroom does NOT come back.
      const burned = headroom / 2n;
      await token.connect(user)["burn(uint256)"](burned);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY - burned);
      expect(await token.voluntarilyBurned()).to.equal(burned);

      // Even one wei of legitimate inbound is now refused on this chain.
      await expect(caller.callMint(user.address, 1n)).to.be.revertedWithCustomError(
        token,
        "ExceedsMaximumSupply"
      );
    });

    it("tracks voluntarilyBurned for burn and burnFrom but not for bridge burns", async () => {
      await fund(token, distributor.address, ethers.parseEther("1000"));
      const caller = await authorizeEoaMinter();

      await token.connect(distributor)["burn(uint256)"](ethers.parseEther("10"));
      expect(await token.voluntarilyBurned()).to.equal(ethers.parseEther("10"));

      await token.connect(distributor).approve(user.address, ethers.parseEther("5"));
      await token.connect(user).burnFrom(distributor.address, ethers.parseEther("5"));
      expect(await token.voluntarilyBurned()).to.equal(ethers.parseEther("15"));

      // A bridge burn is NOT a voluntary burn — it is matched by a mint on another chain.
      await caller.callBurn(distributor.address, ethers.parseEther("20"));
      expect(await token.voluntarilyBurned()).to.equal(ethers.parseEther("15"));
    });
  });

  // ===================================================================
  // `bridgeOp` is the DEPRECATED legacy path, but this change modified its supply predicate
  // (`totalSupply()` -> `totalSupply() + voluntarilyBurned`) and it had no coverage at all.
  // A changed line in a live, deployed, role-gated mint function must not ship untested.
  // ===================================================================
  describe("bridgeOp (deprecated legacy path)", () => {
    const CHAIN = 137;
    const NONCE = 42;

    beforeEach(async () => {
      await runProposal(token, owner, admin, 1 /* AddRole */, bridgeOperator.address, BigInt(0), BRIDGE_OPERATOR_ROLE);
      await token.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, TOTAL_SUPPLY);
      await token.connect(owner).setBridgeOpNonce(CHAIN, NONCE);
    });

    it("voluntary burns no longer manufacture bridgeOp mint headroom", async () => {
      // THE REGRESSION THIS CHANGE FIXES. Before, the cap was `totalSupply() + amount <=
      // TOTAL_SUPPLY`, so burning tokens lowered totalSupply and handed the same amount back as
      // fresh mint capacity — repeatable without limit.
      await fund(token, distributor.address, ethers.parseEther("1000"));
      await token.connect(distributor)["burn(uint256)"](ethers.parseEther("1000"));
      expect(await token.voluntarilyBurned()).to.equal(ethers.parseEther("1000"));

      const headroom =
        TOTAL_SUPPLY - (await token.totalSupply()) - (await token.voluntarilyBurned());

      // One wei past the corrected boundary must fail (a revert does not consume the nonce).
      await expect(
        token.connect(bridgeOperator).bridgeOp(headroom + 1n, CHAIN, NONCE, 1)
      ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");

      // Exactly at the boundary still works — the fix tightens the cap, it does not break the path.
      await token.connect(bridgeOperator).bridgeOp(headroom, CHAIN, NONCE, 1);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY - ethers.parseEther("1000"));
    });

    it("still mints to the token contract and consumes its nonce", async () => {
      const amount = ethers.parseEther("1000");
      const supplyBefore = await token.totalSupply();
      const contractBefore = await token.balanceOf(await token.getAddress());

      await token.connect(bridgeOperator).bridgeOp(amount, CHAIN, NONCE, 1);

      expect(await token.totalSupply()).to.equal(supplyBefore + amount);
      expect(await token.balanceOf(await token.getAddress())).to.equal(contractBefore + amount);
      // Nonce is one-shot: reusing it reverts.
      await expect(
        token.connect(bridgeOperator).bridgeOp(amount, CHAIN, NONCE, 1)
      ).to.be.revertedWithCustomError(token, "UsedNonce");
    });

    it("takes no treasury fee on a legacy mint or burn either", async () => {
      // `bridgeOp` routes through the same `_update` hook, so the fee fix must protect it too.
      await runProposal(token, owner, admin, PROPOSAL_CHANGE_TREASURY_FEE, other.address, BigInt(500));
      const treasury = await token.treasury();
      const treasuryBefore = await token.balanceOf(treasury);
      const amount = ethers.parseEther("1000");

      await token.connect(bridgeOperator).bridgeOp(amount, CHAIN, NONCE, 1);
      await token.connect(owner).setBridgeOpNonce(CHAIN, NONCE + 1);
      await token.connect(bridgeOperator).bridgeOp(amount, CHAIN, NONCE + 1, 2);

      expect(await token.balanceOf(treasury)).to.equal(treasuryBefore);
    });

    it("confers no authority on the new bridge mint/burn surface", async () => {
      // BRIDGE_OPERATOR_ROLE and `bridgeMinters` are deliberately separate authorities. This is
      // the regression guard for the rejected "just reuse BRIDGE_OPERATOR_ROLE" design, which
      // would have handed arbitrary mint power to every existing operator EOA.
      await expect(
        token.connect(bridgeOperator).mint(bridgeOperator.address, 1n)
      ).to.be.revertedWithCustomError(token, "NotBridgeMinter");
      await expect(
        token.connect(bridgeOperator)["burn(address,uint256)"](distributor.address, 1n)
      ).to.be.revertedWithCustomError(token, "NotBridgeMinter");
    });
  });

  // ===================================================================
  describe("pause and blacklist behaviour", () => {
    it("blocks mint and burn while paused", async () => {
      const caller = await authorizeEoaMinter();
      await token.connect(owner).emergencyAction(1); // pause
      await expect(caller.callMint(user.address, 1n))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(caller.callBurn(user.address, 1n))
        .to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("blocks minting to a blacklisted recipient", async () => {
      const caller = await authorizeEoaMinter();
      await runProposal(token, owner, admin, 9 /* AddToBlacklist */, user.address);
      await expect(caller.callMint(user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(token, "BlacklistedAddress");
    });

    it("blocks burning from a blacklisted holder", async () => {
      await fund(token, distributor.address, ethers.parseEther("100"));
      const caller = await authorizeEoaMinter();
      await runProposal(token, owner, admin, 9 /* AddToBlacklist */, distributor.address);
      await expect(caller.callBurn(distributor.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(token, "BlacklistedAddress");
    });

    it("rejects zero amount and zero address", async () => {
      const caller = await authorizeEoaMinter();
      await expect(caller.callMint(user.address, 0n))
        .to.be.revertedWithCustomError(token, "AmountMustBePositive");
      await expect(caller.callMint(ZeroAddress, 1n))
        .to.be.revertedWithCustomError(token, "InvalidAddress");
    });
  });

  // ===================================================================
  // End-to-end: two chains simulated in one EVM.
  // ===================================================================
  describe("cross-chain round trip", () => {
    let tokenA: any, tokenB: any;
    let adapterA: any, adapterB: any;
    let endpointA: any, endpointB: any;

    const CAP = ethers.parseEther("100000000");

    beforeEach(async () => {
      tokenA = token; // already deployed in the outer beforeEach
      tokenB = await deployToken();

      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      endpointA = await Endpoint.deploy(EID_A);
      endpointB = await Endpoint.deploy(EID_B);
      await endpointA.waitForDeployment();
      await endpointB.waitForDeployment();
      await endpointA.setDestLzEndpoint(EID_B, await endpointB.getAddress());
      await endpointB.setDestLzEndpoint(EID_A, await endpointA.getAddress());

      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      adapterA = await Adapter.deploy(
        await tokenA.getAddress(),
        await tokenA.getAddress(),
        await endpointA.getAddress(),
        owner.address
      );
      adapterB = await Adapter.deploy(
        await tokenB.getAddress(),
        await tokenB.getAddress(),
        await endpointB.getAddress(),
        owner.address
      );
      await adapterA.waitForDeployment();
      await adapterB.waitForDeployment();

      // Peer the adapters.
      await adapterA
        .connect(owner)
        .setPeer(EID_B, ethers.zeroPadValue(await adapterB.getAddress(), 32));
      await adapterB
        .connect(owner)
        .setPeer(EID_A, ethers.zeroPadValue(await adapterA.getAddress(), 32));

      // Authorize each adapter as a bridge minter on its own chain.
      await runProposal(tokenA, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, await adapterA.getAddress(), CAP);
      await runProposal(tokenB, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, await adapterB.getAddress(), CAP);

      // MANDATORY: the rate limiter is fail-closed. An unconfigured lane reverts every
      // outbound transfer with RateLimitExceeded, so this must be part of go-live wiring.
      const RATE_WINDOW = 86400;
      await adapterA
        .connect(owner)
        .setRateLimits([{ dstEid: EID_B, limit: CAP, window: RATE_WINDOW }]);
      await adapterB
        .connect(owner)
        .setRateLimits([{ dstEid: EID_A, limit: CAP, window: RATE_WINDOW }]);

      await fund(tokenA, user.address, ethers.parseEther("1000"));
    });

    async function send(adapter: any, from: SignerWithAddress, dstEid: number, to: string, amount: bigint) {
      const sendParam = {
        dstEid,
        to: ethers.zeroPadValue(to, 32),
        amountLD: amount,
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const fee = await adapter.quoteSend(sendParam, false);
      return adapter
        .connect(from)
        .send(sendParam, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, from.address, {
          value: fee.nativeFee,
        });
    }

    it("conserves global supply across a one-way transfer", async () => {
      const amount = ethers.parseEther("100");
      const supplyABefore: bigint = await tokenA.totalSupply();
      const supplyBBefore: bigint = await tokenB.totalSupply();

      await send(adapterA, user, EID_B, user.address, amount);

      // Source burned immediately; destination not yet credited. Global supply is
      // temporarily REDUCED while the message is in flight — never inflated.
      expect(await tokenA.totalSupply()).to.equal(supplyABefore - amount);
      expect(await tokenB.totalSupply()).to.equal(supplyBBefore);

      await endpointB.deliverNext();

      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
      expect(await tokenB.totalSupply()).to.equal(supplyBBefore + amount);
      expect((await tokenA.totalSupply()) + (await tokenB.totalSupply())).to.equal(
        supplyABefore + supplyBBefore
      );
    });

    it("conserves global supply across a full round trip", async () => {
      const amount = ethers.parseEther("250");
      const globalBefore = (await tokenA.totalSupply()) + (await tokenB.totalSupply());
      const userABefore = await tokenA.balanceOf(user.address);

      await send(adapterA, user, EID_B, user.address, amount);
      await endpointB.deliverNext();
      await send(adapterB, user, EID_A, user.address, amount);
      await endpointA.deliverNext();

      expect(await tokenA.balanceOf(user.address)).to.equal(userABefore);
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);
      expect((await tokenA.totalSupply()) + (await tokenB.totalSupply())).to.equal(globalBefore);
    });

    it("leaves dust with the sender and never destroys it", async () => {
      // sharedDecimals is 6, so with 18 local decimals the dust granularity is 1e12.
      const amount = ethers.parseEther("1") + 999n;
      const userBefore = await tokenA.balanceOf(user.address);
      const globalBefore = (await tokenA.totalSupply()) + (await tokenB.totalSupply());

      await send(adapterA, user, EID_B, user.address, amount);
      await endpointB.deliverNext();

      // Exactly 1e18 crossed; the 999 wei of dust stayed behind.
      expect(await tokenB.balanceOf(user.address)).to.equal(ethers.parseEther("1"));
      expect(await tokenA.balanceOf(user.address)).to.equal(userBefore - ethers.parseEther("1"));
      expect((await tokenA.totalSupply()) + (await tokenB.totalSupply())).to.equal(globalBefore);
    });

    it("parks and retries an inbound transfer blocked on the destination", async () => {
      const amount = ethers.parseEther("10");
      await runProposal(tokenB, owner, admin, 9 /* AddToBlacklist */, user.address);

      const supplyABefore = await tokenA.totalSupply();
      await send(adapterA, user, EID_B, user.address, amount);
      // Source supply is already reduced while the message is parked.
      expect(await tokenA.totalSupply()).to.equal(supplyABefore - amount);

      // Assert the SPECIFIC error. A bare `.to.be.reverted` would also pass if `deliverNext`
      // reverted with "no pending message" — i.e. if the send had silently queued nothing.
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
        tokenB,
        "BlacklistedAddress"
      );
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);

      // Clear the blocking condition, then anyone may retry — no funds lost.
      await runProposal(tokenB, owner, admin, 10 /* RemoveFromBlacklist */, user.address);
      await endpointB.deliver(0);
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("halts OUTBOUND when the peer is unset", async () => {
      await adapterA.connect(owner).setPeer(EID_B, ethers.ZeroHash);
      // `OAppSender._lzSend` -> `_getPeerOrRevert` -> NoPeer(dstEid).
      await expect(send(adapterA, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(adapterA, "NoPeer")
        .withArgs(EID_B);
    });

    it("halts INBOUND when the peer is unset, and the message survives to be retried", async () => {
      // The design doc calls setPeer(0) a kill switch for BOTH directions. Outbound is covered
      // above; this is the inbound leg, which was previously asserted only by the test's title.
      const amount = ethers.parseEther("5");
      await send(adapterA, user, EID_B, user.address, amount);

      // Clear the peer on the RECEIVING side. `OAppReceiver.lzReceive` compares
      // `_getPeerOrRevert(srcEid)` against `origin.sender`, so an unset peer reverts NoPeer.
      await adapterB.connect(owner).setPeer(EID_A, ethers.ZeroHash);
      await expect(endpointB.deliverNext())
        .to.be.revertedWithCustomError(adapterB, "NoPeer")
        .withArgs(EID_A);
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);

      // Restoring the peer makes the parked message deliverable again — a halt, not a loss.
      await adapterB
        .connect(owner)
        .setPeer(EID_A, ethers.zeroPadValue(await adapterA.getAddress(), 32));
      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("rejects an inbound message from an address that is not the configured peer", async () => {
      // Guards R-02 from the other side: even with a live lane, only the registered peer may
      // deliver. Repoint adapterB at an impostor and the queued message must be refused.
      const amount = ethers.parseEther("5");
      await send(adapterA, user, EID_B, user.address, amount);

      await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(adapterB, "OnlyPeer");
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);
    });

    it("is FAIL-CLOSED: an unconfigured lane rejects every transfer", async () => {
      // Deploy a fresh adapter that is peered and authorized but has NO rate limit set.
      // LayerZero's RateLimiter returns amountCanBeSent == 0 for an unconfigured dstEid, so the
      // bridge is inert until governance sets an explicit ceiling. This is the intended posture,
      // and this test exists so nobody "fixes" it into a fail-open default.
      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      const fresh = await Adapter.deploy(
        await tokenA.getAddress(),
        await tokenA.getAddress(),
        await endpointA.getAddress(),
        owner.address
      );
      await fresh.waitForDeployment();
      await fresh.connect(owner).setPeer(EID_B, ethers.zeroPadValue(await adapterB.getAddress(), 32));
      await runProposal(tokenA, owner, admin, PROPOSAL_SET_BRIDGE_MINTER, await fresh.getAddress(), CAP);

      await expect(send(fresh, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(fresh, "RateLimitExceeded");

      // And works as soon as a limit is configured.
      await fresh
        .connect(owner)
        .setRateLimits([{ dstEid: EID_B, limit: ethers.parseEther("10"), window: 86400 }]);
      await send(fresh, user, EID_B, user.address, ethers.parseEther("1"));
    });

    it("enforces the outbound rate limit and restores capacity after the window", async () => {
      const limit = ethers.parseEther("100");
      const window = 3600;
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit, window }]);

      await send(adapterA, user, EID_B, user.address, limit);
      await expect(send(adapterA, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      await time.increase(window + 1);
      await send(adapterA, user, EID_B, user.address, ethers.parseEther("1"));
    });

    it("rate limit of zero acts as an immediate kill switch", async () => {
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: 0n, window: 1 }]);
      await expect(send(adapterA, user, EID_B, user.address, 1n)).to.be.reverted;
    });

    it("restricts owner-only configuration", async () => {
      await expect(
        adapterA.connect(user).setPeer(EID_B, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(adapterA, "OwnableUnauthorizedAccount");
      await expect(
        adapterA.connect(user).setRateLimits([{ dstEid: EID_B, limit: 1n, window: 1 }])
      ).to.be.revertedWithCustomError(adapterA, "OwnableUnauthorizedAccount");
    });

    it("wires the adapter to the token correctly", async () => {
      expect(await adapterA.token()).to.equal(await tokenA.getAddress());
      expect(await adapterA.minterBurner()).to.equal(await tokenA.getAddress());
      expect(await adapterA.owner()).to.equal(owner.address);
      expect(await adapterA.sharedDecimals()).to.equal(6);
      expect(await adapterA.decimalConversionRate()).to.equal(10n ** 12n);
      expect(await adapterA.approvalRequired()).to.be.false;
    });

    it("token() and minterBurner() are the SAME contract", async () => {
      // Load-bearing deploy invariant. `_debit` measures `totalSupply()` on `token()` but burns
      // through `minterBurner`. If a deployment ever passed two different addresses, the
      // supply-conservation assertion would be measuring a contract that never changed — the
      // guard would read as passing while proving nothing. Asserted separately from the wiring
      // test above so the failure message names the actual invariant.
      expect(await adapterA.token()).to.equal(await adapterA.minterBurner());
      expect(await adapterB.token()).to.equal(await adapterB.minterBurner());
    });

    // ---------------------------------------------------------------
    // R-01 (Critical in the risk register): a bridge minter can burn ANY holder's balance with
    // no allowance. The design doc requires a test that no adapter path reaches `burn` with a
    // `_from` other than `msg.sender`. `OFTCore._send` hardcodes `_debit(msg.sender, ...)`, so
    // there is no calldata field that can name a victim — these tests pin that.
    // ---------------------------------------------------------------
    it("R-01: send burns ONLY the caller's balance, never a third party's", async () => {
      await fund(tokenA, other.address, ethers.parseEther("500"));
      const victimBefore = await tokenA.balanceOf(other.address);
      const senderBefore = await tokenA.balanceOf(user.address);
      const amount = ethers.parseEther("100");

      // `other` is named as the cross-chain RECIPIENT — the only third-party address a caller
      // controls in SendParam. It must not cause `other`'s source balance to be touched.
      await send(adapterA, user, EID_B, other.address, amount);

      expect(await tokenA.balanceOf(user.address)).to.equal(senderBefore - amount);
      expect(
        await tokenA.balanceOf(other.address),
        "R-01 VIOLATED: a third party's balance was burned"
      ).to.equal(victimBefore);

      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(other.address)).to.equal(amount);
    });

    it("R-01: a caller with no balance cannot drain a funded holder", async () => {
      // `other` holds nothing on chain A; `user` is flush. If `_from` were attacker-selectable
      // this would succeed against user's balance instead of reverting.
      const richBefore = await tokenA.balanceOf(user.address);
      expect(richBefore).to.be.gt(ethers.parseEther("1"));
      expect(await tokenA.balanceOf(other.address)).to.equal(0n);

      await expect(
        send(adapterA, other, EID_B, other.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(tokenA, "ERC20InsufficientBalance");

      expect(await tokenA.balanceOf(user.address)).to.equal(richBefore);
    });

    // ---------------------------------------------------------------
    it("PINNED: the rate limit is NET, not gross — inbound refills outbound capacity", async () => {
      // DELIBERATE BEHAVIOUR PIN, NOT AN ENDORSEMENT.
      //
      // `_debit` calls `_outflow(dstEid)` and `_credit` calls `_inflow(srcEid)`. For a single
      // A<->B lane those are the SAME mapping key, so an inbound transfer subtracts from the very
      // counter that outbound transfers add to. The limiter therefore bounds NET drain per
      // window, not GROSS volume: capital that round-trips can move without limit.
      //
      // Consequences to be aware of when reading the rollout table's "rate limit / 24h" column:
      //   - "10M/24h" bounds net export, not total burn volume.
      //   - The `limit = 0` kill switch is UNAFFECTED: `amountCanBeSent` is 0 regardless of
      //     inflow, which is why it remains the fastest kill switch.
      //   - Inbound mint volume is not rate-limited at all; `bridgeMinters.cap` is its bound.
      //
      // The design doc specified only `_outflow`; `_inflow` was added during implementation.
      // If a gross ceiling is what is wanted, delete `_inflow` from `_credit` — this test is
      // what will fail, and it should be replaced by its inverse.
      const limit = ethers.parseEther("100");
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit, window: 3600 }]);

      await send(adapterA, user, EID_B, user.address, limit); // exhaust A -> B
      await endpointB.deliverNext();
      await expect(
        send(adapterA, user, EID_B, user.address, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      // Round-trip the same tokens back. Delivery on A calls `_inflow(EID_B, 100)`, zeroing A's
      // outbound-to-B counter within the same window.
      await send(adapterB, user, EID_A, user.address, limit);
      await endpointA.deliverNext();
      expect((await adapterA.rateLimits(EID_B)).amountInFlight).to.equal(0n);

      // Outbound capacity is restored without any time passing.
      await send(adapterA, user, EID_B, user.address, ethers.parseEther("50"));
    });

    it("redirects a zero-address recipient to 0xdead instead of reverting", async () => {
      // `MintBurnOFTAdapter._credit` rewrites a zero recipient to 0xdead because `_mint` rejects
      // address(0) — and StorageToken.mint independently reverts InvalidAddress on address(0).
      // FulaOFTAdapter._credit mirrors that rewrite when choosing whose balance to measure for
      // the supply-invariant check; if the mirror were wrong it would measure balanceOf(0) (always
      // zero) and revert SupplyInvariantViolated on every such message. That branch had no
      // coverage, so it was effectively untested code on the inbound path.
      const DEAD = "0x000000000000000000000000000000000000dEaD";
      const amount = ethers.parseEther("3");
      const deadBefore = await tokenB.balanceOf(DEAD);

      await send(adapterA, user, EID_B, ZeroAddress, amount);
      await endpointB.deliverNext();

      expect(await tokenB.balanceOf(DEAD)).to.equal(deadBefore + amount);
    });

    it("resetRateLimits clears accumulated usage and is owner-only", async () => {
      const limit = ethers.parseEther("100");
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit, window: 3600 }]);
      await send(adapterA, user, EID_B, user.address, limit);
      await expect(
        send(adapterA, user, EID_B, user.address, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      await expect(
        adapterA.connect(user).resetRateLimits([EID_B])
      ).to.be.revertedWithCustomError(adapterA, "OwnableUnauthorizedAccount");

      await adapterA.connect(owner).resetRateLimits([EID_B]);
      expect((await adapterA.rateLimits(EID_B)).amountInFlight).to.equal(0n);
      await send(adapterA, user, EID_B, user.address, ethers.parseEther("50"));
    });

    it("parks and retries an inbound transfer when the destination token is PAUSED", async () => {
      // The other half of the kill-switch story: `emergencyAction(1)` on the destination must
      // delay inbound transfers, never destroy them. Source supply stays reduced throughout.
      const amount = ethers.parseEther("10");
      const supplyABefore = await tokenA.totalSupply();
      await send(adapterA, user, EID_B, user.address, amount);
      expect(await tokenA.totalSupply()).to.equal(supplyABefore - amount);

      await tokenB.connect(owner).emergencyAction(1); // pause
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
        tokenB,
        "EnforcedPause"
      );
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);

      await time.increase(30 * 60 + 1); // ProposalTypes.EMERGENCY_COOLDOWN
      await tokenB.connect(owner).emergencyAction(2); // unpause

      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });
  });

  // ===================================================================
  // The adapter must refuse to under-burn or under-credit, so that a future
  // regression in the token's _update becomes a revert rather than silent inflation.
  // ===================================================================
  describe("supply-invariant guard", () => {
    let lossy: any, adapter: any, endpoint: any;

    beforeEach(async () => {
      const Lossy = await ethers.getContractFactory("MockLossyMintBurnToken");
      lossy = await Lossy.deploy(0);
      await lossy.waitForDeployment();

      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      endpoint = await Endpoint.deploy(EID_A);
      await endpoint.waitForDeployment();

      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      adapter = await Adapter.deploy(
        await lossy.getAddress(),
        await lossy.getAddress(),
        await endpoint.getAddress(),
        owner.address
      );
      await adapter.waitForDeployment();
      await adapter.connect(owner).setPeer(EID_B, ethers.zeroPadValue(await adapter.getAddress(), 32));
      await adapter
        .connect(owner)
        .setRateLimits([{ dstEid: EID_B, limit: ethers.parseEther("1000000"), window: 86400 }]);

      await lossy.mintFree(user.address, ethers.parseEther("1000"));
    });

    async function trySend(amount: bigint) {
      const sendParam = {
        dstEid: EID_B,
        to: ethers.zeroPadValue(user.address, 32),
        amountLD: amount,
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const fee = await adapter.quoteSend(sendParam, false);
      return adapter
        .connect(user)
        .send(sendParam, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, user.address, {
          value: fee.nativeFee,
        });
    }

    it("permits a transfer while the token is lossless", async () => {
      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      const dst = await Endpoint.deploy(EID_B);
      await dst.waitForDeployment();
      await endpoint.setDestLzEndpoint(EID_B, await dst.getAddress());
      await trySend(ethers.parseEther("10")); // no revert
    });

    it("reverts the outbound burn when the token destroys less than requested", async () => {
      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      const dst = await Endpoint.deploy(EID_B);
      await dst.waitForDeployment();
      await endpoint.setDestLzEndpoint(EID_B, await dst.getAddress());

      await lossy.setLossBps(500); // 5% skim — the exact un-fixed _update failure mode
      await expect(trySend(ethers.parseEther("10")))
        .to.be.revertedWithCustomError(adapter, "SupplyInvariantViolated");
    });

    it("reverts the INBOUND mint when the token credits less than promised", async () => {
      // The mirror-image guard, previously untested. `MintBurnOFTAdapter._credit` returns
      // `_amountLD` unconditionally without checking the recipient actually received it, so
      // without this override a fee-on-mint regression would inflate global supply invisibly to
      // LayerZero: the source burned the full amount, the destination credited less, and the
      // OFTReceived event would still report the full amount.
      //
      // Self-loop wiring: this endpoint is its own destination, so a send comes straight back as
      // an inbound message to the same adapter. Peers are set for both eids to the adapter.
      await endpoint.setDestLzEndpoint(EID_B, await endpoint.getAddress());
      await adapter
        .connect(owner)
        .setPeer(EID_A, ethers.zeroPadValue(await adapter.getAddress(), 32));

      const amount = ethers.parseEther("10");
      const supplyBefore = await lossy.totalSupply();

      // Send while the token is LOSSLESS so the outbound `_debit` check passes cleanly. This
      // isolates `_credit` — a failure now can only come from the inbound side.
      await trySend(amount);
      expect(await lossy.totalSupply()).to.equal(supplyBefore - amount);

      await lossy.setLossBps(500);
      await expect(endpoint.deliverNext()).to.be.revertedWithCustomError(
        adapter,
        "SupplyInvariantViolated"
      );
      // Nothing was credited, and the source-side burn stands.
      expect(await lossy.totalSupply()).to.equal(supplyBefore - amount);

      // Reverting is non-destructive: clear the fault and the parked message delivers in full.
      await lossy.setLossBps(0);
      await endpoint.deliverNext();
      expect(await lossy.totalSupply()).to.equal(supplyBefore);
      expect(await lossy.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    });

    it("accepts an inbound mint that credits exactly the promised amount", async () => {
      // Negative control for the test above: with a lossless token the same path must succeed,
      // proving the revert is caused by the loss and not by the self-loop wiring.
      await endpoint.setDestLzEndpoint(EID_B, await endpoint.getAddress());
      await adapter
        .connect(owner)
        .setPeer(EID_A, ethers.zeroPadValue(await adapter.getAddress(), 32));

      const supplyBefore = await lossy.totalSupply();
      await trySend(ethers.parseEther("10"));
      await endpoint.deliverNext();

      expect(await lossy.totalSupply()).to.equal(supplyBefore);
      expect(await lossy.balanceOf(user.address)).to.equal(ethers.parseEther("1000"));
    });
  });
});
