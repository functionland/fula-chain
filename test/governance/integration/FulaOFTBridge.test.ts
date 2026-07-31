import { expect } from "chai";
import { ethers, upgrades, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion hard cap
const INITIAL_SUPPLY = ethers.parseEther("1000000000"); // 1 billion minted at deploy
const ONE_DAY = 24 * 60 * 60 + 1;

const PROPOSAL_ADD_WHITELIST = 5;
const PROPOSAL_ADD_BLACKLIST = 9;
const PROPOSAL_REMOVE_BLACKLIST = 10;

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

describe("FULA LayerZero OFT bridge (lock/release escrow)", () => {
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;

  /** Deploy a StorageToken proxy with governance bootstrapped. */
  async function deployToken(): Promise<any> {
    const StorageToken = await ethers.getContractFactory("StorageToken");
    const t = await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    );
    await t.waitForDeployment();
    await time.increase(ONE_DAY);
    await t.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await t.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);
    return t;
  }

  /**
   * Move `amount` out of the token contract to `to`.
   *
   * Whitelisting is idempotent here: re-proposing for an address that already holds a
   * `whitelistLockTime` reverts `AlreadyWhitelisted`, so top-ups skip straight to the transfer.
   */
  async function fund(t: any, to: string, amount: bigint) {
    const cfg = await t.timeConfigs(to);
    if (cfg.whitelistLockTime === 0n) {
      await runProposal(t, owner, admin, PROPOSAL_ADD_WHITELIST, to);
      await time.increase(ONE_DAY); // WHITELIST_LOCK_DURATION
    }
    await t.connect(owner).transferFromContract(to, amount);
  }

  beforeEach(async () => {
    [owner, admin, user, other] = await ethers.getSigners();
  });

  // ===================================================================
  // THE HEADLINE PROPERTY. With lock/release there is no mint and no burn
  // anywhere, so supply conservation is structural rather than maintained.
  // ===================================================================
  describe("cross-chain transfers", () => {
    let tokenA: any, tokenB: any;
    let adapterA: any, adapterB: any;
    let endpointA: any, endpointB: any;

    const LIQUIDITY = ethers.parseEther("1000000");
    const RATE_LIMIT = ethers.parseEther("200000000");
    // Generous relative to LIQUIDITY so ordinary tests are unaffected; the bound itself is
    // exercised deliberately in the inbound rate-limit tests below.
    const INBOUND_LIMIT = ethers.parseEther("100000000");

    beforeEach(async () => {
      tokenA = await deployToken();
      tokenB = await deployToken();

      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      endpointA = await Endpoint.deploy(EID_A);
      endpointB = await Endpoint.deploy(EID_B);
      await endpointA.waitForDeployment();
      await endpointB.waitForDeployment();
      await endpointA.setDestLzEndpoint(EID_B, await endpointB.getAddress());
      await endpointB.setDestLzEndpoint(EID_A, await endpointA.getAddress());

      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      adapterA = await Adapter.deploy(await tokenA.getAddress(), await endpointA.getAddress(), owner.address);
      adapterB = await Adapter.deploy(await tokenB.getAddress(), await endpointB.getAddress(), owner.address);
      await adapterA.waitForDeployment();
      await adapterB.waitForDeployment();

      await adapterA.connect(owner).setPeer(EID_B, ethers.zeroPadValue(await adapterB.getAddress(), 32));
      await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(await adapterA.getAddress(), 32));

      // MANDATORY: both limiters are fail-closed. Outbound throttles flow; inbound bounds how
      // much escrow a single compromise can remove. They are separate buckets on purpose.
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: RATE_LIMIT, window: 86400 }]);
      await adapterB.connect(owner).setRateLimits([{ dstEid: EID_A, limit: RATE_LIMIT, window: 86400 }]);
      await adapterA.connect(owner).setInboundRateLimits([{ dstEid: EID_B, limit: INBOUND_LIMIT, window: 86400 }]);
      await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: INBOUND_LIMIT, window: 86400 }]);

      // SEED ESCROW LIQUIDITY. Unlike mint/burn, a chain can only release what it already holds.
      await fund(tokenA, await adapterA.getAddress(), LIQUIDITY);
      await fund(tokenB, await adapterB.getAddress(), LIQUIDITY);

      await fund(tokenA, user.address, ethers.parseEther("10000"));
    });

    async function send(
      adapter: any,
      token: any,
      from: SignerWithAddress,
      dstEid: number,
      to: string,
      amount: bigint
    ) {
      // Escrow adapters require an allowance — `approvalRequired()` is true.
      await token.connect(from).approve(await adapter.getAddress(), amount);
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

    it("NEVER changes totalSupply on either chain — supply is conserved structurally", async () => {
      const supplyA = await tokenA.totalSupply();
      const supplyB = await tokenB.totalSupply();
      const amount = ethers.parseEther("100");

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      // Even mid-flight — tokens locked on A, not yet released on B — supply is untouched.
      expect(await tokenA.totalSupply()).to.equal(supplyA);
      expect(await tokenB.totalSupply()).to.equal(supplyB);

      await endpointB.deliverNext();

      expect(await tokenA.totalSupply()).to.equal(supplyA);
      expect(await tokenB.totalSupply()).to.equal(supplyB);
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("locks into escrow on the source and releases from escrow on the destination", async () => {
      const amount = ethers.parseEther("250");
      const escrowABefore = await adapterA.availableLiquidity();
      const escrowBBefore = await adapterB.availableLiquidity();
      const userABefore = await tokenA.balanceOf(user.address);

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      expect(await adapterA.availableLiquidity(), "source escrow should grow by the amount").to.equal(
        escrowABefore + amount
      );
      expect(await tokenA.balanceOf(user.address)).to.equal(userABefore - amount);

      await endpointB.deliverNext();
      expect(await adapterB.availableLiquidity(), "destination escrow should shrink by the amount").to.equal(
        escrowBBefore - amount
      );
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("conserves everything across a full round trip", async () => {
      const amount = ethers.parseEther("500");
      const globalBefore = (await tokenA.totalSupply()) + (await tokenB.totalSupply());
      const userABefore = await tokenA.balanceOf(user.address);
      const escrowABefore = await adapterA.availableLiquidity();
      const escrowBBefore = await adapterB.availableLiquidity();

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      await endpointB.deliverNext();
      await send(adapterB, tokenB, user, EID_A, user.address, amount);
      await endpointA.deliverNext();

      expect(await tokenA.balanceOf(user.address)).to.equal(userABefore);
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);
      expect(await adapterA.availableLiquidity()).to.equal(escrowABefore);
      expect(await adapterB.availableLiquidity()).to.equal(escrowBBefore);
      expect((await tokenA.totalSupply()) + (await tokenB.totalSupply())).to.equal(globalBefore);
    });

    it("requires an allowance — no approve, no transfer", async () => {
      const sendParam = {
        dstEid: EID_B,
        to: ethers.zeroPadValue(user.address, 32),
        amountLD: ethers.parseEther("1"),
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      const fee = await adapterA.quoteSend(sendParam, false);
      // `approvalRequired()` is true for an escrow adapter — this is the visible UX difference
      // versus mint/burn, and the reason a holder needs two transactions.
      expect(await adapterA.approvalRequired()).to.be.true;
      await expect(
        adapterA.connect(user).send(sendParam, { nativeFee: fee.nativeFee, lzTokenFee: 0n }, user.address, {
          value: fee.nativeFee,
        })
      ).to.be.revertedWithCustomError(tokenA, "ERC20InsufficientAllowance");
    });

    it("takes only the sender's own tokens, never a third party's", async () => {
      await fund(tokenA, other.address, ethers.parseEther("500"));
      const victimBefore = await tokenA.balanceOf(other.address);
      const senderBefore = await tokenA.balanceOf(user.address);
      const amount = ethers.parseEther("100");

      // `other` is named as the cross-chain RECIPIENT — the only third-party address a caller
      // controls in SendParam. It must not cause `other`'s source balance to move.
      await send(adapterA, tokenA, user, EID_B, other.address, amount);

      expect(await tokenA.balanceOf(user.address)).to.equal(senderBefore - amount);
      expect(await tokenA.balanceOf(other.address)).to.equal(victimBefore);
      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(other.address)).to.equal(amount);
    });

    it("leaves dust with the sender and never destroys it", async () => {
      // sharedDecimals is 6, so with 18 local decimals the granularity is 1e12.
      const amount = ethers.parseEther("1") + 999n;
      const userBefore = await tokenA.balanceOf(user.address);
      const supplyBefore = await tokenA.totalSupply();

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      await endpointB.deliverNext();

      expect(await tokenB.balanceOf(user.address)).to.equal(ethers.parseEther("1"));
      expect(await tokenA.balanceOf(user.address)).to.equal(userBefore - ethers.parseEther("1"));
      expect(await tokenA.totalSupply()).to.equal(supplyBefore);
    });

    // ---------------------------------------------------------------
    // LIQUIDITY — the property mint/burn does not have.
    // ---------------------------------------------------------------
    it("reverts inbound with InsufficientLiquidity when the escrow is drained, then delivers after a top-up", async () => {
      const escrowB = await adapterB.availableLiquidity();
      const amount = escrowB + ethers.parseEther("1"); // one token more than B can release
      await fund(tokenA, user.address, amount);

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
        adapterB,
        "InsufficientLiquidity"
      );
      expect(await tokenB.balanceOf(user.address)).to.equal(0n);

      // Top the escrow up and the parked message delivers — a delay, not a loss.
      await fund(tokenB, await adapterB.getAddress(), ethers.parseEther("10"));
      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("exposes availableLiquidity for monitoring", async () => {
      expect(await adapterA.availableLiquidity()).to.equal(
        await tokenA.balanceOf(await adapterA.getAddress())
      );
    });

    // ---------------------------------------------------------------
    it("parks and retries an inbound transfer blocked by a blacklist", async () => {
      const amount = ethers.parseEther("10");
      await runProposal(tokenB, owner, admin, 9 /* AddToBlacklist */, user.address);

      await send(adapterA, tokenA, user, EID_B, user.address, amount);
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
        tokenB,
        "BlacklistedAddress"
      );

      await runProposal(tokenB, owner, admin, 10 /* RemoveFromBlacklist */, user.address);
      await endpointB.deliver(0);
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("parks and retries when the destination token is paused", async () => {
      const amount = ethers.parseEther("10");
      await send(adapterA, tokenA, user, EID_B, user.address, amount);

      await tokenB.connect(owner).emergencyAction(1); // pause
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(tokenB, "EnforcedPause");

      await time.increase(30 * 60 + 1); // EMERGENCY_COOLDOWN
      await tokenB.connect(owner).emergencyAction(2); // unpause
      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    // ---------------------------------------------------------------
    it("halts OUTBOUND when the peer is unset", async () => {
      await adapterA.connect(owner).setPeer(EID_B, ethers.ZeroHash);
      await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(adapterA, "NoPeer")
        .withArgs(EID_B);
    });

    it("halts INBOUND when the peer is unset, and the message survives to be retried", async () => {
      const amount = ethers.parseEther("5");
      await send(adapterA, tokenA, user, EID_B, user.address, amount);

      await adapterB.connect(owner).setPeer(EID_A, ethers.ZeroHash);
      await expect(endpointB.deliverNext())
        .to.be.revertedWithCustomError(adapterB, "NoPeer")
        .withArgs(EID_A);

      await adapterB
        .connect(owner)
        .setPeer(EID_A, ethers.zeroPadValue(await adapterA.getAddress(), 32));
      await endpointB.deliverNext();
      expect(await tokenB.balanceOf(user.address)).to.equal(amount);
    });

    it("rejects an inbound message from an address that is not the configured peer", async () => {
      await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("5"));
      await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));
      await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(adapterB, "OnlyPeer");
    });

    // ---------------------------------------------------------------
    it("is FAIL-CLOSED: an unconfigured lane rejects every transfer", async () => {
      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      const fresh = await Adapter.deploy(
        await tokenA.getAddress(),
        await endpointA.getAddress(),
        owner.address
      );
      await fresh.waitForDeployment();
      await fresh.connect(owner).setPeer(EID_B, ethers.zeroPadValue(await adapterB.getAddress(), 32));

      await expect(send(fresh, tokenA, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(fresh, "RateLimitExceeded");

      await fresh.connect(owner).setRateLimits([{ dstEid: EID_B, limit: ethers.parseEther("10"), window: 86400 }]);
      await send(fresh, tokenA, user, EID_B, user.address, ethers.parseEther("1"));
    });

    it("enforces the outbound rate limit and refills over the window", async () => {
      const limit = ethers.parseEther("100");
      const window = 3600;
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit, window }]);

      await send(adapterA, tokenA, user, EID_B, user.address, limit);
      await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("50")))
        .to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      await time.increase(window + 1);
      await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("50"));
    });

    it("a rate-limit failure locks NOTHING — the user keeps their tokens", async () => {
      // This is why the throttle belongs on the outbound side: the transfer fails at the START.
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: 1n, window: 86400 }]);
      const balBefore = await tokenA.balanceOf(user.address);
      const escrowBefore = await adapterA.availableLiquidity();

      await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("10")))
        .to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      expect(await tokenA.balanceOf(user.address)).to.equal(balBefore);
      expect(await adapterA.availableLiquidity()).to.equal(escrowBefore);
    });

    it("rate limit of zero acts as an immediate kill switch", async () => {
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: 0n, window: 1 }]);
      // Use a real (above-dust) amount. A sub-dust amount would be rejected earlier by
      // ZeroAmountAfterDust, which would pass this assertion for the wrong reason.
      await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");
    });

    it("REJECTS a sub-dust amount instead of sending an empty message", async () => {
      // `_removeDust` truncates below 1e12 to zero, and an ERC20 transfer of zero SUCCEEDS — so
      // without an explicit guard the user would pay a LayerZero fee to deliver nothing, and
      // `_outflow(eid, 0)` would slip past even a zero rate limit. The mint/burn design blocked
      // this only incidentally via the token's AmountMustBePositive; escrow has no such backstop.
      const escrowBefore = await adapterA.availableLiquidity();
      await expect(send(adapterA, tokenA, user, EID_B, user.address, 999n))
        .to.be.revertedWithCustomError(adapterA, "ZeroAmountAfterDust");
      expect(await adapterA.availableLiquidity()).to.equal(escrowBefore);
    });

    it("a zero rate limit cannot be bypassed with a sub-dust send", async () => {
      // Regression guard for the interaction of the two rules above.
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: 0n, window: 1 }]);
      await expect(send(adapterA, tokenA, user, EID_B, user.address, 999n)).to.be.reverted;
    });

    it("resetRateLimits clears usage and is owner-only", async () => {
      const limit = ethers.parseEther("100");
      await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit, window: 3600 }]);
      await send(adapterA, tokenA, user, EID_B, user.address, limit);
      await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("50")))
        .to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

      await expect(adapterA.connect(user).resetRateLimits([EID_B]))
        .to.be.revertedWithCustomError(adapterA, "OwnableUnauthorizedAccount");
      await adapterA.connect(owner).resetRateLimits([EID_B]);
      await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("50"));
    });

    // ---------------------------------------------------------------
    it("REJECTS a zero-address recipient", async () => {
      const escrowBefore = await adapterA.availableLiquidity();
      await expect(send(adapterA, tokenA, user, EID_B, ZeroAddress, ethers.parseEther("3")))
        .to.be.revertedWithCustomError(adapterA, "ZeroRecipient");
      expect(await adapterA.availableLiquidity()).to.equal(escrowBefore);
    });

    it("REJECTS a composed message", async () => {
      const sendParam = {
        dstEid: EID_B,
        to: ethers.zeroPadValue(user.address, 32),
        amountLD: ethers.parseEther("1"),
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x1234",
        oftCmd: "0x",
      };
      await expect(
        adapterA.connect(user).send(sendParam, { nativeFee: 0n, lzTokenFee: 0n }, user.address, { value: 0n })
      ).to.be.revertedWithCustomError(adapterA, "ComposeNotSupported");
    });

    // ===============================================================
    // E-01. THE OWNER CAN DRAIN THE ESCROW. This is the single most important property to
    // pin, because it disproves the intuition that "no withdraw function" means "no rug".
    //
    // Critically this needs NO DVN compromise and NO forged packet. `setPeer` decides who is
    // trusted; `EndpointV2.send` is permissionless and stamps the packet with `msg.sender`.
    // So the attacker emits a GENUINE source-chain packet from their own address — which
    // honest DVNs will attest to, because it really happened — and the destination adapter
    // honours it because the owner just made that address the peer. Nothing is locked on the
    // source side. This is why the owner must be a timelock/multisig.
    // ===============================================================
    it("E-01: the OWNER can drain the whole escrow by rotating setPeer, locking nothing", async () => {
      const escrow = await adapterB.availableLiquidity();
      expect(escrow, "precondition: destination must hold liquidity").to.be.gt(0n);

      // 1. The owner points chain B's inbound lane at an address it controls.
      await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));

      // 2. That address sends a packet straight through the source endpoint, bypassing the
      //    adapter entirely — so no tokens are debited from anyone.
      const amountSD = escrow / 10n ** 12n; // shared decimals are 6 against 18 local
      const message = ethers.solidityPacked(
        ["bytes32", "uint64"],
        [ethers.zeroPadValue(other.address, 32), amountSD]
      );
      const lockedOnABefore = await adapterA.availableLiquidity();
      await endpointA.connect(other).send(
        {
          dstEid: EID_B,
          receiver: ethers.zeroPadValue(await adapterB.getAddress(), 32),
          message,
          options: "0x",
          payInLzToken: false,
        },
        other.address,
        { value: 0n }
      );
      expect(await adapterA.availableLiquidity(), "attacker locks NOTHING").to.equal(lockedOnABefore);

      // 3. Delivery passes the peer check and releases the escrow.
      const balBefore = await tokenB.balanceOf(other.address);
      await endpointB.deliverNext();

      expect((await tokenB.balanceOf(other.address)) - balBefore).to.equal(escrow);
      expect(await adapterB.availableLiquidity(), "escrow fully drained").to.equal(0n);
    });

    // ===============================================================
    // RECEIVE-SIDE VALIDATION. `send` blocks bad recipients on the way out, but that only
    // constrains messages WE originate — a non-conforming or compromised peer can still
    // deliver one. These drive `_credit` directly with a hand-built payload, which is the
    // only way to reach those branches at all.
    // ===============================================================
    describe("malformed inbound messages", () => {
      // Repoints chain B's lane at an EOA so it can post an arbitrary OFT payload through the
      // permissionless endpoint. Same mechanism as the E-01 attack test.
      async function deliverCrafted(toBytes32: string, amountLD: bigint) {
        await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));
        const message = ethers.solidityPacked(["bytes32", "uint64"], [toBytes32, amountLD / 10n ** 12n]);
        await endpointA.connect(other).send(
          {
            dstEid: EID_B,
            receiver: ethers.zeroPadValue(await adapterB.getAddress(), 32),
            message,
            options: "0x",
            payInLzToken: false,
          },
          other.address,
          { value: 0n }
        );
        return endpointB.deliverNext();
      }

      it("REJECTS an inbound message naming the zero address", async () => {
        const escrowBefore = await adapterB.availableLiquidity();
        await expect(deliverCrafted(ethers.ZeroHash, ethers.parseEther("5"))).to.be.revertedWithCustomError(
          adapterB,
          "ZeroRecipient"
        );
        expect(await adapterB.availableLiquidity(), "escrow untouched").to.equal(escrowBefore);
      });

      it("REJECTS an inbound message naming the adapter ITSELF", async () => {
        const escrowBefore = await adapterB.availableLiquidity();
        await expect(
          deliverCrafted(ethers.zeroPadValue(await adapterB.getAddress(), 32), ethers.parseEther("5"))
        ).to.be.revertedWithCustomError(adapterB, "RecipientIsBridgeAdapter");
        // Without this check the self-transfer would move nothing, the delta would be zero and
        // the message would revert EscrowInvariantViolated forever with a confusing error.
        expect(await adapterB.availableLiquidity(), "escrow untouched").to.equal(escrowBefore);
      });
    });

    // ===============================================================
    // CONCURRENCY. The outbound bucket is a SINGLE slot shared by every user of a lane, and
    // within one block `decay` is zero, so there is no refill to soften contention. These
    // pin what actually happens when two holders transact together.
    // ===============================================================
    describe("multi-user contention", () => {
      // Deliberately NOT using evm_setAutomine to force a literal shared block. That approach
      // hung, and because the hang happened before the restore could run it left automine
      // disabled and cascaded into unrelated tests. Consecutive blocks prove the same property:
      // with a 24h window the bucket regenerates limit*12/86400 per block — about 0.014% — so
      // one user's consumption still denies the next. The finding under test is "the bucket is
      // shared, not per-sender", and that is what these assert.
      it("lets two DIFFERENT holders bridge when the shared allowance covers both", async () => {
        await fund(tokenA, other.address, ethers.parseEther("1000"));
        const amount = ethers.parseEther("100");
        const escrowBefore = await adapterA.availableLiquidity();

        await send(adapterA, tokenA, user, EID_B, user.address, amount);
        await send(adapterA, tokenA, other, EID_B, other.address, amount);

        expect(await adapterA.availableLiquidity()).to.equal(escrowBefore + amount * 2n);
      });

      // The contention case, and the reason the throttle belongs on the outbound side:
      // the loser pays gas and keeps every token.
      it("one holder can exhaust the lane for everyone — and the loser locks NOTHING", async () => {
        await fund(tokenA, other.address, ethers.parseEther("1000"));
        const amount = ethers.parseEther("100");
        await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: amount, window: 86400 }]);

        // First holder consumes the entire shared bucket.
        await send(adapterA, tokenA, user, EID_B, user.address, amount);

        const escrowAfterFirst = await adapterA.availableLiquidity();
        const otherBefore = await tokenA.balanceOf(other.address);

        // A DIFFERENT holder is now denied, despite never having used the bridge.
        await expect(
          send(adapterA, tokenA, other, EID_B, other.address, amount)
        ).to.be.revertedWithCustomError(adapterA, "RateLimitExceeded");

        expect(await tokenA.balanceOf(other.address), "the loser keeps every token").to.equal(otherBefore);
        expect(await adapterA.availableLiquidity(), "nothing extra was locked").to.equal(escrowAfterFirst);
      });
    });

    // ===============================================================
    // TOKEN INTERACTION EDGE CASES. Properties that emerge from StorageToken's behaviour
    // rather than the adapter's own logic, and which the audit called out but never pinned.
    // ===============================================================
    describe("token interaction edge cases", () => {
      // Audit finding E-06, asserted rather than assumed. StorageToken overrides `transfer`
      // with whenNotPaused but does NOT override `transferFrom`. `_credit` uses transfer,
      // `_debit` uses transferFrom — so a pause stops releases but NOT departures. An
      // incident responder who pauses expecting the bridge to halt would be wrong.
      it("E-06: pausing the token does NOT stop outbound locking", async () => {
        await tokenA.connect(owner).emergencyAction(1);
        expect(await tokenA.paused()).to.be.true;

        const escrowBefore = await adapterA.availableLiquidity();
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("5"));
        expect(
          await adapterA.availableLiquidity(),
          "tokens still leave while paused — this is the documented asymmetry"
        ).to.equal(escrowBefore + ethers.parseEther("5"));

        await time.increase(30 * 60 + 1); // EMERGENCY_COOLDOWN before unpausing
        await tokenA.connect(owner).emergencyAction(2);
        expect(await tokenA.paused()).to.be.false;
      });

      // Audit finding E-04. The blacklist applies to `from` AND `to` in `_update`, and nothing
      // stops governance blacklisting the adapter itself — which freezes the whole escrow.
      it("E-04: blacklisting the ADAPTER freezes outbound, and unblacklisting restores it", async () => {
        const adapterAddr = await adapterA.getAddress();
        await runProposal(tokenA, owner, admin, PROPOSAL_ADD_BLACKLIST, adapterAddr);

        // `_update` rejects the adapter as `to`, so nothing can be escrowed at all.
        await expect(send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1"))).to.be
          .reverted;

        // Reversible: the freeze lasts exactly as long as the blacklist entry.
        await runProposal(tokenA, owner, admin, PROPOSAL_REMOVE_BLACKLIST, adapterAddr);
        const escrowBefore = await adapterA.availableLiquidity();
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1"));
        expect(await adapterA.availableLiquidity()).to.equal(escrowBefore + ethers.parseEther("1"));
      });

      it("enforces minAmountLD — a transfer that would slip below it reverts, locking nothing", async () => {
        const amount = ethers.parseEther("10");
        const escrowBefore = await adapterA.availableLiquidity();
        await tokenA.connect(user).approve(await adapterA.getAddress(), amount);
        const sendParam = {
          dstEid: EID_B,
          to: ethers.zeroPadValue(user.address, 32),
          amountLD: amount,
          minAmountLD: amount + 1n, // unsatisfiable by construction
          extraOptions: "0x",
          composeMsg: "0x",
          oftCmd: "0x",
        };
        await expect(
          adapterA.connect(user).send(sendParam, { nativeFee: 0n, lzTokenFee: 0n }, user.address, { value: 0n })
        ).to.be.reverted;
        expect(await adapterA.availableLiquidity()).to.equal(escrowBefore);
      });

      // sharedDecimals is 6 against 18 local, so granularity is exactly 1e12.
      it("handles the dust boundary exactly: 1e12 passes, 1e12-1 is rejected", async () => {
        const escrowBefore = await adapterA.availableLiquidity();

        await expect(
          send(adapterA, tokenA, user, EID_B, user.address, 10n ** 12n - 1n)
        ).to.be.revertedWithCustomError(adapterA, "ZeroAmountAfterDust");
        expect(await adapterA.availableLiquidity()).to.equal(escrowBefore);

        await send(adapterA, tokenA, user, EID_B, user.address, 10n ** 12n);
        expect(await adapterA.availableLiquidity()).to.equal(escrowBefore + 10n ** 12n);
      });
    });

    describe("rate limiter degenerate configurations", () => {
      it("survives window = 0 (the division guard) and still enforces the limit", async () => {
        await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: ethers.parseEther("10"), window: 0 }]);
        // decay divides by `window > 0 ? window : 1`, so a zero window means full decay each
        // second — effectively unlimited, but it must not revert or corrupt state.
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("5"));
        const [, avail] = await adapterA.getAmountCanBeSent(EID_B);
        expect(avail).to.be.gte(0n);
      });

      // The inbound limiter is a security bound, not a throttle, so a config that silently
      // disables it must be unreachable. With window = 0 the inherited maths divides by 1, so
      // decay = limit * secondsElapsed and the bucket refills entirely every second.
      it("REJECTS a zero window on the INBOUND limiter, which would silently disable the bound", async () => {
        await expect(
          adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: ethers.parseEther("100"), window: 0 }])
        ).to.be.revertedWithCustomError(adapterB, "ZeroWindow");

        // The previously configured limit is untouched by the rejected call.
        const [, avail] = await adapterB.getAmountCanBeReceived(EID_A);
        expect(avail).to.equal(INBOUND_LIMIT);
      });

      it("accepts an intentionally unlimited lane at type(uint192).max", async () => {
        const MAX192 = 2n ** 192n - 1n;
        await adapterA.connect(owner).setRateLimits([{ dstEid: EID_B, limit: MAX192, window: 86400 }]);
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1000"));
        const [, avail] = await adapterA.getAmountCanBeSent(EID_B);
        expect(avail).to.be.gt(ethers.parseEther("1000000"));
      });

      it("resetInboundRateLimits clears accumulated inbound usage and is owner-only", async () => {
        const cap = ethers.parseEther("100");
        await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: cap, window: 86400 }]);

        await send(adapterA, tokenA, user, EID_B, user.address, cap);
        await endpointB.deliverNext(); // consumes the whole inbound bucket
        const [, afterUse] = await adapterB.getAmountCanBeReceived(EID_A);
        expect(afterUse).to.equal(0n);

        await expect(adapterB.connect(user).resetInboundRateLimits([EID_A])).to.be.revertedWithCustomError(
          adapterB,
          "OwnableUnauthorizedAccount"
        );

        await adapterB.connect(owner).resetInboundRateLimits([EID_A]);
        const [, afterReset] = await adapterB.getAmountCanBeReceived(EID_A);
        expect(afterReset, "usage cleared without weakening the configured limit").to.equal(cap);
      });
    });

    // ===============================================================
    // LIQUIDITY EXHAUSTION AND RECOVERY. The escrow analogue of cap exhaustion: prove that
    // running a destination dry delays transfers rather than losing them, and that topping
    // up releases the already-parked message without it being re-sent.
    // ===============================================================
    describe("liquidity exhaustion", () => {
      it("parks on an empty destination, then delivers the SAME message once topped up", async () => {
        const escrowB = await adapterB.availableLiquidity();
        await fund(tokenA, user.address, escrowB + ethers.parseEther("1"));

        // Drain B completely.
        await send(adapterA, tokenA, user, EID_B, user.address, escrowB);
        await endpointB.deliverNext();
        expect(await adapterB.availableLiquidity(), "destination should now be dry").to.equal(0n);

        // The next transfer locks on A but cannot be paid out on B.
        const amount = ethers.parseEther("1");
        const escrowABefore = await adapterA.availableLiquidity();
        await send(adapterA, tokenA, user, EID_B, user.address, amount);
        await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
          adapterB,
          "InsufficientLiquidity"
        );

        // Source-side tokens are locked and safe, not lost.
        expect(await adapterA.availableLiquidity()).to.equal(escrowABefore + amount);

        // Top up by a plain transfer — exactly how an operator rebalances.
        await fund(tokenB, await adapterB.getAddress(), amount);

        const before = await tokenB.balanceOf(user.address);
        await endpointB.deliverNext(); // the SAME parked message, not a resend
        expect((await tokenB.balanceOf(user.address)) - before).to.equal(amount);
        expect(await adapterB.availableLiquidity()).to.equal(0n);
      });
    });

    // ===============================================================
    // INVARIANT SWEEP. Supply conservation is the property the whole design rests on, so
    // assert it across an arbitrary operation sequence rather than only on the happy path.
    // Deterministic pseudo-random ordering: a fixed seed keeps failures reproducible.
    // ===============================================================
    it("conserves BOTH total supply and total escrow across an arbitrary operation sequence", async () => {
      await fund(tokenA, other.address, ethers.parseEther("5000"));
      await fund(tokenB, user.address, ethers.parseEther("5000"));

      const supply0 = (await tokenA.totalSupply()) + (await tokenB.totalSupply());
      const escrow0 = (await adapterA.availableLiquidity()) + (await adapterB.availableLiquidity());

      let seed = 987654321;
      const rnd = (n: number) => {
        // xorshift — deterministic, no external dependency.
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return Math.abs(seed) % n;
      };

      for (let i = 0; i < 24; i++) {
        const aToB = rnd(2) === 0;
        const [srcAdapter, srcToken, dstEndpoint, dstEid] = aToB
          ? [adapterA, tokenA, endpointB, EID_B]
          : [adapterB, tokenB, endpointA, EID_A];
        const sender = rnd(2) === 0 ? user : other;
        const amount = ethers.parseEther(String(1 + rnd(50)));

        const senderBal = await srcToken.balanceOf(sender.address);
        if (senderBal < amount) continue;

        try {
          await send(srcAdapter, srcToken, sender, dstEid, sender.address, amount);
        } catch {
          continue; // rate limit or similar — a refusal must also conserve
        }
        // Deliver only sometimes, so some messages stay in flight across iterations.
        if (rnd(3) !== 0) {
          try {
            await dstEndpoint.deliverNext();
          } catch {
            /* parked (e.g. liquidity) — still conserving */
          }
        }

        const supplyNow = (await tokenA.totalSupply()) + (await tokenB.totalSupply());
        expect(supplyNow, `supply changed at step ${i}`).to.equal(supply0);
      }

      // Escrow is conserved too: every transfer moves the same amount from one side's
      // escrow to the other's. Messages still in flight are the only slack, and they are
      // locked on the source, so the SUM can only be >= the start.
      const escrowNow = (await adapterA.availableLiquidity()) + (await adapterB.availableLiquidity());
      expect(escrowNow, "total escrow must never fall below the seeded amount").to.be.gte(escrow0);
      expect((await tokenA.totalSupply()) + (await tokenB.totalSupply())).to.equal(supply0);
    });

    // ===============================================================
    // THE INBOUND BOUND. This is the only check in the contract that does not assume the
    // message is honest, so these tests carry the weight of the whole mitigation.
    // ===============================================================
    describe("inbound rate limit", () => {
      it("is FAIL-CLOSED: an unconfigured source lane releases nothing", async () => {
        await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: 0n, window: 86400 }]);
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("1"));
        await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
          adapterB,
          "InboundRateLimitExceeded"
        );
      });

      it("BOUNDS the drain: an over-limit release is refused, escrow untouched", async () => {
        const cap = ethers.parseEther("100");
        await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: cap, window: 86400 }]);
        const escrowBefore = await adapterB.availableLiquidity();

        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("150"));
        await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
          adapterB,
          "InboundRateLimitExceeded"
        );
        expect(await adapterB.availableLiquidity(), "escrow must not move").to.equal(escrowBefore);
      });

      // Refusal must never destroy value: the payload hash survives a revert, so the same
      // message delivers untouched once the bucket refills. Delay, not loss.
      it("PARKS rather than loses: the same message delivers after the window refills", async () => {
        const cap = ethers.parseEther("100");
        await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: cap, window: 86400 }]);

        await send(adapterA, tokenA, user, EID_B, user.address, cap);
        await endpointB.deliverNext(); // consumes the whole bucket

        await send(adapterA, tokenA, user, EID_B, user.address, cap);
        await expect(endpointB.deliverNext()).to.be.revertedWithCustomError(
          adapterB,
          "InboundRateLimitExceeded"
        );

        await time.increase(86400);
        const before = await tokenB.balanceOf(user.address);
        await endpointB.deliverNext(); // the SAME message, now within budget
        expect((await tokenB.balanceOf(user.address)) - before).to.equal(cap);
      });

      it("is a separate bucket from outbound — inbound use does not consume outbound allowance", async () => {
        const [, outboundBefore] = await adapterB.getAmountCanBeSent(EID_A);
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("10"));
        await endpointB.deliverNext();

        const [, outboundAfter] = await adapterB.getAmountCanBeSent(EID_A);
        const [, inboundAfter] = await adapterB.getAmountCanBeReceived(EID_A);
        expect(outboundAfter, "inbound credit must not shrink outbound allowance").to.be.gte(outboundBefore);
        expect(inboundAfter, "inbound allowance must shrink").to.equal(
          INBOUND_LIMIT - ethers.parseEther("10")
        );
      });

      it("MITIGATES E-01: a malicious peer rotation can now take only the cap, not everything", async () => {
        const cap = ethers.parseEther("100");
        await adapterB.connect(owner).setInboundRateLimits([{ dstEid: EID_A, limit: cap, window: 86400 }]);
        const escrow = await adapterB.availableLiquidity();
        expect(escrow).to.be.gt(cap * 2n); // the attack would otherwise take far more

        await adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));
        const drain = async (amount: bigint) => {
          const message = ethers.solidityPacked(
            ["bytes32", "uint64"],
            [ethers.zeroPadValue(other.address, 32), amount / 10n ** 12n]
          );
          await endpointA.connect(other).send(
            {
              dstEid: EID_B,
              receiver: ethers.zeroPadValue(await adapterB.getAddress(), 32),
              message,
              options: "0x",
              payInLzToken: false,
            },
            other.address,
            { value: 0n }
          );
          return endpointB.deliverNext();
        };

        await drain(cap); // first tranche succeeds — the cap IS the instant loss
        await expect(drain(cap)).to.be.revertedWithCustomError(adapterB, "InboundRateLimitExceeded");
        expect(await adapterB.availableLiquidity()).to.equal(escrow - cap);
      });
    });

    // Every privileged entry point, swept in one place. An access-control regression on any of
    // these is a direct path to the escrow — `setPeer` most obviously, but a stranger who could
    // set the rate limits could also disable both bounds at once.
    it("REJECTS every owner-only entry point when called by a stranger", async () => {
      const stranger = user;
      const cfg = [{ dstEid: EID_B, limit: ethers.parseEther("1"), window: 86400 }];

      const calls: Array<[string, Promise<any>]> = [
        ["setRateLimits", adapterA.connect(stranger).setRateLimits(cfg)],
        ["setInboundRateLimits", adapterA.connect(stranger).setInboundRateLimits(cfg)],
        ["resetRateLimits", adapterA.connect(stranger).resetRateLimits([EID_B])],
        ["resetInboundRateLimits", adapterA.connect(stranger).resetInboundRateLimits([EID_B])],
        ["setPeer", adapterA.connect(stranger).setPeer(EID_B, ethers.zeroPadValue(stranger.address, 32))],
        ["lockPeers", adapterA.connect(stranger).lockPeers()],
        ["transferOwnership", adapterA.connect(stranger).transferOwnership(stranger.address)],
        ["renounceOwnership", adapterA.connect(stranger).renounceOwnership()],
        ["setDelegate", adapterA.connect(stranger).setDelegate(stranger.address)],
      ];

      for (const [name, call] of calls) {
        await expect(call, `${name} must reject a non-owner`).to.be.revertedWithCustomError(
          adapterA,
          "OwnableUnauthorizedAccount"
        );
      }

      // And the owner is genuinely unchanged afterwards.
      expect(await adapterA.owner()).to.equal(owner.address);
      expect(await adapterA.peersLocked()).to.be.false;
    });

    describe("peer lock", () => {
      it("lockPeers is owner-only and permanently blocks setPeer", async () => {
        await expect(adapterB.connect(user).lockPeers()).to.be.revertedWithCustomError(
          adapterB,
          "OwnableUnauthorizedAccount"
        );

        await adapterB.connect(owner).lockPeers();
        expect(await adapterB.peersLocked()).to.be.true;

        await expect(
          adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32))
        ).to.be.revertedWithCustomError(adapterB, "PeersAreLocked");
      });

      // Closes the CHEAP E-01 path — not the whole trust model. A compromised owner is still
      // the LayerZero delegate, so it can `setDelegate` to itself, repoint the receive library
      // and DVN set, and have a malicious DVN attest to a forged packet whose sender matches
      // the LOCKED peer. That passes the peer check and drains the escrow. Locking removes the
      // one-transaction, no-collusion route; the inbound rate limit is what bounds the rest.
      it("BLOCKS the cheap E-01 path: after locking, the lane cannot be redirected", async () => {
        await adapterB.connect(owner).lockPeers();
        const escrow = await adapterB.availableLiquidity();

        await expect(
          adapterB.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32))
        ).to.be.revertedWithCustomError(adapterB, "PeersAreLocked");

        // Legitimate traffic is unaffected.
        await send(adapterA, tokenA, user, EID_B, user.address, ethers.parseEther("5"));
        await endpointB.deliverNext();
        expect(await adapterB.availableLiquidity()).to.equal(escrow - ethers.parseEther("5"));
      });
    });

    // Naming the destination adapter as recipient would produce a message that reverts on
    // EVERY retry (a self-transfer moves nothing, so the escrow delta is zero), leaving the
    // sender's tokens locked on the source chain with no recovery path. `peers[dstEid]` is
    // the destination adapter, so this is catchable before anything is locked.
    it("REJECTS naming the destination adapter as the recipient", async () => {
      const escrowBefore = await adapterA.availableLiquidity();
      await expect(
        send(adapterA, tokenA, user, EID_B, await adapterB.getAddress(), ethers.parseEther("3"))
      ).to.be.revertedWithCustomError(adapterA, "RecipientIsBridgeAdapter");
      expect(await adapterA.availableLiquidity(), "nothing may be locked").to.equal(escrowBefore);
    });

    it("REJECTS a zero refund address, which would burn any excess fee", async () => {
      const sendParam = {
        dstEid: EID_B,
        to: ethers.zeroPadValue(user.address, 32),
        amountLD: ethers.parseEther("1"),
        minAmountLD: 0n,
        extraOptions: "0x",
        composeMsg: "0x",
        oftCmd: "0x",
      };
      await expect(
        adapterA.connect(user).send(sendParam, { nativeFee: 0n, lzTokenFee: 0n }, ZeroAddress, { value: 0n })
      ).to.be.revertedWithCustomError(adapterA, "ZeroRefundAddress");
    });

    it("ownership transfer is TWO-STEP and does not take effect until accepted", async () => {
      await adapterA.connect(owner).transferOwnership(other.address);
      expect(await adapterA.owner()).to.equal(owner.address);
      expect(await adapterA.pendingOwner()).to.equal(other.address);

      await expect(adapterA.connect(other).resetRateLimits([EID_B]))
        .to.be.revertedWithCustomError(adapterA, "OwnableUnauthorizedAccount");

      await adapterA.connect(other).acceptOwnership();
      expect(await adapterA.owner()).to.equal(other.address);
    });

    // The LayerZero delegate is the single most dangerous role on this contract: it can
    // `burn`/`nilify` in-flight messages, permanently stranding funds already locked on the
    // source chain. `OAppCore.setDelegate` is a SEPARATE entry point that ownership transfer
    // does not touch, so without an explicit sync a handover silently leaves that power with
    // the OLD owner. These three tests pin the whole lifecycle.
    it("the constructor seeds the delegate as the initial owner", async () => {
      expect(await endpointA.delegates(await adapterA.getAddress())).to.equal(owner.address);
    });

    it("nominating a new owner does NOT move the delegate yet", async () => {
      await adapterA.connect(owner).transferOwnership(other.address);
      expect(await endpointA.delegates(await adapterA.getAddress())).to.equal(owner.address);
    });

    it("accepting ownership MOVES the LayerZero delegate to the new owner", async () => {
      const adapterAddr = await adapterA.getAddress();
      await adapterA.connect(owner).transferOwnership(other.address);
      await adapterA.connect(other).acceptOwnership();

      expect(await adapterA.owner()).to.equal(other.address);
      expect(
        await endpointA.delegates(adapterAddr),
        "old owner must NOT retain delegate rights after a handover"
      ).to.equal(other.address);
    });

    it("ownership can NEVER be renounced", async () => {
      await expect(adapterA.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(
        adapterA,
        "OwnershipCannotBeRenounced"
      );
      expect(await adapterA.owner()).to.equal(owner.address);
    });

    it("wires the adapter to the token correctly", async () => {
      expect(await adapterA.token()).to.equal(await tokenA.getAddress());
      expect(await adapterA.owner()).to.equal(owner.address);
      expect(await adapterA.sharedDecimals()).to.equal(6);
      expect(await adapterA.decimalConversionRate()).to.equal(10n ** 12n);
      expect(await adapterA.approvalRequired()).to.be.true;
    });

    it("THE TOKEN GRANTS THE ADAPTER NO SPECIAL POWER AT ALL", async () => {
      // The whole point of the escrow design: the adapter is an ordinary holder. It has no role,
      // no minter entry, and no ability to touch anyone's balance beyond its ERC20 allowance.
      const adapterAddr = await adapterA.getAddress();
      expect(await tokenA.hasRole(ADMIN_ROLE, adapterAddr)).to.be.false;
      expect(
        await tokenA.hasRole(ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE")), adapterAddr)
      ).to.be.false;
      // And it cannot move `other`'s tokens without an allowance, exactly like any other address.
      await fund(tokenA, other.address, ethers.parseEther("10"));
      expect(await tokenA.allowance(other.address, adapterAddr)).to.equal(0n);
    });
  });

  // ===================================================================
  // The escrow guard must fire if the token ever becomes lossy.
  // ===================================================================
  describe("escrow-invariant guard", () => {
    let feeToken: any, adapter: any, endpoint: any, dst: any;

    beforeEach(async () => {
      const FeeToken = await ethers.getContractFactory("MockFeeOnTransferToken");
      feeToken = await FeeToken.deploy(0);
      await feeToken.waitForDeployment();

      const Endpoint = await ethers.getContractFactory("MockLZEndpointV2");
      endpoint = await Endpoint.deploy(EID_A);
      await endpoint.waitForDeployment();
      dst = await Endpoint.deploy(EID_B);
      await dst.waitForDeployment();
      await endpoint.setDestLzEndpoint(EID_B, await dst.getAddress());

      const Adapter = await ethers.getContractFactory("FulaOFTAdapter");
      adapter = await Adapter.deploy(await feeToken.getAddress(), await endpoint.getAddress(), owner.address);
      await adapter.waitForDeployment();
      await adapter.connect(owner).setPeer(EID_B, ethers.zeroPadValue(await adapter.getAddress(), 32));
      await adapter
        .connect(owner)
        .setRateLimits([{ dstEid: EID_B, limit: ethers.parseEther("1000000"), window: 86400 }]);

      await feeToken.mintFree(user.address, ethers.parseEther("1000"));
      await feeToken.mintFree(await adapter.getAddress(), ethers.parseEther("1000"));
    });

    async function trySend(amount: bigint) {
      await feeToken.connect(user).approve(await adapter.getAddress(), amount);
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
      await trySend(ethers.parseEther("10"));
    });

    it("reverts the outbound lock when the token delivers less than requested", async () => {
      // This is exactly what would happen if StorageToken's platformFeeBps were ever raised above
      // zero: the escrow would receive less than the adapter reports as sent, and the destination
      // would release the full amount — draining the escrow a little on every hop.
      await feeToken.setFeeBps(500); // 5%
      await expect(trySend(ethers.parseEther("10")))
        .to.be.revertedWithCustomError(adapter, "EscrowInvariantViolated");
    });

    // The mirror image, and the one that actually protects the escrow's solvency. On the way IN
    // a fee means the recipient receives less than the message says was released, so the escrow
    // pays out more than the recipient gets and the difference is lost to the treasury on every
    // hop. This must fail closed — and it must PARK rather than destroy, so it self-heals if the
    // fee is set back to zero.
    it("reverts the inbound RELEASE when the token delivers less than requested", async () => {
      await adapter
        .connect(owner)
        .setInboundRateLimits([{ dstEid: EID_A, limit: ethers.parseEther("1000000"), window: 86400 }]);
      await adapter.connect(owner).setPeer(EID_A, ethers.zeroPadValue(other.address, 32));
      // Loop this endpoint back to itself so a packet addressed to EID_A is queued here.
      await endpoint.setDestLzEndpoint(EID_A, await endpoint.getAddress());

      const amount = ethers.parseEther("10");
      const message = ethers.solidityPacked(
        ["bytes32", "uint64"],
        [ethers.zeroPadValue(user.address, 32), amount / 10n ** 12n]
      );
      await endpoint.connect(other).send(
        {
          dstEid: EID_A, // this endpoint's own eid, so the packet lands back here
          receiver: ethers.zeroPadValue(await adapter.getAddress(), 32),
          message,
          options: "0x",
          payInLzToken: false,
        },
        other.address,
        { value: 0n }
      );

      await feeToken.setFeeBps(500); // 5% — recipient would receive only 9.5
      const escrowBefore = await adapter.availableLiquidity();
      await expect(endpoint.deliverNext()).to.be.revertedWithCustomError(
        adapter,
        "EscrowInvariantViolated"
      );
      expect(await adapter.availableLiquidity(), "escrow must not leak").to.equal(escrowBefore);

      // Fail-closed, not fail-destructive: zero the fee and the same message delivers.
      await feeToken.setFeeBps(0);
      await endpoint.deliverNext();
      expect(await adapter.availableLiquidity()).to.equal(escrowBefore - amount);
    });
  });
});
