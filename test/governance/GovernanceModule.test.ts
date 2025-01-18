import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroAddress } from "ethers";
import { 
  StorageToken,
  StorageToken__factory
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GovernanceModule", () => {
  let storageToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let otherAccount: SignerWithAddress;

  beforeEach(async () => {
    [owner, admin, otherAccount] = await ethers.getSigners();
    
    // Deploy StorageToken instead of GovernanceModule
    const StorageTokenFactory = await ethers.getContractFactory("StorageToken");
    const storageTokenImpl = await StorageTokenFactory.deploy();
    
    // Deploy UUPS Proxy
    const UUPSProxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await UUPSProxy.deploy(
      storageTokenImpl.address,
      storageTokenImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        admin.address,
        "Storage Token",
        "ST"
      ])
    );

    // Get StorageToken instance at proxy address
    storageToken = StorageTokenFactory.attach(proxy.address) as StorageToken;
  });

  describe("Initialization", () => {
    it("Should initialize correctly with valid parameters", async () => {
      // Test Public Variables
      const ADMIN_ROLE = await storageToken.ADMIN_ROLE();
      const BRIDGE_OPERATOR_ROLE = await storageToken.BRIDGE_OPERATOR_ROLE();
      const CONTRACT_OPERATOR_ROLE = await storageToken.CONTRACT_OPERATOR_ROLE();
      const UNDER_REVIEW = await storageToken.UNDER_REVIEW();
      
      // Check constants
      expect(await storageToken.MIN_PROPOSAL_EXECUTION_DELAY()).to.equal(24 * 3600); // 24 hours
      expect(await storageToken.INACTIVITY_THRESHOLD()).to.equal(365 * 24 * 3600); // 365 days
      expect(await storageToken.EMERGENCY_THRESHOLD()).to.equal(3);

      // Verify roles are assigned correctly
      expect(await storageToken.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await storageToken.hasRole(ADMIN_ROLE, admin.address)).to.be.true;

      // Verify owner is set correctly
      expect(await storageToken.owner()).to.equal(owner.address);

      // Verify ERC20 initialization
      expect(await storageToken.name()).to.equal("Storage Token");
      expect(await storageToken.symbol()).to.equal("ST");
    });

    it("Should have correct role change timelock", async () => {
      const currentTime = Math.floor(Date.now() / 1000);
      const ownerTimeConfig = await storageToken.timeConfigs(owner.address);
      const adminTimeConfig = await storageToken.timeConfigs(admin.address);

      // Check if timelock is set to roughly current time + 1 day
      expect(ownerTimeConfig.roleChangeTimeLock).to.be.closeTo(BigInt(currentTime + 24 * 3600), BigInt(300));
      expect(adminTimeConfig.roleChangeTimeLock).to.be.closeTo(BigInt(currentTime + 24 * 3600), BigInt(300));
    });

    it("Should not be able to initialize again", async () => {
      await expect(
        storageToken.initialize(owner.address, admin.address, "Storage Token", "ST")
      ).to.be.revertedWith("Initializable: contract is already initialized");
    });
  });
});
