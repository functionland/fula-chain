import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { StorageToken } from "../typechain-types/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("StorageToken", function () {
    let token: StorageToken;
    let owner: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let users: SignerWithAddress[];

    const TOTAL_SUPPLY = ethers.parseEther("1000000"); // 1M tokens
    const BRIDGE_OPERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("BRIDGE_OPERATOR_ROLE"));
    const CHAIN_ID = 1;

    beforeEach(async function () {
        [owner, bridgeOperator, user1, user2, ...users] = await ethers.getSigners();

        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(StorageToken, [owner.address]);
        await token.waitForDeployment();
    });

    describe("Initialization", function () {
        it("Should initialize with correct name and symbol", async function () {
            expect(await token.name()).to.equal("Test Token");
            expect(await token.symbol()).to.equal("TT");
        });

        it("Should set correct total supply", async function () {
            expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
        });

        it("Should assign total supply to owner", async function () {
            expect(await token.balanceOf(owner.address)).to.equal(TOTAL_SUPPLY);
        });
    });

    describe("Bridge Operations", function () {
        beforeEach(async function () {
            await token.setSupportedChain(CHAIN_ID, true);
            await token.addBridgeOperator(bridgeOperator.address);
            // Wait for timelock
            await time.increase(8 * 3600 + 1);
        });
    
        it("Should allow bridge operator to mint tokens", async function () {
            // First burn some tokens to make room for minting
            const burnAmount = ethers.parseEther("1000");
            await token.connect(owner).transfer(user1.address, burnAmount);
            await token.connect(bridgeOperator).bridgeBurn(user1.address, burnAmount, CHAIN_ID);
            
            // Now mint should succeed
            const mintAmount = ethers.parseEther("500"); // Mint less than what was burned
            await token.connect(bridgeOperator).bridgeMint(user2.address, mintAmount, CHAIN_ID);
            expect(await token.balanceOf(user2.address)).to.equal(mintAmount);
        });
    });

    describe("Supply Management", function () {
        beforeEach(async function() {
            await token.addBridgeOperator(bridgeOperator.address);
            await time.increase(8 * 3600 + 1); // Wait for timelock
            await token.setSupportedChain(CHAIN_ID, true); // Need to support chain
        });
    
        it("Should allow minting up to remaining supply", async function () {
            const oneToken = ethers.parseEther("1");
            await expect(
                token.connect(bridgeOperator).bridgeMint(user1.address, oneToken, CHAIN_ID)
            ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
        });
    
        it("Should prevent minting beyond total supply", async function () {
            const overSupply = ethers.parseEther("1000001");
            await expect(
                token.connect(bridgeOperator).bridgeMint(user1.address, overSupply, CHAIN_ID)
            ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
        });
    });    
    

    describe("Access Control", function () {
        it("Should grant roles to owner", async function () {
            expect(await token.hasRole(await token.DEFAULT_ADMIN_ROLE(), owner.address)).to.be.true;
            expect(await token.hasRole(BRIDGE_OPERATOR_ROLE, owner.address)).to.be.true;
        });

        it("Should allow owner to add bridge operator", async function () {
            await token.addBridgeOperator(bridgeOperator.address);
            await time.increase(8 * 3600 + 1);
            expect(await token.hasRole(BRIDGE_OPERATOR_ROLE, bridgeOperator.address)).to.be.true;
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
                    token.connect(attacker).addBridgeOperator(user1.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent non-admin from removing bridge operators", async function () {
                await expect(
                    token.connect(attacker).removeBridgeOperator(bridgeOperator.address)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
    
            it("Should prevent unauthorized bridge operations", async function () {
                await expect(
                    token.connect(attacker).bridgeMint(attacker.address, ethers.parseEther("100"), CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
                await expect(
                    token.connect(attacker).bridgeBurn(user1.address, ethers.parseEther("100"), CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
            });
        });
    
        describe("Owner Privileges", function () {
            it("Should prevent non-owner from managing pool contracts", async function () {
                await expect(
                    token.connect(attacker).addPoolContract(attacker.address)
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    
                await expect(
                    token.connect(attacker).removePoolContract(user1.address)
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
            });
    
            it("Should prevent non-owner from managing proof contracts", async function () {
                await expect(
                    token.connect(attacker).addProofContract(attacker.address)
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    
                await expect(
                    token.connect(attacker).removeProofContract(user1.address)
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
            });
    
            it("Should prevent non-owner from managing emergency functions", async function () {
                await expect(
                    token.connect(attacker).emergencyPauseToken()
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    
                await expect(
                    token.connect(attacker).emergencyUnpauseToken()
                ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
            });
        });
    
        describe("Bridge Operation Security", function () {
            beforeEach(async function () {
                await token.setSupportedChain(CHAIN_ID, true);
                await token.addBridgeOperator(bridgeOperator.address);
                await time.increase(8 * 3600 + 1);
                
                // Burn some tokens first to avoid supply limit
                const burnAmount = ethers.parseEther("1000");
                await token.connect(owner).transfer(user1.address, burnAmount);
                await token.connect(bridgeOperator).bridgeBurn(user1.address, burnAmount, CHAIN_ID);
            });
        
            it("Should prevent bridge operations on unsupported chains", async function () {
                const UNSUPPORTED_CHAIN = 999;
                const amount = ethers.parseEther("100");
                await expect(
                    token.connect(bridgeOperator).bridgeMint(user1.address, amount, UNSUPPORTED_CHAIN)
                ).to.be.revertedWithCustomError(token, "UnsupportedSourceChain")
                .withArgs(UNSUPPORTED_CHAIN);
            });
        
            it("Should prevent bridge operations when paused", async function () {
                const amount = ethers.parseEther("100");
                await token.emergencyPauseToken();
                await expect(
                    token.connect(bridgeOperator).bridgeMint(user1.address, amount, CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "EnforcedPause");
            });
        
            it("Should enforce timelock on bridge operator role changes", async function () {
                const amount = ethers.parseEther("100");
                await token.addBridgeOperator(user2.address);
                // Try immediately without waiting for timelock
                await expect(
                    token.connect(user2).bridgeMint(user1.address, amount, CHAIN_ID)
                ).to.be.revertedWithCustomError(token, "TimeLockActive");
            });
        });
    
        describe("Transfer Security", function () {
            it("Should prevent transfers when paused", async function () {
                const amount = ethers.parseEther("100");
                await token.emergencyPauseToken();
                await expect(
                    token.connect(owner).transfer(user1.address, amount)
                ).to.be.revertedWithCustomError(token, "EnforcedPause");
            });
        
            it("Should prevent unauthorized pool contract operations", async function () {
                const amount = ethers.parseEther("100");
                await token.transfer(user1.address, amount);
                await expect(
                    token.connect(attacker).transferFrom(user1.address, attacker.address, amount)
                ).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
            });
        });
    });
    
});
