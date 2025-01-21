import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StorageToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));
const BRIDGE_OPERATOR_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));

describe("StorageToken", function () {
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
      // Check token details
      expect(await storageToken.name()).to.equal("Placeholder Token");
      expect(await storageToken.symbol()).to.equal("PLACEHOLDER");
      
      // Check initial supply
      expect(await storageToken.balanceOf(await storageToken.getAddress())).to.equal(INITIAL_SUPPLY);
      expect(await storageToken.totalSupply()).to.equal(INITIAL_SUPPLY);

      // Check roles
      const adminRole = ADMIN_ROLE;
      expect(await storageToken.hasRole(adminRole, owner.address)).to.be.true;
      expect(await storageToken.hasRole(adminRole, admin.address)).to.be.true;
    });

    it("should revert with zero addresses", async function () {
      const StorageToken = await ethers.getContractFactory("StorageToken");
      
      await expect(
        upgrades.deployProxy(
          StorageToken,
          [ZeroAddress, admin.address, INITIAL_SUPPLY],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(StorageToken, "InvalidAddress");

      await expect(
        upgrades.deployProxy(
          StorageToken,
          [owner.address, ZeroAddress, INITIAL_SUPPLY],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(StorageToken, "InvalidAddress");
    });

    it("should revert with supply exceeding total supply", async function () {
      const StorageToken = await ethers.getContractFactory("StorageToken");
      const exceedingSupply = TOTAL_SUPPLY + BigInt(1);
      
      await expect(
        upgrades.deployProxy(
          StorageToken,
          [owner.address, admin.address, exceedingSupply],
          { kind: 'uups', initializer: 'initialize' }
        )
      ).to.be.revertedWithCustomError(StorageToken, "ExceedsSupply")
      .withArgs(exceedingSupply, TOTAL_SUPPLY);
    });

    it("should emit correct events", async function () {
      const StorageToken = await ethers.getContractFactory("StorageToken");
      const newStorageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      );

      await expect(newStorageToken.deploymentTransaction())
        .to.emit(newStorageToken, "TokensAllocatedToContract")
        .withArgs(INITIAL_SUPPLY)
        .to.emit(newStorageToken, "TokensMinted")
        .withArgs(await newStorageToken.getAddress(), INITIAL_SUPPLY);
    });
  });
});

describe("Token Constants", function () {
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
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
    });
  
    describe("maxSupply", function () {
      it("should return correct total supply", async function () {
        const max = await storageToken.maxSupply();
        expect(max).to.equal(TOTAL_SUPPLY);
      });
  
      it("should be callable by any address", async function () {
        const max = await storageToken.connect(otherAccount).maxSupply();
        expect(max).to.equal(TOTAL_SUPPLY);
      });
    });
});

describe("transferFromContract", function () {
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let otherAccount: SignerWithAddress;
  let notWhitelisted: SignerWithAddress;
  
  // Constants
  const TOKEN_UNIT = ethers.parseEther("1");
  const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
  const TRANSFER_AMOUNT = ethers.parseEther("1000");

  beforeEach(async function () {
    [owner, admin, otherAccount, notWhitelisted] = await ethers.getSigners();
    
    const StorageToken = await ethers.getContractFactory("StorageToken");
    storageToken = await upgrades.deployProxy(
      StorageToken,
      [owner.address, admin.address, INITIAL_SUPPLY],
      { kind: 'uups', initializer: 'initialize' }
    ) as StorageToken;
    await storageToken.waitForDeployment();

    // Wait for timelock to expire
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine");

    // Set transaction limit for admin role
    const adminRole = ADMIN_ROLE;
    await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    await storageToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT * BigInt(2));

    // Create whitelist proposal for otherAccount
    const addWhitelistType = 5; // AddWhitelist type
    const tx = await storageToken.connect(owner).createProposal(
      addWhitelistType,
      0,
      otherAccount.address,
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

    // Wait for whitelist lock duration
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine");
  });

  it("should transfer tokens from contract to whitelisted address", async function () {
    const contractAddress = await storageToken.getAddress();
    
    await expect(storageToken.connect(owner).transferFromContract(otherAccount.address, TRANSFER_AMOUNT))
      .to.emit(storageToken, "TransferFromContract")
      .withArgs(contractAddress, otherAccount.address, TRANSFER_AMOUNT, owner.address)
      .to.emit(storageToken, "Transfer")
      .withArgs(contractAddress, otherAccount.address, TRANSFER_AMOUNT);

    expect(await storageToken.balanceOf(otherAccount.address)).to.equal(TRANSFER_AMOUNT);
  });

  it("should revert when transferring to non-whitelisted address", async function () {
    const nonWhitelistedAddr = await notWhitelisted.getAddress();
    
    await expect(
      storageToken.connect(owner).transferFromContract(nonWhitelistedAddr, TRANSFER_AMOUNT)
    ).to.be.revertedWithCustomError(storageToken, "NotWhitelisted")
    .withArgs(nonWhitelistedAddr);
  });

  it("should revert when amount exceeds transaction limit", async function () {
    const adminRole = ADMIN_ROLE;
    const roleConfig = await storageToken.roleConfigs(adminRole);
    const limit = roleConfig.transactionLimit;
    const exceedingAmount = limit + BigInt(1);
    
    await expect(
      storageToken.connect(owner).transferFromContract(otherAccount.address, exceedingAmount)
    ).to.be.revertedWithCustomError(storageToken, "LowAllowance")
    .withArgs(limit, exceedingAmount);
  });

  it("should revert when amount is zero", async function () {
    await expect(
      storageToken.connect(owner).transferFromContract(otherAccount.address, 0)
    ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");
  });

  it("should revert when contract is paused", async function () {
    await storageToken.connect(owner).emergencyAction(1);
    
    await expect(
      storageToken.connect(owner).transferFromContract(otherAccount.address, TRANSFER_AMOUNT)
    ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
  });
});

describe("transferFromContract", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    let receiver: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const TRANSFER_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
  
    beforeEach(async function () {
      [owner, admin, otherAccount, receiver] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
      await storageToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT);
  
      // Create whitelist proposal for receiver
      const addWhitelistType = 5; // AddWhitelist type
      const tx = await storageToken.connect(owner).createProposal(
        addWhitelistType,
        0,
        receiver.address,
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
  
      // Approve and execute whitelist proposal
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Wait for whitelist lock duration (1 day)
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
    });
  
    it("should correctly transfer tokens from contract to whitelisted address", async function () {
      const contractAddress = await storageToken.getAddress();
      const initialContractBalance = await storageToken.balanceOf(contractAddress);
      const initialReceiverBalance = await storageToken.balanceOf(receiver.address);
  
      await expect(storageToken.connect(owner).transferFromContract(receiver.address, TRANSFER_AMOUNT))
        .to.emit(storageToken, "TransferFromContract")
        .withArgs(contractAddress, receiver.address, TRANSFER_AMOUNT, owner.address)
        .to.emit(storageToken, "Transfer")
        .withArgs(contractAddress, receiver.address, TRANSFER_AMOUNT);
  
      expect(await storageToken.balanceOf(contractAddress)).to.equal(initialContractBalance - TRANSFER_AMOUNT);
      expect(await storageToken.balanceOf(receiver.address)).to.equal(initialReceiverBalance + TRANSFER_AMOUNT);
    });
  
    it("should revert when transferring to non-whitelisted address", async function () {
      await expect(
        storageToken.connect(owner).transferFromContract(otherAccount.address, TRANSFER_AMOUNT)
      ).to.be.revertedWithCustomError(storageToken, "NotWhitelisted")
      .withArgs(otherAccount.address);
    });
  
    it("should revert when transfer amount exceeds contract balance", async function () {
      const contractBalance = await storageToken.balanceOf(await storageToken.getAddress());
      const excessAmount = contractBalance + BigInt(1);
  
      await expect(
        storageToken.connect(owner).transferFromContract(receiver.address, excessAmount)
      ).to.be.revertedWithCustomError(storageToken, "ExceedsSupply")
      .withArgs(excessAmount, contractBalance);
    });
  
    it("should revert when transfer amount exceeds role transaction limit", async function () {
      const adminRole = ADMIN_ROLE;
      const roleConfig = await storageToken.roleConfigs(adminRole);
      const limit = roleConfig.transactionLimit;

      const excessAmount = limit + BigInt(1);
  
      await expect(
        storageToken.connect(owner).transferFromContract(receiver.address, excessAmount)
      ).to.be.revertedWithCustomError(storageToken, "LowAllowance")
      .withArgs(limit, excessAmount);
    });
  
    it("should revert when called by non-admin", async function () {
      const adminRole = ADMIN_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).transferFromContract(receiver.address, TRANSFER_AMOUNT)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, adminRole);
    });
  
    it("should revert when amount is zero", async function () {
      await expect(
        storageToken.connect(owner).transferFromContract(receiver.address, 0)
      ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");
    });
  
    it("should revert when contract is paused", async function () {
      // Wait for emergency cooldown
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause contract
      await storageToken.connect(owner).emergencyAction(1);
  
      await expect(
        storageToken.connect(owner).transferFromContract(receiver.address, TRANSFER_AMOUNT)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  });
  
  describe("transfer", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    let receiver: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const TRANSFER_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
  
    beforeEach(async function () {
      [owner, admin, otherAccount, receiver] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
      await storageToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT);
  
      // Create whitelist proposal for receiver
      const addWhitelistType = 5; // AddWhitelist type
      const tx = await storageToken.connect(owner).createProposal(
        addWhitelistType,
        0,
        otherAccount.address,
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
  
      // Approve and execute whitelist proposal
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Wait for whitelist lock duration (1 day)
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      // Transfer some tokens to otherAccount for testing
      await storageToken.connect(owner).transferFromContract(otherAccount.address, TRANSFER_AMOUNT);
    });
  
    it("should correctly transfer tokens between accounts", async function () {
      const initialSenderBalance = await storageToken.balanceOf(otherAccount.address);
      const initialReceiverBalance = await storageToken.balanceOf(receiver.address);
  
      await expect(storageToken.connect(otherAccount).transfer(receiver.address, TRANSFER_AMOUNT))
        .to.emit(storageToken, "Transfer")
        .withArgs(otherAccount.address, receiver.address, TRANSFER_AMOUNT);
  
      expect(await storageToken.balanceOf(otherAccount.address)).to.equal(initialSenderBalance - TRANSFER_AMOUNT);
      expect(await storageToken.balanceOf(receiver.address)).to.equal(initialReceiverBalance + TRANSFER_AMOUNT);
    });
  
    it("should revert when transferring to zero address", async function () {
      await expect(
        storageToken.connect(otherAccount).transfer(ZeroAddress, TRANSFER_AMOUNT)
      ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");
    });
  
    it("should revert when amount is zero", async function () {
      await expect(
        storageToken.connect(otherAccount).transfer(receiver.address, 0)
      ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");
    });
  
    it("should revert when sender has insufficient balance", async function () {
      const balance = await storageToken.balanceOf(otherAccount.address);
      const excessAmount = balance + BigInt(1);
  
      await expect(
        storageToken.connect(otherAccount).transfer(receiver.address, excessAmount)
      ).to.be.reverted; // ERC20 insufficient balance error
    });
  
    it("should revert when contract is paused", async function () {
      // Wait for emergency cooldown
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause contract
      await storageToken.connect(owner).emergencyAction(1);
  
      await expect(
        storageToken.connect(otherAccount).transfer(receiver.address, TRANSFER_AMOUNT)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  });
  
  describe("bridgeMint", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const MINT_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
    const SOURCE_CHAIN_ID = 1;
    const NONCE = 1;
  
    beforeEach(async function () {
      [owner, admin, bridgeOperator, otherAccount] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
  
      // Create proposal for bridge operator role
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      const addRoleType = 1; // AddRole type
      const tx = await storageToken.connect(owner).createProposal(
        addRoleType,
        0,
        bridgeOperator.address,
        bridgeOperatorRole,
        0,
        ZeroAddress
      );
  
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute role proposal
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Set transaction limit for bridge operator
      await storageToken.connect(owner).setRoleTransactionLimit(bridgeOperatorRole, MINT_AMOUNT);
  
      // Set supported chain
      await storageToken.connect(owner).setSupportedChain(SOURCE_CHAIN_ID, true);
    });
  
    it("should correctly mint tokens through bridge", async function () {
      const initialSupply = await storageToken.totalSupply();
      const initialContractBalance = await storageToken.balanceOf(await storageToken.getAddress());
  
      await expect(storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE))
        .to.emit(storageToken, "BridgeOperationDetails")
        .withArgs(bridgeOperator.address, "MINT", MINT_AMOUNT, SOURCE_CHAIN_ID, await time.latest())
        .to.emit(storageToken, "BridgeOperationDetails")
        .withArgs(await bridgeOperator.getAddress(), "MINT", MINT_AMOUNT, SOURCE_CHAIN_ID, await time.latest());
  
      expect(await storageToken.totalSupply()).to.equal(initialSupply + MINT_AMOUNT);
      expect(await storageToken.balanceOf(await storageToken.getAddress())).to.equal(initialContractBalance + MINT_AMOUNT);
    });
  
    it("should revert when minting with used nonce", async function () {
      await storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "UsedNonce")
      .withArgs(NONCE);
    });
  
    it("should revert when minting from unsupported chain", async function () {
      const unsupportedChainId = 999;
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, unsupportedChainId, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "Unsupported")
      .withArgs(unsupportedChainId);
    });
  
    it("should revert when amount is zero", async function () {
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(0, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");
    });
  
    it("should revert when amount exceeds total supply limit", async function () {
      const remainingSupply = TOTAL_SUPPLY - await storageToken.totalSupply();
      const excessAmount = remainingSupply + BigInt(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(excessAmount, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "ExceedsMaximumSupply")
      .withArgs(excessAmount, TOTAL_SUPPLY);
    });
  
    it("should revert when amount exceeds transaction limit", async function () {
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      const limit = await storageToken.getRoleTransactionLimit(bridgeOperatorRole);
      const excessAmount = limit + BigInt(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(excessAmount, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "LowAllowance")
      .withArgs(limit, excessAmount);
    });
  
    it("should revert when called by non-bridge operator", async function () {
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, bridgeOperatorRole);
    });
  
    it("should revert when contract is paused", async function () {
      // Wait for emergency cooldown
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause contract
      await storageToken.connect(owner).emergencyAction(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  });
  

  describe("bridgeBurn", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const BURN_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
    const TARGET_CHAIN_ID = 1;
    const NONCE = 1;
  
    beforeEach(async function () {
      [owner, admin, bridgeOperator, otherAccount] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
  
      // Create proposal for bridge operator role
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      const addRoleType = 1; // AddRole type
      const tx = await storageToken.connect(owner).createProposal(
        addRoleType,
        0,
        bridgeOperator.address,
        bridgeOperatorRole,
        0,
        ZeroAddress
      );
  
      const receipt = await tx.wait();
      const event = receipt?.logs[0];
      const proposalId = event?.topics[1];
  
      // Wait for execution delay
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Approve and execute role proposal
      await storageToken.connect(admin).approveProposal(proposalId);
  
      // Set transaction limit for bridge operator
      await storageToken.connect(owner).setRoleTransactionLimit(bridgeOperatorRole, BURN_AMOUNT);
  
      // Set supported chain
      await storageToken.connect(owner).setSupportedChain(TARGET_CHAIN_ID, true);
    });
  
    it("should correctly burn tokens through bridge", async function () {
      const initialSupply = await storageToken.totalSupply();
      const initialContractBalance = await storageToken.balanceOf(await storageToken.getAddress());
  
      await expect(storageToken.connect(bridgeOperator).bridgeBurn(BURN_AMOUNT, TARGET_CHAIN_ID, NONCE))
        .to.emit(storageToken, "BridgeOperationDetails")
        .withArgs(bridgeOperator.address, "BURN", BURN_AMOUNT, TARGET_CHAIN_ID, await time.latest() +1);
  
      expect(await storageToken.totalSupply()).to.equal(initialSupply - BURN_AMOUNT);
      expect(await storageToken.balanceOf(await storageToken.getAddress())).to.equal(initialContractBalance - BURN_AMOUNT);
    });
  
    it("should revert when burning with used nonce", async function () {
      await storageToken.connect(bridgeOperator).bridgeBurn(BURN_AMOUNT, TARGET_CHAIN_ID, NONCE);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(BURN_AMOUNT, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "UsedNonce")
      .withArgs(NONCE);
    });
  
    it("should revert when burning to unsupported chain", async function () {
      const unsupportedChainId = 999;
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(BURN_AMOUNT, unsupportedChainId, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "Unsupported")
      .withArgs(unsupportedChainId);
    });
  
    it("should revert when amount is zero", async function () {
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(0, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");
    });
  
    it("should revert when amount exceeds contract balance", async function () {
      const contractBalance = await storageToken.balanceOf(await storageToken.getAddress());
      const excessAmount = contractBalance + BigInt(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(excessAmount, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "LowBalance")
      .withArgs(contractBalance, excessAmount);
    });
  
    it("should revert when amount exceeds transaction limit", async function () {
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      const limit = await storageToken.getRoleTransactionLimit(bridgeOperatorRole);
      const excessAmount = limit + BigInt(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(excessAmount, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "LowAllowance")
      .withArgs(limit, excessAmount);
    });
  
    it("should revert when called by non-bridge operator", async function () {
      const bridgeOperatorRole = BRIDGE_OPERATOR_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).bridgeBurn(BURN_AMOUNT, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, bridgeOperatorRole);
    });
  
    it("should revert when contract is paused", async function () {
      // Wait for emergency cooldown
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause contract
      await storageToken.connect(owner).emergencyAction(1);
  
      await expect(
        storageToken.connect(bridgeOperator).bridgeBurn(BURN_AMOUNT, TARGET_CHAIN_ID, NONCE)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  });
  
  describe("setSupportedChain", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const TEST_CHAIN_ID = 1;
  
    beforeEach(async function () {
      [owner, admin, otherAccount] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
    });
  
    it("should correctly set supported chain status", async function () {
      await expect(storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, true))
        .to.emit(storageToken, "SupportedChainChanged")
        .withArgs(TEST_CHAIN_ID, true, owner.address);
  
      expect(await storageToken.supportedChains(TEST_CHAIN_ID)).to.be.true;
  
      await expect(storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, false))
        .to.emit(storageToken, "SupportedChainChanged")
        .withArgs(TEST_CHAIN_ID, false, owner.address);
  
      expect(await storageToken.supportedChains(TEST_CHAIN_ID)).to.be.false;
    });
  
    it("should revert when called by non-admin", async function () {
      const adminRole = ADMIN_ROLE;
      
      await expect(
        storageToken.connect(otherAccount).setSupportedChain(TEST_CHAIN_ID, true)
      ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount")
      .withArgs(otherAccount.address, adminRole);
    });
  
    it("should revert when chainId is zero or negative", async function () {
      await expect(
        storageToken.connect(owner).setSupportedChain(0, true)
      ).to.be.revertedWithCustomError(storageToken, "InvalidChain")
      .withArgs(0);
    });
  
    it("should revert when contract is paused", async function () {
      // Wait for emergency cooldown
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Pause contract
      await storageToken.connect(owner).emergencyAction(1);
  
      await expect(
        storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, true)
      ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    });
  
    it("should allow setting multiple chain IDs", async function () {
      const chainIds = [1, 56, 137];
      
      for (const chainId of chainIds) {
        await expect(storageToken.connect(owner).setSupportedChain(chainId, true))
          .to.emit(storageToken, "SupportedChainChanged")
          .withArgs(chainId, true, owner.address);
  
        expect(await storageToken.supportedChains(chainId)).to.be.true;
      }
    });
  
    it("should allow toggling chain support multiple times", async function () {
      // Enable support
      await storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, true);
      expect(await storageToken.supportedChains(TEST_CHAIN_ID)).to.be.true;
  
      // Disable support
      await storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, false);
      expect(await storageToken.supportedChains(TEST_CHAIN_ID)).to.be.false;
  
      // Re-enable support
      await storageToken.connect(owner).setSupportedChain(TEST_CHAIN_ID, true);
      expect(await storageToken.supportedChains(TEST_CHAIN_ID)).to.be.true;
    });
  });

  describe("Custom Proposals", function () {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let receiver1: SignerWithAddress;
    let receiver2: SignerWithAddress;
    let otherAccount: SignerWithAddress;
    
    // Constants
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_SUPPLY = TOTAL_SUPPLY / BigInt(2); // 1 billion tokens
    const TRANSFER_AMOUNT = ethers.parseEther("1000"); // 1000 tokens
  
    beforeEach(async function () {
      [owner, admin, receiver1, receiver2, otherAccount] = await ethers.getSigners();
      
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = await upgrades.deployProxy(
        StorageToken,
        [owner.address, admin.address, INITIAL_SUPPLY],
        { kind: 'uups', initializer: 'initialize' }
      ) as StorageToken;
      await storageToken.waitForDeployment();
  
      // Wait for timelock to expire
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
  
      // Set quorum for admin role
      const adminRole = ADMIN_ROLE;
      await storageToken.connect(owner).setRoleQuorum(adminRole, 2);
      await storageToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT);
    });
  
    describe("Whitelist Management", function () {
      it("should successfully whitelist address and allow transfer", async function () {
        // Create whitelist proposal
        const addWhitelistType = 5; // AddWhitelist type
        const tx = await storageToken.connect(owner).createProposal(
          addWhitelistType,
          0,
          receiver1.address,
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
  
        // Approve and execute whitelist proposal
        await expect(storageToken.connect(admin).approveProposal(proposalId))
          .to.emit(storageToken, "WalletWhitelistedWithLock");
  
        // Wait for whitelist lock duration (1 day)
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // Try transfer to whitelisted address
        await expect(storageToken.connect(owner).transferFromContract(receiver1.address, TRANSFER_AMOUNT))
          .to.emit(storageToken, "TransferFromContract");
      });
  
      it("should successfully remove from whitelist and prevent transfer", async function () {
        // First whitelist the address
        const addWhitelistType = 5; // AddWhitelist type
        let tx = await storageToken.connect(owner).createProposal(
          addWhitelistType,
          0,
          receiver1.address,
          ethers.ZeroHash,
          0,
          ZeroAddress
        );
        let receipt = await tx.wait();
        let proposalId = receipt?.logs[0].topics[1];
  
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await storageToken.connect(admin).approveProposal(proposalId);
  
        // Now remove from whitelist
        const removeWhitelistType = 6; // RemoveWhitelist type
        tx = await storageToken.connect(owner).createProposal(
          removeWhitelistType,
          0,
          receiver1.address,
          ethers.ZeroHash,
          0,
          ZeroAddress
        );
        receipt = await tx.wait();
        proposalId = receipt?.logs[0].topics[1];
  
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        await expect(storageToken.connect(admin).approveProposal(proposalId))
          .to.emit(storageToken, "WalletRemovedFromWhitelist");
  
        // Try transfer to removed address
        await expect(
          storageToken.connect(owner).transferFromContract(receiver1.address, TRANSFER_AMOUNT)
        ).to.be.revertedWithCustomError(storageToken, "NotWhitelisted")
        .withArgs(receiver1.address);
      });
  
      it("should handle multiple whitelist proposals", async function () {
        // Create whitelist proposals for both receivers
        const addWhitelistType = 5; // AddWhitelist type
        const tx1 = await storageToken.connect(owner).createProposal(
          addWhitelistType,
          0,
          receiver1.address,
          ethers.ZeroHash,
          0,
          ZeroAddress
        );
  
        const tx2 = await storageToken.connect(owner).createProposal(
          addWhitelistType,
          0,
          receiver2.address,
          ethers.ZeroHash,
          0,
          ZeroAddress
        );
  
        // Get pending proposals
        const result = await storageToken.getPendingProposals(0, 10);
        console.log({result});
        const proposalIds = result[0];
        const types = result[1];
        const targets = result[2];
  
        expect(proposalIds.length).to.equal(2);
        expect(types.every(type => type === BigInt(addWhitelistType))).to.be.true;
        expect(targets).to.include(receiver1.address);
        expect(targets).to.include(receiver2.address);
      });
    });
  
    describe("Recovery Proposals", function () {
      let mockToken: StorageToken;
  
      beforeEach(async function () {
        // Deploy a mock token to test recovery
        const StorageToken = await ethers.getContractFactory("StorageToken");
        mockToken = await upgrades.deployProxy(
          StorageToken,
          [owner.address, admin.address, TRANSFER_AMOUNT],
          { kind: 'uups', initializer: 'initialize' }
        ) as StorageToken;
        await mockToken.waitForDeployment();
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        // Set transaction limit for admin role
        const adminRole = await mockToken.ADMIN_ROLE();
        await mockToken.connect(owner).setRoleQuorum(adminRole, 2);
        await mockToken.connect(owner).setRoleTransactionLimit(adminRole, TRANSFER_AMOUNT * BigInt(2));
      });
  
      it("should successfully recover tokens", async function () {
        // First whitelist the contract address for mock token transfer
        const addWhitelistType = 5;
        const tx = await mockToken.connect(owner).createProposal(
          addWhitelistType,
          0,
          await storageToken.getAddress(),
          ethers.ZeroHash,
          0,
          ZeroAddress
        );
        const receipt = await tx.wait();
        const whitelistProposalId = receipt?.logs[0].topics[1];
  
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
        await mockToken.connect(admin).approveProposal(whitelistProposalId);
  
        // Wait for whitelist lock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // Transfer mock tokens to the contract
        await mockToken.connect(owner).transferFromContract(await storageToken.getAddress(), TRANSFER_AMOUNT);
  
        // Create recovery proposal
        const recoveryType = 4; // Recovery type
        const recoveryTx = await storageToken.connect(owner).createProposal(
          recoveryType,
          0,
          receiver1.address,
          ethers.ZeroHash,
          TRANSFER_AMOUNT,
          await mockToken.getAddress()
        );
  
        const recoveryReceipt = await recoveryTx.wait();
        const recoveryProposalId = recoveryReceipt?.logs[0].topics[1];
  
        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine");
  
        // Approve and execute recovery
        await storageToken.connect(admin).approveProposal(recoveryProposalId);
  
        // Verify recovery
        expect(await mockToken.balanceOf(receiver1.address)).to.equal(TRANSFER_AMOUNT);
      });
  
      it("should revert recovery of native token", async function () {
        const recoveryType = 4; // Recovery type
        
        await expect(
          storageToken.connect(owner).createProposal(
            recoveryType,
            0,
            receiver1.address,
            ethers.ZeroHash,
            TRANSFER_AMOUNT,
            await storageToken.getAddress()
          )
        ).to.be.revertedWithCustomError(storageToken, "Failed");
      });
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
      await storageToken.connect(owner).setSupportedChain(SOURCE_CHAIN_ID, true);
  
      // Mint additional tokens through bridge
      await expect(storageToken.connect(bridgeOperator).bridgeMint(MINT_AMOUNT, SOURCE_CHAIN_ID, NONCE))
        .to.emit(storageToken, "BridgeOperationDetails")
        .withArgs(bridgeOperator.address, "MINT", MINT_AMOUNT, SOURCE_CHAIN_ID, await time.latest() +1);
  
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
        .to.emit(storageToken, "WalletWhitelistedWithLock");
  
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
  