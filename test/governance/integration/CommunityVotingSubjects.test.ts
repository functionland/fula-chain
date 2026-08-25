// CommunityVoting — subject creation (Step 3).
//
// Covers the ballot-shape bounds, the anti-spam economics (burned fee + refundable deposit),
// the creator slot accounting, and the fee-on-transfer path. The solvency invariant is asserted
// after every test via `expectSolvent`, and is reused by the later steps.
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, ZeroHash, BytesLike, Contract } from "ethers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const DAY = 24 * 60 * 60;
const TOTAL_SUPPLY = ethers.parseEther("1000000000");

// StorageToken proposal types
const PT_ADD_WHITELIST = 5;

const BURN_FEE = ethers.parseEther("25000");
const DEPOSIT = ethers.parseEther("50000");
const CREATE_COST = BURN_FEE + DEPOSIT;

describe("CommunityVoting — subject creation", function () {
  let voting: Contract;
  let token: Contract;
  let owner: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  const OPTS = ["Yes", "No", "Abstain"];

  beforeEach(async function () {
    [owner, admin, creator, other] = await ethers.getSigners();

    const StorageToken = await ethers.getContractFactory("StorageToken");
    token = (await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, TOTAL_SUPPLY],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await token.waitForDeployment();

    await time.increase(DAY + 1);
    await token.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(DAY + 1);
    await token.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOTAL_SUPPLY);

    // Only the address receiving FROM the token contract needs whitelisting; ordinary
    // wallet-to-wallet transfers are unrestricted. So whitelist the owner once and fan out.
    await runTokenProposal(PT_ADD_WHITELIST, owner.address);
    await token.connect(owner).transferFromContract(owner.address, ethers.parseEther("10000000"));

    const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
    voting = (await upgrades.deployProxy(
      CommunityVoting,
      [await token.getAddress(), ZeroAddress, ZeroAddress, owner.address, admin.address],
      { kind: "uups", initializer: "initialize" }
    )) as unknown as Contract;
    await voting.waitForDeployment();
    await time.increase(DAY + 1);
    await voting.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

    for (const who of [creator, other]) {
      await token.connect(owner).transfer(who.address, ethers.parseEther("1000000"));
      await token.connect(who).approve(await voting.getAddress(), ethers.MaxUint256);
    }
  });

  afterEach(async function () {
    await expectSolvent();
  });

  describe("happy path", function () {
    it("records the subject with the expected fields", async function () {
      const tx = await voting.connect(creator).createSubject("Roadmap?", "QmCid", OPTS, 7 * DAY);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);

      expect(await voting.subjectCount()).to.equal(1n);
      const s = await voting.getSubject(1);
      expect(s.creator).to.equal(creator.address);
      expect(s.createdAt).to.equal(block!.timestamp);
      expect(s.closeTime).to.equal(block!.timestamp + 7 * DAY);
      expect(s.optionCount).to.equal(3);
      expect(s.title).to.equal("Roadmap?");
      // The IPFS CID pointing at the full proposal text is held in state, not only in a log,
      // so the pointer cannot be lost with an indexer.
      expect(s.descriptionCID).to.equal("QmCid");
      expect(s.deposit).to.equal(DEPOSIT);
      expect(s.status).to.equal(0);
      expect(s.depositSettled).to.equal(false);
      // Seeded so an open subject can never be misread as "option 0 is winning".
      expect(s.winningOption).to.equal(65535);
      // The ballot is committed on-chain as hashes; the text itself is published in the event.
      for (let i = 0; i < OPTS.length; i++) {
        expect(await voting.optionHashes(1, i)).to.equal(
          ethers.keccak256(ethers.toUtf8Bytes(OPTS[i]))
        );
      }
    });

    it("burns the fee outright and holds the deposit", async function () {
      const supplyBefore = await token.totalSupply();

      await voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY);

      // A fall in totalSupply is the definitive proof the fee was destroyed rather than moved.
      // (An earlier revision also asserted on the token's `voluntarilyBurned` counter; that was
      // bridge-specific accounting and no longer exists on the token.)
      expect(await token.totalSupply()).to.equal(supplyBefore - BURN_FEE);
      expect(await token.balanceOf(await voting.getAddress())).to.equal(DEPOSIT);
      expect(await voting.totalDepositLiability()).to.equal(DEPOSIT);
    });

    it("publishes the full ballot text in an event, since only hashes are stored", async function () {
      // Title and CID live in state, so they are deliberately not repeated in the log. The option
      // LABELS are not stored anywhere, so this event is their canonical record — hence the test
      // that it actually carries them.
      const tx = await voting.connect(creator).createSubject("Roadmap?", "QmCid", OPTS, 7 * DAY);
      await expect(tx).to.emit(voting, "SubjectCreated");
      await expect(tx).to.emit(voting, "SubjectOptions");

      const receipt = await tx.wait();
      const optionsLog = receipt!.logs
        .map((l: any) => { try { return voting.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === "SubjectOptions");
      expect(optionsLog!.args.options).to.deep.equal(OPTS);
    });

    it("charges the creator exactly fee + deposit", async function () {
      const before = await token.balanceOf(creator.address);
      await voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY);
      expect(before - (await token.balanceOf(creator.address))).to.equal(CREATE_COST);
    });

    it("supports the maximum ballot of 100 options", async function () {
      const many = Array.from({ length: 100 }, (_, i) => `Option ${i}`);
      await voting.connect(creator).createSubject("Big", "C", many, 7 * DAY);
      expect((await voting.getSubject(1)).optionCount).to.equal(100);
      expect(await voting.optionHashes(1, 99)).to.equal(
        ethers.keccak256(ethers.toUtf8Bytes("Option 99"))
      );
    });
  });

  describe("ballot shape", function () {
    it("requires between 2 and 100 options", async function () {
      await expect(
        voting.connect(creator).createSubject("T", "C", ["Only"], 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "InvalidOptionCount");
      await expect(
        voting.connect(creator).createSubject("T", "C", [], 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "InvalidOptionCount");
      const tooMany = Array.from({ length: 101 }, (_, i) => `O${i}`);
      await expect(
        voting.connect(creator).createSubject("T", "C", tooMany, 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "InvalidOptionCount");
    });

    it("rejects an empty option label", async function () {
      await expect(
        voting.connect(creator).createSubject("T", "C", ["Yes", ""], 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "OptionEmpty");
    });

    it("rejects an option longer than 64 bytes", async function () {
      const long = "x".repeat(65);
      await expect(
        voting.connect(creator).createSubject("T", "C", ["Yes", long], 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "OptionTooLong");
      // 64 bytes exactly is fine.
      await voting.connect(creator).createSubject("T", "C", ["Yes", "x".repeat(64)], 7 * DAY);
    });

    it("rejects duplicate option labels, which would split the vote", async function () {
      await expect(
        voting.connect(creator).createSubject("T", "C", ["Yes", "No", "Yes"], 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "DuplicateOption");
    });

    it("bounds the title and the CID", async function () {
      await expect(
        voting.connect(creator).createSubject("t".repeat(257), "C", OPTS, 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "TitleTooLong");
      await expect(
        voting.connect(creator).createSubject("T", "c".repeat(101), OPTS, 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "CidTooLong");
    });

    it("enforces the duration window at both ends", async function () {
      await expect(
        voting.connect(creator).createSubject("T", "C", OPTS, 3 * DAY - 1)
      ).to.be.revertedWithCustomError(voting, "InvalidDuration");
      await expect(
        voting.connect(creator).createSubject("T", "C", OPTS, 30 * DAY + 1)
      ).to.be.revertedWithCustomError(voting, "InvalidDuration");
      // Both boundaries are legal.
      await voting.connect(creator).createSubject("T", "C", OPTS, 3 * DAY);
      await time.increase(DAY + 1);
      await voting.connect(creator).createSubject("T", "C", OPTS, 30 * DAY);
    });
  });

  describe("anti-spam limits", function () {
    it("enforces the creation cooldown", async function () {
      await voting.connect(creator).createSubject("A", "C", OPTS, 7 * DAY);
      await expect(
        voting.connect(creator).createSubject("B", "C", OPTS, 7 * DAY)
      ).to.be.revertedWithCustomError(voting, "CreateCooldownActive");

      await time.increase(DAY + 1);
      await voting.connect(creator).createSubject("B", "C", OPTS, 7 * DAY);
      expect(await voting.subjectCount()).to.equal(2n);
    });

    it("applies the cooldown per creator, not globally", async function () {
      await voting.connect(creator).createSubject("A", "C", OPTS, 7 * DAY);
      await voting.connect(other).createSubject("B", "C", OPTS, 7 * DAY);
      expect(await voting.subjectCount()).to.equal(2n);
    });

    it("caps concurrent open subjects per creator", async function () {
      for (let i = 0; i < 3; i++) {
        await voting.connect(creator).createSubject(`S${i}`, "C", OPTS, 10 * DAY);
        await time.increase(DAY + 1);
      }
      await expect(
        voting.connect(creator).createSubject("S4", "C", OPTS, 10 * DAY)
      ).to.be.revertedWithCustomError(voting, "TooManyOpenSubjects");
    });

    it("frees a slot when a subject closes, even if nobody finalizes it", async function () {
      // "Open" is defined by closeTime, not by finalization — otherwise an abandoned subject
      // would occupy one of the creator's three slots permanently.
      // Durations are staggered so exactly one subject closes during the test.
      await voting.connect(creator).createSubject("S0", "C", OPTS, 5 * DAY); // closes first
      await time.increase(DAY + 1);
      await voting.connect(creator).createSubject("S1", "C", OPTS, 30 * DAY);
      await time.increase(DAY + 1);
      await voting.connect(creator).createSubject("S2", "C", OPTS, 30 * DAY);

      // Clear the cooldown so the slot cap — not the cooldown — is what bites.
      await time.increase(DAY + 1);
      await expect(
        voting.connect(creator).createSubject("S3", "C", OPTS, 3 * DAY)
      ).to.be.revertedWithCustomError(voting, "TooManyOpenSubjects");

      // Advance past S0's close. finalize() is never called for it.
      await time.increase(2 * DAY);
      await voting.connect(creator).createSubject("S3", "C", OPTS, 3 * DAY);
      expect(await voting.subjectCount()).to.equal(4n);
    });
  });

  describe("token interactions", function () {
    it("reverts when the creator has not approved enough", async function () {
      await token.connect(creator).approve(await voting.getAddress(), 0);
      await expect(voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY)).to.be.reverted;
    });

    it("reverts when the creator cannot cover fee + deposit", async function () {
      const poor = (await ethers.getSigners())[5];
      await token.connect(poor).approve(await voting.getAddress(), ethers.MaxUint256);
      await expect(voting.connect(poor).createSubject("T", "C", OPTS, 7 * DAY)).to.be.reverted;
    });

    it("credits only what actually arrived when a transfer fee is active", async function () {
      // Turn on the token's 5% platform fee. The burned fee is unaffected (StorageToken skips
      // the fee when `to == address(0)`), but the deposit transfer loses 5% in flight.
      //
      // Set by writing the token's storage rather than through its ChangeTreasuryFee proposal:
      // that proposal path validates the amount but never persists it, so execution reads
      // `proposal.amount == 0` and always sets the fee to zero. Driving the fee directly also
      // makes this a test of THIS contract's accounting rather than of the token's governance.
      await setPlatformFee(500);
      expect(await token.balanceOf(await voting.getAddress())).to.equal(0n);

      const supplyBefore = await token.totalSupply();
      await voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY);

      // The creator is debited the full fee either way. How much of it is actually DESTROYED
      // depends on the token: this version's _update taxes every transfer including burns, with
      // no mint/burn exemption, so 5% is diverted to the treasury and 95% is burned. There is no
      // intermediate hop to leak on — the fee is taken straight from the creator.
      const expectedBurned = (BURN_FEE * 9500n) / 10000n;
      expect(await token.totalSupply()).to.equal(supplyBefore - expectedBurned);

      const expectedDeposit = (DEPOSIT * 9500n) / 10000n;
      expect(await token.balanceOf(await voting.getAddress())).to.equal(expectedDeposit);
      // The recorded liability matches the tokens actually held, not the amount requested.
      expect((await voting.getSubject(1)).deposit).to.equal(expectedDeposit);
      expect(await voting.totalDepositLiability()).to.equal(expectedDeposit);
    });

    it("reverts for a blacklisted creator", async function () {
      await runTokenProposal(9 /* AddToBlacklist */, creator.address);
      await expect(voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY)).to.be.reverted;
    });
  });

  describe("pause", function () {
    it("blocks new subjects while paused", async function () {
      await voting.connect(owner).emergencyAction(1);
      await expect(voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY)).to.be.reverted;
      await time.increase(31 * 60); // emergency cooldown
      await voting.connect(owner).emergencyAction(2);
      await voting.connect(creator).createSubject("T", "C", OPTS, 7 * DAY);
    });
  });

  describe("views", function () {
    it("reverts for a subject that does not exist", async function () {
      await expect(voting.getSubject(1)).to.be.revertedWithCustomError(voting, "SubjectNotFound");
    });
  });

  /**
   * Conservation, not merely solvency. Asserted as EQUALITY on purpose: a `>=` check passes just
   * as happily when the contract over-holds, which is exactly the signature of a path that
   * decrements a liability without transferring. Balance-delta accounting makes equality hold
   * even with the platform fee enabled, because every credit records what actually arrived.
   */
  async function expectSolvent() {
    const held = await token.balanceOf(await voting.getAddress());
    const owed = (await voting.totalLockedLiability()) + (await voting.totalDepositLiability());
    expect(held, "held balance does not equal recorded liabilities").to.equal(owed);
  }

  /**
   * Force StorageToken's platform fee on. `platformFeeBps` is private and its governance path
   * cannot actually set a non-zero value (see the note at the call site), so write the slot.
   */
  async function setPlatformFee(bps: number) {
    const PLATFORM_FEE_SLOT = 14;
    await ethers.provider.send("hardhat_setStorageAt", [
      await token.getAddress(),
      ethers.toBeHex(PLATFORM_FEE_SLOT, 32),
      ethers.toBeHex(bps, 32),
    ]);
    // Prove the slot is the right one rather than assuming: a plain transfer must now lose the fee.
    const probe = ethers.parseEther("1000");
    const before = await token.balanceOf(other.address);
    await token.connect(owner).transfer(other.address, probe);
    const received = (await token.balanceOf(other.address)) - before;
    expect(received, "platform fee slot did not take effect").to.equal(
      (probe * BigInt(10000 - bps)) / 10000n
    );
  }

  /** Drive a StorageToken proposal through the two-admin flow. */
  async function runTokenProposal(proposalType: number, target: string, amount: number | bigint = 0) {
    const tx = await token
      .connect(owner)
      .createProposal(proposalType, 0, target, ZeroHash, amount, ZeroAddress);
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];
    await time.increase(DAY + 1);
    await token.connect(admin).approveProposal(proposalId);
    await time.increase(DAY + 1); // covers the whitelist lock where relevant
  }
});
