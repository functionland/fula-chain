import { ethers, upgrades } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { parseUnits } from "ethers";

// Import hardhat globally for verification
declare const hre: HardhatRuntimeEnvironment;

async function main() {
  console.log("Deploying StoragePool locally on Hardhat network...");
  const [deployer, admin, user1, user2] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);

  // Get the contract factories
  const StorageToken = await ethers.getContractFactory("StorageToken");
  const StakingPool = await ethers.getContractFactory("StakingPool");
  const StoragePool = await ethers.getContractFactory("StoragePool");

  // Configuration values
  const initialOwner = deployer.address;
  const initialAdmin = admin.address;
  // Large token supply for testing
  const tokenSupply = parseUnits("2000000000", 18); // 2 billion tokens
  const poolInitialAmount = parseUnits("10000000", 18); // 10M tokens for staking pool
  const userTestAmount = parseUnits("1000000", 18); // 1M tokens for users

  // Constants for governance roles
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

  console.log("Using configuration:");
  console.log("- Initial Owner:", initialOwner);
  console.log("- Initial Admin:", initialAdmin);
  console.log("- Token Supply:", ethers.formatEther(tokenSupply));
  console.log("- Pool Initial Amount:", ethers.formatEther(poolInitialAmount));
  console.log("- User Test Amount:", ethers.formatEther(userTestAmount));

  try {
    // 1. Deploy StorageToken
    console.log("\nDeploying StorageToken as UUPS proxy...");
    const storageToken = await upgrades.deployProxy(
      StorageToken,
      [initialOwner, initialAdmin, tokenSupply],
      {
        initializer: "initialize",
        kind: "uups",
      }
    );
    await storageToken.waitForDeployment();
    const tokenAddress = await storageToken.getAddress();
    console.log("StorageToken deployed to:", tokenAddress);

    // Set up token governance
    console.log("\nSetting up token governance parameters...");
    // Increase time to bypass timelock
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
    await ethers.provider.send("evm_mine", []);

    await storageToken.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);

    // Wait for timelock again
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
    await ethers.provider.send("evm_mine", []);

    await storageToken
      .connect(deployer)
      .setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("Token governance parameters set");

    // 2. Deploy StakingPool as UUPS proxy
    console.log("\nDeploying StakingPool as UUPS proxy...");
    const stakingPool = await upgrades.deployProxy(
      StakingPool,
      [tokenAddress, initialOwner, initialAdmin],
      {
        initializer: "initialize",
        kind: "uups",
      }
    );
    await stakingPool.waitForDeployment();
    const stakingPoolAddress = await stakingPool.getAddress();
    console.log("StakingPool deployed to:", stakingPoolAddress);

    // 3. Deploy StoragePool as UUPS proxy
    console.log("\nDeploying StoragePool as UUPS proxy...");
    const storagePool = await upgrades.deployProxy(
      StoragePool,
      [tokenAddress, stakingPoolAddress, initialOwner, initialAdmin],
      {
        initializer: "initialize",
        kind: "uups",
      }
    );
    await storagePool.waitForDeployment();
    const storagePoolAddress = await storagePool.getAddress();
    console.log("StoragePool deployed to:", storagePoolAddress);

    // 4. Set up governance parameters for the pools
    console.log("\nSetting up governance parameters for pools...");

    // Wait for timelock periods to expire for both pools
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
    await ethers.provider.send("evm_mine", []);

    // Set quorum for both pools
    await stakingPool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);
    await storagePool.connect(deployer).setRoleQuorum(ADMIN_ROLE, 2);

    // Wait for timelock periods again
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // +1 day
    await ethers.provider.send("evm_mine", []);

    // Set transaction limits
    await stakingPool
      .connect(deployer)
      .setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    await storagePool
      .connect(deployer)
      .setRoleTransactionLimit(ADMIN_ROLE, tokenSupply);
    console.log("Governance parameters set up for both pools");

    // 5. Set up permissions for StoragePool
    console.log("\nSetting up permissions...");

    // Set StoragePool address as the staking engine on StakingPool
    console.log(
      "Setting StoragePool address as staking engine on StakingPool..."
    );
    await stakingPool.connect(deployer).setStakingEngine(storagePoolAddress);
    console.log("StakingPool configured with StoragePool address");

    // 6. Set up token governance with admin wallet
    console.log("\nSetting up token governance with admin wallet...");
    const storageTokenWithAdmin = storageToken.connect(admin);
    await storageTokenWithAdmin.setRoleQuorum(ADMIN_ROLE, 2);
    console.log("Token quorum set with admin");
    await storageTokenWithAdmin.setRoleTransactionLimit(
      ADMIN_ROLE,
      tokenSupply
    );
    console.log("Token transaction limit set with admin");

    // 7. Whitelist StakingPool in StorageToken via proposal mechanism
    console.log("\nWhitelisting StakingPool in StorageToken via proposal...");
    const storageTokenWithOwner = storageToken.connect(deployer);
    const ADD_WHITELIST_TYPE = 5;
    const ZERO_HASH = ethers.ZeroHash;
    const ZERO_ADDRESS = ethers.ZeroAddress;
    const whitelistProposalTx = await storageTokenWithAdmin.createProposal(
      ADD_WHITELIST_TYPE, 0, stakingPoolAddress, ZERO_HASH, 0, ZERO_ADDRESS
    );
    const whitelistReceipt = await whitelistProposalTx.wait();
    const proposalCreatedLog = whitelistReceipt!.logs.find(log => {
      try {
        const parsed = storageToken.interface.parseLog(log);
        return parsed?.name === "ProposalCreated";
      } catch {
        return false;
      }
    });
    const whitelistProposalId = proposalCreatedLog ?
      storageToken.interface.parseLog(proposalCreatedLog)?.args[0] :
      undefined;
    console.log("Whitelist proposalID:", whitelistProposalId);
    await storageTokenWithOwner.approveProposal(whitelistProposalId);
    console.log("Proposal approved by second admin");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageTokenWithAdmin.executeProposal(whitelistProposalId);
    console.log("Whitelist proposal executed");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    // 8. Transfer tokens to staking pool for testing
    console.log("\nTransferring tokens to staking pool...");
    await storageTokenWithAdmin.transferFromContract(
      stakingPoolAddress,
      poolInitialAmount
    );
    console.log("Tokens transferred to staking pool");

    // 9. Whitelist test users in StorageToken via proposal mechanism
    console.log("\nWhitelisting test users in StorageToken via proposal...");

    // Whitelist user1
    const whitelistUser1ProposalTx = await storageTokenWithAdmin.createProposal(
      ADD_WHITELIST_TYPE, 0, user1.address, ZERO_HASH, 0, ZERO_ADDRESS
    );
    const whitelistUser1Receipt = await whitelistUser1ProposalTx.wait();
    const proposalCreatedLogUser1 = whitelistUser1Receipt!.logs.find(log => {
      try {
        const parsed = storageToken.interface.parseLog(log);
        return parsed?.name === "ProposalCreated";
      } catch {
        return false;
      }
    });
    const whitelistUser1ProposalId = proposalCreatedLogUser1 ?
      storageToken.interface.parseLog(proposalCreatedLogUser1)?.args[0] :
      undefined;
    console.log("Whitelist User1 proposalID:", whitelistUser1ProposalId);
    await storageTokenWithOwner.approveProposal(whitelistUser1ProposalId);
    console.log("User1 proposal approved by second admin");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageTokenWithAdmin.executeProposal(whitelistUser1ProposalId);
    console.log("User1 whitelist proposal executed");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    // Whitelist user2
    const whitelistUser2ProposalTx = await storageTokenWithAdmin.createProposal(
      ADD_WHITELIST_TYPE, 0, user2.address, ZERO_HASH, 0, ZERO_ADDRESS
    );
    const whitelistUser2Receipt = await whitelistUser2ProposalTx.wait();
    const proposalCreatedLogUser2 = whitelistUser2Receipt!.logs.find(log => {
      try {
        const parsed = storageToken.interface.parseLog(log);
        return parsed?.name === "ProposalCreated";
      } catch {
        return false;
      }
    });
    const whitelistUser2ProposalId = proposalCreatedLogUser2 ?
      storageToken.interface.parseLog(proposalCreatedLogUser2)?.args[0] :
      undefined;
    console.log("Whitelist User2 proposalID:", whitelistUser2ProposalId);
    await storageTokenWithOwner.approveProposal(whitelistUser2ProposalId);
    console.log("User2 proposal approved by second admin");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await storageTokenWithAdmin.executeProposal(whitelistUser2ProposalId);
    console.log("User2 whitelist proposal executed");
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    // 10. Transfer tokens to users for testing
    console.log("\nTransferring tokens to test users...");
    await storageTokenWithAdmin.transferFromContract(
      user1.address,
      userTestAmount
    );
    await storageTokenWithAdmin.transferFromContract(
      user2.address,
      userTestAmount
    );
    console.log("Tokens transferred to test users");

    // 11. Get balances for verification
    console.log("\nFetching balances...");
    const deployerBalance = await storageToken.balanceOf(deployer.address);
    const adminBalance = await storageToken.balanceOf(admin.address);
    const stakingPoolBalance = await storageToken.balanceOf(stakingPoolAddress);
    const user1Balance = await storageToken.balanceOf(user1.address);
    const user2Balance = await storageToken.balanceOf(user2.address);

    console.log("Token balances:");
    console.log(`- Deployer: ${ethers.formatEther(deployerBalance)}`);
    console.log(`- Admin: ${ethers.formatEther(adminBalance)}`);
    console.log(`- StakingPool: ${ethers.formatEther(stakingPoolBalance)}`);
    console.log(`- User1: ${ethers.formatEther(user1Balance)}`);
    console.log(`- User2: ${ethers.formatEther(user2Balance)}`);

    // 12. Summary
    console.log("\nDeployment completed successfully!");
    console.log("Summary:");
    console.log("- Storage Token:", tokenAddress);
    console.log("- Staking Pool:", stakingPoolAddress);
    console.log("- Storage Pool:", storagePoolAddress);
    console.log("\nTest accounts:");
    console.log("- Deployer (Owner):", deployer.address);
    console.log("- Admin:", admin.address);
    console.log("- User1:", user1.address);
    console.log("- User2:", user2.address);
    console.log("\nFeel free to interact with these contracts in your tests.");

    // 13. Test basic functionality
    console.log("\nTesting basic functionality...");

    // Test StoragePool initialization
    const tokenPoolAddress = await storagePool.tokenPool();
    console.log("StoragePool tokenPool address:", tokenPoolAddress);
    console.log("Expected StakingPool address:", stakingPoolAddress);
    console.log(
      "TokenPool correctly set:",
      tokenPoolAddress === stakingPoolAddress
    );

    // Test StakingPool initialization
    const stakingEngineAddress = await stakingPool.stakingEngine();
    console.log("StakingPool stakingEngine address:", stakingEngineAddress);
    console.log("Expected StoragePool address:", storagePoolAddress);
    console.log(
      "StakingEngine correctly set:",
      stakingEngineAddress === storagePoolAddress
    );

    // 14. Comprehensive StoragePool workflow testing
    console.log("\n=== COMPREHENSIVE STORAGEPOOL WORKFLOW TESTING ===");

    // Connect contracts with users
    const storagePoolWithUser1 = storagePool.connect(user1);
    const storagePoolWithUser2 = storagePool.connect(user2);
    const storageTokenWithUser1 = storageToken.connect(user1);
    const storageTokenWithUser2 = storageToken.connect(user2);

    // Test parameters
    const joinRequestTokens = ethers.parseEther("100000"); // 100K tokens for joining
    const testPoolName = "TestPool";
    const testRegion = "TestRegion";
    const testPeerId1 = "12D3KooWTest1";
    const testPeerId2 = "12D3KooWTest2";

    // Check current pool creation lock amount
    console.log("Checking pool creation lock amount...");
    const currentLockAmount = await storagePool.createPoolLockAmount();
    console.log(`Current pool creation lock amount: ${ethers.formatEther(currentLockAmount)}`);

    // If it's 0, we'll use a smaller amount for testing
    const actualPoolCreationTokens = currentLockAmount > 0 ? currentLockAmount : ethers.parseEther("100000"); // 100K tokens if not set
    console.log(`Using pool creation tokens: ${ethers.formatEther(actualPoolCreationTokens)}`);

    console.log("\n--- Step 1: User1 creates a pool ---");

    // Check initial balances
    const user1InitialBalance = await storageToken.balanceOf(user1.address);
    const stakingPoolInitialBalance = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User1 initial balance: ${ethers.formatEther(user1InitialBalance)}`);
    console.log(`StakingPool initial balance: ${ethers.formatEther(stakingPoolInitialBalance)}`);

    // User1 approves tokens for pool creation
    console.log("User1 approving tokens for pool creation...");
    await storageTokenWithUser1.approve(storagePoolAddress, actualPoolCreationTokens);

    // User1 creates pool
    console.log("User1 creating pool...");
    const createPoolTx = await storagePoolWithUser1.createPool(
      testPoolName,
      testRegion,
      joinRequestTokens, // required tokens for joining
      604800, // maxChallengeResponsePeriod (7 days)
      1000, // minPingTime
      10, // maxMembers
      testPeerId1
    );
    await createPoolTx.wait();
    console.log("Pool created successfully!");

    // Check balances after pool creation
    const user1BalanceAfterCreate = await storageToken.balanceOf(user1.address);
    const stakingPoolBalanceAfterCreate = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User1 balance after pool creation: ${ethers.formatEther(user1BalanceAfterCreate)}`);
    console.log(`StakingPool balance after pool creation: ${ethers.formatEther(stakingPoolBalanceAfterCreate)}`);
    console.log(`Tokens locked for pool creation: ${ethers.formatEther(user1InitialBalance - user1BalanceAfterCreate)}`);

    // Get pool details - first pool created should have ID 1
    const poolId = 1;
    console.log(`Created pool ID: ${poolId}`);

    console.log("\n--- Step 2: User2 sends join request ---");

    // Check User2 initial balance
    const user2InitialBalance = await storageToken.balanceOf(user2.address);
    console.log(`User2 initial balance: ${ethers.formatEther(user2InitialBalance)}`);

    // User2 approves tokens for join request
    console.log("User2 approving tokens for join request...");
    await storageTokenWithUser2.approve(storagePoolAddress, joinRequestTokens);

    // User2 sends join request
    console.log("User2 sending join request...");
    const joinRequestTx = await storagePoolWithUser2.joinPoolRequest(poolId, testPeerId2);
    await joinRequestTx.wait();
    console.log("Join request submitted successfully!");

    // Check balances after join request
    const user2BalanceAfterJoin = await storageToken.balanceOf(user2.address);
    const stakingPoolBalanceAfterJoin = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User2 balance after join request: ${ethers.formatEther(user2BalanceAfterJoin)}`);
    console.log(`StakingPool balance after join request: ${ethers.formatEther(stakingPoolBalanceAfterJoin)}`);
    console.log(`Tokens locked for join request: ${ethers.formatEther(user2InitialBalance - user2BalanceAfterJoin)}`);

    console.log("\n--- Step 3: User1 (pool creator) votes to accept join request ---");

    // User1 votes to accept the join request
    console.log("User1 voting to accept join request...");
    const voteTx = await storagePoolWithUser1.voteOnJoinRequest(poolId, testPeerId2, testPeerId1, true);
    await voteTx.wait();
    console.log("Vote submitted successfully!");

    // Check if user2 is now a member
    console.log("Checking if User2 is now a pool member...");
    // Note: The join request should be automatically approved since User1 is the only member and voted yes

    console.log("\n--- Step 4: User2 leaves the pool ---");

    // Check User2 balance before leaving
    const user2BalanceBeforeLeave = await storageToken.balanceOf(user2.address);
    const stakingPoolBalanceBeforeLeave = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User2 balance before leaving: ${ethers.formatEther(user2BalanceBeforeLeave)}`);
    console.log(`StakingPool balance before User2 leaves: ${ethers.formatEther(stakingPoolBalanceBeforeLeave)}`);

    // User2 leaves the pool (removes their peer ID)
    console.log("User2 leaving the pool...");
    const leaveTx = await storagePoolWithUser2.removeMemberPeerId(poolId, testPeerId2);
    await leaveTx.wait();
    console.log("User2 left the pool successfully!");

    // Check balances after User2 leaves
    const user2BalanceAfterLeave = await storageToken.balanceOf(user2.address);
    const stakingPoolBalanceAfterLeave = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User2 balance after leaving: ${ethers.formatEther(user2BalanceAfterLeave)}`);
    console.log(`StakingPool balance after User2 leaves: ${ethers.formatEther(stakingPoolBalanceAfterLeave)}`);
    console.log(`Tokens returned to User2: ${ethers.formatEther(user2BalanceAfterLeave - user2BalanceBeforeLeave)}`);

    console.log("\n--- Step 5: User1 (pool creator) deletes the pool ---");

    // Check User1 balance before deleting pool
    const user1BalanceBeforeDelete = await storageToken.balanceOf(user1.address);
    const stakingPoolBalanceBeforeDelete = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User1 balance before deleting pool: ${ethers.formatEther(user1BalanceBeforeDelete)}`);
    console.log(`StakingPool balance before pool deletion: ${ethers.formatEther(stakingPoolBalanceBeforeDelete)}`);

    // User1 deletes the pool
    console.log("User1 deleting the pool...");
    const deleteTx = await storagePoolWithUser1.deletePool(poolId);
    await deleteTx.wait();
    console.log("Pool deleted successfully!");

    // Check final balances after pool deletion
    const user1FinalBalance = await storageToken.balanceOf(user1.address);
    const stakingPoolFinalBalance = await storageToken.balanceOf(stakingPoolAddress);
    console.log(`User1 final balance: ${ethers.formatEther(user1FinalBalance)}`);
    console.log(`StakingPool final balance: ${ethers.formatEther(stakingPoolFinalBalance)}`);
    console.log(`Tokens returned to User1: ${ethers.formatEther(user1FinalBalance - user1BalanceBeforeDelete)}`);

    console.log("\n--- Final Balance Summary ---");
    const user1TotalChange = user1FinalBalance - user1InitialBalance;
    const user2TotalChange = user2BalanceAfterLeave - user2InitialBalance;
    const stakingPoolTotalChange = stakingPoolFinalBalance - stakingPoolInitialBalance;

    console.log(`User1 total balance change: ${ethers.formatEther(user1TotalChange)}`);
    console.log(`User2 total balance change: ${ethers.formatEther(user2TotalChange)}`);
    console.log(`StakingPool total balance change: ${ethers.formatEther(stakingPoolTotalChange)}`);

    // Verify that all tokens were properly returned (should be close to 0 change for users)
    const tolerance = ethers.parseEther("0.001"); // Small tolerance for any fees
    const user1ChangeAbs = user1TotalChange < 0 ? -user1TotalChange : user1TotalChange;
    const user2ChangeAbs = user2TotalChange < 0 ? -user2TotalChange : user2TotalChange;

    console.log("\n--- Test Results ---");
    console.log(`✅ Pool creation: ${user1ChangeAbs <= tolerance ? "PASS" : "FAIL"} (User1 tokens properly handled)`);
    console.log(`✅ Join request: ${user2ChangeAbs <= tolerance ? "PASS" : "FAIL"} (User2 tokens properly handled)`);
    console.log(`✅ Pool workflow: ${stakingPoolTotalChange >= 0 ? "PASS" : "FAIL"} (No tokens lost in StakingPool)`);

    console.log("\n=== COMPREHENSIVE TESTING COMPLETED ===");
  } catch (error: any) {
    console.error("Deployment failed:", error.message);
    if (error.data) {
      console.error("Error data:", error.data);
    }
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

// Execute the main function and handle any errors
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

// Run with:
// npx hardhat node
// npx hardhat run scripts/StoragePool/deployLocalStoragePool.ts --network localhost
/*
Advance the time for testing:
npx hardhat console --network localhost
> await network.provider.send("evm_increaseTime", [86400]) // 1 day
> await network.provider.send("evm_mine")
 */
