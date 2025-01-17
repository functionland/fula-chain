import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StorageToken, TokenDistributionEngine } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("TokenDistributionEngine - Initialization", () => {
    let tokenDistributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
    const INITIAL_MINT = TOTAL_SUPPLY / BigInt(2);

    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        
        // Deploy StorageToken first
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            INITIAL_MINT
        ])) as StorageToken;
        await storageToken.waitForDeployment();
    });

    describe("TokenDistributionEngine - Initialization", () => {
      let tokenDistributionEngine: TokenDistributionEngine;
      let storageToken: StorageToken;
      let owner: SignerWithAddress;
      let admin: SignerWithAddress;
      let addr1: SignerWithAddress;
  
      beforeEach(async () => {
          [owner, admin, addr1] = await ethers.getSigners();
          
          // Deploy StorageToken first
          const StorageToken = await ethers.getContractFactory("StorageToken");
          storageToken = (await upgrades.deployProxy(StorageToken, [
              owner.address,
              admin.address,
              ethers.parseEther("1000000000") // 1 billion tokens
          ])) as StorageToken;
          await storageToken.waitForDeployment();
  
          // Deploy TokenDistributionEngine
          const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
          tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
              await storageToken.getAddress(),
              owner.address,
              admin.address
          ])) as TokenDistributionEngine;
          await tokenDistributionEngine.waitForDeployment();
      });
  
      describe("initialize", () => {
          it("should initialize contract with valid parameters", async () => {
              expect(await tokenDistributionEngine.storageToken()).to.equal(await storageToken.getAddress());
              
              const ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
              expect(await tokenDistributionEngine.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
              expect(await tokenDistributionEngine.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
          });
  
          it("should revert with zero address for storage token", async () => {
              const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
              await expect(
                  upgrades.deployProxy(TokenDistributionEngine, [
                      ZeroAddress,
                      owner.address,
                      admin.address
                  ])
              ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
          });
  
          it("should revert with zero address for owner", async () => {
              const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
              await expect(
                  upgrades.deployProxy(TokenDistributionEngine, [
                      await storageToken.getAddress(),
                      ZeroAddress,
                      admin.address
                  ])
              ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
          });
  
          it("should revert with zero address for admin", async () => {
              const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
              await expect(
                  upgrades.deployProxy(TokenDistributionEngine, [
                      await storageToken.getAddress(),
                      owner.address,
                      ZeroAddress
                  ])
              ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
          });
  
          it("should revert when trying to initialize twice", async () => {
              await expect(
                  tokenDistributionEngine.initialize(
                      await storageToken.getAddress(),
                      owner.address,
                      admin.address
                  )
              ).to.be.reverted;
          });
      });
  });  
});

describe("TokenDistributionEngine - Emergency Actions", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  const EMERGENCY_COOLDOWN = 30 * 60; // 30 minutes in seconds

  beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();
  });

  describe("TokenDistributionEngine - Emergency Actions", () => {
    let tokenDistributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const EMERGENCY_COOLDOWN = 30 * 60; // 30 minutes in seconds

    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            ethers.parseEther("1000000000")
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
            await storageToken.getAddress(),
            owner.address,
            admin.address
        ])) as TokenDistributionEngine;
        await tokenDistributionEngine.waitForDeployment();
    });

    describe("emergencyAction", () => {
        it("should pause and unpause with proper cooldown", async () => {
            // First pause
            await tokenDistributionEngine.connect(admin).emergencyAction(true);
            expect(await tokenDistributionEngine.paused()).to.be.true;

            // Try to unpause immediately - should fail
            await expect(
                tokenDistributionEngine.connect(admin).emergencyAction(false)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "CoolDownActive");

            // Wait for cooldown
            await ethers.provider.send("evm_increaseTime", [EMERGENCY_COOLDOWN + 1]);
            await ethers.provider.send("evm_mine", []);

            // Now unpause should work
            await tokenDistributionEngine.connect(admin).emergencyAction(false);
            expect(await tokenDistributionEngine.paused()).to.be.false;

            // Try to pause again immediately - should fail
            await expect(
                tokenDistributionEngine.connect(admin).emergencyAction(true)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "CoolDownActive");
        });

        it("should emit EmergencyAction event with correct parameters", async () => {
            const tx = await tokenDistributionEngine.connect(admin).emergencyAction(true);
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt!.blockNumber);
            
            const event = receipt?.logs.find(
                log => tokenDistributionEngine.interface.parseLog(log)?.name === "EmergencyAction"
            );
            
            const parsedEvent = tokenDistributionEngine.interface.parseLog(event);
            expect(parsedEvent?.args?.action).to.equal("paused");
            expect(parsedEvent?.args?.timestamp).to.equal(block?.timestamp);
            expect(parsedEvent?.args?.caller).to.equal(admin.address);
        });

        it("should revert when called by non-admin", async () => {
            await expect(
                tokenDistributionEngine.connect(addr1).emergencyAction(true)
            ).to.be.reverted;
        });

        it("should prevent operations when paused", async () => {
            await tokenDistributionEngine.connect(admin).emergencyAction(true);
            
            // Try some operation that should be blocked when paused
            await expect(
                tokenDistributionEngine.connect(owner).transferOwnership(addr1.address)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
        });
    });
});
});


describe("TokenDistributionEngine - Ownership", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;

  beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();
  });

  describe("transferOwnership", () => {
      it("should set pending owner correctly", async () => {
          await tokenDistributionEngine.connect(owner).transferOwnership(addr1.address);
          
          // Check pending owner through events since it's private
          const filter = tokenDistributionEngine.filters.OwnershipTransferred;
          const events = await tokenDistributionEngine.queryFilter(filter);
          expect(events[0].args.newOwner).to.equal(owner.address);
          expect(await tokenDistributionEngine.owner()).to.equal(owner.address);
          // accept transfer
          await tokenDistributionEngine.connect(addr1).acceptOwnership();
          expect(await tokenDistributionEngine.owner()).to.equal(addr1.address);

      });

      it("should revert when called by non-owner", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).transferOwnership(addr1.address)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "OwnableUnauthorizedAccount");
      });

      it("should revert when transferring to zero address", async () => {
          await expect(
              tokenDistributionEngine.connect(owner).transferOwnership(ZeroAddress)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
      });

      it("should revert when contract is paused", async () => {
          await tokenDistributionEngine.connect(admin).emergencyAction(true);
          
          // Wait for cooldown
          await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);
          
          await expect(
              tokenDistributionEngine.connect(owner).transferOwnership(addr1.address)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
      });
  });

  describe("acceptOwnership", () => {
      beforeEach(async () => {
          await tokenDistributionEngine.connect(owner).transferOwnership(addr1.address);
      });

      it("should transfer ownership when called by pending owner", async () => {
          await tokenDistributionEngine.connect(addr1).acceptOwnership();
          expect(await tokenDistributionEngine.owner()).to.equal(addr1.address);
      });

      it("should revert when called by non-pending owner", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).acceptOwnership()
          ).to.be.revertedWith("Not pending owner");
      });

      it("should revert when contract is paused", async () => {
          await tokenDistributionEngine.connect(admin).emergencyAction(true);
          
          // Wait for cooldown
          await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);
          
          await expect(
              tokenDistributionEngine.connect(addr1).acceptOwnership()
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
      });

      it("should clear pending owner after successful transfer", async () => {
          await tokenDistributionEngine.connect(addr1).acceptOwnership();
          
          // Try to accept again - should fail since pending owner is cleared
          await expect(
              tokenDistributionEngine.connect(addr1).acceptOwnership()
          ).to.be.revertedWith("Not pending owner");
      });

      it("should emit OwnershipTransferred event", async () => {
          await expect(tokenDistributionEngine.connect(addr1).acceptOwnership())
              .to.emit(tokenDistributionEngine, "OwnershipTransferred")
              .withArgs(owner.address, addr1.address);
      });
  });

  describe("TokenDistributionEngine - Ownership", () => {
    let tokenDistributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;

    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            ethers.parseEther("1000000000")
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
            await storageToken.getAddress(),
            owner.address,
            admin.address
        ])) as TokenDistributionEngine;
        await tokenDistributionEngine.waitForDeployment();
    });

    describe("transferOwnership", () => {
        it("should transfer ownership correctly", async () => {
            await tokenDistributionEngine.connect(owner).transferOwnership(addr1.address);
            await tokenDistributionEngine.connect(addr1).acceptOwnership();
            
            expect(await tokenDistributionEngine.owner()).to.equal(addr1.address);
        });

        it("should emit OwnershipTransferred event", async () => {
            await tokenDistributionEngine.connect(owner).transferOwnership(addr1.address);
            
            await expect(tokenDistributionEngine.connect(addr1).acceptOwnership())
                .to.emit(tokenDistributionEngine, "OwnershipTransferred")
                .withArgs(owner.address, addr1.address);
        });

        it("should revert when called by non-owner", async () => {
            await expect(
                tokenDistributionEngine.connect(addr1).transferOwnership(addr1.address)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "OwnableUnauthorizedAccount");
        });

        it("should revert when transferring to zero address", async () => {
            await expect(
                tokenDistributionEngine.connect(owner).transferOwnership(ZeroAddress)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
        });

        it("should revert when contract is paused", async () => {
            await tokenDistributionEngine.connect(admin).emergencyAction(true);
            
            await expect(
                tokenDistributionEngine.connect(owner).transferOwnership(addr1.address)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
        });
    });

    describe("acceptOwnership", () => {
        beforeEach(async () => {
            await tokenDistributionEngine.connect(owner).transferOwnership(addr1.address);
        });

        it("should revert when called by non-pending owner", async () => {
            await expect(
                tokenDistributionEngine.connect(admin).acceptOwnership()
            ).to.be.revertedWith("Not pending owner");
        });

        it("should revert when contract is paused", async () => {
            await tokenDistributionEngine.connect(admin).emergencyAction(true);
            
            await expect(
                tokenDistributionEngine.connect(addr1).acceptOwnership()
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
        });

        it("should clear pending owner after successful transfer", async () => {
            await tokenDistributionEngine.connect(addr1).acceptOwnership();
            
            // Try to accept again - should fail since pending owner is cleared
            await expect(
                tokenDistributionEngine.connect(addr1).acceptOwnership()
            ).to.be.revertedWith("Not pending owner");
        });
    });
});

});


describe("TokenDistributionEngine - Vesting Cap Management", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  const CAP_ID = 1;
  const TOKEN_UNIT = ethers.parseEther("1");

  beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();
  });

  describe("addVestingCap", () => {
      it("should add a vesting cap with valid parameters", async () => {
          const capName = ethers.encodeBytes32String("Team");
          const totalAllocation = TOKEN_UNIT * BigInt(1000000); // 1M tokens
          const cliff = 180; // 180 days
          const vestingTerm = 24; // 24 months
          const vestingPlan = 3; // quarterly
          const initialRelease = 10; // 10%

          await tokenDistributionEngine.connect(admin).addVestingCap(
              CAP_ID,
              capName,
              totalAllocation,
              cliff,
              vestingTerm,
              vestingPlan,
              initialRelease
          );

          const cap = await tokenDistributionEngine.vestingCaps(CAP_ID);
          expect(cap.totalAllocation).to.equal(totalAllocation);
          expect(cap.cliff).to.equal(cliff * 24 * 60 * 60); // converted to seconds
          expect(cap.vestingTerm).to.equal(vestingTerm * 30 * 24 * 60 * 60); // converted to seconds
          expect(cap.vestingPlan).to.equal(vestingPlan * 30 * 24 * 60 * 60); // converted to seconds
          expect(cap.initialRelease).to.equal(initialRelease);

          const capIds = await tokenDistributionEngine.capIds(0);
          expect(capIds).to.equal(CAP_ID);
      });

      it("should revert when adding duplicate cap ID", async () => {
          const capName = ethers.encodeBytes32String("Team");
          await tokenDistributionEngine.connect(admin).addVestingCap(
              CAP_ID,
              capName,
              TOKEN_UNIT * BigInt(1000000),
              180,
              24,
              3,
              10
          );

          await expect(
              tokenDistributionEngine.connect(admin).addVestingCap(
                  CAP_ID,
                  capName,
                  TOKEN_UNIT * BigInt(1000000),
                  180,
                  24,
                  3,
                  10
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "CapExists");
      });

      it("should revert when total allocation is zero", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).addVestingCap(
                  CAP_ID,
                  ethers.encodeBytes32String("Team"),
                  0,
                  180,
                  24,
                  3,
                  10
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAllocation");
      });

      it("should revert when initial release is greater than 100%", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).addVestingCap(
                  CAP_ID,
                  ethers.encodeBytes32String("Team"),
                  TOKEN_UNIT * BigInt(1000000),
                  180,
                  24,
                  3,
                  101
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "InitialReleaseTooLarge");
      });

      it("should revert when vesting plan is greater than or equal to vesting term", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).addVestingCap(
                  CAP_ID,
                  ethers.encodeBytes32String("Team"),
                  TOKEN_UNIT * BigInt(1000000),
                  180,
                  24,
                  24,
                  10
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "OutOfRangeVestingPlan");
      });

      it("should revert when called by non-admin", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).addVestingCap(
                  CAP_ID,
                  ethers.encodeBytes32String("Team"),
                  TOKEN_UNIT * BigInt(1000000),
                  180,
                  24,
                  3,
                  10
              )
          ).to.be.reverted;
      });

      it("should emit VestingCapAdded event", async () => {
          const capName = ethers.encodeBytes32String("Team");
          await expect(
              tokenDistributionEngine.connect(admin).addVestingCap(
                  CAP_ID,
                  capName,
                  TOKEN_UNIT * BigInt(1000000),
                  180,
                  24,
                  3,
                  10
              )
          ).to.emit(tokenDistributionEngine, "VestingCapAdded")
              .withArgs(CAP_ID, capName);
      });
  });
});

describe("TokenDistributionEngine - TGE", () => {
    let tokenDistributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const CAP_ID = 1;
    const ROLE_CHANGE_DELAY = 24 * 60 * 60; // 1 day in seconds

    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            ethers.parseEther("1000000000")
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
            await storageToken.getAddress(),
            owner.address,
            admin.address
        ])) as TokenDistributionEngine;
        await tokenDistributionEngine.waitForDeployment();

        // Wait for timelock to expire
        await ethers.provider.send("evm_increaseTime", [ROLE_CHANGE_DELAY + 1]);
        await ethers.provider.send("evm_mine", []);

        // Set quorum for ADMIN_ROLE in StorageToken
      const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
      await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        // Setup vesting cap
        await tokenDistributionEngine.connect(admin).addVestingCap(
            CAP_ID,
            ethers.encodeBytes32String("Team"),
            TOKEN_UNIT * BigInt(100000), // 1M tokens
            180, // 180 days cliff
            24,  // 24 months vesting
            3,   // quarterly vesting
            10   // 10% initial release
        );

        // Setup contract operator role and whitelist
        const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
        const tx = await storageToken.connect(owner).createProposal(
            0, // RoleChange
            addr1.address,
            CONTRACT_OPERATOR_ROLE,
            0,
            ZeroAddress,
            true
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs
            .map((log) => storageToken.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated");
        
        const proposalId = event?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId);
        
        // Wait for execution delay
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await storageToken.connect(owner).executeProposal(proposalId);

        // Whitelist distribution contract
        const tx4 = await storageToken.connect(owner).createProposal(
            3, // Whitelist
            await tokenDistributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress,
            true
        );
        
        const receipt4 = await tx4.wait();
        const event4 = receipt4?.logs
            .map((log) => storageToken.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated");
        
        const proposalId4 = event4?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId4);
        
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await storageToken.connect(owner).executeProposal(proposalId4);

        // Whitelist distribution contract
      await expect(storageToken.connect(owner).createProposal(
        3, // Whitelist
        await tokenDistributionEngine.getAddress(),
          ethers.ZeroHash,
          0,
          ZeroAddress,
          true
      )).to.be.revertedWithCustomError(storageToken, "AlreadyWhitelisted");

    await storageToken.connect(owner).setRoleTransactionLimit(await storageToken.ADMIN_ROLE(), TOKEN_UNIT * BigInt(1000000));
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

    // Transfer tokens to distribution contract
    await storageToken.connect(admin).transferFromContract(
        await tokenDistributionEngine.getAddress(),
        TOKEN_UNIT * BigInt(1000000)
    );
    });

    describe("InitiateTGE", () => {
      it("should successfully initiate TGE", async () => {
          await tokenDistributionEngine.connect(admin).InitiateTGE();
          expect(await tokenDistributionEngine.tgeInitiated()).to.be.true;
      });

      it("should revert when called twice", async () => {
          await tokenDistributionEngine.connect(admin).InitiateTGE();
          await expect(
              tokenDistributionEngine.connect(admin).InitiateTGE()
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "TGETInitiatedErr");
      });

      it("should revert when contract has insufficient balance", async () => {
          // Add another cap that exceeds contract balance
          await tokenDistributionEngine.connect(admin).addVestingCap(
              2,
              ethers.encodeBytes32String("Advisors"),
              TOKEN_UNIT * BigInt(2000000), // 2M tokens (more than available)
              180,
              24,
              3,
              10
          );

          await expect(
              tokenDistributionEngine.connect(admin).InitiateTGE()
          ).to.be.revertedWithCustomError(
              tokenDistributionEngine, 
              "InsufficientContractBalance"
          );
      });

      it("should emit TGEInitiated event", async () => {
          const tx = await tokenDistributionEngine.connect(admin).InitiateTGE();
          const receipt = await tx.wait();
          const block = await ethers.provider.getBlock(receipt!.blockNumber);
          
          await expect(tx)
              .to.emit(tokenDistributionEngine, "TGEInitiated")
              .withArgs(block!.timestamp, block!.number);
      });

      it("should revert when called by non-admin", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).InitiateTGE()
          ).to.be.reverted;
      });
  });
});

describe("TokenDistributionEngine - Token Claims", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  const TOKEN_UNIT = ethers.parseEther("1");
  const CAP_ID = 1;

  beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();

      // Wait for timelock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Set quorum for ADMIN_ROLE in StorageToken
      const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
      await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

      // Setup vesting cap
      await tokenDistributionEngine.connect(admin).addVestingCap(
          CAP_ID,
          ethers.encodeBytes32String("Team"),
          TOKEN_UNIT * BigInt(1000), // 1000 tokens
          180, // 180 days cliff
          24,  // 24 months vesting
          3,   // quarterly vesting
          10   // 10% initial release
      );

      // Setup contract operator role and whitelist
      const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
      const tx = await storageToken.connect(owner).createProposal(
          0, // RoleChange
          addr1.address,
          CONTRACT_OPERATOR_ROLE,
          0,
          ZeroAddress,
          true
      );
      
      const receipt = await tx.wait();
      const event = receipt?.logs
          .map((log) => storageToken.interface.parseLog(log))
          .find((parsedLog) => parsedLog?.name === "ProposalCreated");
      
      const proposalId = event?.args?.proposalId;
      await storageToken.connect(admin).approveProposal(proposalId);
      
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await storageToken.connect(owner).executeProposal(proposalId);

      // Whitelist distribution contract
      const tx2 = await storageToken.connect(owner).createProposal(
          3, // Whitelist
          await tokenDistributionEngine.getAddress(),
          ethers.ZeroHash,
          0,
          ZeroAddress,
          true
      );
      
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs
          .map((log) => storageToken.interface.parseLog(log))
          .find((parsedLog) => parsedLog?.name === "ProposalCreated");
      
      const proposalId2 = event2?.args?.proposalId;
      await storageToken.connect(admin).approveProposal(proposalId2);
      
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await storageToken.connect(owner).executeProposal(proposalId2);
      await storageToken.connect(owner).setRoleTransactionLimit(await storageToken.ADMIN_ROLE(), TOKEN_UNIT * BigInt(1000));
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

      // Transfer tokens to distribution contract
      await storageToken.connect(admin).transferFromContract(
          await tokenDistributionEngine.getAddress(),
          TOKEN_UNIT * BigInt(1000)
      );

      await tokenDistributionEngine.connect(admin).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);
      // Add wallet to cap
      const addWalletTx = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
          CAP_ID,
          [addr1.address],
          [ethers.encodeBytes32String("Test Wallet")],
          [TOKEN_UNIT * BigInt(100)]
      );
      

      const addWalletReceipt = await addWalletTx.wait();
      const addWalletEvent = addWalletReceipt?.logs
          .map((log) => tokenDistributionEngine.interface.parseLog(log))
          .find((parsedLog) => parsedLog?.name === "ProposalCreated");
      const addWalletProposalId = addWalletEvent?.args?.proposalId;

      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

      const tx3 = await tokenDistributionEngine.connect(owner).approveProposal(addWalletProposalId);
      const receipt3 = await tx3.wait();
      const event3 = receipt3?.logs
          .map((log) => tokenDistributionEngine.interface.parseLog(log))
          .find((parsedLog) => parsedLog?.name === "ProposalApproved");
      const addWalletApprovedProposalId = event3?.args?.proposalId;
      const executionAttempted = event3?.args?.executionAttempted;
      expect(addWalletApprovedProposalId).to.be.eq(addWalletProposalId);
      expect(executionAttempted).to.be.eq(true);
      

      // Initiate TGE
      await tokenDistributionEngine.connect(admin).InitiateTGE();
  });

  describe("calculateDueTokens", () => {
      it("should return 0 before cliff period", async () => {
          await expect(
              tokenDistributionEngine.calculateDueTokens(addr1.address, CAP_ID)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
      });

      it("should calculate initial release after cliff", async () => {
          // Move past cliff period
          await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          const dueTokens = await tokenDistributionEngine.calculateDueTokens(addr1.address, CAP_ID);
          // 10% of 100 tokens
          expect(dueTokens).to.equal(TOKEN_UNIT * BigInt(10));
      });

      it("should calculate vested tokens after one quarter", async () => {
          // Move past cliff period plus one quarter
          await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 90 * 24 * 60 * 60]);
          await ethers.provider.send("evm_mine", []);

          const dueTokens = await tokenDistributionEngine.calculateDueTokens(addr1.address, CAP_ID);
          // Initial 10% plus ~11.25% of remaining 90%
          const expectedTokens = TOKEN_UNIT * BigInt(10) + 
            (TOKEN_UNIT * BigInt(100) - TOKEN_UNIT * BigInt(10)) * 
            BigInt(3) / BigInt(24);
          expect(dueTokens).to.be.eq(expectedTokens);
      });
  });

  describe("claimTokens", () => {
      it("should revert when nothing is due", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).claimTokens(CAP_ID, 1)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
      });

      it("should successfully claim tokens after cliff", async () => {
          // Move past cliff period
          await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          const initialBalance = await storageToken.balanceOf(addr1.address);
          await tokenDistributionEngine.connect(addr1).claimTokens(CAP_ID, 1);
          const finalBalance = await storageToken.balanceOf(addr1.address);

          expect(finalBalance - initialBalance).to.equal(TOKEN_UNIT * BigInt(10));
      });

      it("should emit TokensClaimed event", async () => {
          await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          await expect(tokenDistributionEngine.connect(addr1).claimTokens(CAP_ID, 1))
              .to.emit(tokenDistributionEngine, "TokensClaimed");
      });

      it("should update claimed tokens after successful claim", async () => {
          await ethers.provider.send("evm_increaseTime", [180 * 24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          await tokenDistributionEngine.connect(addr1).claimTokens(CAP_ID, 1);
          const claimed = await tokenDistributionEngine.claimedTokens(addr1.address, CAP_ID);
          expect(claimed).to.equal(TOKEN_UNIT * BigInt(10));
      });
  });
});

describe("TokenDistributionEngine - Add Wallets to Cap", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  const TOKEN_UNIT = ethers.parseEther("1");
  const CAP_ID = 1;

  beforeEach(async () => {
      [owner, admin, addr1, addr2] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();

      // Wait for timelock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Set quorum for ADMIN_ROLE
      await tokenDistributionEngine.connect(owner).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);

      // Setup vesting cap
      await tokenDistributionEngine.connect(admin).addVestingCap(
          CAP_ID,
          ethers.encodeBytes32String("Team"),
          TOKEN_UNIT * BigInt(1000),
          180,
          24,
          3,
          10
      );
  });

  describe("proposeAddWalletsToCap", () => {
      it("should create proposal to add wallets", async () => {
          const wallets = [addr1.address, addr2.address];
          const names = [
              ethers.encodeBytes32String("Wallet1"),
              ethers.encodeBytes32String("Wallet2")
          ];
          const allocations = [TOKEN_UNIT * BigInt(100), TOKEN_UNIT * BigInt(200)];

          const tx = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
              CAP_ID,
              wallets,
              names,
              allocations
          );

          const receipt = await tx.wait();
          const event = receipt?.logs
              .map((log) => tokenDistributionEngine.interface.parseLog(log))
              .find((parsedLog) => parsedLog?.name === "ProposalCreated");

          expect(event?.args?.flags).to.equal(2); // WalletAddition type
          expect(event?.args?.proposer).to.equal(admin.address);
      });

      it("should revert when arrays have different lengths", async () => {
          const wallets = [addr1.address];
          const names = [ethers.encodeBytes32String("Wallet1")];
          const allocations = [TOKEN_UNIT * BigInt(100), TOKEN_UNIT * BigInt(200)];

          await expect(
              tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
                  CAP_ID,
                  wallets,
                  names,
                  allocations
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "LengthMisMatch");
      });

      it("should revert when cap does not exist", async () => {
          const nonExistentCapId = 999;
          await expect(
              tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
                  nonExistentCapId,
                  [addr1.address],
                  [ethers.encodeBytes32String("Wallet1")],
                  [TOKEN_UNIT * BigInt(100)]
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "CapNotFound");
      });

      it("should revert when called by non-admin", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).proposeAddWalletsToCap(
                  CAP_ID,
                  [addr1.address],
                  [ethers.encodeBytes32String("Wallet1")],
                  [TOKEN_UNIT * BigInt(100)]
              )
          ).to.be.reverted;
      });

      it("should revert when allocation exceeds cap total", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
                  CAP_ID,
                  [addr1.address],
                  [ethers.encodeBytes32String("Wallet1")],
                  [TOKEN_UNIT * BigInt(2000)] // Exceeds cap total of 1000
              )
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "AllocationTooHigh");
      });
  });
});


describe("TokenDistributionEngine - Proposal Approval", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  const TOKEN_UNIT = ethers.parseEther("1");
  const CAP_ID = 1;

  beforeEach(async () => {
      [owner, admin, addr1, addr2] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();

      // Wait for timelock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Set quorum for ADMIN_ROLE
      await tokenDistributionEngine.connect(owner).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);

      // Setup vesting cap
      await tokenDistributionEngine.connect(admin).addVestingCap(
          CAP_ID,
          ethers.encodeBytes32String("Team"),
          TOKEN_UNIT * BigInt(1000),
          180,
          24,
          3,
          10
      );
  });

  describe("approveProposal", () => {
      let proposalId: string;

      beforeEach(async () => {
          const tx = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
              CAP_ID,
              [addr1.address],
              [ethers.encodeBytes32String("Test Wallet")],
              [TOKEN_UNIT * BigInt(100)]
          );

          const receipt = await tx.wait();
          const event = receipt?.logs
              .map((log) => tokenDistributionEngine.interface.parseLog(log))
              .find((parsedLog) => parsedLog?.name === "ProposalCreated");

          proposalId = event?.args?.proposalId;
      });

      it("should approve proposal successfully", async () => {
          await tokenDistributionEngine.connect(owner).approveProposal(proposalId);
          const proposal = await tokenDistributionEngine.proposals(proposalId);
          expect(proposal.config.approvals).to.equal(2);
      });

      it("should revert when non-admin tries to approve", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).approveProposal(proposalId)
          ).to.be.reverted;
      });

      it("should revert when proposal does not exist", async () => {
          const nonExistentProposalId = ethers.id("nonexistent");
          await expect(
              tokenDistributionEngine.connect(owner).approveProposal(nonExistentProposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalError").withArgs(1);
      });

      it("should revert when proposal has expired", async () => {
          await ethers.provider.send("evm_increaseTime", [72 * 60 * 60 + 1]); // 72 hours + 1 second
          await ethers.provider.send("evm_mine", []);

          await expect(
              tokenDistributionEngine.connect(owner).approveProposal(proposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalError").withArgs(2);
      });

      it("should emit ProposalApproved event", async () => {
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // 72 hours + 1 second
        await ethers.provider.send("evm_mine", []);

          await expect(tokenDistributionEngine.connect(owner).approveProposal(proposalId))
              .to.emit(tokenDistributionEngine, "ProposalApproved")
              .withArgs(proposalId, true, owner.address);
      });

      it("should revert when same admin approves twice", async () => {
          await tokenDistributionEngine.connect(owner).approveProposal(proposalId);
          await expect(
              tokenDistributionEngine.connect(owner).approveProposal(proposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalError").withArgs(4);
      });
  });
});

describe("TokenDistributionEngine - Execute Proposal", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;
  let addr2: SignerWithAddress;
  const TOKEN_UNIT = ethers.parseEther("1");
  const CAP_ID = 1;

  beforeEach(async () => {
      [owner, admin, addr1, addr2] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();

      // Wait for timelock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Set quorum for ADMIN_ROLE
      await tokenDistributionEngine.connect(owner).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);

      // Setup vesting cap
      await tokenDistributionEngine.connect(admin).addVestingCap(
          CAP_ID,
          ethers.encodeBytes32String("Team"),
          TOKEN_UNIT * BigInt(1000),
          180,
          24,
          3,
          10
      );
  });

  describe("executeProposal", () => {
      let proposalId: string;

      beforeEach(async () => {
          const tx = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
              CAP_ID,
              [addr1.address],
              [ethers.encodeBytes32String("Test Wallet")],
              [TOKEN_UNIT * BigInt(100)]
          );

          const receipt = await tx.wait();
          const event = receipt?.logs
              .map((log) => tokenDistributionEngine.interface.parseLog(log))
              .find((parsedLog) => parsedLog?.name === "ProposalCreated");

          proposalId = event?.args?.proposalId;
          await tokenDistributionEngine.connect(owner).approveProposal(proposalId);
      });

      it("should revert when execution delay not met", async () => {
          await expect(
              tokenDistributionEngine.connect(admin).executeProposal(proposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalExecutionError");
      });

      it("should revert when quorum not met", async () => {
          const tx = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
              CAP_ID,
              [addr2.address],
              [ethers.encodeBytes32String("Test Wallet 2")],
              [TOKEN_UNIT * BigInt(100)]
          );
          const receipt = await tx.wait();
          const newProposalId = receipt?.logs
              .map((log) => tokenDistributionEngine.interface.parseLog(log))
              .find((parsedLog) => parsedLog?.name === "ProposalCreated")?.args?.proposalId;

          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
          await expect(
              tokenDistributionEngine.connect(admin).executeProposal(newProposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalExecutionError");
      });

      it("should emit ProposalExecuted event", async () => {
          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          await expect(tokenDistributionEngine.connect(admin).executeProposal(proposalId))
              .to.emit(tokenDistributionEngine, "ProposalExecuted")
              .withArgs(proposalId, 2, addr1.address);
      });

      it("should revert when executing same proposal twice", async () => {
          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          await tokenDistributionEngine.connect(admin).executeProposal(proposalId);
          await expect(
              tokenDistributionEngine.connect(admin).executeProposal(proposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalError");
      });
  });
});

describe("TokenDistributionEngine - Contract Upgrade", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let addr1: SignerWithAddress;

  beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      
      // Deploy StorageToken
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
          owner.address,
          admin.address,
          ethers.parseEther("1000000000")
      ])) as StorageToken;
      await storageToken.waitForDeployment();

      // Deploy TokenDistributionEngine
      const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
          await storageToken.getAddress(),
          owner.address,
          admin.address
      ])) as TokenDistributionEngine;
      await tokenDistributionEngine.waitForDeployment();

      // Wait for timelock
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      // Set quorum for ADMIN_ROLE
      await tokenDistributionEngine.connect(owner).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);
  });

  describe("Contract Upgrade Process", () => {
      it("should successfully propose and execute upgrade", async () => {
          // Deploy new implementation using upgrades plugin
          const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine");
          const implementationV2 = await upgrades.deployImplementation(TokenDistributionEngineV2);
          
          // Propose upgrade
          const tx = await tokenDistributionEngine.connect(owner).proposeUpgrade(implementationV2);
          const receipt = await tx.wait();
          
          // Get proposalId from event
          const event = receipt?.logs
              .map((log) => tokenDistributionEngine.interface.parseLog(log))
              .find((parsedLog) => parsedLog?.name === "ProposalCreated");
          const proposalId = event?.args?.proposalId;

          // Approve proposal
          await tokenDistributionEngine.connect(admin).approveProposal(proposalId);

          // Wait for execution delay
          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
          await ethers.provider.send("evm_mine", []);

          // Execute proposal
          await tokenDistributionEngine.connect(owner).executeProposal(proposalId);

          // Verify upgrade
          const implementationAddress = await upgrades.erc1967.getImplementationAddress(
              await tokenDistributionEngine.getAddress()
          );
          expect(implementationAddress.toLowerCase()).to.equal(implementationV2.toLowerCase());
      });

      // ... rest of the tests remain the same
  });
});

describe("TokenDistributionEngine - Full Distribution Flow", () => {
    let tokenDistributionEngine: TokenDistributionEngine;
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let investor1: SignerWithAddress;
    let investor2: SignerWithAddress;
    let investor3: SignerWithAddress;
    let investor4: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const MONTH = 30 * 24 * 60 * 60; // 30 days in seconds

    beforeEach(async () => {
        [owner, admin, investor1, investor2, investor3, investor4] = await ethers.getSigners();
        
        // Deploy StorageToken
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            ethers.parseEther("1000000000")
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Deploy TokenDistributionEngine
        const TokenDistributionEngine = await ethers.getContractFactory("TokenDistributionEngine");
        tokenDistributionEngine = (await upgrades.deployProxy(TokenDistributionEngine, [
            await storageToken.getAddress(),
            owner.address,
            admin.address
        ])) as TokenDistributionEngine;
        await tokenDistributionEngine.waitForDeployment();

        // Wait for timelock
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await ethers.provider.send("evm_mine", []);

        // Set quorum for ADMIN_ROLE
        await tokenDistributionEngine.connect(owner).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);

        // Setup vesting caps
        await tokenDistributionEngine.connect(admin).addVestingCap(
            1, // First cap
            ethers.encodeBytes32String("First Cap"),
            TOKEN_UNIT * BigInt(750), // 250 + 500
            4 * MONTH,  // 4 month cliff
            15 * MONTH, // 15 month vesting
            1,          // monthly vesting
            10         // 10% initial release
        );

        await tokenDistributionEngine.connect(admin).addVestingCap(
            2, // Second cap
            ethers.encodeBytes32String("Second Cap"),
            TOKEN_UNIT * BigInt(200),
            6 * MONTH,  // 6 month cliff
            18 * MONTH, // 18 month vesting
            1,          // monthly vesting
            5          // 5% initial release
        );

        await tokenDistributionEngine.connect(admin).addVestingCap(
            3, // Third cap
            ethers.encodeBytes32String("Third Cap"),
            TOKEN_UNIT * BigInt(50),
            0,          // no cliff
            6 * MONTH,  // 6 month vesting
            1,          // monthly vesting
            20         // 20% initial release
        );

        // Add investors to caps
        const tx1 = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
            1,
            [investor1.address, investor2.address],
            [ethers.encodeBytes32String("Investor1"), ethers.encodeBytes32String("Investor2")],
            [TOKEN_UNIT * BigInt(250), TOKEN_UNIT * BigInt(500)]
        );
        const receipt1 = await tx1.wait();
        const proposalId1 = receipt1?.logs
            .map((log) => tokenDistributionEngine.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated")?.args?.proposalId;
        await tokenDistributionEngine.connect(owner).approveProposal(proposalId1);

        const tx2 = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
            2,
            [investor3.address],
            [ethers.encodeBytes32String("Investor3")],
            [TOKEN_UNIT * BigInt(200)]
        );
        const receipt2 = await tx2.wait();
        const proposalId2 = receipt2?.logs
            .map((log) => tokenDistributionEngine.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated")?.args?.proposalId;
        await tokenDistributionEngine.connect(owner).approveProposal(proposalId2);

        const tx3 = await tokenDistributionEngine.connect(admin).proposeAddWalletsToCap(
            3,
            [investor4.address],
            [ethers.encodeBytes32String("Investor4")],
            [TOKEN_UNIT * BigInt(50)]
        );
        const receipt3 = await tx3.wait();
        const proposalId3 = receipt3?.logs
            .map((log) => tokenDistributionEngine.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated")?.args?.proposalId;
        await tokenDistributionEngine.connect(owner).approveProposal(proposalId3);

        // Whitelist distribution contract
        await storageToken.connect(owner).setRoleQuorum(await storageToken.ADMIN_ROLE(), 2);
        const tx4 = await storageToken.connect(owner).createProposal(
            3, // Whitelist
            await tokenDistributionEngine.getAddress(),
            ethers.ZeroHash,
            0,
            ZeroAddress,
            true
        );
        
        const receipt4 = await tx4.wait();
        const event4 = receipt4?.logs
            .map((log) => storageToken.interface.parseLog(log))
            .find((parsedLog) => parsedLog?.name === "ProposalCreated");
        
        const proposalId4 = event4?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId4);
        
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
        await storageToken.connect(owner).executeProposal(proposalId2);
        await storageToken.connect(owner).setRoleTransactionLimit(await storageToken.ADMIN_ROLE(), TOKEN_UNIT * BigInt(1000));
        await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

        // Transfer tokens to distribution contract
        await storageToken.connect(admin).transferFromContract(
            await tokenDistributionEngine.getAddress(),
            TOKEN_UNIT * BigInt(1000)
        );

        await tokenDistributionEngine.connect(admin).setRoleQuorum(await tokenDistributionEngine.ADMIN_ROLE(), 2);

        // Initiate TGE
        await tokenDistributionEngine.connect(admin).InitiateTGE();
    });

    it("should handle complete vesting flow for all investors", async () => {
        // TGE Claims
        await expect(
            tokenDistributionEngine.connect(investor1).claimTokens(1, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
        
        await expect(
            tokenDistributionEngine.connect(investor2).claimTokens(1, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");

        await expect(
            tokenDistributionEngine.connect(investor3).claimTokens(2, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");

        // Investor 4 can claim initial release at TGE
        await tokenDistributionEngine.connect(investor4).claimTokens(3, 1);
        expect(await storageToken.balanceOf(investor4.address)).to.equal(TOKEN_UNIT * BigInt(10)); // 20% of 50

        // Move to month 4 (cliff for investors 1 & 2)
        await ethers.provider.send("evm_increaseTime", [4 * MONTH]);
        await ethers.provider.send("evm_mine", []);

        // Investors 1 & 2 claim initial release + 1 month vesting
        await tokenDistributionEngine.connect(investor1).claimTokens(1, 1);
        await tokenDistributionEngine.connect(investor2).claimTokens(1, 1);

        // Move to month 5
        await ethers.provider.send("evm_increaseTime", [MONTH]);
        await ethers.provider.send("evm_mine", []);

        // All investors claim
        await tokenDistributionEngine.connect(investor1).claimTokens(1, 1);
        await tokenDistributionEngine.connect(investor2).claimTokens(1, 1);
        await expect(
            tokenDistributionEngine.connect(investor3).claimTokens(2, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "CliffNotReached");
        await tokenDistributionEngine.connect(investor4).claimTokens(3, 1);

        // Skip to month 8
        await ethers.provider.send("evm_increaseTime", [3 * MONTH]);
        await ethers.provider.send("evm_mine", []);

        // Investors 1 & 2 claim accumulated tokens
        await tokenDistributionEngine.connect(investor1).claimTokens(1, 1);
        await tokenDistributionEngine.connect(investor2).claimTokens(1, 1);

        // Move to end of vesting for investor 4
        await ethers.provider.send("evm_increaseTime", [6 * MONTH]);
        await ethers.provider.send("evm_mine", []);

        // Investor 4 claims remaining tokens
        await tokenDistributionEngine.connect(investor4).claimTokens(3, 1);
        await expect(
            tokenDistributionEngine.connect(investor4).claimTokens(3, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "NoTokensDue");

        // Move to end of vesting for all investors
        await ethers.provider.send("evm_increaseTime", [15 * MONTH]);
        await ethers.provider.send("evm_mine", []);

        // Final claims and verify balances
        await tokenDistributionEngine.connect(investor1).claimTokens(1, 1);
        await tokenDistributionEngine.connect(investor2).claimTokens(1, 1);
        await tokenDistributionEngine.connect(investor3).claimTokens(2, 1);

        // Verify final balances
        expect(await storageToken.balanceOf(investor1.address)).to.equal(TOKEN_UNIT * BigInt(250));
        expect(await storageToken.balanceOf(investor2.address)).to.equal(TOKEN_UNIT * BigInt(500));
        expect(await storageToken.balanceOf(investor3.address)).to.equal(TOKEN_UNIT * BigInt(200));
        expect(await storageToken.balanceOf(investor4.address)).to.equal(TOKEN_UNIT * BigInt(50));

        // Verify no more claims possible
        await expect(
            tokenDistributionEngine.connect(investor1).claimTokens(1, 1)
        ).to.be.revertedWithCustomError(tokenDistributionEngine, "NoTokensDue");
    });
});
