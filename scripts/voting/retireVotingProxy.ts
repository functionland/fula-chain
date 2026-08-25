// Retires a superseded CommunityVoting proxy by pausing it.
//
//   PROXY=0x.. npx hardhat run scripts/voting/retireVotingProxy.ts --network base
//
// A superseded proxy is still fully functional: anyone who finds the address can create subjects
// and lock real FULA in a contract nobody is watching. `emergencyAction(1)` blocks createSubject,
// vote and finalize. It is a single-admin call needing no proposal, and it is reversible with
// `emergencyAction(2)`.
//
// Claims are deliberately never pausable, so pausing can never trap a user's funds — but this
// refuses to run if the contract holds any FULA or has any subjects, because in that case it is
// not actually abandoned and pausing would strand live activity.
import hre, { ethers } from "hardhat";

async function main() {
  const proxy = process.env.PROXY?.trim();
  if (!proxy) throw new Error("Set PROXY to the proxy address to retire");

  const [admin] = await ethers.getSigners();
  const voting = await ethers.getContractAt("CommunityVoting", proxy);
  const token = await ethers.getContractAt("StorageToken", await voting.token());

  const [subjects, held, paused, locked, deposits] = await Promise.all([
    voting.subjectCount(),
    token.balanceOf(proxy),
    voting.paused(),
    voting.totalLockedLiability(),
    voting.totalDepositLiability(),
  ]);

  console.log(`network : ${hre.network.name}`);
  console.log(`proxy   : ${proxy}`);
  console.log(`subjects: ${subjects}`);
  console.log(`FULA held: ${ethers.formatEther(held)}  (locked ${ethers.formatEther(locked)}, deposits ${ethers.formatEther(deposits)})`);
  console.log(`paused  : ${paused}`);

  if (subjects !== 0n || held !== 0n) {
    throw new Error(
      "Refusing to retire: this proxy has subjects or holds FULA, so it is in use. " +
        "Pausing it would stop finalization of live polls."
    );
  }
  if (paused) {
    console.log("\nAlready paused — nothing to do.");
    return;
  }

  // emergencyAction is gated by ROLE_CHANGE_DELAY as well as ADMIN_ROLE, so for the first 24h
  // after a deployment even a rightful admin cannot pause it. Without this check that surfaces
  // as a bare "execution reverted" with no hint of when to retry.
  const tc = await voting.timeConfigs(admin.address);
  const unlock = Number(tc.roleChangeTimeLock);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  if (now < unlock) {
    throw new Error(
      `Cannot pause yet: ${admin.address} is under ROLE_CHANGE_DELAY on this proxy until ` +
        `${new Date(unlock * 1000).toISOString()} ` +
        `(~${Math.ceil((unlock - now) / 3600)}h away). emergencyAction requires the caller's ` +
        `role timelock to have elapsed, which it does not for the first 24h after deployment.`
    );
  }

  console.log(`\nPausing with emergencyAction(1) as ${admin.address}...`);
  const tx = await voting.connect(admin).emergencyAction(1);
  const rcpt = await tx.wait();
  console.log(`  mined in block ${rcpt?.blockNumber}, status ${rcpt?.status}`);

  // Base RPCs serve stale reads right after a write; poll rather than trusting one read.
  for (let i = 0; i < 12; i++) {
    if (await voting.paused()) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  paused: ${await voting.paused()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
