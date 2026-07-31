// PHASE C — the SECOND admin approves a pending proposal, reaching quorum and executing it.
//
// `createProposal` auto-approves for its proposer, so approval MUST come from a different admin.
// Running this as admin1 would revert. The script signs as `signers[1]` for that reason.
//
// Also doubles as the proposal STATUS reader: with no PROPOSAL_ID it lists every pending proposal
// with its execution window and how long is left. That is the missing R-14 mitigation — there was
// previously nothing in the repo that could answer "how long do I have?".
//
// ⚠️ THE EXPIRY CONSTANT IS A TRAP. Two constants named PROPOSAL_TIMEOUT exist with different
// values: GovernanceModule.sol:78 = 48h (the live one, used by _initializeProposal) and
// ProposalTypes.sol:33 = 3 days (dead, referenced nowhere). This script imports the 48h value from
// live.ts. Reading the wrong one puts the deadline 24h past actual expiry.
//
// USAGE:
//   npx hardhat run scripts/bridge/approveProposal.ts --network sepolia            # list
//   PROPOSAL_ID=0x.. npx hardhat run scripts/bridge/approveProposal.ts --network sepolia
//   APPROVE_ALL=1    npx hardhat run scripts/bridge/approveProposal.ts --network sepolia
import { ethers, network } from "hardhat";
import { MIN_PROPOSAL_EXECUTION_DELAY, PROPOSAL_TIMEOUT } from "./live";

const TESTNET_TOKENS: Record<string, string> = {
  sepolia: "0x32d6929c9F552068D54481FeAe75674fD29F337e",
  "base-sepolia": "0x32d6929c9F552068D54481FeAe75674fD29F337e",
};

const TYPE_NAMES: Record<number, string> = {
  1: "AddRole",
  3: "Upgrade",
  5: "AddWhitelist",
  9: "AddToBlacklist",
  10: "RemoveFromBlacklist",
  11: "ChangeTreasuryFee",
  12: "SetBridgeMinter",
  13: "RemoveBridgeMinter",
};

function hms(seconds: number): string {
  const s = Math.abs(seconds);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function main() {
  const tokenAddr = process.env.TOKEN_ADDRESS?.trim() || TESTNET_TOKENS[network.name];
  if (!tokenAddr) throw new Error(`No token recorded for "${network.name}"; set TOKEN_ADDRESS`);

  const signers = await ethers.getSigners();
  if (signers.length < 2) {
    throw new Error(
      `Need TWO signers. Approval must come from an admin OTHER than the proposer — ` +
        `createProposal already counts the proposer's own approval.`
    );
  }
  const approver = signers[1];
  const token = await ethers.getContractAt("StorageToken", tokenAddr);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;

  console.log(`network:  ${network.name}`);
  console.log(`token:    ${tokenAddr}`);
  console.log(`approver: ${approver.address}  (admin2)`);
  console.log(`chain time: ${new Date(now * 1000).toISOString()}\n`);

  // ---------------------------------------------------------------- enumerate
  const count: bigint = await token.proposalCount();
  const found: Array<{ id: string; type: number; target: string; created: number; approvals: number }> = [];

  for (let i = 0n; i < count; i++) {
    const id = await token.proposalRegistry(i);
    if (id === ethers.ZeroHash) continue;
    const p = await token.proposals(id);
    if (p.target === ethers.ZeroAddress) continue; // already executed / cleaned up
    // `expiryTime` is created + PROPOSAL_TIMEOUT, so recover the creation time from it.
    const created = Number(p.config.expiryTime) - PROPOSAL_TIMEOUT;
    found.push({
      id,
      type: Number(p.proposalType),
      target: p.target,
      created,
      approvals: Number(p.config.approvals),
    });
  }

  if (found.length === 0) {
    console.log(`No open proposals.`);
    return;
  }

  console.log(`${found.length} open proposal(s):\n`);
  for (const f of found) {
    const execAt = f.created + MIN_PROPOSAL_EXECUTION_DELAY;
    const expAt = f.created + PROPOSAL_TIMEOUT;
    const name = TYPE_NAMES[f.type] ?? `type ${f.type}`;
    console.log(`  ${f.id}`);
    console.log(`    ${name}  ->  ${f.target}`);
    console.log(`    approvals: ${f.approvals} / 2`);
    console.log(`    executable: ${new Date(execAt * 1000).toISOString()}`);
    console.log(`    expires:    ${new Date(expAt * 1000).toISOString()}`);
    if (now < execAt) {
      console.log(`    STATUS: WAITING — executable in ${hms(execAt - now)}`);
    } else if (now >= expAt) {
      console.log(`    STATUS: EXPIRED ${hms(now - expAt)} ago — must be re-proposed`);
    } else {
      console.log(`    STATUS: READY — ${hms(expAt - now)} left in the window`);
    }
    console.log();
  }

  // ---------------------------------------------------------------- approve
  const targetId = process.env.PROPOSAL_ID?.trim();
  const approveAll = process.env.APPROVE_ALL?.trim() === "1";
  if (!targetId && !approveAll) {
    console.log(`Set PROPOSAL_ID=0x.. to approve one, or APPROVE_ALL=1 for every READY proposal.`);
    return;
  }

  const toApprove = found.filter((f) => {
    if (targetId) return f.id.toLowerCase() === targetId.toLowerCase();
    const execAt = f.created + MIN_PROPOSAL_EXECUTION_DELAY;
    const expAt = f.created + PROPOSAL_TIMEOUT;
    return now >= execAt && now < expAt;
  });

  if (toApprove.length === 0) {
    console.log(`Nothing to approve (none READY, or the given id was not found / not open).`);
    return;
  }

  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
  const quorum = Number((await token.roleConfigs(ADMIN_ROLE)).quorum);

  let nonce = await ethers.provider.getTransactionCount(approver.address, "pending");
  for (const f of toApprove) {
    const execAt = f.created + MIN_PROPOSAL_EXECUTION_DELAY;

    // `approveProposal` only auto-executes when quorum is reached AT OR AFTER the execution
    // time. Approving EARLY is legitimate and the vote counts, but it leaves the proposal
    // sitting at full quorum with nothing left to trigger it — every further `approveProposal`
    // then reverts ProposalErr(4) ("already approved"). That state needs `executeProposal`,
    // which is a separate public entry point with the same ADMIN_ROLE gate.
    if (f.approvals >= quorum && now >= execAt) {
      console.log(`executing ${f.id} (already at ${f.approvals}/${quorum} approvals) ...`);
      const tx = await token.connect(approver).executeProposal(f.id, { nonce });
      nonce++;
      await tx.wait();
      console.log(`  ok (${tx.hash})`);
      continue;
    }

    if (now < execAt) {
      console.log(`SKIP ${f.id} — not executable for another ${hms(execAt - now)}.`);
      console.log(`  (Approving early is allowed and counts, but will NOT execute yet.)`);
    }
    console.log(`approving ${f.id} ...`);
    const tx = await token.connect(approver).approveProposal(f.id, { nonce });
    nonce++;
    await tx.wait();
    console.log(`  ok (${tx.hash})`);
  }

  console.log(`\nRe-run without PROPOSAL_ID/APPROVE_ALL to confirm the proposals cleared.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// npx hardhat run scripts/bridge/approveProposal.ts --network sepolia
