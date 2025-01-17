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

describe("TokenDistributionEngine - Role Removal", () => {
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
    });

    describe("Role Removal Process", () => {
        let proposalId: string;
        let ADMIN_ROLE: string;

        beforeEach(async () => {
            ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
            
            // Create proposal to remove admin role
            const tx = await tokenDistributionEngine.connect(owner).createProposal(
                2, // RoleRemoval
                admin.address,
                ADMIN_ROLE,
                0,
                ZeroAddress,
                false
            );

            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => tokenDistributionEngine.interface.parseLog(log))
                .find((parsedLog) => parsedLog?.name === "ProposalCreated");

            proposalId = event?.args?.proposalId;
        });

        it("should successfully remove role after proposal execution", async () => {
            // Approve proposal
            await tokenDistributionEngine.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine", []);

            // Execute proposal
            await tokenDistributionEngine.connect(owner).executeProposal(proposalId);

            // Verify role was removed
            expect(await tokenDistributionEngine.hasRole(ADMIN_ROLE, admin.address)).to.be.false;
        });

        it("should emit AdminRemovalExecuted event", async () => {
            await tokenDistributionEngine.connect(admin).approveProposal(proposalId);
            
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine", []);

            await expect(tokenDistributionEngine.connect(owner).executeProposal(proposalId))
                .to.emit(tokenDistributionEngine, "AdminRemovalExecuted")
                .withArgs(admin.address);
        });

        it("should revert when trying to remove last admin", async () => {
            // First remove admin
            await tokenDistributionEngine.connect(admin).approveProposal(proposalId);
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await tokenDistributionEngine.connect(owner).executeProposal(proposalId);

            // Try to remove owner (last admin)
            const tx = await tokenDistributionEngine.connect(owner).createProposal(
                2, // RoleRemoval
                owner.address,
                ADMIN_ROLE,
                0,
                ZeroAddress,
                false
            );

            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => tokenDistributionEngine.interface.parseLog(log))
                .find((parsedLog) => parsedLog?.name === "ProposalCreated");

            const lastAdminProposalId = event?.args?.proposalId;

            await tokenDistributionEngine.connect(owner).approveProposal(lastAdminProposalId);
            
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await expect(
                tokenDistributionEngine.connect(owner).executeProposal(lastAdminProposalId)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "LastAdminErr");
        });

        it("should revert when non-admin creates removal proposal", async () => {
            await expect(
                tokenDistributionEngine.connect(addr1).createProposal(
                    2, // RoleRemoval
                    admin.address,
                    ADMIN_ROLE,
                    0,
                    ZeroAddress,
                    false
                )
            ).to.be.reverted;
        });

        it("should revert when removing non-existent role", async () => {
            const tx = await tokenDistributionEngine.connect(owner).createProposal(
                2, // RoleRemoval
                addr1.address,
                ADMIN_ROLE,
                0,
                ZeroAddress,
                false
            );

            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => tokenDistributionEngine.interface.parseLog(log))
                .find((parsedLog) => parsedLog?.name === "ProposalCreated");

            const nonExistentRoleProposalId = event?.args?.proposalId;

            await tokenDistributionEngine.connect(admin).approveProposal(nonExistentRoleProposalId);
            
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await expect(
                tokenDistributionEngine.connect(owner).executeProposal(nonExistentRoleProposalId)
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "RoleNotFound");
        });
    });
});
describe("TokenDistributionEngine - Role Proposal", () => {
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

    describe("proposeRole", () => {
        it("should create role proposal successfully", async () => {
            const ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
            const tx = await tokenDistributionEngine.connect(owner).proposeRole(
                addr1.address,
                ADMIN_ROLE,
                true
            );

            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => tokenDistributionEngine.interface.parseLog(log))
                .find((parsedLog) => parsedLog?.name === "ProposalCreated");

            expect(event?.args?.target).to.equal(addr1.address);
            expect(event?.args?.role).to.equal(ADMIN_ROLE);
            expect(event?.args?.isAdd).to.be.true;
        });

        it("should revert when proposing role to zero address", async () => {
            const ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
            await expect(
                tokenDistributionEngine.connect(owner).proposeRole(
                    ZeroAddress,
                    ADMIN_ROLE,
                    true
                )
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
        });

        it("should revert when non-admin proposes role", async () => {
            const ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
            await expect(
                tokenDistributionEngine.connect(addr1).proposeRole(
                    addr1.address,
                    ADMIN_ROLE,
                    true
                )
            ).to.be.reverted;
        });

        it("should revert when proposing invalid role", async () => {
            const INVALID_ROLE = ethers.id("INVALID_ROLE");
            await expect(
                tokenDistributionEngine.connect(owner).proposeRole(
                    addr1.address,
                    INVALID_ROLE,
                    true
                )
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidRole");
        });

        it("should revert when contract is paused", async () => {
            await tokenDistributionEngine.connect(admin).emergencyAction(true);
            const ADMIN_ROLE = await tokenDistributionEngine.ADMIN_ROLE();
            
            await expect(
                tokenDistributionEngine.connect(owner).proposeRole(
                    addr1.address,
                    ADMIN_ROLE,
                    true
                )
            ).to.be.revertedWithCustomError(tokenDistributionEngine, "EnforcedPause");
        });
    });
});

describe("TokenDistributionEngine - Contract Upgrade", () => {
  let tokenDistributionEngine: TokenDistributionEngine;
  let tokenDistributionEngineV2: TokenDistributionEngine;
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

      // Deploy V2 implementation
      const TokenDistributionEngineV2 = await ethers.getContractFactory("TokenDistributionEngine");
      tokenDistributionEngineV2 = await TokenDistributionEngineV2.deploy() as TokenDistributionEngine;
      await tokenDistributionEngineV2.waitForDeployment();
  });

  describe("Contract Upgrade Process", () => {
      it("should successfully propose and execute upgrade", async () => {
          // Propose upgrade
          const proposalId = await tokenDistributionEngine.connect(owner).proposeUpgrade(
              await tokenDistributionEngineV2.getAddress()
          );

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
          expect(implementationAddress.toLowerCase()).to.equal(
              (await tokenDistributionEngineV2.getAddress()).toLowerCase()
          );
      });

      it("should revert when proposing upgrade to zero address", async () => {
          await expect(
              tokenDistributionEngine.connect(owner).proposeUpgrade(ZeroAddress)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "InvalidAddress");
      });

      it("should revert when non-admin proposes upgrade", async () => {
          await expect(
              tokenDistributionEngine.connect(addr1).proposeUpgrade(
                  await tokenDistributionEngineV2.getAddress()
              )
          ).to.be.reverted;
      });

      it("should revert when executing upgrade without enough approvals", async () => {
          const proposalId = await tokenDistributionEngine.connect(owner).proposeUpgrade(
              await tokenDistributionEngineV2.getAddress()
          );

          await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);

          await expect(
              tokenDistributionEngine.connect(owner).executeProposal(proposalId)
          ).to.be.revertedWithCustomError(
              tokenDistributionEngine, 
              "ProposalExecutionError"
          );
      });

      it("should revert when executing upgrade before delay period", async () => {
          const proposalId = await tokenDistributionEngine.connect(owner).proposeUpgrade(
              await tokenDistributionEngineV2.getAddress()
          );

          await tokenDistributionEngine.connect(admin).approveProposal(proposalId);

          await expect(
              tokenDistributionEngine.connect(owner).executeProposal(proposalId)
          ).to.be.revertedWithCustomError(
              tokenDistributionEngine, 
              "ProposalExecutionError"
          );
      });

      it("should revert when proposal expires", async () => {
          const proposalId = await tokenDistributionEngine.connect(owner).proposeUpgrade(
              await tokenDistributionEngineV2.getAddress()
          );

          await ethers.provider.send("evm_increaseTime", [4 * 24 * 60 * 60]); // 4 days
          await ethers.provider.send("evm_mine", []);

          await expect(
              tokenDistributionEngine.connect(admin).approveProposal(proposalId)
          ).to.be.revertedWithCustomError(tokenDistributionEngine, "ProposalError");
      });
  });
});
