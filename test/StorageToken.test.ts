import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { StorageToken } from "../typechain-types/contracts";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { Contract } from "ethers";

const WHITELIST_LOCK_DURATION = 24 * 60 * 60;
const INITIAL_MINTED_TOKENS = ethers.parseEther("1000000"); // 1M tokens
const MAX_SUPPLY = ethers.parseEther("2000000000");

describe("StorageToken", function () {
    let token: StorageToken;
    let owner: SignerWithAddress;
    let bridgeOperator: SignerWithAddress;
    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let users: SignerWithAddress[];
    

    beforeEach(async () => {
        [owner, ...users] = await ethers.getSigners();
        const StorageToken = await ethers.getContractFactory("StorageToken");
        token = await upgrades.deployProxy(StorageToken, [owner.address, INITIAL_MINTED_TOKENS], {
            initializer: 'initialize'
        }) as StorageToken;;
        await token.waitForDeployment();
    });

    it("should initialize correctly", async () => {
        const deploymentTx = await token.deploymentTransaction();
        const receipt = await deploymentTx.wait();
        const logs = receipt?.logs;
        if (!logs) {
            throw new Error("TokensMinted logs not found");
        }
        const event = logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "TokensMinted");
        if (!event) {
            throw new Error("TokensMinted event not found");
        }
    
        expect(await token.name()).to.equal("Placeholder Token");
        expect(await token.symbol()).to.equal("PLACEHOLDER");
        expect(await token.hasRole(await token.ADMIN_ROLE(), owner.address)).to.be.true;
        expect(await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), owner.address)).to.be.true;
        expect(await token.totalSupply()).to.equal(INITIAL_MINTED_TOKENS);
        expect(event?.args?.amount).to.equal(INITIAL_MINTED_TOKENS);
    });
    it("should add wallet to whitelist with lock duration", async () => {
        const wallet = users[0].address;
        const tx = await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
        const receipt = await tx.wait();
    
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "WalletWhitelistedWithLock");
        if (!event) {
            throw new Error("TokensMinted event not found");
        }
    
        expect(event?.args?.lockUntil).to.be.closeTo(
            (await ethers.provider.getBlock("latest")).timestamp + WHITELIST_LOCK_DURATION,
            5 // Allow slight timestamp difference
        );
        expect(event?.args?.wallet).to.equal(wallet);
    });
    
    it("should allow admin to pause the contract in an emergency", async () => {
        const tx = await token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken();
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    
        if (!event) throw new Error("EmergencyAction event not found");
    
        // Assertions
        expect(await token.paused()).to.be.true;
        expect(event.args.action).to.equal("Contract paused");
    });

    it("should allow admin to unpause the contract after an emergency", async () => {
        // Pause the contract first
        await token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken();
        await time.increase(5 * 60); 
    
        // Unpause the contract
        const tx = await token.connect(await ethers.getSigner(owner.address)).emergencyUnpauseToken();
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    
        if (!event) throw new Error("EmergencyAction event not found");
    
        // Assertions
        expect(await token.paused()).to.be.false;
        expect(event.args.action).to.equal("Contract unpaused");
    });

    it("should remove a wallet from whitelist", async () => {
        const wallet = users[0].address;
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
    
        // Remove wallet from whitelist
        const tx = await token.connect(await ethers.getSigner(owner.address)).removeFromWhitelist(wallet);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "WalletRemovedFromWhitelist");
    
        if (!event) throw new Error("WalletRemovedFromWhitelist event not found");
    
        // Assertions
        expect(event.args.wallet).to.equal(wallet);
    });
    
    it("should allow admin to add a bridge operator with time lock", async () => {
        const bridge_operator_role = await token.BRIDGE_OPERATOR_ROLE();
        const operator = users[0].address;
    
        // Add bridge operator
        const tx = await token.connect(await ethers.getSigner(owner.address)).updateAddressRole(operator, bridge_operator_role, true);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "RoleUpdated");
    
        if (!event) throw new Error("RoleUpdated event not found");
    
        // Assertions
        expect(await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), operator)).to.be.true;
        expect(event.args.target).to.equal(operator);
        expect(event.args.role).to.equal(await token.BRIDGE_OPERATOR_ROLE());
        expect(event.args.status).to.be.true;
    });
    
    it("should allow admin to remove a bridge operator after time lock", async () => {
        const bridge_operator_role = await token.BRIDGE_OPERATOR_ROLE();
        const operator = users[0].address;
    
        // Add bridge operator first
        await token.connect(await ethers.getSigner(owner.address)).updateAddressRole(operator, bridge_operator_role, true);
    
        // Remove bridge operator
        const tx = await token.connect(await ethers.getSigner(owner.address)).updateAddressRole(operator, bridge_operator_role, false);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "RoleUpdated");
    
        if (!event) throw new Error("RoleUpdated event not found");
    
        // Assertions
        expect(await token.hasRole(await token.BRIDGE_OPERATOR_ROLE(), operator)).to.be.false;
        expect(event.args.target).to.equal(operator);
        expect(event.args.role).to.equal(await token.BRIDGE_OPERATOR_ROLE());
        expect(event.args.status).to.be.false;
    });
    
    it("should mint tokens for cross-chain transfers", async () => {
        const sourceChain = 1; // Example source chain ID
        const mintAmount = ethers.parseEther("1000");
    
        // Set the source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Mint tokens
        const tx = await token.connect(await ethers.getSigner(owner.address)).bridgeMint(mintAmount, sourceChain);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "BridgeOperationDetails");
    
        if (!event) throw new Error("BridgeOperationDetails event not found");
    
        // Assertions
        expect(await token.totalSupply()).to.equal(INITIAL_MINTED_TOKENS + BigInt(mintAmount));
        expect(await token.balanceOf(await token.getAddress())).to.equal(INITIAL_MINTED_TOKENS + BigInt(mintAmount));
        expect(event.args.operator).to.equal(owner.address);
        expect(event.args.operation).to.equal("MINT");
        expect(event.args.amount).to.equal(mintAmount);
        expect(event.args.chainId).to.equal(sourceChain);
    });
    
    it("should burn tokens for cross-chain transfers", async () => {
        const targetChain = 2; // Example target chain ID
        const burnAmount = ethers.parseEther("500");
    
        // Set the target chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(targetChain, true);
    
        // Burn tokens
        const tx = await token.connect(await ethers.getSigner(owner.address)).bridgeBurn(burnAmount, targetChain);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs
            .map((log) => {
                try {
                    return token.interface.parseLog(log);
                } catch (e) {
                    return null;
                }
            })
            .find((parsedLog) => parsedLog && parsedLog.name === "BridgeOperationDetails");
    
        if (!event) throw new Error("BridgeOperationDetails event not found");
    
        // Assertions
        expect(await token.totalSupply()).to.equal(INITIAL_MINTED_TOKENS - BigInt(burnAmount));
        expect(await token.balanceOf(await token.getAddress())).to.equal(INITIAL_MINTED_TOKENS - BigInt(burnAmount));
        expect(event.args.operator).to.equal(owner.address);
        expect(event.args.operation).to.equal("BURN");
        expect(event.args.amount).to.equal(burnAmount);
        expect(event.args.chainId).to.equal(targetChain);
    });

    it("should add a supported chain", async () => {
        const chainId = 42; // Example chain ID
    
        // Add supported chain
        const tx = await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(chainId, true);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");
    
        if (!event) throw new Error("SupportedChainChanged event not found");
    
        // Assertions
        expect(await token.supportedChains(chainId)).to.be.true;
        expect(event.args.chainId).to.equal(chainId);
        expect(event.args.supported).to.be.true;
    });

    it("should remove a supported chain", async () => {
        const chainId = 42; // Example chain ID
    
        // Add supported chain first
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(chainId, true);
    
        // Remove supported chain
        const tx = await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(chainId, false);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");
    
        if (!event) throw new Error("SupportedChainChanged event not found");
    
        // Assertions
        expect(await token.supportedChains(chainId)).to.be.false;
        expect(event.args.chainId).to.equal(chainId);
        expect(event.args.supported).to.be.false;
    });
    
    it("should transfer tokens from contract to whitelisted address", async () => {
        const wallet = users[0].address;
        const transferAmount = ethers.parseEther("500");
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
    
        // Advance time by whitelist lock duration
        await time.increase(WHITELIST_LOCK_DURATION);
    
        // Transfer tokens from contract
        const tx = await token.connect(await ethers.getSigner(owner.address)).transferFromContract(wallet, transferAmount);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "TransferFromContract");
    
        if (!event) throw new Error("TransferFromContract event not found");
    
        // Assertions
        expect(await token.balanceOf(wallet)).to.equal(BigInt(transferAmount));
        expect(await token.balanceOf(await token.getAddress())).to.equal(
            BigInt(INITIAL_MINTED_TOKENS) - BigInt(transferAmount)
        );
        expect(event.args.from).to.equal(await token.getAddress());
        expect(event.args.to).to.equal(wallet);
        expect(event.args.amount).to.equal(transferAmount);
    });

    it("should revert when transferring tokens to a non-whitelisted address", async () => {
        const wallet = users[0].address;
        const transferAmount = INITIAL_MINTED_TOKENS / BigInt(2);
    
        // Attempt to transfer tokens from contract to non-whitelisted address
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transferFromContract(wallet, transferAmount)
        ).to.be.revertedWith("Recipient not whitelisted");
    });
    it("should revert when minting tokens exceeding maximum supply", async () => {
        const sourceChain = 1; // Example source chain ID
        const excessiveAmount = BigInt(2) * MAX_SUPPLY; // Exceeds total supply
    
        // Set the source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Attempt to mint excessive tokens
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeMint(excessiveAmount, sourceChain)
        ).to.be.revertedWithCustomError(token, "ExceedsMaximumSupply");
    });

    it("should revert when burning tokens without sufficient balance", async () => {
        const targetChain = 2; // Example target chain ID
        const burnAmount = BigInt(2) * INITIAL_MINTED_TOKENS; // Excessive amount
    
        // Set the target chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(targetChain, true);
    
        // Attempt to burn excessive tokens
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeBurn(burnAmount, targetChain)
        ).to.be.revertedWith("Insufficient balance to burn");
    });
    
    it("should only allow admins to add another admin", async () => {
        const newAdmin = users[0].address;
    
        // Attempt to add admin from a non-admin account 
        await expect(
            token.connect(await ethers.getSigner(users[1].address)).addAdmin(newAdmin)
        ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    
        // Add admin from an existing admin account
        const tx = await token.connect(await ethers.getSigner(owner.address)).addAdmin(newAdmin);
        const receipt = await tx.wait();
    
        // Parse emitted events
        const events = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).filter((parsedLog) => parsedLog && parsedLog.name === "RoleUpdated");
    
        if (!events || events.length !== 2) throw new Error("Expected two RoleUpdated events");
    
        // Assertions for new admin addition
        const addEvent = events.find(e => e.args.status === true);
        expect(await token.hasRole(await token.ADMIN_ROLE(), newAdmin)).to.be.true;
        expect(addEvent.args.target).to.equal(newAdmin);
        expect(addEvent.args.role).to.equal(await token.ADMIN_ROLE());
        expect(addEvent.args.status).to.be.true;
    
        // Assertions for owner role removal
        const removeEvent = events.find(e => e.args.status === false);
        expect(await token.hasRole(await token.ADMIN_ROLE(), owner.address)).to.be.false;
        expect(removeEvent.args.target).to.equal(owner.address);
        expect(removeEvent.args.role).to.equal(await token.ADMIN_ROLE());
        expect(removeEvent.args.status).to.be.false;
    });    

    it("should enforce emergency cooldown between pause actions", async () => {
        // Pause the contract
        const tx = await token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken();
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    
        if (!event) throw new Error("EmergencyAction event not found");
    
        // Assertions
        expect(event.args.action).to.equal("Contract paused");

        // Attempt to pause again before cooldown expires
        await expect(
            token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken()
        ).to.be.revertedWith("Cooldown active");
    
        // Advance time by EMERGENCY_COOLDOWN
        await time.increase(5 * 60); // 5 minutes in seconds
    
        // Pause the contract again after cooldown
        await expect(
            token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken()
        ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("should enforce role change time lock for new bridge operator", async () => {
        const bridge_operator_role = await token.BRIDGE_OPERATOR_ROLE();
        const bridgeOperator = users[0].address;
        const mintAmount = ethers.parseEther("500");
        const sourceChain = 1;
    
        // Add bridge operator
        await token.connect(await ethers.getSigner(owner.address)).updateAddressRole(bridgeOperator, bridge_operator_role, true);
    
        // Set source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Attempt to mint tokens before time lock expires
        await expect(
            token.connect(await ethers.getSigner(bridgeOperator)).bridgeMint(mintAmount, sourceChain)
        ).to.be.revertedWithCustomError(token, "TimeLockActive");
    
        // Advance time by ROLE_CHANGE_DELAY
        await time.increase(24 * 60 * 60); // 8 hours in seconds
    
        // Mint tokens successfully after time lock expires
        const tx = await token.connect(await ethers.getSigner(bridgeOperator)).bridgeMint(mintAmount, sourceChain);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "BridgeOperationDetails");
    
        if (!event) throw new Error("BridgeOperationDetails event not found");
    
        // Assertions
        expect(event.args.operator).to.equal(bridgeOperator);
        expect(event.args.operation).to.equal("MINT");
        expect(event.args.amount).to.equal(BigInt(mintAmount));
    });
    
    it("should revert when attempting to whitelist the zero address", async () => {
        const zeroAddress = ethers.ZeroAddress;
    
        // Attempt to whitelist the zero address
        await expect(
            token.connect(await ethers.getSigner(owner.address)).addToWhitelist(zeroAddress)
        ).to.be.revertedWith("Invalid wallet address");
    });

    it("should allow removing a whitelisted address before lock expires", async () => {
        const wallet = users[0].address;
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
    
        // Remove wallet from whitelist before lock expires
        const tx = await token.connect(await ethers.getSigner(owner.address)).removeFromWhitelist(wallet);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "WalletRemovedFromWhitelist");
    
        if (!event) throw new Error("WalletRemovedFromWhitelist event not found");
    
        // Assertions
        expect(event.args.wallet).to.equal(wallet);
    });

    it("should revert when unpausing before cooldown expires", async () => {
        // Pause the contract
        await token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken();
    
        // Attempt to unpause before cooldown expires
        await expect(
            token.connect(await ethers.getSigner(owner.address)).emergencyUnpauseToken()
        ).to.be.revertedWith("Cooldown active");
    });

    it("should allow unpausing after cooldown expires", async () => {
        // Pause the contract
        await token.connect(await ethers.getSigner(owner.address)).emergencyPauseToken();
    
        // Advance time by EMERGENCY_COOLDOWN
        await time.increase(5 * 60); // 5 minutes in seconds
    
        // Unpause the contract
        const tx = await token.connect(await ethers.getSigner(owner.address)).emergencyUnpauseToken();
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "EmergencyAction");
    
        if (!event) throw new Error("EmergencyAction event not found");
    
        // Assertions
        expect(await token.paused()).to.be.false;
        expect(event.args.action).to.equal("Contract unpaused");
    });
    
    it("should revert when minting tokens for an unsupported source chain", async () => {
        const unsupportedChain = 99; // Example unsupported chain ID
        const mintAmount = ethers.parseEther("1000");
    
        // Attempt to mint tokens for an unsupported chain
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeMint(mintAmount, unsupportedChain)
        ).to.be.revertedWithCustomError(token, "UnsupportedChain");
    });
    it("should revert when burning tokens for an unsupported target chain", async () => {
        const unsupportedChain = 99; // Example unsupported chain ID
        const burnAmount = ethers.parseEther("500");
    
        // Attempt to burn tokens for an unsupported chain
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeBurn(burnAmount, unsupportedChain)
        ).to.be.revertedWithCustomError(token, "UnsupportedChain");
    });
    
    it("should revert when minting zero tokens", async () => {
        const sourceChain = 1; // Example source chain ID
    
        // Set source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Attempt to mint zero tokens
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeMint(0, sourceChain)
        ).to.be.revertedWithCustomError(token, "AmountMustBePositive");
    });
    it("should revert when minting tokens without BRIDGE_OPERATOR_ROLE", async () => {
        const sourceChain = 1; // Example source chain ID
        const mintAmount = ethers.parseEther("1000");
    
        // Set source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Attempt to mint tokens without BRIDGE_OPERATOR_ROLE
        await expect(
            token.connect(await ethers.getSigner(users[0].address)).bridgeMint(mintAmount, sourceChain)
        ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
                
    it("should revert when setting an unsupported chain with an invalid chain ID", async () => {
        const invalidChainId = 0; // Invalid chain ID
    
        // Attempt to set an invalid chain ID
        await expect(
            token.connect(await ethers.getSigner(owner.address)).setSupportedChain(invalidChainId, true)
        ).to.be.revertedWith("Invalid chain ID");
    });
    it("should allow adding and removing a supported chain", async () => {
        const validChainId = 42; // Example valid chain ID
    
        // Add a supported chain
        const addTx = await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(validChainId, true);
        const addReceipt = await addTx.wait();
    
        // Parse emitted event for adding the chain
        const addEvent = addReceipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");
    
        if (!addEvent) throw new Error("SupportedChainChanged event not found for adding");
    
        // Assertions for adding the chain
        expect(await token.supportedChains(validChainId)).to.be.true;
        expect(addEvent.args.chainId).to.equal(validChainId);
        expect(addEvent.args.supported).to.be.true;
    
        // Remove the supported chain
        const removeTx = await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(validChainId, false);
        const removeReceipt = await removeTx.wait();
    
        // Parse emitted event for removing the chain
        const removeEvent = removeReceipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");
    
        if (!removeEvent) throw new Error("SupportedChainChanged event not found for removing");
    
        // Assertions for removing the chain
        expect(await token.supportedChains(validChainId)).to.be.false;
        expect(removeEvent.args.chainId).to.equal(validChainId);
        expect(removeEvent.args.supported).to.be.false;
    });
    it("should revert when transferring tokens to a non-whitelisted address", async () => {
        const nonWhitelistedAddress = users[0].address;
        const transferAmount = ethers.parseEther("100");
    
        // Attempt to transfer tokens to a non-whitelisted address
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transferFromContract(nonWhitelistedAddress, transferAmount)
        ).to.be.revertedWith("Recipient not whitelisted");
    });
    it("should revert when transferring tokens before whitelist lock expires", async () => {
        const wallet = users[0].address;
        const transferAmount = ethers.parseEther("100");
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
    
        // Attempt to transfer tokens before lock duration expires
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transferFromContract(wallet, transferAmount)
        ).to.be.revertedWith("Recipient is still locked");
    });
    it("should revert when minting a zero amount", async () => {
        const sourceChain = 1; // Example source chain ID
        const negativeAmount = BigInt(0); // Invalid negative amount
    
        // Set source chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(sourceChain, true);
    
        // Attempt to mint a negative amount
        await expect(
            token.connect(await ethers.getSigner(owner.address)).bridgeMint(negativeAmount, sourceChain)
        ).to.be.revertedWithCustomError(token, "AmountMustBePositive");
    });

    it("should revert when transferring more tokens than available in contract balance", async () => {
        const wallet = users[0].address;
        const transferAmount = BigInt(2) * INITIAL_MINTED_TOKENS; // Excessive amount
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
        await time.increase(24 * 60 * 60);
    
        // Attempt to transfer tokens exceeding contract balance
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transferFromContract(wallet, transferAmount)
        ).to.be.revertedWithCustomError(token, "ExceedsAvailableSupply");
    });
    it("should revert when transferring zero tokens from contract", async () => {
        const wallet = users[0].address;
    
        // Add wallet to whitelist
        await token.connect(await ethers.getSigner(owner.address)).addToWhitelist(wallet);
        await time.increase(24 * 60 * 60);
    
        // Attempt to transfer zero tokens
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transferFromContract(wallet, 0)
        ).to.be.revertedWithCustomError(token, "AmountMustBePositive");
    });
    it("should revert when adding an admin with an invalid address", async () => {
        const invalidAdmin = ethers.ZeroAddress;
    
        // Attempt to add an admin with an invalid address
        await expect(
            token.connect(await ethers.getSigner(owner.address)).addAdmin(invalidAdmin)
        ).to.be.revertedWith("Invalid address");
    });
    it("should revert when adding or removing an admin before time lock expires", async () => {
        const newAdmin = users[0].address;
        const newAdmin1 = users[1].address;
    
        // Add a new admin
        await token.connect(await ethers.getSigner(owner.address)).addAdmin(newAdmin);
        await expect(
            token.connect(await ethers.getSigner(newAdmin)).addAdmin(newAdmin1)
        ).to.be.revertedWithCustomError(token, "TimeLockActive");

        await time.increase(24 * 60 * 60);

        await token.connect(await ethers.getSigner(newAdmin)).addAdmin(newAdmin1);
    
        // Attempt to remove the admin before time lock expires
        await expect(
            token.connect(await ethers.getSigner(newAdmin1)).removeAdmin(newAdmin)
        ).to.be.revertedWithCustomError(token, "TimeLockActive");
    });
    it("should revert when removing an admin if removing self", async () => {    
        // Attempt to remove self
        await expect(
            token.connect(await ethers.getSigner(owner.address)).removeAdmin(owner.address)
        ).to.be.revertedWith("Cannot remove self");
    });
    it("should revert when burning tokens without BRIDGE_OPERATOR_ROLE", async () => {
        const targetChain = 2; // Example target chain ID
        const burnAmount = ethers.parseEther("500");
    
        // Set target chain as supported
        await token.connect(await ethers.getSigner(owner.address)).setSupportedChain(targetChain, true);
    
        // Attempt to burn tokens without BRIDGE_OPERATOR_ROLE
        await expect(
            token.connect(await ethers.getSigner(users[0].address)).bridgeBurn(burnAmount, targetChain)
        ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
               
    it("should revert when transferring tokens to the zero address", async () => {
        const transferAmount = ethers.parseEther("100");
    
        // Attempt to transfer tokens to the zero address
        await expect(
            token.connect(await ethers.getSigner(owner.address)).transfer(ethers.ZeroAddress, transferAmount)
        ).to.be.revertedWith("ERC20: transfer to the zero address not allowed");
    });

    it("should allow setting supported chain by authorized bridge operator", async () => {
        const bridge_operator_role = await token.BRIDGE_OPERATOR_ROLE();
        const chainId = 42; // Example chain ID
        const bridgeOperator = users[0].address;
    
        // Grant BRIDGE_OPERATOR_ROLE to user
        await token.connect(await ethers.getSigner(owner.address)).updateAddressRole(bridgeOperator, bridge_operator_role, true);
    
        // Advance time by ROLE_CHANGE_DELAY
        await time.increase(24 * 60 * 60); // 8 hours in seconds
    
        // Set supported chain by authorized bridge operator
        const tx = await token.connect(await ethers.getSigner(users[0].address)).setSupportedChain(chainId, true);
        const receipt = await tx.wait();
    
        // Parse emitted event
        const event = receipt?.logs?.map((log) => {
            try {
                return token.interface.parseLog(log);
            } catch (e) {
                return null;
            }
        }).find((parsedLog) => parsedLog && parsedLog.name === "SupportedChainChanged");
    
        if (!event) throw new Error("SupportedChainChanged event not found");
    
        // Assertions
        expect(await token.supportedChains(chainId)).to.be.true;
        expect(event.args.chainId).to.equal(chainId);
        expect(event.args.supported).to.be.true;
    });
             
});