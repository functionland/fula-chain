import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { StorageToken } from "../typechain-types/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract } from "ethers";

describe("StorageToken", function () {
    let token: StorageToken;
    let owner: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let users: SignerWithAddress[];

    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const CHAIN_ID = 1;

    beforeEach(async function () {
        [owner, bridgeOperator, user1, user2, ...users] = await ethers.getSigners();

        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(StorageToken, [owner.address], {
            initializer: 'initialize'
        });
        console.log(`Owner address: ${owner.address}`);
        await token.waitForDeployment();

        // Mint the maximum supply to the owner
        const maxSupply = await token.connect(await ethers.getSigner(owner.address)).maxSupply();
        await token.connect(await ethers.getSigner(owner.address)).mintToken(maxSupply);
    });

    describe("Initialization", function () {
        it("Should initialize with correct name and symbol", async function () {
            expect(await token.name()).to.equal("Test Token");
            expect(await token.symbol()).to.equal("TT");
        });

        it("Should set correct total supply", async function () {
            expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
        });

        it("Should assign total supply to contract", async function () {
            expect(await token.balanceOf(await token.getAddress())).to.equal(TOTAL_SUPPLY);
        });
    });

    describe("Bridge Operations", function () {
        beforeEach(async function () {
            const hasRole = await token.hasRole(await token.ADMIN_ROLE(), await ethers.getSigner(owner.address));
            expect(hasRole).to.be.true;
            const hasBridgeRole = await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), await ethers.getSigner(owner.address));
            expect(hasBridgeRole).to.be.true;
            await token.setSupportedChain(CHAIN_ID, true);
            await token.addBridgeOperator(bridgeOperator.address);
            // Wait for timelock
            await time.increase(8 * 3600 + 1);
        });
    
        it("Should allow bridge operator to mint tokens on target chain", async function () {
            // First burn some tokens to make room for minting
            const burnAmount = ethers.parseEther("1000");
            await token.bridgeBurn(burnAmount, CHAIN_ID);
            
            // Now mint should succeed
            const mintAmount = ethers.parseEther("500"); // Mint less than what was burned
            await token.bridgeMint(mintAmount, CHAIN_ID);
            expect(await token.balanceOf(await token.getAddress())).to.equal(await token.maxSupply() - burnAmount  + mintAmount);
        });
    });

    describe("Supply Management", function () {
        beforeEach(async function() {
            await token.addBridgeOperator(bridgeOperator.address);
            await time.increase(8 * 3600 + 1); // Wait for timelock
            await token.setSupportedChain(CHAIN_ID, true); // Need to support chain
        });
    
        it("Should allow minting up to remaining supply", async function () {
            expect(await token.balanceOf(await token.getAddress())).to.equal(await token.maxSupply());
            const oneToken = ethers.parseEther("1");
            await expect(
                token.connect(await ethers.getSigner(bridgeOperator.address)).bridgeMint(oneToken, CHAIN_ID)
            ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
        });
    
        it("Should prevent minting beyond total supply", async function () {
            const overSupply = ethers.parseEther("1000001");
            await expect(
                token.connect(await ethers.getSigner(bridgeOperator.address)).bridgeMint(overSupply, CHAIN_ID)
            ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
        });
    });    
    

    describe("Access Control", function () {
        it("Should grant roles to owner", async function () {
            expect(await token.hasRole(await token.ADMIN_ROLE(), owner.address)).to.be.true;
            expect(await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), owner.address)).to.be.true;
        });

        it("Should allow owner to add bridge operator", async function () {
            await token.addBridgeOperator(bridgeOperator.address);
            await time.increase(8 * 3600 + 1);
            expect(await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), bridgeOperator.address)).to.be.true;
        });
    });

    describe("Emergency Functions", function () {
        it("Should allow owner to pause and unpause", async function () {
            await token.emergencyPauseToken();
            expect(await token.paused()).to.be.true;

            await token.emergencyUnpauseToken();
            expect(await token.paused()).to.be.false;
        });

        it("Should respect emergency cooldown", async function () {
            await token.emergencyPauseToken();
            await expect(token.emergencyPauseToken()).to.be.revertedWith("Cooldown active");
        });
    });

    describe("Contract Management", function () {
        it("Should allow owner to add and remove pool contracts", async function () {
            await token.addPoolContract(user1.address);
            expect(await token.poolContracts(user1.address)).to.be.true;

            await token.removePoolContract(user1.address);
            expect(await token.poolContracts(user1.address)).to.be.false;
        });

        it("Should allow owner to add and remove proof contracts", async function () {
            await token.addProofContract(user1.address);
            expect(await token.proofContracts(user1.address)).to.be.true;

            await token.removeProofContract(user1.address);
            expect(await token.proofContracts(user1.address)).to.be.false;
        });
    });

    describe("Security and Access Control", function () {
        let attacker: SignerWithAddress;
        
        beforeEach(async function () {
            [owner, bridgeOperator, user1, user2, attacker, ...users] = await ethers.getSigners();
        });
    
        describe("Role-Based Access Control", function () {
            it("Should prevent non-admin from adding bridge operators", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).addBridgeOperator(user1.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent non-admin from removing bridge operators", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).removeBridgeOperator(bridgeOperator.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent unauthorized bridge operations", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).bridgeMint(ethers.parseEther("100"), CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).bridgeBurn(ethers.parseEther("100"), CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
        });
    
        describe("Owner Privileges", function () {
            it("Should prevent non-owner from managing pool contracts", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).addPoolContract(attacker.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).removePoolContract(user1.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent non-owner from managing proof contracts", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).addProofContract(attacker.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).removeProofContract(user1.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent non-owner from managing emergency functions", async function () {
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).emergencyPauseToken()
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).emergencyUnpauseToken()
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
        });
    
        describe("Bridge Operation Security", function () {
            beforeEach(async function () {
                await token.setSupportedChain(CHAIN_ID, true);
                await token.addBridgeOperator(bridgeOperator.address);
                await time.increase(8 * 3600 + 1);
                
                // Burn some tokens first to avoid supply limit
                const burnAmount = ethers.parseEther("1000");
                await token.connect(await ethers.getSigner(owner.address)).transferFromContract(user1.address, burnAmount);
                await token.connect(await ethers.getSigner(bridgeOperator.address)).bridgeBurn(burnAmount, CHAIN_ID);
            });
        
            it("Should prevent bridge operations on unsupported chains", async function () {
                const UNSUPPORTED_CHAIN = 999;
                const amount = ethers.parseEther("100");
                await expect(
                    token.connect(await ethers.getSigner(bridgeOperator.address)).bridgeMint(amount, UNSUPPORTED_CHAIN)
                ).to.be.revertedWithCustomError(token, "UnsupportedSourceChain")
                .withArgs(UNSUPPORTED_CHAIN);
            });
        
            it("Should prevent bridge operations when paused", async function () {
                const amount = ethers.parseEther("100");
                await token.emergencyPauseToken();
                await expect(
                    token.connect(await ethers.getSigner(bridgeOperator.address)).bridgeMint(amount, CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "EnforcedPause");
            });
        
            it("Should enforce timelock on bridge operator role changes", async function () {
                const amount = ethers.parseEther("100");
                await token.addBridgeOperator(user2.address);
                // Try immediately without waiting for timelock
                await expect(
                    token.connect(await ethers.getSigner(user2.address)).bridgeMint(amount, CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "TimeLockActive");
            });
        });
    
        describe("Transfer Security", function () {
            it("Should prevent transfers when paused", async function () {
                const amount = ethers.parseEther("100");
                await token.emergencyPauseToken();
                await expect(
                    token.connect(await ethers.getSigner(owner.address)).transferFromContract(user1.address, amount)
                ).to.be.revertedWithCustomError(token, "EnforcedPause");
            });
        
            it("Should prevent unauthorized pool contract operations", async function () {
                const amount = ethers.parseEther("100");
                await token.transferFromContract(user1.address, amount);
                await expect(
                    token.connect(await ethers.getSigner(attacker.address)).transferFrom(user1.address, attacker.address, amount)
                ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
            });
        });
    });
    
});

describe("10 Transactors Performing Transactions", function () {
    let token: StorageToken;
    let owner: SignerWithAddress;
    let users: SignerWithAddress[];
  
    beforeEach(async function () {
      [owner, ...users] = await ethers.getSigners();
      const StorageToken = await ethers.getContractFactory("StorageToken");
      token = await upgrades.deployProxy(StorageToken, [owner.address]);
      await token.waitForDeployment();

      // Mint the maximum supply to the owner
      const maxSupply = await token.connect(await ethers.getSigner(owner.address)).maxSupply();
      await token.connect(await ethers.getSigner(owner.address)).mintToken(maxSupply);
    });
  
    it("Should handle simultaneous transactions correctly", async function () {
      const transferAmount = ethers.parseEther("100");
      const initialBalance = await token.balanceOf(await token.getAddress());
  
      // Distribute tokens to users
      for (let i = 0; i < 10; i++) {
        await token.transferFromContract(users[i].address, transferAmount);
        expect(await token.balanceOf(users[i].address)).to.equal(transferAmount);
      }
  
      // Verify owner's balance decreased correctly
      const expectedContractBalance = initialBalance - (transferAmount * BigInt(10));
      const finalBalance = await token.balanceOf(await token.getAddress());
      expect(finalBalance).to.be.eq(expectedContractBalance);
  
      // Users transfer tokens to each other
      for (let i = 0; i < 9; i++) {
        await token.connect(await ethers.getSigner(users[i].address)).transfer(users[i + 1].address, transferAmount / BigInt(2));
        expect(await token.balanceOf(users[i + 1].address)).to.equal(
          transferAmount + (transferAmount / BigInt(2))
        );
      }
    });
  });

  describe("Minting and Burning by Hackers", function () {
    let token: StorageToken;
    let owner: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let hacker: SignerWithAddress;
    const CHAIN_ID = 1;
  
    beforeEach(async function () {
      [owner, bridgeOperator, hacker] = await ethers.getSigners();
  
      // Deploy the main token contract
      const StorageToken = await ethers.getContractFactory("StorageToken");
      token = await upgrades.deployProxy(StorageToken, [owner.address]);
      await token.waitForDeployment();
  
      // Assign bridge operator role
      await token.addBridgeOperator(bridgeOperator.address);
      await time.increase(8 * 3600 + 1); // Wait for timelock

      // Mint the maximum supply to the owner
      const maxSupply = await token.connect(await ethers.getSigner(owner.address)).maxSupply();
      await token.connect(await ethers.getSigner(owner.address)).mintToken(maxSupply);
    });
  
    it("Should prevent unauthorized minting", async function () {
      const mintAmount = ethers.parseEther("100");
  
      // Hacker attempts to mint tokens
      await expect(
        token.connect(await ethers.getSigner(hacker.address)).bridgeMint(mintAmount, CHAIN_ID)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  
    it("Should prevent unauthorized burning", async function () {
      const burnAmount = ethers.parseEther("100");
  
      // Hacker attempts to burn tokens
      await expect(
        token.connect(await ethers.getSigner(hacker.address)).bridgeBurn(burnAmount, CHAIN_ID)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });