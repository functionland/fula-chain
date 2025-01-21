import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { TokenDistributionEngine, StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));

describe("TokenDistributionEngine", function () {
  let distributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let otherAccount: SignerWithAddress;
  
  // Constants
  const TOKEN_UNIT = ethers.parseEther("1");
  const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens

  beforeEach(async function () {
    [owner, admin, otherAccount] = await ethers.getSigners();
    
    // Deploy StorageToken first
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: 'uups', initializer: 'initialize' }
    ) as StorageToken;
    await storageToken.waitForDeployment();
  });

  describe("initialize", function () {
    it("should correctly initialize the contract", async function () {
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      distributionEngine = await upgrades.deployProxy(
        TokenDistributionEngine,
        [await storageToken.getAddress(), owner.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
      ) as TokenDistributionEngine;

      // Check storage token address
      expect(await distributionEngine.storageToken()).to.equal(await storageToken.getAddress());

      // Check roles
      const adminRole = ADMIN_ROLE;
      expect(await distributionEngine.hasRole(adminRole, owner.address)).to.be.true;
      expect(await distributionEngine.hasRole(adminRole, admin.address)).to.be.true;

      // Check token allowance
      const allowance = await storageToken.allowance(
        await distributionEngine.getAddress(),
        await distributionEngine.getAddress()
      );
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("should revert with zero addresses", async function () {
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      
      await expect(
        upgrades.deployProxy(
          TokenDistributionEngine,
          [await storageToken.getAddress(), ZeroAddress, admin.address],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(TokenDistributionEngine, "InvalidAddress")
      .withArgs();

      await expect(
        upgrades.deployProxy(
          TokenDistributionEngine,
          [await storageToken.getAddress(), owner.address, ZeroAddress],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(TokenDistributionEngine, "InvalidAddress")
      .withArgs();

      await expect(
        upgrades.deployProxy(
          TokenDistributionEngine,
          [ZeroAddress, owner.address, admin.address],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(TokenDistributionEngine, "InvalidAddress")
      .withArgs();
    });

    it("should emit TokenDistributionInitialized event", async function () {
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        const tokenAddress = await storageToken.getAddress();
        
        const distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [tokenAddress, owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
    
        await distributionEngine.waitForDeployment();
    
        // Get the transaction that deployed the contract
        const tx = await distributionEngine.deploymentTransaction();
        if (!tx) throw new Error("No deployment transaction found");
        
        const receipt = await tx.wait();
        if (!receipt) throw new Error("No receipt found");
    
        // Parse logs using contract interface
        const logs = receipt.logs
            .map((log) => {
                try {
                    return distributionEngine.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .filter((parsedLog): parsedLog is NonNullable<typeof parsedLog> => 
                parsedLog !== null && parsedLog.name === "TokenDistributionInitialized"
            );
    
        expect(logs.length).to.equal(1);
        expect(logs[0].args[0]).to.equal(tokenAddress);
    });
    

    it("should prevent reinitialization", async function () {
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      distributionEngine = await upgrades.deployProxy(
        TokenDistributionEngine,
        [await storageToken.getAddress(), owner.address, admin.address],
        { kind: 'uups', initializer: 'initialize' }
      ) as TokenDistributionEngine;

      await expect(
        distributionEngine.initialize(
          await storageToken.getAddress(),
          owner.address,
          admin.address
        )
      ).to.be.revertedWithCustomError(distributionEngine, "InvalidInitialization");
    });
  });
});

describe("initiateTGE", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens

    beforeEach(async function () {
        [owner, admin, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await ethers.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, BigInt(2) * CAP_ALLOCATION);

        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            BigInt(2) * CAP_ALLOCATION
        );

        // Add a vesting cap
        await distributionEngine.connect(owner).addVestingCap(
            1, // capId
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        );
    });

    it("should correctly initiate TGE", async function () {
        const tx = await distributionEngine.connect(owner).initiateTGE();
        const receipt = await tx.wait();
        
        // Check TGE initiated flag
        const cap = await distributionEngine.vestingCaps(1);
        expect(cap.startDate).to.equal(await time.latest());

        // Verify event
        await expect(tx)
            .to.emit(distributionEngine, "TGEInitiated")
            .withArgs(CAP_ALLOCATION, await time.latest());
    });

    it("should revert if already initiated", async function () {
        await distributionEngine.connect(owner).initiateTGE();
        
        await expect(
            distributionEngine.connect(owner).initiateTGE()
        ).to.be.revertedWithCustomError(distributionEngine, "TGEAlreadyInitiated");
    });

    it("should revert if contract has insufficient balance", async function () {
        // Add another cap that would exceed balance
        await distributionEngine.connect(owner).addVestingCap(
            2,
            ethers.encodeBytes32String("Test Cap 2"),
            BigInt(3) * CAP_ALLOCATION,
            30,
            12,
            1,
            10
        );

        await expect(
            distributionEngine.connect(owner).initiateTGE()
        ).to.be.revertedWithCustomError(
            distributionEngine, 
            "InsufficientContractBalance"
        );
    });

    it("should revert when called by non-admin", async function () {
        await expect(
            distributionEngine.connect(otherAccount).initiateTGE()
        ).to.be.revertedWithCustomError(
            distributionEngine, 
            "AccessControlUnauthorizedAccount"
        );
    });

    it("should revert when contract is paused", async function () {
        // Wait for emergency cooldown
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Pause contract
        await distributionEngine.connect(owner).emergencyAction(1);

        await expect(
            distributionEngine.connect(owner).initiateTGE()
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });

    it("should set correct start dates for all caps", async function () {
        // Add another cap
        await distributionEngine.connect(owner).addVestingCap(
            2,
            ethers.encodeBytes32String("Test Cap 2"),
            CAP_ALLOCATION / BigInt(2),
            30,
            12,
            1,
            10
        );

        const initTime = await time.latest();
        await distributionEngine.connect(owner).initiateTGE();

        const cap1 = await distributionEngine.vestingCaps(1);
        const cap2 = await distributionEngine.vestingCaps(2);

        expect(cap1.startDate).to.equal(initTime +1);
        expect(cap2.startDate).to.equal(initTime +1);
    });
});

describe("addVestingCap", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens

    beforeEach(async function () {
        [owner, admin, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorum
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION
        );
    });

    it("should correctly add a vesting cap", async function () {
        const capId = 1;
        const capName = ethers.encodeBytes32String("Test Cap");
        
        await expect(distributionEngine.connect(owner).addVestingCap(
            capId,
            capName,
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        )).to.emit(distributionEngine, "VestingCapAction")
          .withArgs(capId, capName, 1); // 1 for ADD action

        const cap = await distributionEngine.vestingCaps(capId);
        expect(cap.totalAllocation).to.equal(CAP_ALLOCATION);
        expect(cap.name).to.equal(capName);
        expect(cap.cliff).to.equal(30 * 24 * 60 * 60); // 30 days in seconds
        expect(cap.vestingTerm).to.equal(12 * 30 * 24 * 60 * 60); // 12 months in seconds
        expect(cap.vestingPlan).to.equal(1 * 30 * 24 * 60 * 60); // 1 month in seconds
        expect(cap.initialRelease).to.equal(10);
    });

    it("should revert when cap already exists", async function () {
        const capId = 1;
        await distributionEngine.connect(owner).addVestingCap(
            capId,
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30,
            12,
            1,
            10
        );

        await expect(
            distributionEngine.connect(owner).addVestingCap(
                capId,
                ethers.encodeBytes32String("Test Cap 2"),
                CAP_ALLOCATION,
                30,
                12,
                1,
                10
            )
        ).to.be.revertedWithCustomError(distributionEngine, "CapExists")
        .withArgs(capId);
    });

    it("should revert with invalid parameters", async function () {
        const capId = 1;
        const capName = ethers.encodeBytes32String("Test Cap");

        // Zero allocation
        await expect(
            distributionEngine.connect(owner).addVestingCap(
                capId,
                capName,
                0,
                30,
                12,
                1,
                10
            )
        ).to.be.revertedWithCustomError(distributionEngine, "InvalidAllocation");

        // Initial release > 100%
        await expect(
            distributionEngine.connect(owner).addVestingCap(
                capId,
                capName,
                CAP_ALLOCATION,
                30,
                12,
                1,
                101
            )
        ).to.be.revertedWithCustomError(distributionEngine, "InitialReleaseTooLarge");

        // Vesting plan >= vesting term
        await expect(
            distributionEngine.connect(owner).addVestingCap(
                capId,
                capName,
                CAP_ALLOCATION,
                30,
                12,
                12,
                10
            )
        ).to.be.revertedWithCustomError(distributionEngine, "OutOfRangeVestingPlan");
    });

    it("should revert when called by non-admin", async function () {
        await expect(
            distributionEngine.connect(otherAccount).addVestingCap(
                1,
                ethers.encodeBytes32String("Test Cap"),
                CAP_ALLOCATION,
                30,
                12,
                1,
                10
            )
        ).to.be.revertedWithCustomError(
            distributionEngine,
            "AccessControlUnauthorizedAccount"
        );
    });

    it("should revert when contract is paused", async function () {
        // Wait for emergency cooldown
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Pause contract
        await distributionEngine.connect(owner).emergencyAction(1);

        await expect(
            distributionEngine.connect(owner).addVestingCap(
                1,
                ethers.encodeBytes32String("Test Cap"),
                CAP_ALLOCATION,
                30,
                12,
                1,
                10
            )
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });

    it("should track caps in capIds array", async function () {
        const capId1 = 1;
        const capId2 = 2;

        await distributionEngine.connect(owner).addVestingCap(
            capId1,
            ethers.encodeBytes32String("Test Cap 1"),
            CAP_ALLOCATION / BigInt(2),
            30,
            12,
            1,
            10
        );

        await distributionEngine.connect(owner).addVestingCap(
            capId2,
            ethers.encodeBytes32String("Test Cap 2"),
            CAP_ALLOCATION / BigInt(2),
            30,
            12,
            1,
            10
        );

        const capIds = [];
        let i = 0;
        while (true) {
            try {
                capIds.push(await distributionEngine.capIds(i));
                i++;
            } catch {
                break;
            }
        }

        expect(capIds).to.deep.equal([capId1, capId2]);
    });
});

describe("removeVestingCap", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens

    beforeEach(async function () {
        [owner, admin, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorum
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION
        );

        // Add a vesting cap
        const capId = 1;
        await distributionEngine.connect(owner).addVestingCap(
            capId,
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        );
    });

    it("should correctly remove a vesting cap", async function () {
        const capId = 1;
        const cap = await distributionEngine.vestingCaps(capId);
        const capName = cap.name;

        await expect(distributionEngine.connect(owner).removeVestingCap(capId))
            .to.emit(distributionEngine, "VestingCapAction")
            .withArgs(capId, capName, 2); // 2 for REMOVE action

        const removedCap = await distributionEngine.vestingCaps(capId);
        expect(removedCap.totalAllocation).to.equal(0);

        // Check capIds array
        const capIds = [];
        let i = 0;
        while (true) {
            try {
                capIds.push(await distributionEngine.capIds(i));
                i++;
            } catch {
                break;
            }
        }
        expect(capIds).to.not.include(capId);
    });

    it("should revert when cap has wallets", async function () {
        const capId = 1;
        
        // Add wallet to cap through proposal
        const addWalletType = 7; // AddDistributionWallets type
        const walletName = ethers.encodeBytes32String("Test Wallet");
        const walletAllocation = ethers.parseEther("100000");
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        const tx = await distributionEngine.connect(owner).createProposal(
            addWalletType,
            capId,
            otherAccount.address,
            walletName,
            walletAllocation,
            ZeroAddress
        );

        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve proposal
        await distributionEngine.connect(admin).approveProposal(proposalId);

        await expect(
            distributionEngine.connect(owner).removeVestingCap(capId)
        ).to.be.revertedWithCustomError(distributionEngine, "CapHasWallets");
    });

    it("should revert with invalid cap id", async function () {
        const invalidCapId = 999;
        await expect(
            distributionEngine.connect(owner).removeVestingCap(invalidCapId)
        ).to.be.revertedWithCustomError(distributionEngine, "InvalidCapId")
        .withArgs(invalidCapId);
    });

    it("should revert when called by non-admin", async function () {
        await expect(
            distributionEngine.connect(otherAccount).removeVestingCap(1)
        ).to.be.revertedWithCustomError(
            distributionEngine,
            "AccessControlUnauthorizedAccount"
        );
    });

    it("should revert when contract is paused", async function () {
        // Wait for emergency cooldown
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Pause contract
        await distributionEngine.connect(owner).emergencyAction(1);

        await expect(
            distributionEngine.connect(owner).removeVestingCap(1)
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });
});

describe("calculateDueTokens", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let beneficiary: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens
    const WALLET_ALLOCATION = ethers.parseEther("100000"); // 100k tokens

    beforeEach(async function () {
        [owner, admin, beneficiary, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION
        );

        // Add a vesting cap
        const capId = 1;
        await distributionEngine.connect(owner).addVestingCap(
            capId,
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        );

        // Add wallet to cap through proposal
        const addWalletType = 7; // AddDistributionWallets type
        const walletName = ethers.encodeBytes32String("Test Wallet");
        
        const addWalletTx = await distributionEngine.connect(owner).createProposal(
            addWalletType,
            capId,
            beneficiary.address,
            walletName,
            WALLET_ALLOCATION,
            ZeroAddress
        );

        const addWalletReceipt = await addWalletTx.wait();
        const addWalletEvent = addWalletReceipt?.logs[0];
        const addWalletProposalId = addWalletEvent?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve proposal
        await distributionEngine.connect(admin).approveProposal(addWalletProposalId);

        // Initiate TGE
        await distributionEngine.connect(owner).initiateTGE();
    });

    it("should return 0 before cliff period", async function () {
        await expect(
            distributionEngine.calculateDueTokens(beneficiary.address, 1)
        ).to.be.revertedWithCustomError(distributionEngine, "CliffNotReached");
    });

    it("should calculate initial release after cliff", async function () {
        // Move past cliff period
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days
        await ethers.provider.send("evm_mine");

        const dueTokens = await distributionEngine.calculateDueTokens(beneficiary.address, 1);
        const expectedInitialRelease = WALLET_ALLOCATION * BigInt(10) / BigInt(100); // 10% initial release
        expect(dueTokens).to.equal(expectedInitialRelease);
    });

    it("should calculate linear vesting after cliff", async function () {
        // Move past cliff and 6 months into vesting
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days cliff
        await ethers.provider.send("evm_increaseTime", [6 * 30 * 24 * 60 * 60]); // 6 months
        await ethers.provider.send("evm_mine");

        const dueTokens = await distributionEngine.calculateDueTokens(beneficiary.address, 1);
        
        // Calculate expected tokens:
        // Initial 10% + (90% * 6/12 months)
        const initialRelease = WALLET_ALLOCATION * BigInt(10) / BigInt(100);
        const remainingAllocation = WALLET_ALLOCATION - initialRelease;
        const vestedPortion = remainingAllocation * BigInt(6) / BigInt(12);
        const expectedTokens = initialRelease + vestedPortion;

        // Allow for small rounding differences
        const difference = dueTokens > expectedTokens ? 
            dueTokens - expectedTokens : 
            expectedTokens - dueTokens;
        expect(difference).to.be.lessThan(1000000); // Less than 0.000001 token difference
    });

    it("should return full amount after vesting period", async function () {
        // Move past full vesting period
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days cliff
        await ethers.provider.send("evm_increaseTime", [12 * 30 * 24 * 60 * 60]); // 12 months
        await ethers.provider.send("evm_mine");

        const dueTokens = await distributionEngine.calculateDueTokens(beneficiary.address, 1);
        expect(dueTokens).to.equal(WALLET_ALLOCATION);
    });

    it("should revert for non-existent cap", async function () {
        await expect(
            distributionEngine.calculateDueTokens(beneficiary.address, 999)
        ).to.be.revertedWithCustomError(distributionEngine, "InvalidAllocationParameters");
    });

    it("should revert for non-existent wallet", async function () {
        await expect(
            distributionEngine.calculateDueTokens(otherAccount.address, 1)
        ).to.be.revertedWithCustomError(distributionEngine, "NothingToClaim");
    });

    it("should handle multiple vesting intervals correctly", async function () {
        // Move past cliff and 3 vesting intervals
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days cliff
        await ethers.provider.send("evm_increaseTime", [3 * 30 * 24 * 60 * 60]); // 3 months
        await ethers.provider.send("evm_mine");

        const dueTokens = await distributionEngine.calculateDueTokens(beneficiary.address, 1);
        
        // Calculate expected tokens:
        // Initial 10% + (90% * 3/12 months)
        const initialRelease = WALLET_ALLOCATION * BigInt(10) / BigInt(100);
        const remainingAllocation = WALLET_ALLOCATION - initialRelease;
        const vestedPortion = remainingAllocation * BigInt(3) / BigInt(12);
        const expectedTokens = initialRelease + vestedPortion;

        const difference = dueTokens > expectedTokens ? 
            dueTokens - expectedTokens : 
            expectedTokens - dueTokens;
        expect(difference).to.be.lessThan(1000000);
    });
});

describe("claimTokens", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let beneficiary: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens
    const WALLET_ALLOCATION = ethers.parseEther("100000"); // 100k tokens
    const CHAIN_ID = 1;

    beforeEach(async function () {
        [owner, admin, beneficiary, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION
        );

        // Add a vesting cap
        const capId = 1;
        await distributionEngine.connect(owner).addVestingCap(
            capId,
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        );

        // Add wallet to cap through proposal
        const addWalletType = 7; // AddDistributionWallets type
        const walletName = ethers.encodeBytes32String("Test Wallet");
        
        const addWalletTx = await distributionEngine.connect(owner).createProposal(
            addWalletType,
            capId,
            beneficiary.address,
            walletName,
            WALLET_ALLOCATION,
            ZeroAddress
        );

        const addWalletReceipt = await addWalletTx.wait();
        const addWalletEvent = addWalletReceipt?.logs[0];
        const addWalletProposalId = addWalletEvent?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve proposal
        await distributionEngine.connect(admin).approveProposal(addWalletProposalId);

        // Initiate TGE
        await distributionEngine.connect(owner).initiateTGE();
    });

    it("should correctly claim tokens after cliff", async function () {
        // Move past cliff period
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days
        await ethers.provider.send("evm_mine");

        const expectedClaim = WALLET_ALLOCATION * BigInt(10) / BigInt(100); // 10% initial release
        const initialBalance = await storageToken.balanceOf(beneficiary.address);

        await expect(distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID))
            .to.emit(distributionEngine, "TokensClaimed")
            .withArgs(beneficiary.address, expectedClaim)
            .to.emit(distributionEngine, "ClaimProcessed")
            .withArgs(beneficiary.address, 1, expectedClaim, await time.latest() +1, CHAIN_ID);

        const finalBalance = await storageToken.balanceOf(beneficiary.address);
        expect(finalBalance - initialBalance).to.equal(expectedClaim);

        // Check claimed amount is recorded
        const walletInfo = await distributionEngine.vestingWallets(beneficiary.address, 1);
        expect(walletInfo.claimed).to.equal(expectedClaim);
    });

    it("should revert when TGE not initiated", async function () {
        // Deploy new instance without TGE
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        const newDistributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;

        await expect(
            newDistributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID)
        ).to.be.revertedWithCustomError(newDistributionEngine, "TGENotInitiated");
    });

    it("should revert when nothing is due", async function () {
        await expect(
            distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID)
        ).to.be.revertedWithCustomError(distributionEngine, "CliffNotReached");
    });

    it("should revert when contract is paused", async function () {
        // Move past cliff period
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days
        await ethers.provider.send("evm_mine");

        // Pause contract
        await distributionEngine.connect(owner).emergencyAction(1);

        await expect(
            distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID)
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });

    it("should handle multiple claims correctly", async function () {
        // Move past cliff and 3 months
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days cliff
        await ethers.provider.send("evm_increaseTime", [3 * 30 * 24 * 60 * 60]); // 3 months
        await ethers.provider.send("evm_mine");

        // First claim
        await distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID);
        const firstClaimAmount = await storageToken.balanceOf(beneficiary.address);

        // Move forward 3 more months
        await ethers.provider.send("evm_increaseTime", [3 * 30 * 24 * 60 * 60]); // 3 more months
        await ethers.provider.send("evm_mine");

        // Second claim
        await distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID);
        const totalClaimedAmount = await storageToken.balanceOf(beneficiary.address);

        expect(totalClaimedAmount).to.be.gt(firstClaimAmount);
        
        const walletInfo = await distributionEngine.vestingWallets(beneficiary.address, 1);
        expect(walletInfo.claimed).to.equal(totalClaimedAmount);
    });

    it("should revert if contract has insufficient balance", async function () {
        // Move past cliff
        await ethers.provider.send("evm_increaseTime", [31 * 24 * 60 * 60]); // 31 days
        await ethers.provider.send("evm_mine");

        // Create proposal to recover tokens from distribution engine (simulating balance drain)
        const recoveryType = 4; // Recovery type
        const tx = await distributionEngine.connect(owner).createProposal(
            recoveryType,
            0,
            owner.address,
            ethers.ZeroHash,
            CAP_ALLOCATION,
            await storageToken.getAddress()
        );

        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay and approve
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await distributionEngine.connect(admin).approveProposal(proposalId);

        await expect(
            distributionEngine.connect(beneficiary).claimTokens(1, CHAIN_ID)
        ).to.be.revertedWithCustomError(distributionEngine, "LowContractBalance");
    });
});


describe("Custom Proposals", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let beneficiary: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens
    const WALLET_ALLOCATION = ethers.parseEther("100000"); // 100k tokens

    beforeEach(async function () {
        [owner, admin, beneficiary, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION
        );

        // Add a vesting cap
        const capId = 1;
        await distributionEngine.connect(owner).addVestingCap(
            capId,
            ethers.encodeBytes32String("Test Cap"),
            CAP_ALLOCATION,
            30, // 30 days cliff
            12, // 12 months vesting
            1,  // monthly vesting plan
            10  // 10% initial release
        );
    });

    describe("Add Distribution Wallet Proposal", function () {
        it("should create and execute add wallet proposal", async function () {
            const capId = 1;
            const walletName = ethers.encodeBytes32String("Test Wallet");
            
            // Create proposal
            const tx = await distributionEngine.connect(owner).createProposal(
                7, // AddDistributionWallets type
                capId,
                beneficiary.address,
                walletName,
                WALLET_ALLOCATION,
                ZeroAddress
            );

            const receipt = await tx.wait();
            const event = receipt?.logs[0];
            const proposalId = event?.topics[1];

            // Wait for execution delay
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine");

            // Approve and execute
            await expect(distributionEngine.connect(admin).approveProposal(proposalId))
                .to.emit(distributionEngine, "DistributionWalletAdded")
                .withArgs(
                    beneficiary.address,
                    WALLET_ALLOCATION,
                    (await distributionEngine.vestingCaps(capId)).startDate,
                    (await distributionEngine.vestingCaps(capId)).cliff,
                    (await distributionEngine.vestingCaps(capId)).vestingTerm
                );

            // Verify wallet was added
            const walletInfo = await distributionEngine.vestingWallets(beneficiary.address, capId);
            expect(walletInfo.amount).to.equal(WALLET_ALLOCATION);
            expect(walletInfo.name).to.equal(walletName);
        });

        it("should handle proposal expiry correctly", async function () {
            const capId = 1;
            
            // Create proposal
            const tx = await distributionEngine.connect(owner).createProposal(
                7, // AddDistributionWallets type
                capId,
                beneficiary.address,
                ethers.encodeBytes32String("Test Wallet"),
                WALLET_ALLOCATION,
                ZeroAddress
            );

            const receipt = await tx.wait();
            const event = receipt?.logs[0];
            const proposalId = event?.topics[1];

            // Wait for proposal to expire (48 hours)
            await ethers.provider.send("evm_increaseTime", [48 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine");

            // Try to approve expired proposal
            await expect(
                distributionEngine.connect(admin).approveProposal(proposalId)
            ).to.be.revertedWithCustomError(distributionEngine, "ProposalErr");

            // Verify no wallet was added
            const walletInfo = await distributionEngine.vestingWallets(beneficiary.address, capId);
            expect(walletInfo.amount).to.equal(0);
        });
    });

    describe("Remove Distribution Wallet Proposal", function () {
        beforeEach(async function () {
            // Add wallet first
            const addTx = await distributionEngine.connect(owner).createProposal(
                7, // AddDistributionWallets type
                1,
                beneficiary.address,
                ethers.encodeBytes32String("Test Wallet"),
                WALLET_ALLOCATION,
                ZeroAddress
            );

            const receipt = await addTx.wait();
            const event = receipt?.logs[0];
            const proposalId = event?.topics[1];

            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await distributionEngine.connect(admin).approveProposal(proposalId);
        });

        it("should create and execute remove wallet proposal", async function () {
            const capId = 1;
            
            // Create removal proposal
            const tx = await distributionEngine.connect(owner).createProposal(
                8, // RemoveDistributionWallet type
                capId,
                beneficiary.address,
                ethers.ZeroHash,
                0,
                ZeroAddress
            );

            const receipt = await tx.wait();
            const event = receipt?.logs[0];
            const proposalId = event?.topics[1];

            // Wait for execution delay
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine");

            // Approve and execute
            await expect(distributionEngine.connect(admin).approveProposal(proposalId))
                .to.emit(distributionEngine, "DistributionWalletRemoved")
                .withArgs(beneficiary.address, capId);

            // Verify wallet was removed
            const walletInfo = await distributionEngine.vestingWallets(beneficiary.address, capId);
            expect(walletInfo.amount).to.equal(0);
        });

        it("should revert when removing non-existent wallet", async function () {
            await expect(
                distributionEngine.connect(owner).createProposal(
                    8, // RemoveDistributionWallet type
                    1,
                    otherAccount.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress
                )
            ).to.be.revertedWithCustomError(distributionEngine, "WalletNotInCap");
        });
    });

    it("should revert with invalid proposal type", async function () {
        await expect(
            distributionEngine.connect(owner).createProposal(
                99, // Invalid type
                1,
                beneficiary.address,
                ethers.ZeroHash,
                WALLET_ALLOCATION,
                ZeroAddress
            )
        ).to.be.revertedWithCustomError(distributionEngine, "InvalidProposalType");
    });
});


  describe("Complete Token Lifecycle", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let receiver: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const MINT_AMOUNT = ethers.parseEther("100000"); // 100k tokens
    const TRANSFER_AMOUNT = ethers.parseEther("50000"); // 50k tokens
    const SOURCE_CHAIN_ID = 1;
    const NONCE = 1;
  
    beforeEach(async function () {
      [owner, admin, receiver, bridgeOperator] = await ethers.getSigners();
      
      // Deploy and initialize contract
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
    });
  
    it("should execute complete token lifecycle process", async function () {
      // Initial state verification
      expect(await storageToken.balanceOf(await storageToken.getAddress())).to.equal(INITIAL_SUPPLY);
      expect(await storageToken.totalSupply()).to.equal(INITIAL_SUPPLY);
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set up roles and limits
      const adminRole = ADMIN_ROLE;
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
  
      // Set quorum and transaction limits
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
      await storageToken.connect(owner).setRoleQuorum(bridgeOperatorRole, 2);
      await storageToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT);
      await storageToken.connect(owner).setRoleTransactionLimit(bridgeOperatorRole, MINT_AMOUNT);
  
      // Set up bridge operator
      const addRoleType = 1; // AddRole type
      const bridgeRoleTx = await storageToken.connect(owner).createProposal(
        addRoleType,
        0,
        bridgeOperator.address,
        bridgeOperatorRole,
        0,
        ZeroAddress
      );
      
      const bridgeRoleReceipt = await bridgeRoleTx.wait();
      const bridgeRoleProposalId = bridgeRoleReceipt?.logs[0].topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute bridge operator role
      await storageToken.connect(admin).approveProposal(bridgeRoleProposalId);
  
      // Set up supported chain
      await storageToken.connect(owner).setBridgeOpNonce(SOURCE_CHAIN_ID, NONCE);
  
      // Mint additional tokens through bridge
      await expect(storageToken.connect(bridgeOperator).bridgeOp(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE, 1))
        .to.emit(storageToken, "BridgeOperationDetails")
        .withArgs(bridgeOperator.address, 1, MINT_AMOUNT, SOURCE_CHAIN_ID, await time.latest() +1);
  
      // Create whitelist proposal for receiver
      const addWhitelistType = 5; // AddWhitelist type
      const whitelistTx = await storageToken.connect(owner).createProposal(
        addWhitelistType,
        0,
        receiver.address,
        ethers.ZeroHash,
        0,
        ZeroAddress
      );
  
      const whitelistReceipt = await whitelistTx.wait();
      const whitelistProposalId = whitelistReceipt?.logs[0].topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute whitelist proposal
      await expect(storageToken.connect(admin).approveProposal(whitelistProposalId))
        .to.emit(storageToken, "WalletWhitelistedOp");
  
      // Wait for whitelist lock duration
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Transfer tokens to whitelisted address
      const contractAddress = await storageToken.getAddress();
      await expect(storageToken.connect(owner).transferFromContract(receiver.address, TRANSFER_AMOUNT))
        .to.emit(storageToken, "TransferFromContract")
        .withArgs(contractAddress, receiver.address, TRANSFER_AMOUNT, owner.address)
        .to.emit(storageToken, "Transfer")
        .withArgs(contractAddress, receiver.address, TRANSFER_AMOUNT);
  
      // Final state verification
      expect(await storageToken.balanceOf(receiver.address)).to.equal(TRANSFER_AMOUNT);
      expect(await storageToken.balanceOf(contractAddress)).to.equal(INITIAL_SUPPLY + MINT_AMOUNT - TRANSFER_AMOUNT);
      expect(await storageToken.totalSupply()).to.equal(INITIAL_SUPPLY + MINT_AMOUNT);
    });
  });

  describe("transferBackToStorage", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const TRANSFER_AMOUNT = ethers.parseEther("100000"); // 100k tokens

    beforeEach(async function () {
        [owner, admin, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TRANSFER_AMOUNT);

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            TRANSFER_AMOUNT
        );
    });

    it("should correctly transfer tokens back to storage token", async function () {
        const storageTokenAddress = await storageToken.getAddress();
        const initialStorageBalance = await storageToken.balanceOf(storageTokenAddress);
        const initialDistributionBalance = await storageToken.balanceOf(await distributionEngine.getAddress());

        await expect(distributionEngine.connect(owner).transferBackToStorage(TRANSFER_AMOUNT))
            .to.emit(distributionEngine, "TokensReturnedToStorage")
            .withArgs(TRANSFER_AMOUNT);

        expect(await storageToken.balanceOf(storageTokenAddress))
            .to.equal(initialStorageBalance + TRANSFER_AMOUNT);
        expect(await storageToken.balanceOf(await distributionEngine.getAddress()))
            .to.equal(initialDistributionBalance - TRANSFER_AMOUNT);
    });

    it("should revert with zero amount", async function () {
        await expect(
            distributionEngine.connect(owner).transferBackToStorage(0)
        ).to.be.revertedWithCustomError(distributionEngine, "AmountMustBePositive");
    });

    it("should revert with insufficient balance", async function () {
        const excessAmount = TRANSFER_AMOUNT + BigInt(1);
        await expect(
            distributionEngine.connect(owner).transferBackToStorage(excessAmount)
        ).to.be.revertedWithCustomError(distributionEngine, "LowContractBalance");
    });

    it("should revert when called by non-admin", async function () {
        await expect(
            distributionEngine.connect(otherAccount).transferBackToStorage(TRANSFER_AMOUNT)
        ).to.be.revertedWithCustomError(
            distributionEngine,
            "AccessControlUnauthorizedAccount"
        );
    });

    it("should revert when contract is paused", async function () {
        await distributionEngine.connect(owner).emergencyAction(1);

        await expect(
            distributionEngine.connect(owner).transferBackToStorage(TRANSFER_AMOUNT)
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });
});

  
  describe("Upgrade Process", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let beneficiary: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens
    const WALLET_ALLOCATION = ethers.parseEther("100000"); // 100k tokens

    beforeEach(async function () {
        [owner, admin, beneficiary, otherAccount] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    });

    it("should properly handle contract upgrades", async function () {
        // Get the implementation address for upgrade
        const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine");
        const implementationAddress = await upgrades.prepareUpgrade(
            await distributionEngine.getAddress(),
            TokenDistributionEngineV2,
            { kind: 'uups' }
        );

        // Create upgrade proposal
        const upgradeType = 3; // Upgrade type
        const tx = await distributionEngine.connect(owner).createProposal(
            upgradeType,
            0,
            implementationAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );

        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve upgrade proposal
        await distributionEngine.connect(admin).approveProposal(proposalId);

        // Perform the upgrade
        const upgradedDistribution = await upgrades.upgradeProxy(
            await distributionEngine.getAddress(),
            TokenDistributionEngineV2,
            { kind: 'uups' }
        );

        // Verify state is maintained
        expect(await upgradedDistribution.storageToken()).to.equal(await storageToken.getAddress());
        expect(await upgradedDistribution.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("should revert upgrade when paused", async function () {
        // Get implementation address
        const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine");
        const implementationAddress = await upgrades.prepareUpgrade(
            await distributionEngine.getAddress(),
            TokenDistributionEngineV2,
            { kind: 'uups' }
        );

        // Create upgrade proposal
        const upgradeType = 3; // Upgrade type
        const tx = await distributionEngine.connect(owner).createProposal(
            upgradeType,
            0,
            implementationAddress,
            ethers.ZeroHash,
            0,
            ZeroAddress
        );

        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve upgrade proposal
        await distributionEngine.connect(admin).approveProposal(proposalId);

        // Pause contract
        await distributionEngine.connect(owner).emergencyAction(1);

        // Try to upgrade when paused
        await expect(
            upgrades.upgradeProxy(
                await distributionEngine.getAddress(),
                TokenDistributionEngineV2,
                { kind: 'uups' }
            )
        ).to.be.revertedWithCustomError(distributionEngine, "EnforcedPause");
    });

    it("should revert upgrade without proper proposal approval", async function () {
        const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine");
        await expect(
            upgrades.upgradeProxy(
                await distributionEngine.getAddress(),
                TokenDistributionEngineV2,
                { kind: 'uups' }
            )
        ).to.be.reverted;
    });

    it("should revert upgrade when called by non-admin", async function () {
        const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine", otherAccount);
        
        await expect(
            upgrades.upgradeProxy(
                await distributionEngine.getAddress(),
                TokenDistributionEngineV2,
                { kind: 'uups' }
            )
        ).to.be.revertedWithCustomError(distributionEngine, "AccessControlUnauthorizedAccount");
    });
});


describe("Complex Vesting Scenarios", function () {
    let distributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let wallets: SignerWithAddress[];
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const CAP_ALLOCATION = ethers.parseEther("1000000"); // 1 million tokens per cap
    const WALLET_ALLOCATION = ethers.parseEther("100000"); // 100k tokens per wallet
    const CHAIN_ID = 1;

    // Vesting parameters
    const vestingCaps = [
        {
            id: 1,
            name: "Long Term Vesting",
            initialRelease: 5,
            cliff: 8,        // 8 months
            vestingTerm: 18, // 18 months
            vestingPlan: 1   // monthly
        },
        {
            id: 2,
            name: "Medium Term Vesting",
            initialRelease: 10,
            cliff: 6,        // 6 months
            vestingTerm: 15, // 15 months
            vestingPlan: 1   // monthly
        },
        {
            id: 3,
            name: "Short Term Vesting",
            initialRelease: 20,
            cliff: 0,        // no cliff
            vestingTerm: 6,  // 6 months
            vestingPlan: 1   // monthly
        }
    ];

    beforeEach(async function () {
        [owner, admin, ...wallets] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = await upgrades.deployProxy(
            StorageToken,
            [owner.address, admin.address, INITIAL_SUPPLY],
            { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        distributionEngine = await upgrades.deployProxy(
            TokenDistributionEngine,
            [await storageToken.getAddress(), owner.address, admin.address],
            { kind: 'uups', initializer: 'initialize' }
        ) as TokenDistributionEngine;
        await distributionEngine.waitForDeployment();

        // Wait for timelock to expire and set quorums
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await distributionEngine.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, CAP_ALLOCATION * BigInt(3));

        // Create whitelist proposal for distribution engine
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
            addWhitelistType,
            0,
            await distributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs[0];
        const proposalId = event?.topics[1];

        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Approve whitelist proposal
        await storageToken.connect(admin).approveProposal(proposalId);

        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");

        // Transfer tokens to distribution engine
        await storageToken.connect(owner).transferFromContract(
            await distributionEngine.getAddress(),
            CAP_ALLOCATION * BigInt(3)
        );

        // Create vesting caps
        for (const cap of vestingCaps) {
            await distributionEngine.connect(owner).addVestingCap(
                cap.id,
                ethers.encodeBytes32String(cap.name),
                CAP_ALLOCATION,
                cap.cliff * 30, // convert months to days
                cap.vestingTerm,
                cap.vestingPlan,
                cap.initialRelease
            );
        }

        // Add wallets to caps (2 wallets per cap)
        for (let i = 0; i < vestingCaps.length; i++) {
            const cap = vestingCaps[i];
            for (let j = 0; j < 2; j++) {
                const walletIndex = i * 2 + j;
                const wallet = wallets[walletIndex];
                const walletName = ethers.encodeBytes32String(`Wallet ${walletIndex + 1}`);

                const addWalletTx = await distributionEngine.connect(owner).createProposal(
                    7, // AddDistributionWallets type
                    cap.id,
                    wallet.address,
                    walletName,
                    WALLET_ALLOCATION,
                    ZeroAddress
                );

                const addWalletReceipt = await addWalletTx.wait();
                const addWalletEvent = addWalletReceipt?.logs[0];
                const addWalletProposalId = addWalletEvent?.topics[1];

                // Wait for execution delay
                await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
                await ethers.provider.send("evm_mine");

                // Approve proposal
                await distributionEngine.connect(admin).approveProposal(addWalletProposalId);
            }
        }
    });

    it("should handle complex vesting scenarios correctly", async function () {
        // Try claiming before TGE
        for (let i = 0; i < 6; i++) {
            await expect(
                distributionEngine.connect(wallets[i]).claimTokens(Math.floor(i/2) + 1, CHAIN_ID)
            ).to.be.revertedWithCustomError(distributionEngine, "TGENotInitiated");
        }

        // Initiate TGE
        await distributionEngine.connect(owner).initiateTGE();
        const tgeTime = await time.latest();

        // Track claims for each wallet
        const claims = Array(6).fill(0n);
        
        // Simulate 26 months (longest vesting period + 1 month buffer)
        for (let month = 0; month <= 26; month++) {
            console.log(`\nMonth ${month}:`);

            // Try claims for all wallets
            for (let walletIndex = 0; walletIndex < 6; walletIndex++) {
                const capIndex = Math.floor(walletIndex / 2);
                const cap = vestingCaps[capIndex];
                const wallet = wallets[walletIndex];
                const capId = cap.id;

                try {
                    const beforeBalance = await storageToken.balanceOf(wallet.address);
                    await distributionEngine.connect(wallet).claimTokens(capId, CHAIN_ID);
                    const afterBalance = await storageToken.balanceOf(wallet.address);
                    const claimed = afterBalance - beforeBalance;
                    claims[walletIndex] += claimed;

                    if (claimed > 0n) {
                        console.log(`Wallet ${walletIndex + 1} claimed: ${ethers.formatEther(claimed)} tokens`);
                    }

                    // Verify against calculateDueTokens
                    const dueTokens = await distributionEngine.calculateDueTokens(wallet.address, capId);
                    expect(dueTokens).to.equal(0); // All due tokens should be claimed

                } catch (error: any) {
                    if (error.message.includes("NothingDue")) {
                        // Expected when nothing is available to claim
                        continue;
                    }
                    if (error.message.includes("CliffNotReached")) {
                        console.log(`Wallet ${walletIndex + 1} cliff not reached`);
                        continue;
                    }
                    throw error;
                }
            }

            // Move forward one month
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");
        }

        // Verify final claimed amounts
        for (let walletIndex = 0; walletIndex < 6; walletIndex++) {
            const capIndex = Math.floor(walletIndex / 2);
            const cap = vestingCaps[capIndex];
            
            console.log(`\nWallet ${walletIndex + 1} (Cap ${cap.id}):`);
            console.log(`Total claimed: ${ethers.formatEther(claims[walletIndex])} tokens`);
            
            // Verify total claimed equals allocation
            expect(claims[walletIndex]).to.equal(WALLET_ALLOCATION);

            // Verify no more tokens can be claimed
            await expect(
                distributionEngine.connect(wallets[walletIndex]).claimTokens(cap.id, CHAIN_ID)
            ).to.be.revertedWithCustomError(distributionEngine, "NothingDue");
        }
    });
});
