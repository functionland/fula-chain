// Deploys the CommunityVoting UUPS proxy.
//
// Usage:
//   TOKEN_ADDRESS=0x.. STAKING_ENGINE=0x.. STORAGE_POOL=0x.. OWNER=0x.. ADMIN=0x.. \
//     npx hardhat run scripts/deployCommunityVoting.ts --network base
//
// Set DRY_RUN=1 to run every pre-flight check and stop before deploying.
//
// STAKING_ENGINE and STORAGE_POOL may be the zero address: the contract degrades gracefully,
// disabling stake-derived voting power and the membership multiplier respectively. Both can be
// wired later through governance proposal type 15.
import hre, { ethers, upgrades } from "hardhat";

/** StorageToken keeps `platformFeeBps` private, so it is read straight from its storage slot. */
const STORAGE_TOKEN_FEE_SLOT = 14;

/**
 * Verified per-chain addresses, so a bare run cannot pick the wrong contract.
 *
 * This table exists because of a real incident: the first Base deployment wired
 * `stakingEngine = 0x3EDD28f6...`, copied from `scripts/checkProxyStorage.ts`. That address is a
 * live FULA staking contract, so every sanity check passed — but it holds ~999k staked while the
 * one users actually stake in (`0xb2064743...`, the VIP staking page's contract) holds ~6.46M.
 * About 87% of staked FULA would have been invisible to voting, silently.
 *
 * The lesson: "it is a plausible address of the right type" is not verification. Pin the value,
 * and make disagreeing with it deliberate.
 */
const KNOWN_GOOD: Record<string, { token: string; stakingEngine: string; note: string }> = {
  // Base mainnet
  "8453": {
    token: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
    // StakingEngineLinear proxy, impl 0x912270870f... — the contract the VIP staking page uses.
    stakingEngine: "0xb2064743e3da40bB4C18e80620A02a38e87fB145",
    note: "Base mainnet",
  },
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return ethers.getAddress(value);
}

function optionalAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return ethers.ZeroAddress;
  return ethers.getAddress(value);
}

/**
 * Resolve an address from env, falling back to the verified default for this chain.
 * If env disagrees with the known-good value, refuse unless CONFIRM_OVERRIDE is set — overriding
 * stays possible, doing it by accident does not.
 */
function resolveAddress(
  envName: string,
  knownGood: string | undefined,
  confirmOverride: boolean
): string {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    if (knownGood) {
      console.log(`${envName}: using verified default ${knownGood}`);
      return ethers.getAddress(knownGood);
    }
    return ethers.ZeroAddress;
  }
  const supplied = ethers.getAddress(raw);
  if (knownGood && supplied !== ethers.getAddress(knownGood)) {
    const message =
      `\n${envName} OVERRIDE\n` +
      `  supplied   : ${supplied}\n` +
      `  known-good : ${ethers.getAddress(knownGood)}\n`;
    if (!confirmOverride) {
      throw new Error(
        message +
          `  Refusing to deploy. If the override is intended, set CONFIRM_OVERRIDE=1.\n` +
          `  If it is not, unset ${envName} and the verified default will be used.`
      );
    }
    console.warn(message + `  CONFIRM_OVERRIDE is set — proceeding with the supplied address.`);
  }
  return supplied;
}

async function main() {
  // Trim and accept several spellings. On Windows cmd, `set DRY_RUN=1 && ...` stores "1 " WITH a
  // trailing space, so a strict === "1" silently turns an intended dry run into a real mainnet
  // deployment. Anything non-empty other than an explicit "0"/"false" is treated as a dry run:
  // erring toward NOT deploying is the only safe direction for this flag.
  const dryRaw = (process.env.DRY_RUN ?? "").trim().toLowerCase();
  const dryRun = dryRaw !== "" && dryRaw !== "0" && dryRaw !== "false" && dryRaw !== "no";
  if (dryRaw !== "" && !dryRun) {
    console.log(`DRY_RUN=${JSON.stringify(dryRaw)} interpreted as OFF — this WILL deploy.`);
  }
  const confirmOverride = (process.env.CONFIRM_OVERRIDE ?? "").trim() !== "";

  const network = await ethers.provider.getNetwork();
  const known = KNOWN_GOOD[network.chainId.toString()];
  if (known) console.log(`Verified address table found for ${known.note}.\n`);

  const tokenAddress = known
    ? resolveAddress("TOKEN_ADDRESS", known.token, confirmOverride)
    : required("TOKEN_ADDRESS");
  const stakingEngine = known
    ? resolveAddress("STAKING_ENGINE", known.stakingEngine, confirmOverride)
    : optionalAddress("STAKING_ENGINE");
  // No known-good default: storagePool is deliberately unset on Base, because
  // StoragePool.createPoolLockAmount caps pool join stakes far below minPoolJoinStake's 1 FULA
  // floor, which would make the membership multiplier unreachable for everyone.
  const storagePool = optionalAddress("STORAGE_POOL");
  const initialOwner = required("OWNER");
  const initialAdmin = required("ADMIN");

  const [deployer] = await ethers.getSigners();
  console.log(`network      : ${hre.network.name} (chainId ${network.chainId})`);
  console.log(`deployer     : ${deployer.address}`);
  console.log(`token        : ${tokenAddress}`);
  console.log(`stakingEngine: ${stakingEngine}${stakingEngine === ethers.ZeroAddress ? "  (stake power disabled)" : ""}`);
  console.log(`storagePool  : ${storagePool}${storagePool === ethers.ZeroAddress ? "  (multiplier disabled)" : ""}`);
  console.log(`owner        : ${initialOwner}`);
  console.log(`admin        : ${initialAdmin}`);

  if (initialOwner === initialAdmin) {
    throw new Error(
      "OWNER and ADMIN must be different addresses: createProposal auto-approves for its " +
        "proposer, so a second distinct admin is required to ever reach quorum 2."
    );
  }

  // ---- Pre-flight A: the token is a real FULA deployment ----
  const token = await ethers.getContractAt("StorageToken", tokenAddress);
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  console.log(`\ntoken symbol : ${symbol} (${decimals} decimals)`);
  if (symbol !== "FULA") throw new Error(`Expected FULA at ${tokenAddress}, found ${symbol}`);
  if (Number(decimals) !== 18) throw new Error(`Expected 18 decimals, found ${decimals}`);

  // ---- Pre-flight B: the platform fee, which changes the economics ----
  // Non-zero means every lock arrives smaller than requested and every refund leaves smaller
  // than recorded. The contract handles it correctly via balance-delta accounting, but the
  // user-visible round-trip loss should be a conscious decision, not a surprise.
  const feeRaw = await ethers.provider.getStorage(tokenAddress, STORAGE_TOKEN_FEE_SLOT);
  const platformFeeBps = BigInt(feeRaw);
  console.log(`platformFee  : ${platformFeeBps} bps`);
  if (platformFeeBps !== 0n) {
    console.warn(
      `  WARNING: a non-zero platform fee means voters lose ${platformFeeBps} bps on the way in ` +
        `and again on the way out. Accounting stays correct, but say so in the UI.`
    );
  }

  // ---- Pre-flight B2: the staking engine is the RIGHT one ----
  // `token()` matching only proves it is *a* FULA staking contract; several exist. `totalStaked`
  // is the number that distinguishes them, and printing it is what turns "plausible address" into
  // "the one people actually use". Read it out loud so a wrong choice is obvious before deploying.
  if (stakingEngine !== ethers.ZeroAddress) {
    const engine = await ethers.getContractAt("StakingEngineLinear", stakingEngine);
    const engineToken = await engine.token();
    console.log(`stake token  : ${engineToken}`);
    if (engineToken.toLowerCase() !== tokenAddress.toLowerCase()) {
      throw new Error(
        `Staking engine ${stakingEngine} governs ${engineToken}, not the token being wired ` +
          `(${tokenAddress}). Stake-derived voting power would read a different token entirely.`
      );
    }
    try {
      const totalStaked: bigint = await engine.totalStaked();
      console.log(`totalStaked  : ${ethers.formatEther(totalStaked)} FULA`);
      if (totalStaked === 0n) {
        console.warn(
          "  WARNING: this staking contract holds NOTHING. Several FULA staking contracts exist " +
            "on Base; wiring an empty or superseded one gives every staker zero voting power " +
            "with no error. Confirm this is the contract your stakers actually use."
        );
      }
    } catch {
      console.warn("  (totalStaked unavailable — confirm this is the intended staking contract)");
    }
  }

  // ---- Pre-flight C: the sybil-cost assumption behind the membership multiplier ----
  if (storagePool !== ethers.ZeroAddress) {
    const pool = await ethers.getContractAt("StoragePool", storagePool);
    const createPoolLockAmount: bigint = await pool.createPoolLockAmount();
    console.log(`poolLockCost : ${ethers.formatEther(createPoolLockAmount)} FULA`);
    if (createPoolLockAmount === 0n) {
      console.warn(
        "  WARNING: creating a StoragePool currently costs nothing, so a motivated actor can " +
          "spin up pools and self-approve sybil members. minPoolJoinStake and minMembershipAge " +
          "are the only remaining barriers to the voting-power multiplier — tune them, or " +
          "consider setting memberMultiplierBps to 10000 (1x) until pool creation has a cost."
      );
    }
  }

  // ---- Pre-flight D: the implementation is upgrade-safe ----
  const CommunityVoting = await ethers.getContractFactory("CommunityVoting");
  await upgrades.validateImplementation(CommunityVoting, {
    kind: "uups",
    unsafeAllow: ["constructor"],
  });
  console.log("\nvalidateImplementation: OK");

  if (dryRun) {
    console.log("\nDRY_RUN=1 — all pre-flight checks passed, nothing deployed.");
    return;
  }

  const voting = await upgrades.deployProxy(
    CommunityVoting,
    [tokenAddress, stakingEngine, storagePool, initialOwner, initialAdmin],
    { kind: "uups", initializer: "initialize", unsafeAllow: ["constructor"] }
  );
  await voting.waitForDeployment();

  const proxyAddress = await voting.getAddress();
  console.log(`\nCommunityVoting proxy         : ${proxyAddress}`);

  // Read the implementation slot with retries. Base RPCs serve stale state for several seconds
  // after a deployment, and this call then throws "doesn't look like an ERC 1967 proxy" for a
  // proxy that is in fact already live — which reads as a failed deployment when it succeeded.
  // The proxy address above is the authoritative output; never re-run a deploy on this error
  // without first checking whether that address already has code.
  let implAddress = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(
    `CommunityVoting implementation: ${implAddress || "(RPC still stale — read the ERC1967 slot later; the proxy IS deployed)"}`
  );

  // Read the seeded parameters back off the chain and refuse to proceed if any disagrees.
  //
  // The values live in `initialize`, so a proxy pointed at a STALE implementation is seeded
  // with that implementation's constants while every address check still passes. The OZ plugin
  // keys implementations by bytecode hash and so should deploy a fresh one whenever these
  // change — but "should" is exactly what was assumed about the staking-engine address. Assert
  // it instead. This also catches a stale artifact or an un-recompiled source tree.
  const EXPECTED_PARAMS: Array<[number, string, bigint]> = [
    [1, "burnFee", ethers.parseEther("25000")],
    [2, "deposit", ethers.parseEther("50000")],
    [3, "minVoteBasis", ethers.parseEther("10000")],
    [8, "quorumBasis", ethers.parseEther("200000")],
    [9, "quorumVoters", 8n],
  ];
  console.log("\nSeeded parameters (read back from the deployed proxy):");
  const wrong: string[] = [];
  for (const [id, name, expected] of EXPECTED_PARAMS) {
    let actual: bigint | null = null;
    for (let attempt = 0; attempt < 10 && actual === null; attempt++) {
      try {
        actual = await voting.paramValue(id);
      } catch {
        await new Promise((r) => setTimeout(r, 3000)); // stale RPC right after deployment
      }
    }
    const shown = name.includes("Voters") ? String(actual) : `${ethers.formatEther(actual ?? 0n)} FULA`;
    const good = actual === expected;
    console.log(`  ${good ? "ok  " : "WRONG"} ${name.padEnd(14)} ${shown}`);
    if (!good) wrong.push(`${name}: expected ${expected}, chain has ${actual}`);
  }
  if (wrong.length) {
    throw new Error(
      "Deployed proxy is seeded with unexpected parameters, which usually means it was pointed " +
        "at a stale implementation:\n  " +
        wrong.join("\n  ") +
        `\nThe proxy at ${proxyAddress} IS deployed and must be retired rather than reused.`
    );
  }

  // The quorum halves are ANDed, so a turnout that satisfies one must be able to satisfy the
  // other. Guard the relationship, not just the values: an earlier seeding paired 15 voters
  // with 5,000,000 basis, which no realistic turnout could reach, so every deposit would burn.
  const qVoters = await voting.paramValue(9);
  const qBasis = await voting.paramValue(8);
  const minVote = await voting.paramValue(3);
  const perVoter = qBasis / qVoters;
  console.log(
    `\nQuorum shape: ${qVoters} voters must average ${ethers.formatEther(perVoter)} FULA ` +
      `(${(Number(perVoter) / Number(minVote)).toFixed(1)}x the ${ethers.formatEther(minVote)} minimum)`
  );
  if (perVoter > minVote * 10n) {
    throw new Error(
      `quorumBasis/quorumVoters demands ${ethers.formatEther(perVoter)} FULA per voter, over 10x ` +
        `the ${ethers.formatEther(minVote)} minimum. That is almost certainly unreachable and every ` +
        `proposal would burn its deposit. Re-check the seeds before using this deployment.`
    );
  }

  // The UI recovers ballot option labels from SubjectOptions event logs, and public RPCs reject
  // wide eth_getLogs ranges. Record this so log queries can start here instead of block 0.
  const deployBlock = voting.deploymentTransaction()?.blockNumber;
  console.log(`Deployment block              : ${deployBlock ?? "(unknown — read it from the tx)"}`);
  console.log(`Deployment tx                 : ${voting.deploymentTransaction()?.hash ?? "(unknown)"}`);

  console.log(
    "\nREQUIRED NEXT STEP — the contract is inert until this is done:\n" +
      `  setRoleQuorum(ADMIN_ROLE, 2)\n` +
      "  Quorum defaults to 0 and GovernanceModule rejects anything below 2, so no proposal can\n" +
      "  be created until an admin sets it. setRoleQuorum itself carries no timelock, so it can\n" +
      "  be called immediately; creating PROPOSALS is what waits out the 24h ROLE_CHANGE_DELAY\n" +
      "  applied to both initial admins at initialization."
  );

  if (process.env.ETHERSCAN_API_KEY) {
    console.log("\nWaiting for confirmations before verification...");
    await voting.deploymentTransaction()?.wait(6);
    try {
      await hre.run("verify:verify", { address: implAddress, constructorArguments: [] });
    } catch (error) {
      console.warn(`Verification failed (non-fatal): ${error}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// npx hardhat run scripts/deployCommunityVoting.ts --network base
