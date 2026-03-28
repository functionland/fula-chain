import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseUnits } from "ethers";

declare const hre: HardhatRuntimeEnvironment;

async function main() {
  console.log("Deploying RewardsProgram locally on Hardhat network...");
  const [deployer, admin, programAdmin, teamLeader, client1, client2] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  const StorageToken = await ethers.getContractFactory("StorageToken");
  const StakingPool = await ethers.getContractFactory("StakingPool");
  const RewardsProgram = await ethers.getContractFactory("RewardsProgram");

  const initialOwner = deployer.address;
  const initialAdmin = admin.address;
  const tokenSupply = parseUnits("2000000000", 18);
  const userTestAmount = parseUnits("1000000", 18);

  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

  console.log("Using configuration:");
  console.log("- Initial Owner:", initialOwner);
  console.log("- Initial Admin:", initialAdmin);

  try {
    // 1. Deploy StorageToken
    console.log("\nDeploying StorageToken as UUPS proxy...");
    const storageToken = await upgrades.deployProxy(
      StorageToken,
      [initialOwner, initialAdmin, tokenSupply],
      { initializer: "initialize", kind: "uups" }
    );
    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);

    // Set up token governance
    console.log("\nSetting up token governance parameters...");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await storageToken.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await storageToken.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("Token governance parameters set");

    // 2. Deploy StakingPool as UUPS proxy
    console.log("\nDeploying StakingPool as UUPS proxy...");
    const stakingPool = await upgrades.deployProxy(
      StakingPool,
      [tokenAddress, initialOwner, initialAdmin],
      { initializer: "initialize", kind: "uups" }
    );
    await stakingPool.waitForDeployment();
    const stakingPoolAddress = await stakingPool.getAddress();
    console.log("StakingPool deployed to:", stakingPoolAddress);

    // 3. Deploy RewardsProgram as UUPS proxy
    console.log("\nDeploying RewardsProgram as UUPS proxy...");
    const rewardsProgram = await upgrades.deployProxy(
      RewardsProgram,
      [tokenAddress, stakingPoolAddress, initialOwner, initialAdmin],
      { initializer: "initialize", kind: "uups" }
    );
    await rewardsProgram.waitForDeployment();
    const rewardsProgramAddress = await rewardsProgram.getAddress();
    console.log("RewardsProgram deployed to:", rewardsProgramAddress);

    // CRITICAL SECURITY: Initialize implementation contracts
    console.log("\n🔒 SECURING IMPLEMENTATION CONTRACTS...");

    const contracts = [
      { name: "StorageToken", proxy: tokenAddress, initArgs: [tokenAddress, tokenAddress, 0] },
      { name: "StakingPool", proxy: stakingPoolAddress, initArgs: [tokenAddress, stakingPoolAddress, stakingPoolAddress] },
      { name: "RewardsProgram", proxy: rewardsProgramAddress, initArgs: [tokenAddress, stakingPoolAddress, rewardsProgramAddress, rewardsProgramAddress] },
    ];

    for (const c of contracts) {
      console.log(`Securing ${c.name} implementation...`);
      try {
        const implAddress = await upgrades.erc1967.getImplementationAddress(c.proxy);
        const impl = await ethers.getContractAt(c.name, implAddress);
        const initTx = await impl.initialize(...c.initArgs);
        await initTx.wait();
        console.log(`✅ ${c.name} implementation secured`);
      } catch (error: any) {
        if (error.message.includes("already initialized") || error.message.includes("InvalidInitialization")) {
          console.log(`✅ ${c.name} implementation was already secured`);
        } else {
          console.warn(`⚠️  Failed to secure ${c.name} implementation: ${error.message}`);
        }
      }
    }

    // 4. Set up governance parameters for pools
    console.log("\nSetting up governance parameters for pools...");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await stakingPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await rewardsProgram.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await stakingPool.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    await rewardsProgram.connect(deployer).setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("Governance parameters set for both contracts");

    // 5. Set RewardsProgram as staking engine on StakingPool
    console.log("\nSetting RewardsProgram as staking engine on StakingPool...");
    await stakingPool.connect(deployer).setStakingEngine(rewardsProgramAddress);
    console.log("StakingPool configured with RewardsProgram address");

    // 6. Set up token governance with admin wallet
    console.log("\nSetting up token governance with admin wallet...");
    const storageTokenWithAdmin = storageToken.connect(admin);
    await storageTokenWithAdmin.setRoleQuorum(ADMIN_ROLE, 2);
    await storageTokenWithAdmin.setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);

    // 7. Whitelist StakingPool and RewardsProgram in StorageToken
    console.log("\nWhitelisting StakingPool and RewardsProgram in StorageToken...");
    const ADD_WHITELIST_TYPE = 5;
    const ZERO_HASH = ethers.ZeroHash;
    const ZERO_ADDRESS = ethers.ZeroAddress;
    const storageTokenWithOwner = storageToken.connect(deployer);

    for (const addr of [stakingPoolAddress, rewardsProgramAddress]) {
      const tx = await storageTokenWithAdmin.createProposal(ADD_WHITELIST_TYPE, 0, addr, ZERO_HASH, 0, ZERO_ADDRESS);
      const receipt = await tx.wait();
      const log = receipt!.logs.find((l: any) => {
        try { return storageToken.interface.parseLog(l)?.name === "ProposalCreated"; } catch { return false; }
      });
      const proposalId = log ? storageToken.interface.parseLog(log)?.args[0] : undefined;
      await storageTokenWithOwner.approveProposal(proposalId);
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await storageTokenWithAdmin.executeProposal(proposalId);
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
    }
    console.log("Whitelist proposals executed");

    // 8. Whitelist test users and transfer tokens
    console.log("\nWhitelisting test users...");
    const users = [programAdmin, teamLeader, client1, client2];
    for (const user of users) {
      const tx = await storageTokenWithAdmin.createProposal(ADD_WHITELIST_TYPE, 0, user.address, ZERO_HASH, 0, ZERO_ADDRESS);
      const receipt = await tx.wait();
      const log = receipt!.logs.find((l: any) => {
        try { return storageToken.interface.parseLog(l)?.name === "ProposalCreated"; } catch { return false; }
      });
      const proposalId = log ? storageToken.interface.parseLog(log)?.args[0] : undefined;
      await storageTokenWithOwner.approveProposal(proposalId);
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await storageTokenWithAdmin.executeProposal(proposalId);
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await storageTokenWithAdmin.transferFromContract(user.address, userTestAmount);
    }
    console.log("Users whitelisted and funded");

    // 9. Test full workflow
    console.log("\n=== REWARDS PROGRAM WORKFLOW TEST ===");

    // Helper to create bytes8/bytes12
    function toBytes8(str: string): string {
      const bytes = ethers.toUtf8Bytes(str);
      const padded = new Uint8Array(8);
      padded.set(bytes);
      return ethers.hexlify(padded);
    }
    function toBytes12(str: string): string {
      const bytes = ethers.toUtf8Bytes(str);
      const padded = new Uint8Array(12);
      padded.set(bytes);
      return ethers.hexlify(padded);
    }

    // Create a program
    console.log("\n--- Step 1: Create Program ---");
    const createTx = await rewardsProgram.connect(deployer).createProgram(
      toBytes8("SRP"), "Solidity Rewards Program", "For Solidity developers"
    );
    await createTx.wait();
    console.log("Program created: SRP (ID: 1)");

    // Assign ProgramAdmin
    console.log("\n--- Step 2: Assign ProgramAdmin ---");
    await rewardsProgram.connect(deployer).assignProgramAdmin(1, programAdmin.address, toBytes12("PA001"));
    console.log("ProgramAdmin assigned:", programAdmin.address);

    // ProgramAdmin adds TeamLeader
    console.log("\n--- Step 3: Add TeamLeader ---");
    await rewardsProgram.connect(programAdmin).addMember(1, teamLeader.address, toBytes12("TL001"), 2);
    console.log("TeamLeader added:", teamLeader.address);

    // TeamLeader adds Client
    console.log("\n--- Step 4: Add Client ---");
    await rewardsProgram.connect(teamLeader).addMember(1, client1.address, toBytes12("CL001"), 1);
    console.log("Client added:", client1.address);

    // ProgramAdmin deposits tokens
    console.log("\n--- Step 5: Deposit Tokens ---");
    const depositAmount = parseUnits("10000", 18);
    await storageToken.connect(programAdmin).approve(rewardsProgramAddress, depositAmount);
    await rewardsProgram.connect(programAdmin).addTokens(1, depositAmount);
    console.log(`ProgramAdmin deposited ${ethers.formatEther(depositAmount)} FULA`);

    // Transfer to TeamLeader (unlocked)
    console.log("\n--- Step 6: Transfer to TeamLeader ---");
    await rewardsProgram.connect(programAdmin).transferToSubMember(
      1, teamLeader.address, parseUnits("5000", 18), "Monthly allocation", false, 0
    );
    console.log("Transferred 5000 FULA to TeamLeader (unlocked)");

    // Transfer locked tokens to Client
    console.log("\n--- Step 7: Transfer locked tokens to Client ---");
    await rewardsProgram.connect(teamLeader).transferToSubMember(
      1, client1.address, parseUnits("2000", 18), "Performance bonus", true, 0
    );
    console.log("Transferred 2000 FULA to Client (locked)");

    // Transfer time-locked tokens to Client
    console.log("\n--- Step 8: Transfer time-locked tokens to Client ---");
    await rewardsProgram.connect(teamLeader).transferToSubMember(
      1, client1.address, parseUnits("1000", 18), "Vesting reward", false, 7
    );
    console.log("Transferred 1000 FULA to Client (7 day lock)");

    // Client transfers back to parent
    console.log("\n--- Step 9: Client transfers back to TeamLeader ---");
    await rewardsProgram.connect(client1).transferToParent(1, ethers.ZeroAddress, parseUnits("500", 18));
    console.log("Client transferred 500 FULA back to TeamLeader");

    // TeamLeader withdraws
    console.log("\n--- Step 10: TeamLeader withdraws ---");
    const tlBalBefore = await storageToken.balanceOf(teamLeader.address);
    await rewardsProgram.connect(teamLeader).withdraw(1, parseUnits("1000", 18));
    const tlBalAfter = await storageToken.balanceOf(teamLeader.address);
    console.log(`TeamLeader withdrew 1000 FULA (wallet delta: ${ethers.formatEther(tlBalAfter - tlBalBefore)})`);

    // Print final balances
    console.log("\n--- Final Balances ---");
    const paBalance = await rewardsProgram.getBalance(1, programAdmin.address);
    const tlBalance = await rewardsProgram.getBalance(1, teamLeader.address);
    const clBalance = await rewardsProgram.getBalance(1, client1.address);

    console.log(`ProgramAdmin: available=${ethers.formatEther(paBalance[0])}, locked=${ethers.formatEther(paBalance[1])}, timeLocked=${ethers.formatEther(paBalance[2])}`);
    console.log(`TeamLeader:   available=${ethers.formatEther(tlBalance[0])}, locked=${ethers.formatEther(tlBalance[1])}, timeLocked=${ethers.formatEther(tlBalance[2])}`);
    console.log(`Client:       available=${ethers.formatEther(clBalance[0])}, locked=${ethers.formatEther(clBalance[1])}, timeLocked=${ethers.formatEther(clBalance[2])}`);

    const poolBalance = await stakingPool.getBalance();
    console.log(`\nStakingPool total: ${ethers.formatEther(poolBalance)}`);

    // Get implementation addresses
    const tokenImplAddress = await upgrades.erc1967.getImplementationAddress(tokenAddress);
    const stakingPoolImplAddress = await upgrades.erc1967.getImplementationAddress(stakingPoolAddress);
    const rewardsProgramImplAddress = await upgrades.erc1967.getImplementationAddress(rewardsProgramAddress);

    console.log("\n✅ LOCAL DEPLOYMENT COMPLETED SUCCESSFULLY!");
    console.log("\n📋 DEPLOYMENT SUMMARY:");
    console.log("StorageToken Proxy:", tokenAddress);
    console.log("StorageToken Implementation:", tokenImplAddress);
    console.log("StakingPool Proxy:", stakingPoolAddress);
    console.log("StakingPool Implementation:", stakingPoolImplAddress);
    console.log("RewardsProgram Proxy:", rewardsProgramAddress);
    console.log("RewardsProgram Implementation:", rewardsProgramImplAddress);

    console.log("\n🧪 TEST ACCOUNTS:");
    console.log("Deployer/Owner:", deployer.address);
    console.log("Admin:", admin.address);
    console.log("ProgramAdmin:", programAdmin.address);
    console.log("TeamLeader:", teamLeader.address);
    console.log("Client1:", client1.address);
    console.log("Client2:", client2.address);

  } catch (error: any) {
    console.error("Deployment failed:", error.message);
    if (error.data) console.error("Error data:", error.data);
    if (error.stack) console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// Run with:
// npx hardhat node
// npx hardhat run scripts/RewardsProgram/deployLocalRewardsProgram.ts --network localhost
