import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { FulaUsersIndexAnchor } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const CONTRACT_OPERATOR_ROLE = ethers.keccak256(
  ethers.toUtf8Bytes("CONTRACT_OPERATOR_ROLE"),
);

// ProposalType enum: NA=0, AddRole=1, RemoveRole=2, ...
const PROPOSAL_TYPE_ADD_ROLE = 1;

const ONE_DAY = 24 * 60 * 60;

describe("FulaUsersIndexAnchor", function () {
  let anchor: FulaUsersIndexAnchor;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let operator: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, admin, operator, other] = await ethers.getSigners();

    const FulaUsersIndexAnchorFactory = await ethers.getContractFactory(
      "FulaUsersIndexAnchor",
    );
    anchor = (await upgrades.deployProxy(
      FulaUsersIndexAnchorFactory,
      [owner.address, admin.address],
      { kind: "uups", initializer: "initialize" },
    )) as unknown as FulaUsersIndexAnchor;
    await anchor.waitForDeployment();

    // Wait past ROLE_CHANGE_DELAY so owner/admin can mutate state.
    await time.increase(ONE_DAY + 1);

    // Set quorum 2 on ADMIN_ROLE so proposals can be approved.
    await anchor.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await time.increase(ONE_DAY + 1);

    // Grant CONTRACT_OPERATOR_ROLE to `operator` via the standard
    // governance AddRole flow. owner.createProposal() counts as the
    // first approval; admin.approveProposal() is the second and (with
    // quorum=2 + executionTime reached) executes immediately.
    const tx = await anchor
      .connect(owner)
      .createProposal(
        PROPOSAL_TYPE_ADD_ROLE,
        0,
        operator.address,
        CONTRACT_OPERATOR_ROLE,
        0,
        ZeroAddress,
      );
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];

    await time.increase(ONE_DAY + 1);
    await anchor.connect(admin).approveProposal(proposalId);
    // Wait for the operator's own ROLE_CHANGE_DELAY before they can act.
    await time.increase(ONE_DAY + 1);

    expect(
      await anchor.hasRole(CONTRACT_OPERATOR_ROLE, operator.address),
    ).to.equal(true);
  });

  it("starts with zero state", async function () {
    const [cid, seq, ts] = await anchor.latest();
    expect(cid).to.equal(ethers.ZeroHash);
    expect(seq).to.equal(0n);
    expect(ts).to.equal(0n);
  });

  it("operator can publish, latest reflects it, Published event emitted", async function () {
    const cid = ethers.id("first cbor");
    const tx = await anchor.connect(operator).publish(cid, 1n);
    const rcpt = await tx.wait();
    const block = await ethers.provider.getBlock(rcpt!.blockHash);
    const expectedTs = BigInt(block!.timestamp);

    await expect(tx)
      .to.emit(anchor, "Published")
      .withArgs(1n, cid, expectedTs);

    const [storedCid, seq, ts] = await anchor.latest();
    expect(storedCid).to.equal(cid);
    expect(seq).to.equal(1n);
    expect(ts).to.equal(expectedTs);
  });

  it("non-operator publish reverts (AccessControl)", async function () {
    const cid = ethers.id("first");
    // OZ AccessControl emits AccessControlUnauthorizedAccount on revert
    await expect(anchor.connect(other).publish(cid, 1n)).to.be.reverted;
  });

  it("monotonic sequence enforced — equal or lower reverts", async function () {
    const cid1 = ethers.id("first");
    const cid2 = ethers.id("second");
    await anchor.connect(operator).publish(cid1, 5n);

    // Same sequence rejected.
    await expect(
      anchor.connect(operator).publish(cid2, 5n),
    ).to.be.revertedWithCustomError(anchor, "NonMonotonicSequence");

    // Lower sequence rejected.
    await expect(
      anchor.connect(operator).publish(cid2, 4n),
    ).to.be.revertedWithCustomError(anchor, "NonMonotonicSequence");

    // Higher sequence accepted.
    await anchor.connect(operator).publish(cid2, 6n);
    const [, seq] = await anchor.latest();
    expect(seq).to.equal(6n);
  });

  it("can skip sequence numbers (gap allowed) — only strict-monotonic, not consecutive", async function () {
    // Real-world: chain cron only submits when CID changed. If
    // master ticks happened at sequences 5 and 9 with no chain
    // submissions in between, the next chain submission writes seq=9
    // — strict-greater, not strict-consecutive.
    const cid1 = ethers.id("first");
    const cid2 = ethers.id("second");
    await anchor.connect(operator).publish(cid1, 1n);
    await anchor.connect(operator).publish(cid2, 100n);
    const [, seq] = await anchor.latest();
    expect(seq).to.equal(100n);
  });

  it("zero CID rejected", async function () {
    await expect(
      anchor.connect(operator).publish(ethers.ZeroHash, 1n),
    ).to.be.revertedWithCustomError(anchor, "EmptyCid");
  });

  it("paused publish reverts; unpause restores function", async function () {
    // emergencyAction(1) pauses
    await anchor.connect(owner).emergencyAction(1);
    const cid = ethers.id("after pause");

    // OZ Pausable reverts with EnforcedPause custom error.
    await expect(anchor.connect(operator).publish(cid, 1n)).to.be.reverted;

    // Wait past EMERGENCY_COOLDOWN before unpause is allowed.
    // EMERGENCY_COOLDOWN is in ProposalTypes; tests in other files use 30 minutes.
    await time.increase(30 * 60 + 1);
    await anchor.connect(owner).emergencyAction(2);

    // Now publishing works.
    await anchor.connect(operator).publish(cid, 1n);
    const [storedCid] = await anchor.latest();
    expect(storedCid).to.equal(cid);
  });

  it("custom proposal types reject — InvalidProposalType", async function () {
    // Anchor has no custom types; a bogus type 99 must revert.
    await expect(
      anchor.connect(owner).createProposal(
        99, // bogus type
        0,
        other.address,
        ethers.ZeroHash,
        0,
        ZeroAddress,
      ),
    ).to.be.revertedWithCustomError(anchor, "InvalidProposalType");
  });

  it("RemoveRole proposal revokes operator privilege", async function () {
    // Round-trip: grant role, operator publishes, governance revokes,
    // operator is denied. Demonstrates end-to-end role management
    // for incident response (e.g., compromised master key).
    const cid = ethers.id("before revoke");
    await anchor.connect(operator).publish(cid, 1n);

    const PROPOSAL_TYPE_REMOVE_ROLE = 2;
    const tx = await anchor
      .connect(owner)
      .createProposal(
        PROPOSAL_TYPE_REMOVE_ROLE,
        0,
        operator.address,
        CONTRACT_OPERATOR_ROLE,
        0,
        ZeroAddress,
      );
    const receipt = await tx.wait();
    const proposalId = receipt!.logs[0].topics[1];

    await time.increase(ONE_DAY + 1);
    await anchor.connect(admin).approveProposal(proposalId);

    expect(
      await anchor.hasRole(CONTRACT_OPERATOR_ROLE, operator.address),
    ).to.equal(false);

    // Operator can no longer publish.
    const cid2 = ethers.id("after revoke");
    await expect(anchor.connect(operator).publish(cid2, 2n)).to.be.reverted;

    // State preserved at the last successful publish.
    const [storedCid, seq] = await anchor.latest();
    expect(storedCid).to.equal(cid);
    expect(seq).to.equal(1n);
  });
});
