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
  const tokenAddress = required("TOKEN_ADDRESS");
  const stakingEngine = optionalAddress("STAKING_ENGINE");
  const storagePool = optionalAddress("STORAGE_POOL");
  const initialOwner = required("OWNER");
  const initialAdmin = required("ADMIN");

  const network = await ethers.provider.getNetwork();
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
