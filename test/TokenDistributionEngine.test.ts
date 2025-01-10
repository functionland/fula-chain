import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { TokenDistributionEngine, StorageToken } from "../typechain-types/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TokenDistributionEngine", function () {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let distributor: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let users: SignerWithAddress[];
  let distributionEngineAddress: string;
  const initialDistributionPool = ethers.parseEther("100000");
  let tge: any;

  beforeEach(async function () {
    // Get signers
    [owner, admin, distributor, user1, user2, ...users] = await ethers.getSigners();

    // Deploy StorageToken
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = (await upgrades.deployProxy(StorageToken, [owner.address, (initialDistributionPool * BigInt(2))])) as StorageToken;
    await storageToken.waitForDeployment();

    // Deploy TokenDistributionEngine
    const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
    tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
      await storageToken.getAddress(),
      owner.address,
    ])) as TokenDistributionEngine;
    await tokenDistributionEngine.waitForDeployment();

    // Grant roles
    const engineWithOwner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));
    await engineWithOwner.grantRole(await engineWithOwner.ADMIN_ROLE(), admin.address);
    await engineWithOwner.grantRole(await engineWithOwner.DISTRIBUTOR_ROLE(), distributor.address);

    await storageToken.connect(await ethers.getSigner(owner.address)).grantRole(await storageToken.ADMIN_ROLE(), admin.address);

    tge = async (tokens: bigint) => {

      await storageToken.connect(await ethers.getSigner(admin.address)).addToWhitelist(await tokenDistributionEngine.getAddress());
      await time.increase(2 * 24 * 60 * 60);
      await storageToken.connect(await ethers.getSigner(admin.address)).transferFromContract(await tokenDistributionEngine.getAddress(), tokens);
      console.log(`Balance of contract ${await tokenDistributionEngine.getAddress()} is ${await storageToken.balanceOf(await tokenDistributionEngine.getAddress())} and required is ${tokens}`);
      expect(await storageToken.balanceOf(await tokenDistributionEngine.getAddress())).to.be.eq(tokens);
    
        const adminSigner_local = tokenDistributionEngine.connect(await ethers.getSigner(admin.address));
        if (await tokenDistributionEngine.tgeInitiated()) {
          console.log("TGE Already done");
          return null;
        }

        // Initiate TGE
        const tx = await adminSigner_local.InitiateTGE();
        const receipt = await tx.wait();
        return receipt;
    }
  });

  it("should initialize correctly", async function () {
    const engineAddress = await tokenDistributionEngine.getAddress();
    const ownerRole = await tokenDistributionEngine.hasRole(
      await tokenDistributionEngine.DEFAULT_ADMIN_ROLE(),
      owner.address
    );

    // Check if the contract has been initialized properly
    expect(ownerRole).to.be.true; // Owner should have admin role
    expect(await tokenDistributionEngine.tgeInitiated()).to.be.false; // TGE should not be initiated yet
    expect(await storageToken.balanceOf(engineAddress)).to.equal(ethers.parseEther("0")); // Contract should hold initial supply
  });

  it("should pause and unpause distribution", async function () {
    const engineWithOwner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));

    // Pause distribution
    await engineWithOwner.emergencyPauseDistribution();
    expect(await tokenDistributionEngine.paused()).to.be.true; // Contract should be paused

    // Unpause distribution
    await engineWithOwner.emergencyUnpauseDistribution();
    expect(await tokenDistributionEngine.paused()).to.be.false; // Contract should be unpaused

    // Check emitted events
    const txPause = await engineWithOwner.emergencyPauseDistribution();
    const receiptPause = await txPause.wait();
    const pauseEvent = receiptPause?.logs
        .map((log) => {
            try {
                return engineWithOwner.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    expect(pauseEvent?.args?.action).to.equal("Distribution paused");

    const txUnpause = await engineWithOwner.emergencyUnpauseDistribution();
    const receiptUnpause = await txUnpause.wait();
    const unpauseEvent = receiptUnpause?.logs
        .map((log) => {
            try {
                return engineWithOwner.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    expect(unpauseEvent?.args?.action).to.equal("Distribution unpaused");
  });

  it("should add a vesting cap successfully", async function () {
    const capId = 1;
    const name = "Team Allocation";
    const totalAllocation = ethers.parseEther("500000"); // Half of the total supply
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
    const initialReleasePercentage = 10; // Initial release of 10%

    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));

    // Add a vesting cap as distributor role
    const txAddCap = await distributorSigner.addVestingCap(
      capId,
      name,
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    const receiptAddCap = await txAddCap.wait();
    const adCapEvent = receiptAddCap?.logs
        .map((log) => {
            try {
                return tokenDistributionEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "VestingCapAdded");
    expect(adCapEvent?.args?.name).to.equal(name);
    expect(adCapEvent?.args?.id).to.equal(capId);

    // Verify that the cap was added correctly
    const capDetails = await tokenDistributionEngine.vestingCaps(capId);
    
    expect(capDetails.totalAllocation).to.equal(totalAllocation);
    expect(capDetails.cliff).to.equal(cliffInDays * 24 * 60 * 60); // Convert days to seconds
    expect(capDetails.vestingTerm).to.equal(vestingTermInMonths * 30 * 24 * 60 * 60); // Convert months to seconds (approx.)
    
     expect(capDetails.initialRelease).to.equal(initialReleasePercentage);

     console.log(`cap Details`) 
  });

  it("should initiate TGE successfully", async function () {
    const adminSigner = tokenDistributionEngine.connect(await ethers.getSigner(admin.address));

    // Initiate TGE
    const receipt = await tge(ethers.parseEther("0"));

    // Parse the "TGEInitiated" event from the transaction receipt
    const tgeEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TGEInitiated");

    const startTime = tgeEvent.args?.startTime;

    // Verify that the TGE was initiated
    expect(await tokenDistributionEngine.tgeInitiated()).to.be.true; // TGE should now be initiated
    expect(startTime).to.be.a("bigint"); // Ensure start time is a valid timestamp
  });

  it("should add wallets to a vesting cap", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocations = [initialDistributionPool / BigInt(2), initialDistributionPool / BigInt(4)]; // Specific allocations per wallet
    const totalCapAllocation = initialDistributionPool; // Total allocation for the cap

    // Add a vesting cap first
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
        capId,
        "Team Allocation",
        totalCapAllocation,
        30, // Cliff in days
        12, // Vesting term in months
        1, // Vesting plan in months
        10 // Initial release percentage
    );

    // Add wallets to the vesting cap with specific allocations
    const tx = await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    const receipt = await tx.wait();

    // Parse and verify the "WalletsAddedToCap" event
    const walletsEvent = receipt?.logs
        .map((log) => {
            try {
                return tokenDistributionEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "WalletsAddedToCap");

    if (walletsEvent) {
        const addedCapId = walletsEvent.args?.capId;
        const addedWallets = walletsEvent.args?.wallets;

        // Verify event arguments
        expect(addedCapId).to.equal(capId); // Cap ID should match
        expect(addedWallets).to.deep.equal(wallets); // Wallet addresses should match
    } else {
        throw new Error("WalletsAddedToCap event not emitted");
    }

    // Verify state changes for each wallet
    let totalAllocatedToWallets = BigInt(0);
    for (let i = 0; i < wallets.length; i++) {
        expect(await tokenDistributionEngine.walletNames(wallets[i], capId)).to.equal(names[i]); // Verify wallet names
        expect(await tokenDistributionEngine.allocatedTokens(wallets[i], capId)).to.equal(totalAllocations[i]); // Verify specific allocations

        totalAllocatedToWallets += totalAllocations[i];
    }

    // Verify that wallets were added to the cap's wallet list correctly
    const fetchedWallets = await tokenDistributionEngine.getCapWallets(capId);
    expect(fetchedWallets).to.deep.equal(wallets); // Verify wallet list matches input

    // Verify that the total allocated tokens were updated correctly
    expect(await tokenDistributionEngine.totalAllocatedToWallets()).to.equal(totalAllocatedToWallets);
});

  

it("should fail to add wallets with mismatched names", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet"]; // Mismatched array length
    const totalAllocations = [ethers.parseEther("250000"), ethers.parseEther("250000")]; // Allocations per wallet

    // Add a vesting cap first
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
        capId,
        "Team Allocation",
        ethers.parseEther("500000"), // Total allocation for the cap
        30, // Cliff in days
        12, // Vesting term in months
        1, // Vesting plan in months
        10 // Initial release percentage
    );

    // Attempt to add wallets with mismatched names array length and expect failure
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWith(
        "Wallets and names length mismatch"
    );

    // Verify that no wallets were added to the cap after the failed transaction
    const capWallets = await tokenDistributionEngine.getCapWallets(capId);
    expect(capWallets.length).to.equal(0); // No wallets should have been added

    // Verify that no allocations were made for any wallet in this cap
    for (const wallet of wallets) {
        const allocation = await tokenDistributionEngine.allocatedTokens(wallet, capId);
        expect(allocation).to.equal(0); // No tokens should be allocated
    }
});



it("should calculate due tokens correctly after cliff period", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
        capId,
        "Team Allocation",
        totalAllocation,
        cliffInDays,
        vestingTermInMonths,
        vestingPlanInMonths,
        initialReleasePercentage
    );
    await tge(totalAllocation);

    // Add wallets to the vesting cap with allocations
    const totalAllocations = [totalAllocation]; // Single wallet allocation matches total cap allocation
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60 + 1); // Advance time by the cliff period

    // Calculate due tokens
    const dueTokens = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);

    // Expected calculation: Only the initial release should be claimable after the cliff
    const expectedInitialRelease = (totalAllocation * BigInt(initialReleasePercentage)) / BigInt(100);
    
    // Verify the calculation matches expected logic
    expect(dueTokens).to.equal(expectedInitialRelease);

    // Verify no tokens have been claimed yet (state validation)
    const claimedTokens = await tokenDistributionEngine.claimedTokens(user1.address, capId);
    expect(claimedTokens).to.equal(0);

    // Verify allocated tokens for the wallet
    const allocatedTokens = await tokenDistributionEngine.allocatedTokens(user1.address, capId);
    expect(allocatedTokens).to.equal(totalAllocation);

    // Verify vesting cap details (state validation)
    const vestingCap = await tokenDistributionEngine.vestingCaps(capId);
    expect(vestingCap.totalAllocation).to.equal(totalAllocation);
    expect(vestingCap.cliff).to.equal(cliffInDays * 24 * 60 * 60); // Converted to seconds
    expect(vestingCap.vestingTerm).to.equal(vestingTermInMonths * 30 * 24 * 60 * 60); // Converted to seconds
    expect(vestingCap.vestingPlan).to.equal(vestingPlanInMonths * 30 * 24 * 60 * 60); // Converted to seconds
    expect(vestingCap.initialRelease).to.equal(initialReleasePercentage);
});


it("should allow claiming tokens and emit correct event", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = initialDistributionPool;
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
        capId,
        "Team Allocation",
        totalAllocation,
        cliffInDays,
        vestingTermInMonths,
        vestingPlanInMonths,
        initialReleasePercentage
    );
    expect(await storageToken.balanceOf(await tokenDistributionEngine.getAddress())).to.be.eq(ethers.parseEther("0"));
    await tge(totalAllocation);
    expect(await storageToken.balanceOf(await tokenDistributionEngine.getAddress())).to.be.eq(totalAllocation);

    // Add wallets to the vesting cap with allocations
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period

    // Claim tokens
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1); // Assume chainId is `1`
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
        .map((log) => {
            try {
                return tokenDistributionEngine.interface.parseLog(log);
            } catch (e) {
                return null; // Ignore logs that don't match the interface
            }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    if (!claimEvent) {
        throw new Error("TokensClaimed event not emitted");
    }

    // Extract event arguments
    const receiver = claimEvent.args.receiver;
    const claimedCapId = claimEvent.args.capId;
    const chainId = claimEvent.args.chainId;
    const dueTokens = claimEvent.args.dueTokens;
    console.log(`receiver : ${receiver}`);
    console.log(`claimedCapId : ${claimedCapId}`);
    console.log(`chainId : ${chainId}`);
    console.log(`dueTokens : ${dueTokens}`);


    // Expected initial release calculation (10% of total allocation)
    const expectedInitialRelease = (totalAllocation * BigInt(initialReleasePercentage)) / BigInt(100);

    // Verify event details
    expect(receiver).to.equal(user1.address);
    expect(claimedCapId).to.equal(capId);
    expect(dueTokens).to.equal(expectedInitialRelease);
    expect(chainId).to.equal(1); // Assuming chainId was passed as `1`

    // Verify state changes
    const claimedTokens = await tokenDistributionEngine.claimedTokens(user1.address, capId);
    expect(claimedTokens).to.equal(expectedInitialRelease); // Ensure claimed tokens match initial release

    const allocatedTokens = await tokenDistributionEngine.allocatedTokens(user1.address, capId);
    expect(allocatedTokens).to.equal(totalAllocation); // Ensure remaining allocation is correct

    console.log(`Claimed Amount: ${dueTokens}`);
});


 it("should revert when claiming tokens before tge", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Attempt to claim tokens before the cliff period ends
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWith("TGE has not happened and claiming is disabled");
  });

  it("should fail to add a duplicate vesting cap", async function () {
    const capId = 1;
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Attempt to add the same cap again and expect failure
    await expect(
      distributorSigner.addVestingCap(
        capId,
        "Duplicate Cap",
        totalAllocation,
        cliffInDays,
        vestingTermInMonths,
        vestingPlanInMonths,
        initialReleasePercentage
      )
    ).to.be.revertedWith("Cap already exists");
  });

  it("should revert if non-distributor tries to add wallets", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap as distributor role
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Attempt to add wallets using a non-distributor account (e.g., user1)
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const totalAllocations = [totalAllocation];
    await expect(userSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWithCustomError(tokenDistributionEngine, "AccessControlUnauthorizedAccount");
  });

  it("should pause and prevent token claims during emergency pause", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period

    // Pause the contract
    const ownerSigner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));
    await ownerSigner.emergencyPauseDistribution();

    // Attempt to claim tokens while paused
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");

    // Unpause the contract
    await ownerSigner.emergencyUnpauseDistribution();

    // Claim tokens successfully after unpausing
    const tx = await userSigner.claimTokens(capId, 1);
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;

    expect(receiver).to.equal(user1.address);
    expect(claimedCapId).to.equal(capId);
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed
  });

  it("should revert if non-admin tries to initiate TGE", async function () {
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));

    // Attempt to initiate TGE as a non-admin
    await expect(userSigner.InitiateTGE()).to.be.revertedWithCustomError(tokenDistributionEngine, "AccessControlUnauthorizedAccount");
  });


  it("should allocate tokens correctly to wallets after TGE initiation", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation / BigInt(4), totalAllocation / BigInt(2)];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Initiate TGE
    const receipt = await tge(totalAllocation);

    // Parse the "TGEInitiated" event from the transaction receipt
    const tgeEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TGEInitiated");

    const startTime = tgeEvent?.args?.startTime;

    expect(startTime).to.be.a("bigint"); // Ensure start time is valid
    expect(await tokenDistributionEngine.tgeInitiated()).to.be.true; // Verify TGE was initiated

    // Verify token allocation for each wallet
    let i = 0;
    for (const wallet of wallets) {
      const allocation = await tokenDistributionEngine.allocatedTokens(wallet, capId);
      expect(allocation).to.equal(totalAllocations[i]); // Equal allocation per wallet
      i = i + 1;
    }
  });

  it("should revert if trying to claim tokens from a non-existent cap", async function () {
    const capId = 999; // Non-existent cap ID
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await tge(ethers.parseEther("0"));

    // Attempt to claim tokens from a non-existent cap and expect failure
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
  });

  it("should emit correct event when claiming tokens after vesting period", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    await tge(totalAllocation);
    // Simulate passing the cliff period and one vesting period
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one month

    // Claim tokens
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1); // Assume chainId is `1`
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;

    expect(receiver).to.equal(user1.address); // Ensure the correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure the correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed
  });

  it("should revert if non-owner tries to pause distribution", async function () {
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));

    // Attempt to pause the contract as a non-owner
    await expect(userSigner.emergencyPauseDistribution()).to.be.revertedWithCustomError(tokenDistributionEngine, "AccessControlUnauthorizedAccount");
  });

  it("should revert if non-owner tries to unpause distribution", async function () {
    const ownerSigner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));

    // Pause the contract as the owner
    await ownerSigner.emergencyPauseDistribution();
    expect(await tokenDistributionEngine.paused()).to.be.true; // Verify the contract is paused

    // Attempt to unpause the contract as a non-owner
    await expect(userSigner.emergencyUnpauseDistribution()).to.be.revertedWithCustomError(tokenDistributionEngine, "AccessControlUnauthorizedAccount");
  });

  it("should emit correct event when pausing and unpausing distribution", async function () {
    const ownerSigner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));

    // Pause the contract
    const pauseTx = await ownerSigner.emergencyPauseDistribution();
    const pauseReceipt = await pauseTx.wait();

    // Parse the "EmergencyAction" event for pausing
    const pauseEvent = pauseReceipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");

    const action1 = pauseEvent?.args?.action;
    const timestamp1 = pauseEvent?.args?.timestamp;

    expect(action1).to.equal("Distribution paused"); // Ensure the action matches
    expect(timestamp1).to.be.a("bigint"); // Ensure a valid timestamp is emitted

    // Unpause the contract
    const unpauseTx = await ownerSigner.emergencyUnpauseDistribution();
    const unpauseReceipt = await unpauseTx.wait();

    // Parse the "EmergencyAction" event for unpausing
    const unpauseEvent = unpauseReceipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");

    const action = unpauseEvent?.args?.action;
    const timestamp = unpauseEvent?.args?.timestamp;

    expect(action).to.equal("Distribution unpaused"); // Ensure the action matches
    expect(timestamp).to.be.a("bigint"); // Ensure a valid timestamp is emitted
  });

  it("should revert if trying to add a vesting cap with invalid initial release percentage", async function () {
    const capId = 1;
    const totalAllocation = ethers.parseEther("100000");
    const invalidInitialReleasePercentage = 110; // Invalid percentage (>100)
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));

    // Attempt to add a vesting cap with an invalid initial release percentage
    await expect(
      distributorSigner.addVestingCap(
        capId,
        "Invalid Cap",
        totalAllocation,
        cliffInDays,
        vestingTermInMonths,
        vestingPlanInMonths,
        invalidInitialReleasePercentage
      )
    ).to.be.revertedWith("Invalid initial release percentage");
  });

  it("should revert if trying to allocate tokens without enough balance in the contract", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = BigInt(2) * initialDistributionPool; // Exceeds the contract's token balance
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
  
    // Add a vesting cap with excessive allocation
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Excessive Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
  
    // Attempt to add wallets and expect it to fail due to insufficient balance
    const totalAllocations = [totalAllocation];
    const adminSigner = tokenDistributionEngine.connect(await ethers.getSigner(admin.address));
    await adminSigner.InitiateTGE();

    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWith(
      "Insufficient contract balance"
    );
  });
  

  it("should emit correct event when adding a new vesting cap", async function () {
    const capId = 1;
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));

    // Add a new vesting cap
    const tx = await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const receipt = await tx.wait();

    // Parse the "VestingCapAdded" event from the transaction receipt
    const capEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "VestingCapAdded");

    const addedCapId = capEvent?.args?.id;
    const name = capEvent?.args?.name;

    expect(addedCapId).to.equal(capId); // Ensure the correct cap ID is emitted
    expect(name).to.equal("Team Allocation"); // Ensure the correct name is emitted
  });

  it("should transfer allocated tokens to wallets after TGE initiation", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation / BigInt(4), totalAllocation / BigInt(2)];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Initiate TGE
    await tge(totalAllocation);

    // Verify token balances after TGE initiation
    let i = 0;
    for (const wallet of wallets) {
      const allocation = await tokenDistributionEngine.allocatedTokens(wallet, capId);
      expect(allocation).to.equal(totalAllocations[i]); // Equal allocation per wallet

      const walletBalance = await storageToken.balanceOf(wallet);
      expect(walletBalance).to.equal(0); // Tokens should not yet be transferred until claimed
      i = i + 1;
    }
  });

  it("should revert if trying to assign more thant token total cap", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("2000000"); // Exceeds the contract's token balance
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Excessive Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    const totalAllocations = [totalAllocation];
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWith(
      "Not enough balance in the token contract to cover the cap"
    );
  });

  it("should emit correct event when tokens are claimed", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    await tge(totalAllocation);
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Simulate passing the cliff period and one vesting period
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one month

    // Claim tokens
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1); // Assume chainId is `1`
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;

    expect(receiver).to.equal(user1.address); // Ensure the correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure the correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed

    console.log(`Tokens Claimed Event: Receiver=${receiver}, CapID=${claimedCapId}, Amount=${claimedAmount}`);
  });

  it("should correctly calculate tokens after partial claim", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period and one vesting period
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one month
    const dueTokens1 = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);
    console.log(`user is owed ${dueTokens1} tokens from ${totalAllocation} tokens`);

    // Claim part of the tokens
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1);
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;
    console.log(`${receiver} claimed ${claimedAmount} tokens`);

    expect(receiver).to.equal(user1.address); // Ensure the correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure the correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed

    // Simulate passing another vesting period
    await time.increase(vestingPlanInMonths * 30 * 24 * 60 * 60 + 2); // Advance time by another month

    // Calculate due tokens after partial claim
    const dueTokens = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);

    // Verify the calculation matches the expected logic
    expect(dueTokens).to.be.gt(0); // Ensure additional tokens are due after another vesting period
  });

  it("should revert if trying to add wallets with duplicate addresses", async function () {
    const capId = 1;
    const wallets = [user1.address, user1.address]; // Duplicate addresses
    const names = ["User1 Wallet", "Duplicate Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap first
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Attempt to add wallets with duplicate addresses and expect failure
    const totalAllocations = [totalAllocation / BigInt(4), totalAllocation / BigInt(2)];
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWith(
      "Wallet already added"
    );
  });

  it("should revert if claiming tokens when TGE is not initiated", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Attempt to claim tokens before TGE is initiated
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWith("TGE has not happened and claiming is disabled");
  });

  it("should revert if attempting to add wallets with too high allocation", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap first
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Manually modify allocated tokens to create a mismatch (simulate error)
    const totalAllocations = [totalAllocation, totalAllocation / BigInt(2)];
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWithCustomError(tokenDistributionEngine, "AllocationTooHigh");
  });


  it("should correctly handle vesting longer than vesting term", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Vesting plan longer than the term

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Extended Vesting Plan",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period and full term
    await time.increase((cliffInDays + (vestingTermInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + full term

    // Claim tokens after the full term has elapsed
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1);
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const claimedAmount = claimEvent?.args?.dueTokens;

    expect(claimedAmount).to.equal(totalAllocation); // Entire allocation should be claimable after full term
  });

  it("should emit correct event when adding wallets to a cap", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap first
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Add wallets to the cap
    const totalAllocations = [totalAllocation / BigInt(4), totalAllocation / BigInt(2)];
    const tx = await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    const receipt = await tx.wait();

    // Parse the "WalletsAddedToCap" event from the transaction receipt
    const walletsEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "WalletsAddedToCap");

    expect(walletsEvent?.args?.capId).to.equal(capId); // Ensure correct cap ID is emitted
    expect(walletsEvent?.args?.wallets).to.deep.equal(wallets); // Ensure correct wallet addresses are emitted

    console.log(`Wallets Added Event: CapID=${walletsEvent?.args?.capId}, Wallets=${walletsEvent?.args?.wallets}`);
  });

  it("should revert if trying to add a vesting cap with zero total allocation", async function () {
    const capId = 1;
    const totalAllocation = ethers.parseEther("0"); // Zero allocation
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));

    // Attempt to add a vesting cap with zero total allocation
    await expect(
      distributorSigner.addVestingCap(
        capId,
        "Zero Allocation Cap",
        totalAllocation,
        cliffInDays,
        vestingTermInMonths,
        vestingPlanInMonths,
        initialReleasePercentage
      )
    ).to.be.revertedWith("Allocation to this cap should be greater than 0");
  });

  it("should revert if trying to claim tokens before TGE initiation", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period

    // Attempt to claim tokens before TGE initiation
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWith("TGE has not happened and claiming is disabled");
  });

  it("should handle multiple caps for the same wallet correctly", async function () {
    const wallet = user1.address;
    const names = ["Cap1 Wallet", "Cap2 Wallet"];
    const totalAllocationCap1 = ethers.parseEther("500");
    const totalAllocationCap2 = ethers.parseEther("500");
    const initialReleasePercentage = 10; // 10% initial release for both caps
    const cliffInDaysCap1 = 30; // Cliff of 30 days for Cap1
    const cliffInDaysCap2 = 60; // Cliff of 60 days for Cap2
    const vestingTermInMonths = 12; // Vesting over a year for both caps
    const vestingPlanInMonths = 1; // Monthly release for both caps

    // Add two separate caps for the same wallet
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      1,
      "Cap1",
      totalAllocationCap1,
      cliffInDaysCap1,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocationCap1, totalAllocationCap2];
    await distributorSigner.addWalletsToCap(1, [wallet], [names[0]], [totalAllocations[0]]);

    await distributorSigner.addVestingCap(
      2,
      "Cap2",
      totalAllocationCap2,
      cliffInDaysCap2,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    await distributorSigner.addWalletsToCap(2, [wallet], [names[1]], [totalAllocations[1]]);
    await tge(totalAllocationCap1+totalAllocationCap2);

    // Simulate passing the cliff period for Cap1 and claim tokens
    await time.increase(cliffInDaysCap1 * 24 * 60 * 60); // Advance time by Cap1's cliff period
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await userSigner.claimTokens(1, 1); // Claim tokens from Cap1

    // Simulate passing the cliff period for Cap2 and claim tokens
    await time.increase((cliffInDaysCap2 - cliffInDaysCap1) * 24 * 60 * 60); // Advance time to Cap2's cliff period
    await userSigner.claimTokens(2, 1); // Claim tokens from Cap2

    // Verify allocations and balances
    const claimedTokensCap1 = await tokenDistributionEngine.claimedTokens(wallet, 1);
    const claimedTokensCap2 = await tokenDistributionEngine.claimedTokens(wallet, 2);

    expect(claimedTokensCap1).to.be.gt(0); // Tokens should be claimed from Cap1
    expect(claimedTokensCap2).to.be.gt(0); // Tokens should be claimed from Cap2

    console.log(`Claimed Tokens: Cap1=${claimedTokensCap1}, Cap2=${claimedTokensCap2}`);
  });

  it("should not revert if trying to add wallets after TGE initiation", async function () {
    const capId = 1;
    const capId2 = 2;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and initiate TGE
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation/BigInt(2),
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Attempt to add wallets after TGE initiation and expect failure
    const totalAllocations = [totalAllocation/BigInt(2)];
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).not.to.be.reverted;

    await tge(totalAllocation);
    await distributorSigner.addVestingCap(
      capId2,
      "Team Allocation",
      totalAllocation/BigInt(2),
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );

    // Attempt to add wallets after TGE initiation and expect failure
    const totalAllocations2 = [totalAllocation/BigInt(2)];
    await expect(distributorSigner.addWalletsToCap(capId2, wallets, names, totalAllocations2)).not.to.be.reverted;

  });

 it("should correctly handle emergency pause during ongoing claims", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Initiate TGE
    await tge(totalAllocation);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period

    // Pause the contract during an ongoing claim
    const ownerSigner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));
    await ownerSigner.emergencyPauseDistribution();

    // Attempt to claim tokens while paused and expect failure
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    console.log("pausing and claiming");
    const isPaused = await tokenDistributionEngine.paused();
    console.log("Contract paused state:", isPaused);
    expect(isPaused).to.be.eq(true);
    
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");

    // Unpause the contract and allow claim
    await ownerSigner.emergencyUnpauseDistribution();
    console.log("unpausing and claiming");
    const tx = await userSigner.claimTokens(capId, 1);
    const receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;

    expect(receiver).to.equal(user1.address); // Ensure correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed
  });

  it("should revert if trying to reinitialize the contract", async function () {
    const storageTokenAddress = await storageToken.getAddress();
    
    // Attempt to reinitialize the contract and expect failure
    await expect(
      tokenDistributionEngine.initialize(storageTokenAddress, owner.address)
    ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidInitialization");
  });

  it("should correctly handle multiple claims over time for a single wallet", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("120000");
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 3; // Quarterly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Quarterly Vesting",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period and first quarter (vesting plan)
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one quarter

    // Claim tokens after first quarter
    let userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    let tx = await userSigner.claimTokens(capId, 1);
    let receipt = await tx.wait();

    // Parse the "TokensClaimed" event from the transaction receipt
    let claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const claimedAmount = claimEvent?.args?.dueTokens;
    expect(claimedAmount).to.be.gt(0); // Ensure tokens were claimed

    // Simulate passing another quarter (vesting plan)
    await time.increase(vestingPlanInMonths * 30 * 24 * 60 * 60); // Advance time by another quarter

    // Claim tokens after second quarter
    tx = await userSigner.claimTokens(capId, 1);
    receipt = await tx.wait();

    claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null;
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const claimedAmount1 = claimEvent?.args?.dueTokens;
    expect(claimedAmount1).to.be.gt(0); // Ensure tokens were claimed for the second quarter
  });

  it("should correctly handle multiple wallets claiming from the same cap", async function () {
    const capId = 1;
    const wallets = [user1.address, user2.address];
    const names = ["User1 Wallet", "User2 Wallet"];
    const totalAllocation = ethers.parseEther("200000");
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 3; // Quarterly release

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Multi-Wallet Vesting",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation / BigInt(4), totalAllocation / BigInt(2)];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period and first quarter (vesting plan)
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one quarter

    for (const wallet of wallets) {
      const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(wallet));

      // Claim tokens for each wallet
      const tx = await userSigner.claimTokens(capId, 1);
      const receipt = await tx.wait();

      // Parse the "TokensClaimed" event from the transaction receipt
      const claimEvent = receipt?.logs
        .map((log) => {
          try {
            return tokenDistributionEngine.interface.parseLog(log);
          } catch (e) {
            return null;
          }
        })
        .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const claimedAmount = claimEvent?.args?.dueTokens;
    expect(claimedAmount).to.be.gt(0); // Ensure tokens were claimed for each wallet
    console.log(`Wallet ${wallet} claimed ${claimedAmount.toString()} tokens`);
    }
  });

  it("should handle edge case where claiming shorter than cliff period", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000");
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 90; // Cliff of 90 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 2; // Vesting plan shorter than cliff (2 months)

    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Short Vesting Plan",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);

    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60 - 10); // Advance time by the cliff period

    // Attempt to claim tokens after cliff but before any valid vesting plan period
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
  });

  it("should allow claiming tokens and emit correct event", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000"); // Total allocation for the cap
    const initialReleasePercentage = 10; // 10% initial release
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
  
    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);
  
    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period
  
    // Claim tokens
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    const tx = await userSigner.claimTokens(capId, 1); // Assume chainId is `1`
    const receipt = await tx.wait();
  
    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");

    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;
  
      // Verify event details
    expect(receiver).to.equal(user1.address); // Ensure the correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure the correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed
  
    console.log(`Tokens Claimed Event: Receiver=${receiver}, CapID=${claimedCapId}, Amount=${claimedAmount}`);

  
    // Verify the user's claimed tokens in storage
    const claimedTokens = await tokenDistributionEngine.claimedTokens(user1.address, capId);
    expect(claimedTokens).to.equal(totalAllocation * BigInt(initialReleasePercentage) / BigInt(100)); // Should match initial release percentage
  
    // Verify the user's balance after claiming tokens
    const userBalance = await storageToken.balanceOf(user1.address);
    expect(userBalance).to.equal(totalAllocation * BigInt(initialReleasePercentage) / BigInt(100)); // Should match claimed tokens
  
    console.log(`User's Balance After Claim: ${ethers.formatEther(userBalance)} tokens`);
  });

  it("should calculate tokens correctly after multiple vesting periods", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("120000"); // Total allocation for the cap
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 3; // Quarterly release
  
    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Quarterly Vesting",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);
    await tge(totalAllocation);
  
    // Simulate passing the cliff period and first quarter (vesting plan)
    await time.increase((cliffInDays + (vestingPlanInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + one quarter
  
    // Calculate due tokens after first quarter
    let dueTokens = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);
  
    // Verify the calculation matches expected logic
    const expectedInitialRelease = totalAllocation * BigInt(initialReleasePercentage) / BigInt(100);
    const expectedQuarterlyRelease = (totalAllocation - BigInt(expectedInitialRelease)) / (BigInt(vestingTermInMonths / vestingPlanInMonths));
    
    expect(dueTokens).to.equal(expectedInitialRelease + BigInt(expectedQuarterlyRelease)); // Initial + first quarter's release
  
    console.log(`Tokens due after first quarter: ${ethers.formatEther(dueTokens)} tokens`);
  
    // Simulate passing another quarter (vesting plan)
    await time.increase(vestingPlanInMonths * 30 * 24 * 60 * 60); // Advance time by another quarter
  
    // Calculate due tokens after second quarter
    dueTokens = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);
  
    // Verify the calculation matches expected logic
    expect(dueTokens).to.equal(
      expectedInitialRelease + BigInt(expectedQuarterlyRelease * BigInt(2)) // Initial + two quarters' release
    );
  
    console.log(`Tokens due after second quarter: ${ethers.formatEther(dueTokens)} tokens`);
  
    // Simulate passing the full vesting term
    await time.increase((vestingTermInMonths - (vestingPlanInMonths * 2)) * 30 * 24 * 60 * 60); // Advance time to end of term
  
    // Calculate due tokens at the end of the term
    dueTokens = await tokenDistributionEngine.calculateDueTokens(user1.address, capId);
  
    // Verify all tokens are vested at the end of the term
    expect(dueTokens).to.equal(totalAllocation); // All tokens should be claimable at this point
  
    console.log(`Tokens due at end of term: ${ethers.formatEther(dueTokens)} tokens`);
  });
  
  it("should revert if non-admin tries to initiate TGE", async function () {
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));

    // Attempt to initiate TGE as a non-admin
    await expect(userSigner.InitiateTGE())
    .to.be.revertedWithCustomError(tokenDistributionEngine, "AccessControlUnauthorizedAccount")
    .withArgs(user1.address, await tokenDistributionEngine.ADMIN_ROLE());
  });
  

  it("should revert if trying to add wallets to a non-existent cap", async function () {
    const capId = 999; // Non-existent cap ID
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
  
    // Attempt to add wallets to a non-existent cap
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    const totalAllocations = [BigInt(10)];
    await expect(distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations)).to.be.revertedWith("Invalid cap ID");
  
    // Verify that no wallets were added
    const addedWallets = await tokenDistributionEngine.getCapWallets(capId);
    expect(addedWallets.length).to.equal(0); // No wallets should be associated with the invalid cap ID
  
    console.log(`Attempt to add wallets to a non-existent cap reverted successfully.`);
  });
  
  it("should revert if trying to claim more tokens than allocated", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000"); // Total allocation for the cap
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
  
    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    await tge(totalAllocation);
  
    // Simulate passing the entire vesting term (cliff + full term)
    await time.increase((cliffInDays + (vestingTermInMonths * 30)) * 24 * 60 * 60); // Advance time by cliff + full term
  
    // Claim all tokens successfully first
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await userSigner.claimTokens(capId, 1);
  
    // Attempt to claim again and expect failure since all tokens are already claimed
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWith("No tokens due");
  
    // Verify that no additional tokens have been claimed
    const claimedTokens = await tokenDistributionEngine.claimedTokens(user1.address, capId);
    expect(claimedTokens).to.equal(totalAllocation); // Claimed tokens should match the total allocation
  
    // Verify that user's balance matches the total allocation
    const userBalance = await storageToken.balanceOf(user1.address);
    expect(userBalance).to.equal(totalAllocation); // User's balance should match the total allocation
  
    console.log(`Attempt to claim more tokens than allocated reverted successfully.`);
  });
  
  it("should revert if claiming tokens for an unallocated wallet", async function () {
    const capId = 1;
    const wallets = [user2.address]; // Allocate tokens to user2 only
    const names = ["User2 Wallet"];
    const totalAllocation = ethers.parseEther("100000"); // Total allocation for the cap
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
  
    // Add a vesting cap and allocate it to user2 only
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    await tge(totalAllocation);
  
    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period
  
    // Attempt to claim tokens as an unallocated wallet (user1)
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWith("No allocation for wallet");
  
    // Verify that no tokens have been claimed for user1
    const claimedTokens = await tokenDistributionEngine.claimedTokens(user1.address, capId);
    expect(claimedTokens).to.equal(0); // No tokens should be claimed by user1
  
    // Verify that user1's balance remains zero
    const userBalance = await storageToken.balanceOf(user1.address);
    expect(userBalance).to.equal(0); // User1's balance should remain zero
  
    console.log(`Attempt to claim tokens by unallocated wallet reverted successfully.`);
  });

  it("should correctly handle emergency pause during ongoing claims", async function () {
    const capId = 1;
    const wallets = [user1.address];
    const names = ["User1 Wallet"];
    const totalAllocation = ethers.parseEther("100000"); // Total allocation for the cap
    const initialReleasePercentage = 10; // Initial release of 10%
    const cliffInDays = 30; // Cliff of 30 days
    const vestingTermInMonths = 12; // Vesting over a year
    const vestingPlanInMonths = 1; // Monthly release
  
    // Add a vesting cap and wallets
    const distributorSigner = tokenDistributionEngine.connect(await ethers.getSigner(distributor.address));
    await distributorSigner.addVestingCap(
      capId,
      "Team Allocation",
      totalAllocation,
      cliffInDays,
      vestingTermInMonths,
      vestingPlanInMonths,
      initialReleasePercentage
    );
    const totalAllocations = [totalAllocation];
    await distributorSigner.addWalletsToCap(capId, wallets, names, totalAllocations);

    // Initiate TGE
    await tge(totalAllocation);
  
    // Simulate passing the cliff period
    await time.increase(cliffInDays * 24 * 60 * 60); // Advance time by the cliff period
  
    // Pause the contract during an ongoing claim
    const ownerSigner = tokenDistributionEngine.connect(await ethers.getSigner(owner.address));
    await ownerSigner.emergencyPauseDistribution();
  
    // Attempt to claim tokens while paused and expect failure
    const userSigner = tokenDistributionEngine.connect(await ethers.getSigner(user1.address));
    await expect(userSigner.claimTokens(capId, 1)).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
  
    console.log("Claim attempt during paused state reverted successfully.");
  
    // Unpause the contract and allow claim
    await ownerSigner.emergencyUnpauseDistribution();
  
    // Claim tokens after unpausing
    const tx = await userSigner.claimTokens(capId, 1);
    const receipt = await tx.wait();
  
    // Parse the "TokensClaimed" event from the transaction receipt
    const claimEvent = receipt?.logs
      .map((log) => {
        try {
          return tokenDistributionEngine.interface.parseLog(log);
        } catch (e) {
          return null; // Ignore logs that don't match the interface
        }
      })
      .find((parsedLog) => parsedLog && parsedLog.name === "TokensClaimed");
  
    const receiver = claimEvent?.args?.receiver;
    const claimedCapId = claimEvent?.args?.capId;
    const claimedAmount = claimEvent?.args?.dueTokens;
  
    expect(receiver).to.equal(user1.address); // Ensure correct user claimed tokens
    expect(claimedCapId).to.equal(capId); // Ensure correct cap ID is referenced
    expect(claimedAmount).to.be.gt(0); // Ensure some tokens were claimed
  
    console.log(`Tokens Claimed Event: Receiver=${receiver}, CapID=${claimedCapId}, Amount=${claimedAmount}`);
  
    // Verify that user's balance reflects the claimed amount
    const userBalance = await storageToken.balanceOf(user1.address);
    expect(userBalance).to.equal(totalAllocation * BigInt(initialReleasePercentage) / BigInt(100)); // Should match initial release percentage
  
    console.log(`User's Balance After Claim: ${ethers.formatEther(userBalance)} tokens`);
  });
  

});