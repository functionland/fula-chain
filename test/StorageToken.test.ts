import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { StorageToken } from "../typechain-types/StorageToken";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ZeroAddress } from "ethers";

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
      [owner, admin, addr1] = await ethers.getSigners();
      const StorageToken = await ethers.getContractFactory("StorageToken");
      storageToken = (await upgrades.deployProxy(StorageToken, [
        owner.address,
        admin.address,
        TOTAL_SUPPLY / BigInt(2)
      ])) as StorageToken;
      await storageToken.waitForDeployment();
    });
  
    describe("initialize", () => {
      it("should properly initialize the contract with all features", async () => {
        const StorageToken = await ethers.getContractFactory("StorageToken");
        
        // Test zero address validation
        await expect(
          upgrades.deployProxy(StorageToken, [
            ZeroAddress,
            admin.address,
            TOTAL_SUPPLY
          ])
        ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");
  
        // Test initial supply validation
        await expect(
          upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY + BigInt(1)
          ])
        ).to.be.revertedWith("Exceeds maximum supply");
  
        // Verify initial state
        expect(await storageToken.name()).to.equal("Placeholder Token");
        expect(await storageToken.symbol()).to.equal("PLACEHOLDER");
        expect(await storageToken.totalSupply()).to.equal(TOTAL_SUPPLY / BigInt(2));
        const contractAddress = await storageToken.getAddress();
        expect(await storageToken.balanceOf(contractAddress)).to.equal(TOTAL_SUPPLY / BigInt(2));
  
        // Verify roles
        const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
        expect(await storageToken.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
        expect(await storageToken.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
  
        // Verify role timelocks
        const roleChangeTimeLock = 24 * 60 * 60;
        
        // Try to perform an admin action immediately
        await expect(
          storageToken.connect(owner).removeAdmin(addr1.address)
        ).to.be.revertedWithCustomError(storageToken, "TimeLockActive");
  
        // Advance time past the timelock
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
  
        // Verify can't initialize again
        await expect(
          storageToken.initialize(owner.address, admin.address, TOTAL_SUPPLY)
        ).to.be.revertedWithCustomError(storageToken, "InvalidInitialization");
  
        // Verify version
        expect(await storageToken.version()).to.equal(1);
      });
    });

    describe("transferOwnership", () => {
        beforeEach(async() => {
            const roleChangeTimeLock = 24 * 60 * 60;
            // Advance time past the timelock
            await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        });
        it("should properly handle ownership transfer with all features", async () => {
            // Test transfer when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).transferOwnership(addr1.address)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause for further tests
            await expect(
                storageToken.connect(owner).emergencyUnpauseToken()
            ).to.be.revertedWithCustomError(storageToken, "CoolDownActive");

            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-owner transfer attempt
            await expect(
                storageToken.connect(addr1).transferOwnership(addr1.address)
            ).to.be.revertedWithCustomError(storageToken, "OwnableUnauthorizedAccount");

            // Test transfer to zero address
            await expect(
                storageToken.connect(owner).transferOwnership(ZeroAddress)
            ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");

            // Test successful transfer initiation
            await storageToken.connect(owner).transferOwnership(addr1.address);

            // Verify pending owner
            const contractAddress = await storageToken.getAddress();
            await expect(
                storageToken.connect(admin).acceptOwnership()
            ).to.be.revertedWith("Not pending owner");

            // Test successful ownership acceptance
            await storageToken.connect(addr1).acceptOwnership();
            expect(await storageToken.owner()).to.equal(addr1.address);

            // Verify old owner lost ownership
            await expect(
                storageToken.connect(owner).transferOwnership(admin.address)
            ).to.be.revertedWithCustomError(storageToken, "OwnableUnauthorizedAccount");
        });
    });
  });
  

  describe("StorageToken Proposal Creation", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock using TimeConfig
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("createProposal", () => {
        it("should properly handle proposal creation with all features", async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            
            // Test proposal creation when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).createProposal(
                    3, // ProposalType.Whitelist
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-admin proposal creation
            await expect(
                storageToken.connect(addr1).createProposal(
                    3, //whitelist
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test zero address target
            await expect(
                storageToken.connect(owner).createProposal(
                    3, //whitelist
                    ZeroAddress,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");

            // Test invalid quorum using RoleConfig
            await expect(
                storageToken.connect(owner).createProposal(
                    3,
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "InvalidQuorumErr");

            // Set quorum using RoleConfig
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

            // Test successful whitelist proposal
            const tx = await storageToken.connect(owner).createProposal(
                3,
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            // Verify proposal creation with packed structs
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            expect(event?.args?.proposalType).to.be.eq(3);

            // Test duplicate proposal with packed PendingProposals
            await expect(
                storageToken.connect(owner).createProposal(
                    3,
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "ExistingActiveProposal");

            // Test role change proposal
            await expect(
                storageToken.connect(owner).createProposal(
                    0,
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                )
            ).to.be.revertedWithCustomError(storageToken, "InvalidRole");

            const tx2 = await storageToken.connect(owner).createProposal(
                0,
                addr1.address,
                storageToken.ADMIN_ROLE(),
                0,
                ZeroAddress,
                true
            );

            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            expect(event2?.args?.proposalType).to.be.eq(0);

            // Verify proposal count with packed structs
            const proposalDetails = await storageToken.getPendingProposals(0, 10);
            expect(proposalDetails.proposalIds.length).to.be.equal(2);
        });
    });
});

describe("StorageToken Proposal Approval", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("approveProposal", () => {
        let proposalId: string;
        let proposalId2: string;
    
        beforeEach(async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    
            // Create proposal with whitelist type
            const tx = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            proposalId = event?.args?.proposalId;

            const tx2 = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                owner.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            proposalId2 = event2?.args?.proposalId;
    
            // Handle timelock for admin using TimeConfig
            const roleChangeTimeLock = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
            await ethers.provider.send("evm_mine", []);
        });
    
        it("should properly handle proposal approval with all features", async () => {
            // Test approval when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(admin).approveProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    
            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();
    
            // Test non-admin approval attempt
            await expect(
                storageToken.connect(addr1).approveProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");
    
            // Test invalid proposal ID
            await expect(
                storageToken.connect(admin).approveProposal(ethers.ZeroHash)
            ).to.be.revertedWithCustomError(storageToken, "ProposalNotFoundErr");

            // Test duplicate approval
            await expect(
                storageToken.connect(owner).approveProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "ProposalAlreadyApprovedErr");
    
            // Get proposal details before approval to verify flags
            const beforeDetails = await storageToken.getProposalDetails(proposalId);
            expect((beforeDetails.flags & 1) === 0).to.be.true; // Check executed flag is false
    
            // Test successful approval
            const tx = await storageToken.connect(admin).approveProposal(proposalId);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalApproved");
            expect(event?.args?.proposalId).to.equal(proposalId);
    
            // Test already executed approval
            await expect(
                storageToken.connect(admin).approveProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "ProposalAlreadyExecutedErr");
    
            // Test proposal expiry
            const proposalTimeout = 48 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [proposalTimeout + 1]);
            await ethers.provider.send("evm_mine", []);
    
            await expect(
                storageToken.connect(admin).approveProposal(proposalId2)
            ).to.be.revertedWithCustomError(storageToken, "ProposalExpiredErr");
    
            // Verify proposal was deleted after expiry
            const proposalDetails = await storageToken.getPendingProposals(0, 10);
            expect(proposalDetails.proposalIds.length).to.equal(0);
        });
    });
      
});

describe("StorageToken Proposal Execution", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("executeProposal", () => {
        let proposalId: string;
        
        beforeEach(async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    
            const tx = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            proposalId = event?.args?.proposalId;
    
            // Add delay after proposal creation to ensure execution time hasn't passed
            await ethers.provider.send("evm_increaseTime", [1]);
            await ethers.provider.send("evm_mine", []);
        });
    
        it("should properly handle proposal execution with all features", async () => {
            // Test execution when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).executeProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    
            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();
    
            // Test non-admin execution attempt
            await expect(
                storageToken.connect(addr1).executeProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");
    
            // Test invalid proposal ID
            await expect(
                storageToken.connect(owner).executeProposal(ethers.ZeroHash)
            ).to.be.revertedWithCustomError(storageToken, "ProposalNotFoundErr");
    
            // Test execution without sufficient approvals
            await expect(
                storageToken.connect(owner).executeProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "InsufficientApprovalsErr");
    
            // Add approval
            await storageToken.connect(admin).approveProposal(proposalId);
            
            // Wait for execution delay
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await ethers.provider.send("evm_mine", []);
    
            // Test successful execution
            const tx = await storageToken.connect(owner).executeProposal(proposalId);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalExecuted");
            expect(event?.args?.proposalId).to.equal(proposalId);
    
            // Verify proposal was executed by checking executed
            const proposalDetails = await storageToken.getProposalDetails(proposalId);
            expect(proposalDetails.executed).to.be.true; // Check executed flag
    
            // Test re-execution attempt
            await expect(
                storageToken.connect(owner).executeProposal(proposalId)
            ).to.be.revertedWithCustomError(storageToken, "ProposalAlreadyExecutedErr");
        });
    });
    
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let operator: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, operator] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("removeFromWhitelist and transferFromContract", () => {
        let proposalId: string;

        beforeEach(async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            // Create and execute operator role proposal
            const tx = await storageToken.connect(owner).createProposal(
                0, // RoleChange
                operator.address,
                CONTRACT_OPERATOR_ROLE,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            proposalId = event?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Set transaction limit for operator
            await storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));

            // Create and execute whitelist proposal for addr1
            const tx2 = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId2 = event2?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId2);
            
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId2);

            // Wait for whitelist lock to expire
            const whitelistLock = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [whitelistLock + 1]);
        });

        it("should properly handle whitelist removal and transfers", async () => {
            // Test transfer before removal
            await storageToken.connect(operator).transferFromContract(addr1.address, TOKEN_UNIT);
            expect(await storageToken.balanceOf(addr1.address)).to.equal(TOKEN_UNIT);

            // Test removal when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).removeFromWhitelist(addr1.address)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test transfer exceeding limit
            const largeAmount = TOKEN_UNIT * BigInt(1001);
            await expect(
                storageToken.connect(operator).transferFromContract(addr1.address, largeAmount)
            ).to.be.revertedWithCustomError(storageToken, "LowAllowance");

            // Remove from whitelist
            await storageToken.connect(owner).removeFromWhitelist(addr1.address);

            // Verify transfer fails after removal
            await expect(
                storageToken.connect(operator).transferFromContract(addr1.address, TOKEN_UNIT)
            ).to.be.revertedWithCustomError(storageToken, "NotWhitelisted");
            
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, bridgeOperator] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("bridgeMint", () => {
        beforeEach(async () => {
            // Setup bridge operator role
            const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            const tx = await storageToken.connect(owner).createProposal(
                0, // RoleChange
                bridgeOperator.address,
                BRIDGE_OPERATOR_ROLE,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Set transaction limit for bridge operator
            await storageToken.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));

            // Set supported chain
            await storageToken.connect(owner).setSupportedChain(1, true);
        });

        it("should properly handle bridge minting with all features", async () => {
            // Test mint when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-bridge operator mint attempt
            await expect(
                storageToken.connect(addr1).bridgeMint(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test unsupported chain
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOKEN_UNIT, 2, 1)
            ).to.be.revertedWithCustomError(storageToken, "UnsupportedChain");

            // Test timelock
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOTAL_SUPPLY + BigInt(1), 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "TimeLockActive");

            const timeLockDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [timeLockDelay + 1]); 

            // Test exceeding total supply
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOTAL_SUPPLY + BigInt(1), 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "ExceedsMaximumSupply");

            // Test exceeding transaction limit
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOKEN_UNIT * BigInt(1001), 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "LowAllowance");

            // Test successful mint
            const mintAmount = TOKEN_UNIT * BigInt(100);
            const tx = await storageToken.connect(bridgeOperator).bridgeMint(mintAmount, 1, 1);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "BridgeOperationDetails");

            expect(event?.args?.operation).to.equal("MINT");
            expect(event?.args?.amount).to.equal(mintAmount);
            expect(event?.args?.chainId).to.equal(1);

            // Test duplicate nonce
            await expect(
                storageToken.connect(bridgeOperator).bridgeMint(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "UsedNonce");

            // Verify contract balance increased
            const contractAddress = await storageToken.getAddress();
            expect(await storageToken.balanceOf(contractAddress)).to.equal(
                (TOTAL_SUPPLY / BigInt(2)) + mintAmount
            );
        });
    });
});


describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, bridgeOperator] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("bridgeBurn", () => {
        beforeEach(async () => {
            // Setup bridge operator role
            const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            const tx = await storageToken.connect(owner).createProposal(
                0, // RoleChange
                bridgeOperator.address,
                BRIDGE_OPERATOR_ROLE,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Set transaction limit for bridge operator
            await storageToken.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));

            // Set supported chain
            await storageToken.connect(owner).setSupportedChain(1, true);
        });

        it("should properly handle bridge burning with all features", async () => {
            // Test burn when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(bridgeOperator).bridgeBurn(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-bridge operator burn attempt
            await expect(
                storageToken.connect(addr1).bridgeBurn(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test unsupported chain
            await expect(
                storageToken.connect(bridgeOperator).bridgeBurn(TOKEN_UNIT, 2, 1)
            ).to.be.revertedWithCustomError(storageToken, "UnsupportedChain");

            // Test time lock
            await expect(
                storageToken.connect(bridgeOperator).bridgeBurn(TOKEN_UNIT * BigInt(1001), 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "TimeLockActive");

            const timeLockDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [timeLockDelay + 1]); 

            // Test exceeding transaction limit
            await expect(
                storageToken.connect(bridgeOperator).bridgeBurn(TOKEN_UNIT * BigInt(1001), 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "LowAllowance");

            // Test successful burn
            const burnAmount = TOKEN_UNIT * BigInt(100);
            const initialBalance = await storageToken.balanceOf(await storageToken.getAddress());
            
            const tx = await storageToken.connect(bridgeOperator).bridgeBurn(burnAmount, 1, 1);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "BridgeOperationDetails");

            expect(event?.args?.operation).to.equal("BURN");
            expect(event?.args?.amount).to.equal(burnAmount);
            expect(event?.args?.chainId).to.equal(1);

            // Verify balance decreased
            const contractAddress = await storageToken.getAddress();
            expect(await storageToken.balanceOf(contractAddress)).to.equal(
                initialBalance - burnAmount
            );

            // Test duplicate nonce
            await expect(
                storageToken.connect(bridgeOperator).bridgeBurn(TOKEN_UNIT, 1, 1)
            ).to.be.revertedWithCustomError(storageToken, "UsedNonce");
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("setSupportedChain", () => {
        it("should properly handle chain support settings with all features", async () => {
            // Test when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).setSupportedChain(1, true)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-admin attempt
            await expect(
                storageToken.connect(addr1).setSupportedChain(1, true)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test invalid chain ID
            await expect(
                storageToken.connect(owner).setSupportedChain(0, true)
            ).to.be.revertedWithCustomError(storageToken, "InvalidChainId");

            // Test successful chain support setting
            const tx = await storageToken.connect(owner).setSupportedChain(1, true);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");

            expect(event?.args?.chainId).to.equal(1);
            expect(event?.args?.supported).to.be.true;
            expect(event?.args?.caller).to.equal(owner.address);

            // Verify chain support status
            expect(await storageToken.supportedChains(1)).to.be.true;

            // Test chain support removal
            await storageToken.connect(owner).setSupportedChain(1, false);
            expect(await storageToken.supportedChains(1)).to.be.false;

            // Test timelock restriction
            const newAdmin = addr1;
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            
            // Grant admin role to new address
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            const tx2 = await storageToken.connect(owner).createProposal(
                0, // RoleChange
                newAdmin.address,
                ADMIN_ROLE,
                0,
                ZeroAddress,
                true
            );
            
            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event2?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Try to set chain support before timelock expires
            await expect(
                storageToken.connect(newAdmin).setSupportedChain(2, true)
            ).to.be.revertedWithCustomError(storageToken, "TimeLockActive");
        });
    });
});


describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("emergencyPauseToken and emergencyUnpauseToken", () => {
        it("should properly handle emergency actions with all features", async () => {
            // Test non-admin pause attempt
            await expect(
                storageToken.connect(addr1).emergencyPauseToken()
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test successful pause
            const tx = await storageToken.connect(owner).emergencyPauseToken();
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");

            expect(event?.args?.action).to.equal("Contract paused");
            expect(event?.args?.caller).to.equal(owner.address);

            // Test pause when already paused
            await expect(
                storageToken.connect(owner).emergencyPauseToken()
            ).to.be.revertedWithCustomError(storageToken, "CoolDownActive");

            // Test unpause before cooldown
            await expect(
                storageToken.connect(owner).emergencyUnpauseToken()
            ).to.be.revertedWithCustomError(storageToken,"CoolDownActive");

            // Advance time past cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await ethers.provider.send("evm_mine", []);

            // Test successful unpause
            const tx2 = await storageToken.connect(owner).emergencyUnpauseToken();
            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");

            expect(event2?.args?.action).to.equal("Contract unpaused");
            expect(event2?.args?.caller).to.equal(owner.address);

            // Test contract functionality after unpause
            await storageToken.connect(owner).setSupportedChain(1, true);

            // Test pause with new admin
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            const tx3 = await storageToken.connect(owner).createProposal(
                0, // RoleChange
                addr1.address,
                ADMIN_ROLE,
                0,
                ZeroAddress,
                true
            );
            
            const receipt3 = await tx3.wait();
            const event3 = receipt3?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event3?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Test pause with new admin before timelock expires
            await expect(
                storageToken.connect(addr1).emergencyPauseToken()
            ).to.be.revertedWithCustomError(storageToken, "TimeLockActive");
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let admin2: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, admin2, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);

        // Add another admin for testing removal
        const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        
        const tx = await storageToken.connect(owner).createProposal(
            0, // RoleChange
            admin2.address,
            ADMIN_ROLE,
            0,
            ZeroAddress,
            true
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs
            .map((log) => {
                try {
                    return storageToken.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
        
        const proposalId = event?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId);
        
        const executionDelay = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
        await storageToken.connect(owner).executeProposal(proposalId);
    });

    describe("removeAdmin", () => {
        it("should properly handle admin removal with all features", async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();

            // Test removal when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).removeAdmin(admin.address)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-admin removal attempt
            await expect(
                storageToken.connect(addr1).removeAdmin(admin.address)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test zero address removal
            await expect(
                storageToken.connect(owner).removeAdmin(ZeroAddress)
            ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");

            // Test self-removal
            await expect(
                storageToken.connect(owner).removeAdmin(owner.address)
            ).to.be.revertedWithCustomError(storageToken, "CannotRemoveSelf");

            // Test successful admin removal
            const tx = await storageToken.connect(owner).removeAdmin(admin2.address);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "RoleUpdated");

            expect(event?.args?.target).to.equal(admin2.address);
            expect(event?.args?.role).to.equal(ADMIN_ROLE);
            expect(event?.args?.status).to.be.false;

            // Verify admin was removed
            expect(await storageToken.hasRole(ADMIN_ROLE, admin2.address)).to.be.false;

            // Test removing last two admins
            await expect(
                storageToken.connect(owner).removeAdmin(admin.address)
            ).to.be.revertedWithCustomError(storageToken, "MinimumRoleNoRequired");
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let addr2: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, addr2] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);

        // Setup initial token balance for testing transfers
        const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
        const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
        
        // Set quorum for admin role
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

        // Create and execute operator role proposal
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
            .map((log) => {
                try {
                    return storageToken.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
        
        const proposalId = event?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId);
        
        const executionDelay = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
        await storageToken.connect(owner).executeProposal(proposalId);

        // Set transaction limit for operator
        await storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));

        // Create and execute whitelist proposal for addr2
        const tx2 = await storageToken.connect(owner).createProposal(
            3, // Whitelist
            addr2.address,
            ethers.ZeroHash,
            0,
            ZeroAddress,
            true
        );
        
        const receipt2 = await tx2.wait();
        const event2 = receipt2?.logs
            .map((log) => {
                try {
                    return storageToken.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
        
        const proposalId2 = event2?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId2);
        
        await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
        await storageToken.connect(owner).executeProposal(proposalId2);

        // Wait for whitelist lock to expire
        const whitelistLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [whitelistLock + 1]);
    });

    describe("transfer", () => {
        it("should properly handle token transfers with all features", async () => {
            // Test transfer when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(addr1).transfer(addr2.address, TOKEN_UNIT)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test zero amount transfer
            await expect(
                storageToken.connect(addr1).transfer(addr2.address, 0)
            ).to.be.revertedWithCustomError(storageToken, "AmountMustBePositive");

            // Test transfer to zero address
            await expect(
                storageToken.connect(addr1).transfer(ZeroAddress, TOKEN_UNIT)
            ).to.be.revertedWithCustomError(storageToken, "InvalidAddress");

            // Test successful transfer from contract to whitelisted address
            const transferAmount = TOKEN_UNIT * BigInt(50);
            await storageToken.connect(addr1).transferFromContract(addr2.address, transferAmount);

            // Test normal transfer between accounts
            await storageToken.connect(addr2).transfer(addr1.address, transferAmount);

            // Verify balances
            expect(await storageToken.balanceOf(addr1.address)).to.equal(transferAmount);
            expect(await storageToken.balanceOf(addr2.address)).to.equal(0);

            // Verify activity timestamp updated
            const lastActivity = await storageToken.getRoleActivity(addr2.address);
            const blockTimestamp = (await ethers.provider.getBlock("latest"))?.timestamp;
            expect(lastActivity).to.equal(blockTimestamp);
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("setRoleQuorum", () => {
        it("should properly handle role quorum settings with all features", async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
            const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();

            // Test when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2)
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-admin attempt
            await expect(
                storageToken.connect(addr1).setRoleQuorum(ADMIN_ROLE, 2)
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test invalid quorum (less than 2)
            await expect(
                storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 1)
            ).to.be.revertedWithCustomError(storageToken, "InvalidQuorumErr");

            // Test successful quorum setting for all roles
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            await storageToken.connect(owner).setRoleQuorum(CONTRACT_OPERATOR_ROLE, 3);
            await storageToken.connect(owner).setRoleQuorum(BRIDGE_OPERATOR_ROLE, 4);

            // Verify quorum values
            expect(await storageToken.getRoleQuorum(ADMIN_ROLE)).to.equal(2);
            expect(await storageToken.getRoleQuorum(CONTRACT_OPERATOR_ROLE)).to.equal(3);
            expect(await storageToken.getRoleQuorum(BRIDGE_OPERATOR_ROLE)).to.equal(4);

            // Test quorum update
            const tx = await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 5);
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "QuorumUpdated");

            expect(event?.args?.role).to.equal(ADMIN_ROLE);
            expect(event?.args?.newQuorum).to.equal(5);
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("checkRoleActivity", () => {
        it("should properly track role activity with all features", async () => {
            // Test initial state (no activity)
            expect(await storageToken.checkRoleActivity(addr1.address)).to.be.false;

            // Setup contract operator role
            const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            // Create and execute operator role proposal
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
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            // Create and execute whitelist proposal for addr1
            const tx2 = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt2 = await tx2.wait();
            const event2 = receipt2?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId2 = event2?.args?.proposalId;
            await storageToken.connect(admin).approveProposal(proposalId2);
            
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId2);

            // Wait for whitelist lock to expire
            const whitelistLock = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [whitelistLock + 1]);

            // Set transaction limit and perform action
            await storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));
            await storageToken.connect(addr1).transferFromContract(addr1.address, TOKEN_UNIT);
            expect(await storageToken.checkRoleActivity(addr1.address)).to.be.true;

            // Test activity after inactivity period
            const inactivityThreshold = 365 * 24 * 60 * 60; // 365 days in seconds
            await ethers.provider.send("evm_increaseTime", [inactivityThreshold + 1]);
            await ethers.provider.send("evm_mine", []);

            expect(await storageToken.checkRoleActivity(addr1.address)).to.be.false;
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("setRoleTransactionLimit", () => {
        it("should properly handle role transaction limits with all features", async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
            const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();

            // Test when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000))
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");

            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();

            // Test non-admin attempt
            await expect(
                storageToken.connect(addr1).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000))
            ).to.be.revertedWithCustomError(storageToken, "AccessControlUnauthorizedAccount");

            // Test setting limits for different roles
            const tx = await storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(1000));
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "TransactionLimitUpdated");

            expect(event?.args?.role).to.equal(CONTRACT_OPERATOR_ROLE);
            expect(event?.args?.newLimit).to.equal(TOKEN_UNIT * BigInt(1000));

            // Set and verify limits for other roles
            await storageToken.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, TOKEN_UNIT * BigInt(2000));
            await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOKEN_UNIT * BigInt(3000));

            // Verify limits were set correctly
            expect(await storageToken.getRoleTransactionLimit(CONTRACT_OPERATOR_ROLE)).to.equal(TOKEN_UNIT * BigInt(1000));
            expect(await storageToken.getRoleTransactionLimit(BRIDGE_OPERATOR_ROLE)).to.equal(TOKEN_UNIT * BigInt(2000));
            expect(await storageToken.getRoleTransactionLimit(ADMIN_ROLE)).to.equal(TOKEN_UNIT * BigInt(3000));

            // Verify activity timestamp updated
            const lastActivity = await storageToken.getRoleActivity(owner.address);
            const blockTimestamp = (await ethers.provider.getBlock("latest"))?.timestamp;
            expect(lastActivity).to.equal(blockTimestamp);
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let addr2: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, addr2] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("StorageToken", () => {
        let storageToken: StorageToken;
        let owner: SignerWithAddress;
        let admin: SignerWithAddress;
        let addr1: SignerWithAddress;
        let addr2: SignerWithAddress;
        const TOKEN_UNIT = ethers.parseEther("1");
        const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
      
        beforeEach(async () => {
            [owner, admin, addr1, addr2] = await ethers.getSigners();
            const StorageToken = await ethers.getContractFactory("StorageToken");
            storageToken = (await upgrades.deployProxy(StorageToken, [
                owner.address,
                admin.address,
                TOTAL_SUPPLY / BigInt(2)
            ])) as StorageToken;
            await storageToken.waitForDeployment();
    
            // Handle timelock
            const roleChangeTimeLock = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
            await ethers.provider.send("evm_mine", []);
        });
    
        describe("getPendingProposals", () => {
            it("should properly handle pending proposals retrieval with all features", async () => {
                const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
                await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    
                // Create multiple proposals of different types
                const tx1 = await storageToken.connect(owner).createProposal(
                    3, // Whitelist
                    addr1.address,
                    ethers.ZeroHash,
                    0,
                    ZeroAddress,
                    true
                );
                
                const receipt1 = await tx1.wait();
                const event1 = receipt1?.logs
                    .map((log) => {
                        try {
                            return storageToken.interface.parseLog(log);
                        } catch (e) {
                            return null;
                        }
                    })
                    .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
                
                const proposalId1 = event1?.args?.proposalId;
    
                // Create another proposal
                const tx2 = await storageToken.connect(owner).createProposal(
                    0, // RoleChange
                    addr2.address,
                    ADMIN_ROLE,
                    0,
                    ZeroAddress,
                    true
                );
                
                const receipt2 = await tx2.wait();
                const event2 = receipt2?.logs
                    .map((log) => {
                        try {
                            return storageToken.interface.parseLog(log);
                        } catch (e) {
                            return null;
                        }
                    })
                    .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
                
                const proposalId2 = event2?.args?.proposalId;
    
                // Get pending proposals with pagination
                const pendingProposals = await storageToken.getPendingProposals(0, 10);
                
                // Verify number of pending proposals
                expect(pendingProposals.proposalIds.length).to.equal(2);
                expect(pendingProposals.types.length).to.equal(2);
                expect(pendingProposals.targets.length).to.equal(2);
                expect(pendingProposals.expiryTimes.length).to.equal(2);
                expect(pendingProposals.executed.length).to.equal(2);
                expect(pendingProposals.total).to.equal(2);
    
                // Verify proposal details
                expect(pendingProposals.targets).to.include(addr1.address);
                expect(pendingProposals.targets).to.include(addr2.address);
                expect(pendingProposals.types).to.include(BigInt(3)); // Whitelist
                expect(pendingProposals.types).to.include(BigInt(0)); // RoleChange
                expect(pendingProposals.executed).to.deep.equal([false, false]);
    
                // Test pagination
                const paginatedProposals = await storageToken.getPendingProposals(1, 1);
                expect(paginatedProposals.proposalIds.length).to.equal(1);
                expect(paginatedProposals.total).to.equal(2);
    
                // Execute one proposal
                await storageToken.connect(admin).approveProposal(proposalId1);
                const executionDelay = 24 * 60 * 60;
                await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
                await storageToken.connect(owner).executeProposal(proposalId1);
    
                // Verify updated pending proposals
                const updatedPendingProposals = await storageToken.getPendingProposals(0, 10);
                expect(updatedPendingProposals.proposalIds.length).to.equal(1);
                expect(updatedPendingProposals.targets[0]).to.equal(addr2.address);
                expect(updatedPendingProposals.types[0]).to.equal(0); // RoleChange
                expect(updatedPendingProposals.total).to.equal(2);
    
                // Let a proposal expire
                const proposalTimeout = 48 * 60 * 60;
                await ethers.provider.send("evm_increaseTime", [proposalTimeout + 1]);
                await ethers.provider.send("evm_mine", []);
    
                // Verify no pending proposals after expiry
                const finalPendingProposals = await storageToken.getPendingProposals(0, 10);
                expect(finalPendingProposals.proposalIds.length).to.equal(0);
                expect(finalPendingProposals.total).to.equal(2);
            });
    
            it("should handle pagination limits correctly", async () => {
                await expect(
                    storageToken.getPendingProposals(0, 51)
                ).to.be.revertedWith("Limit too high");
            });
        });
    });    
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("getProposalDetails", () => {
        let proposalId: string;

        beforeEach(async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            // Create a test proposal
            const tx = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            proposalId = event?.args?.proposalId;
        });

        it("should properly retrieve proposal details with all features", async () => {
            // Test non-existent proposal
            await expect(
                storageToken.getProposalDetails(ethers.ZeroHash)
            ).to.be.revertedWithCustomError(storageToken, "ProposalNotFoundErr");

            // Get proposal details
            const details = await storageToken.connect(addr1).getProposalDetails(proposalId);
            
            // Verify proposal details
            expect(details.proposalType).to.equal(3); // Whitelist
            expect(details.target).to.equal(addr1.address);
            expect(details.role).to.equal(ethers.ZeroHash);
            expect(details.amount).to.equal(0);
            expect(details.tokenAddress).to.equal(ZeroAddress);
            expect(details.isAdd).to.be.true;
            expect(details.approvals).to.equal(1);
            expect(details.executed).to.be.false;
            expect(details.hasApproved).to.be.false; // For non-creator caller

            // Get details as proposal creator
            const creatorDetails = await storageToken.connect(owner).getProposalDetails(proposalId);
            expect(creatorDetails.hasApproved).to.be.true;

            // Approve proposal and verify updated details
            await storageToken.connect(admin).approveProposal(proposalId);
            const updatedDetails = await storageToken.getProposalDetails(proposalId);
            expect(updatedDetails.approvals).to.equal(2);

            // Execute proposal and verify final state
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            const finalDetails = await storageToken.getProposalDetails(proposalId);
            expect(finalDetails.executed).to.be.true;
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("hasApprovedProposal", () => {
        let proposalId: string;

        beforeEach(async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            
            // Create a test proposal
            const tx = await storageToken.connect(owner).createProposal(
                3, // Whitelist
                addr1.address,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            proposalId = event?.args?.proposalId;
        });

        it("should properly check proposal approvals with all features", async () => {
            // Check creator's approval status
            expect(await storageToken.hasApprovedProposal(proposalId, owner.address)).to.be.true;

            // Check non-approver's status
            expect(await storageToken.hasApprovedProposal(proposalId, addr1.address)).to.be.false;

            // Add another approval
            await storageToken.connect(admin).approveProposal(proposalId);
            expect(await storageToken.hasApprovedProposal(proposalId, admin.address)).to.be.true;

            // Check non-existent proposal
            expect(await storageToken.hasApprovedProposal(ethers.ZeroHash, owner.address)).to.be.false;

            // Execute proposal and verify approvals still exist
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
            await storageToken.connect(owner).executeProposal(proposalId);

            expect(await storageToken.hasApprovedProposal(proposalId, owner.address)).to.be.true;
            expect(await storageToken.hasApprovedProposal(proposalId, admin.address)).to.be.true;
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);
    });

    describe("getRoleTransactionLimit and getRoleQuorum", () => {
        it("should properly handle role limits and quorums with all features", async () => {
            const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
            const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
            const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();

            // Test initial values
            expect(await storageToken.getRoleTransactionLimit(ADMIN_ROLE)).to.equal(0);
            expect(await storageToken.getRoleTransactionLimit(CONTRACT_OPERATOR_ROLE)).to.equal(0);
            expect(await storageToken.getRoleTransactionLimit(BRIDGE_OPERATOR_ROLE)).to.equal(0);
            expect(await storageToken.getRoleQuorum(ADMIN_ROLE)).to.equal(0);
            expect(await storageToken.getRoleQuorum(CONTRACT_OPERATOR_ROLE)).to.equal(0);
            expect(await storageToken.getRoleQuorum(BRIDGE_OPERATOR_ROLE)).to.equal(0);

            // Set and verify transaction limits
            await storageToken.connect(owner).setRoleTransactionLimit(ADMIN_ROLE, TOKEN_UNIT * BigInt(1000));
            await storageToken.connect(owner).setRoleTransactionLimit(CONTRACT_OPERATOR_ROLE, TOKEN_UNIT * BigInt(500));
            await storageToken.connect(owner).setRoleTransactionLimit(BRIDGE_OPERATOR_ROLE, TOKEN_UNIT * BigInt(2000));

            expect(await storageToken.getRoleTransactionLimit(ADMIN_ROLE)).to.equal(TOKEN_UNIT * BigInt(1000));
            expect(await storageToken.getRoleTransactionLimit(CONTRACT_OPERATOR_ROLE)).to.equal(TOKEN_UNIT * BigInt(500));
            expect(await storageToken.getRoleTransactionLimit(BRIDGE_OPERATOR_ROLE)).to.equal(TOKEN_UNIT * BigInt(2000));

            // Set and verify quorums
            await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
            await storageToken.connect(owner).setRoleQuorum(CONTRACT_OPERATOR_ROLE, 3);
            await storageToken.connect(owner).setRoleQuorum(BRIDGE_OPERATOR_ROLE, 4);

            expect(await storageToken.getRoleQuorum(ADMIN_ROLE)).to.equal(2);
            expect(await storageToken.getRoleQuorum(CONTRACT_OPERATOR_ROLE)).to.equal(3);
            expect(await storageToken.getRoleQuorum(BRIDGE_OPERATOR_ROLE)).to.equal(4);

            // Test non-existent role
            const FAKE_ROLE = ethers.id("FAKE_ROLE");
            expect(await storageToken.getRoleTransactionLimit(FAKE_ROLE)).to.equal(0);
            expect(await storageToken.getRoleQuorum(FAKE_ROLE)).to.equal(0);
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();
    });

    describe("tokenUnit and maxSupply", () => {
        it("should return correct token unit and max supply values", async () => {
            // Test tokenUnit
            const unit = await storageToken.tokenUnit();
            expect(unit).to.equal(TOKEN_UNIT);
            
            // Verify unit is 10^18
            expect(unit).to.equal(ethers.parseEther("1"));

            // Test maxSupply
            const max = await storageToken.maxSupply();
            expect(max).to.equal(TOTAL_SUPPLY);
            
            // Verify max supply is 2 billion tokens
            expect(max).to.equal(ethers.parseEther("2000000000"));

            // Verify max supply calculation
            const expectedMaxSupply = BigInt(2000000000) * TOKEN_UNIT;
            expect(max).to.equal(expectedMaxSupply);

            // Verify current total supply is half of max supply
            expect(await storageToken.totalSupply()).to.equal(TOTAL_SUPPLY / BigInt(2));
        });
    });
});

describe("StorageToken", () => {
    let storageToken: StorageToken;
    let owner: SignerWithAddress;
    let admin: SignerWithAddress;
    let addr1: SignerWithAddress;
    let operator: SignerWithAddress;
    const TOKEN_UNIT = ethers.parseEther("1");
    const TOTAL_SUPPLY = ethers.parseEther("2000000000"); // 2 billion tokens
  
    beforeEach(async () => {
        [owner, admin, addr1, operator] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        storageToken = (await upgrades.deployProxy(StorageToken, [
            owner.address,
            admin.address,
            TOTAL_SUPPLY / BigInt(2)
        ])) as StorageToken;
        await storageToken.waitForDeployment();

        // Handle timelock
        const roleChangeTimeLock = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [roleChangeTimeLock + 1]);
        await ethers.provider.send("evm_mine", []);

        // Set quorums for both roles first
        const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
        const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
        await storageToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
        await storageToken.connect(owner).setRoleQuorum(CONTRACT_OPERATOR_ROLE, 2);

        // Setup operator role through proposal
        const tx = await storageToken.connect(owner).createProposal(
            0, // RoleChange
            addr1.address,
            ADMIN_ROLE,
            0,
            ZeroAddress,
            true
        );
        
        const receipt = await tx.wait();
        const event = receipt?.logs
            .map((log) => {
                try {
                    return storageToken.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
        
        const proposalId = event?.args?.proposalId;
        await storageToken.connect(admin).approveProposal(proposalId);
        
        const executionDelay = 24 * 60 * 60;
        await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
        await storageToken.connect(owner).executeProposal(proposalId);
    });

    describe("upgrade", () => {
        it("should properly handle contract upgrades with all features", async () => {
            // Create factory with addr1 signer
            const StorageTokenV2 = await ethers.getContractFactory("StorageToken", addr1);
        
            // Get the implementation address that will be used by the upgrade
            const implementationAddress = await upgrades.prepareUpgrade(
                await storageToken.getAddress(),
                StorageTokenV2
            );

            const executionDelay2 = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay2 + 1]);

            // Create and execute upgrade proposal first
            const tx = await storageToken.connect(addr1).createProposal(
                1, // Upgrade
                implementationAddress,
                ethers.ZeroHash,
                0,
                ZeroAddress,
                true
            );
            
            const receipt = await tx.wait();
            const event = receipt?.logs
                .map((log) => {
                    try {
                        return storageToken.interface.parseLog(log);
                    } catch (e) {
                        return null;
                    }
                })
                .find((parsedLog) => parsedLog && parsedLog.name === "ProposalCreated");
            
            const proposalId = event?.args?.proposalId;
            console.log(`proposalId=${proposalId}`);
            console.log(`implementationAddress=${implementationAddress}`);
    
            // Add approval
            await storageToken.connect(admin).approveProposal(proposalId);
            
            const executionDelay = 24 * 60 * 60;
            await ethers.provider.send("evm_increaseTime", [executionDelay + 1]);
    
            // Now test upgrade when paused
            await storageToken.connect(owner).emergencyPauseToken();
            await expect(
                upgrades.upgradeProxy(
                    await storageToken.getAddress(),
                    StorageTokenV2,
                    { kind: 'uups' }
                )
            ).to.be.revertedWithCustomError(storageToken, "EnforcedPause");
    
            // Unpause with cooldown
            const coolDownLock = 30 * 60;
            await ethers.provider.send("evm_increaseTime", [coolDownLock + 1]);
            await storageToken.connect(owner).emergencyUnpauseToken();
    
            // Test successful upgrade
            const upgradedToken = await upgrades.upgradeProxy(
                await storageToken.getAddress(),
                StorageTokenV2,
                { kind: 'uups' }
            );
            expect(await upgradedToken.version()).to.equal(1);
        });
    });
});

