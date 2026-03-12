import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { FulaFileNFT, StorageToken } from "../../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ZeroAddress, BytesLike } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const ADMIN_ROLE: BytesLike = ethers.keccak256(ethers.toUtf8Bytes("ADMIN_ROLE"));

describe("FulaFileNFT", function () {
  let nft: FulaFileNFT;
  let fulaToken: StorageToken;
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  const INITIAL_FULA_SUPPLY = ethers.parseEther("1000000000"); // 1 billion FULA
  const FULA_PER_NFT = ethers.parseEther("10"); // 10 FULA per NFT
  const BASE_URI = "https://ipfs.cloud.fx.land/gateway/";
  const DEFAULT_EVENT = "default";

  async function setupQuorumAndWhitelist() {
    await time.increase(86401);

    await fulaToken.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
    await fulaToken.connect(owner).setRoleTransactionLimit(
      ADMIN_ROLE,
      ethers.parseEther("1000000000")
    );

    const addWhitelistType = 5;
    const tx = await fulaToken.connect(owner).createProposal(
      addWhitelistType, 0, user1.address, ethers.ZeroHash, 0, ZeroAddress
    );
    const receipt = await tx.wait();

    const event = receipt?.logs.find((log: any) => {
      try {
        return fulaToken.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ProposalCreated";
      } catch { return false; }
    });
    const parsed = fulaToken.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
    const proposalId = parsed!.args[0];

    await time.increase(86401);
    await fulaToken.connect(admin).approveProposal(proposalId);
    await time.increase(86401);

    await fulaToken.connect(owner).transferFromContract(
      user1.address,
      ethers.parseEther("10000")
    );
  }

  beforeEach(async function () {
    [owner, admin, user1, user2] = await ethers.getSigners();

    const StorageTokenFactory = await ethers.getContractFactory("StorageToken");
    fulaToken = await upgrades.deployProxy(
      StorageTokenFactory,
      [owner.address, admin.address, INITIAL_FULA_SUPPLY],
      { kind: 'uups', initializer: 'initialize' }
    ) as StorageToken;
    await fulaToken.waitForDeployment();

    const FulaFileNFTFactory = await ethers.getContractFactory("FulaFileNFT");
    nft = await upgrades.deployProxy(
      FulaFileNFTFactory,
      [owner.address, admin.address, await fulaToken.getAddress(), BASE_URI],
      { kind: 'uups', initializer: 'initialize' }
    ) as FulaFileNFT;
    await nft.waitForDeployment();
  });

  describe("initialize", function () {
    it("should correctly initialize the contract", async function () {
      expect(await nft.storageToken()).to.equal(await fulaToken.getAddress());
      expect(await nft.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await nft.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should revert with zero addresses", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");

      await expect(
        upgrades.deployProxy(Factory, [
          ZeroAddress, admin.address, await fulaToken.getAddress(), BASE_URI
        ], { kind: 'uups', initializer: 'initialize' })
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");

      await expect(
        upgrades.deployProxy(Factory, [
          owner.address, admin.address, ZeroAddress, BASE_URI
        ], { kind: 'uups', initializer: 'initialize' })
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });
  });

  describe("mintWithFula", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should mint NFTs with FULA payment", async function () {
      const nftAddress = await nft.getAddress();
      const metadataCid = "QmTest123";
      const count = 5;
      const totalFula = FULA_PER_NFT * BigInt(count);

      await fulaToken.connect(user1).approve(nftAddress, totalFula);

      const tx = await nft.connect(user1).mintWithFula(DEFAULT_EVENT, metadataCid, FULA_PER_NFT, count);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(count);

      // Verify token info (creator, metadataCid, eventName, fulaPerNft, initialMintCount)
      const info = await nft.getTokenInfo(1);
      expect(info[0]).to.equal(user1.address); // creator
      expect(info[1]).to.equal(metadataCid); // metadataCid
      expect(info[2]).to.equal(DEFAULT_EVENT); // eventName
      expect(info[3]).to.equal(FULA_PER_NFT); // fulaPerNft
      expect(info[4]).to.equal(count); // initialMintCount

      expect(await fulaToken.balanceOf(nftAddress)).to.equal(totalFula);

      // Verify event-based queries
      const events = await nft.getCreatorEvents(user1.address);
      expect(events.length).to.equal(1);
      expect(events[0]).to.equal(DEFAULT_EVENT);

      const tokens = await nft.getEventTokens(user1.address, DEFAULT_EVENT, 0, 100);
      expect(tokens.length).to.equal(1);
      expect(tokens[0]).to.equal(1);

      await expect(tx)
        .to.emit(nft, "NftMinted")
        .withArgs(user1.address, 1, count, metadataCid, FULA_PER_NFT, DEFAULT_EVENT);
    });

    it("should mint with zero FULA (free mint)", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 1);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should auto-increment token IDs", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(2));

      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFirst", FULA_PER_NFT, 1);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmSecond", FULA_PER_NFT, 1);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.balanceOf(user1.address, 2)).to.equal(1);

      const tokens = await nft.getEventTokens(user1.address, DEFAULT_EVENT, 0, 100);
      expect(tokens.length).to.equal(2);
    });

    it("should revert with zero count", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", FULA_PER_NFT, 0)
      ).to.be.revertedWithCustomError(nft, "ZeroAmount");
    });

    it("should revert with insufficient FULA allowance", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", FULA_PER_NFT, 1)
      ).to.be.reverted;
    });
  });

  describe("createClaimOffer and claimNFT", function () {
    let linkHash: string;

    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmClaim", FULA_PER_NFT, 1);
    });

    it("should create a claim offer and claim it", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const nftAddress = await nft.getAddress();

      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => {
          try {
            return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
          } catch { return false; }
        }
      );
      const parsed = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
      linkHash = parsed!.args[0];

      expect(await nft.balanceOf(nftAddress, 1)).to.equal(1);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(0);

      // Verify claim offer (tokenId, sender, claimer, expiresAt, status)
      const offer = await nft.getClaimOffer(linkHash);
      expect(offer[0]).to.equal(1); // tokenId
      expect(offer[1]).to.equal(user1.address); // sender
      expect(offer[2]).to.equal(user2.address); // claimer
      expect(offer[4]).to.equal(0); // status: active

      const claimTx = await nft.connect(user2).claimNFT(linkHash);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
      expect(await nft.balanceOf(nftAddress, 1)).to.equal(0);

      await expect(claimTx)
        .to.emit(nft, "NftClaimed")
        .withArgs(linkHash, 1, user2.address);

      // Verify claimer address is stored on-chain
      const offerAfter = await nft.claimOffers(linkHash);
      expect(offerAfter[2]).to.equal(user2.address); // claimer updated to actual claimer
      expect(offerAfter[4]).to.equal(1); // status: claimed
    });

    it("should revert claim by wrong recipient (targeted offer)", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await expect(
        nft.connect(owner).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "NotClaimRecipient");
    });

    it("should revert expired claim", async function () {
      const expiresAt = (await time.latest()) + 100;
      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await time.increase(200);

      await expect(
        nft.connect(user2).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "ClaimExpired");
    });

    it("should revert double claim", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDouble", FULA_PER_NFT, 1);

      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await nft.connect(user2).claimNFT(linkHash);

      await expect(
        nft.connect(user2).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("should revert create with past expiry", async function () {
      const pastExpiry = (await time.latest()) - 100;
      await expect(
        nft.connect(user1).createClaimOffer(1, user2.address, pastExpiry)
      ).to.be.revertedWithCustomError(nft, "InvalidExpiryTime");
    });
  });

  describe("open claims (claimer = address(0))", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(3));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmOpen", FULA_PER_NFT, 3);
    });

    it("should create an open offer with claimer = address(0)", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt);
      const receipt = await tx.wait();

      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const parsed = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
      const linkHash = parsed!.args[0];

      const offer = await nft.getClaimOffer(linkHash);
      expect(offer[2]).to.equal(ZeroAddress); // claimer is address(0)
    });

    it("should allow anyone to claim an open offer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await nft.connect(user2).claimNFT(linkHash);
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
    });

    it("should allow owner to claim an open offer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await nft.connect(owner).claimNFT(linkHash);
      expect(await nft.balanceOf(owner.address, 1)).to.equal(1);
    });

    it("should prevent double-claim on open offers", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await nft.connect(user2).claimNFT(linkHash);

      await expect(
        nft.connect(owner).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("should respect expiry on open offers", async function () {
      const expiresAt = (await time.latest()) + 100;
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await time.increase(200);

      await expect(
        nft.connect(user2).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "ClaimExpired");
    });

    it("should still restrict targeted offers to designated claimer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      const linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];

      await expect(
        nft.connect(owner).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "NotClaimRecipient");

      await nft.connect(user2).claimNFT(linkHash);
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
    });
  });

  describe("burn", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(5));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmBurn", FULA_PER_NFT, 5);

      // Transfer 3 to user2 via standard ERC1155 transfer (no FULA released)
      await nft.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 3, "0x");
    });

    it("should release FULA to the creator (not the burner)", async function () {
      // user2 has 3 NFTs, burns 1 — FULA goes to user1 (creator)
      const creatorFulaBefore = await fulaToken.balanceOf(user1.address);

      const tx = await nft.connect(user2).burn(user2.address, 1, 1);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(2);

      // Verify FULA released to creator
      const creatorFulaAfter = await fulaToken.balanceOf(user1.address);
      expect(creatorFulaAfter - creatorFulaBefore).to.equal(FULA_PER_NFT);

      // Verify event includes creator
      await expect(tx)
        .to.emit(nft, "NftBurned")
        .withArgs(1, user2.address, 1, FULA_PER_NFT, user1.address);
    });

    it("should release nothing for zero fulaPerNft", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 1);
      const tokenId = 2;

      const user1FulaBefore = await fulaToken.balanceOf(user1.address);
      await nft.connect(user1).burn(user1.address, tokenId, 1);

      const user1FulaAfter = await fulaToken.balanceOf(user1.address);
      expect(user1FulaAfter).to.equal(user1FulaBefore);
    });

    it("should release proportional FULA for partial burn", async function () {
      // user2 has 3, burn 2 — FULA goes to creator (user1)
      const creatorFulaBefore = await fulaToken.balanceOf(user1.address);

      await nft.connect(user2).burn(user2.address, 1, 2);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);

      const creatorFulaAfter = await fulaToken.balanceOf(user1.address);
      expect(creatorFulaAfter - creatorFulaBefore).to.equal(FULA_PER_NFT * BigInt(2));
    });

    it("should revert burn by non-owner/non-approved", async function () {
      await expect(
        nft.connect(owner).burn(user2.address, 1, 1)
      ).to.be.reverted;
    });

    it("should revert burn of more than balance", async function () {
      await expect(
        nft.connect(user2).burn(user2.address, 1, 10)
      ).to.be.reverted;
    });

    it("should update totalLockedFula correctly", async function () {
      const initialLocked = FULA_PER_NFT * BigInt(5);
      expect(await nft.totalLockedFula()).to.equal(initialLocked);

      await nft.connect(user2).burn(user2.address, 1, 2);
      expect(await nft.totalLockedFula()).to.equal(initialLocked - FULA_PER_NFT * BigInt(2));

      await nft.connect(user2).burn(user2.address, 1, 1);
      expect(await nft.totalLockedFula()).to.equal(initialLocked - FULA_PER_NFT * BigInt(3));
    });

    it("should not release FULA on standard transfer", async function () {
      const user2FulaBefore = await fulaToken.balanceOf(user2.address);
      const ownerFulaBefore = await fulaToken.balanceOf(owner.address);

      await nft.connect(user2).safeTransferFrom(user2.address, owner.address, 1, 1, "0x");

      const user2FulaAfter = await fulaToken.balanceOf(user2.address);
      const ownerFulaAfter = await fulaToken.balanceOf(owner.address);

      expect(user2FulaAfter).to.equal(user2FulaBefore);
      expect(ownerFulaAfter).to.equal(ownerFulaBefore);

      expect(await nft.totalLockedFula()).to.equal(FULA_PER_NFT * BigInt(5));
    });
  });

  describe("totalLockedFula", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should track locked FULA across mints and burns", async function () {
      const nftAddress = await nft.getAddress();
      const count = 3;
      const totalMintFula = FULA_PER_NFT * BigInt(count);

      await fulaToken.connect(user1).approve(nftAddress, totalMintFula);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmLocked", FULA_PER_NFT, count);
      expect(await nft.totalLockedFula()).to.equal(totalMintFula);

      // Transfer 1 to user2, then burn — FULA released to creator (user1)
      await nft.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 1, "0x");
      await nft.connect(user2).burn(user2.address, 1, 1);
      expect(await nft.totalLockedFula()).to.equal(totalMintFula - FULA_PER_NFT);
    });

    it("should be zero after free mint", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 5);
      expect(await nft.totalLockedFula()).to.equal(0);
    });
  });

  describe("recoverERC20 safeguard", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should prevent draining locked FULA", async function () {
      const nftAddress = await nft.getAddress();

      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDrain", FULA_PER_NFT, 1);

      await expect(
        nft.connect(owner).recoverERC20(
          await fulaToken.getAddress(),
          FULA_PER_NFT,
          admin.address
        )
      ).to.be.revertedWithCustomError(nft, "InsufficientBalance");
    });

    it("should allow recovering surplus FULA above locked amount", async function () {
      const nftAddress = await nft.getAddress();

      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmSurplus", FULA_PER_NFT, 1);

      const surplus = ethers.parseEther("50");
      await fulaToken.connect(user1).transfer(nftAddress, surplus);

      const balBefore = await fulaToken.balanceOf(admin.address);
      await nft.connect(owner).recoverERC20(
        await fulaToken.getAddress(),
        surplus,
        admin.address
      );
      const balAfter = await fulaToken.balanceOf(admin.address);
      expect(balAfter - balBefore).to.equal(surplus);

      expect(await nft.totalLockedFula()).to.equal(FULA_PER_NFT);
    });
  });

  describe("cancelClaimOffer", function () {
    let linkHash: string;

    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmCancel", FULA_PER_NFT, 1);

      const expiresAt = (await time.latest()) + 300;
      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => {
        try {
          return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
        } catch { return false; }
      });
      linkHash = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];
    });

    it("should allow sender to cancel after expiry", async function () {
      await time.increase(301);

      const tx = await nft.connect(user1).cancelClaimOffer(linkHash);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);

      await expect(tx)
        .to.emit(nft, "ClaimOfferCancelled")
        .withArgs(linkHash, 1, user1.address, user1.address);

      // Verify status is cancelled (2), not claimed
      await expect(
        nft.connect(user2).claimNFT(linkHash)
      ).to.be.revertedWithCustomError(nft, "OfferCancelled");
    });

    it("should allow admin to cancel before expiry", async function () {
      await nft.connect(owner).cancelClaimOffer(linkHash);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should allow sender to cancel before expiry", async function () {
      await nft.connect(user1).cancelClaimOffer(linkHash);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should reject non-sender non-admin cancelling before expiry", async function () {
      await expect(
        nft.connect(user2).cancelClaimOffer(linkHash)
      ).to.be.revertedWithCustomError(nft, "NotAuthorizedToCancel");
    });
  });

  describe("metadataCid validation", function () {
    it("should revert with empty CID", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "", 0, 1)
      ).to.be.revertedWithCustomError(nft, "InvalidCidLength");
    });

    it("should revert with CID longer than 256 bytes", async function () {
      const longCid = "Q" + "m".repeat(256);
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, longCid, 0, 1)
      ).to.be.revertedWithCustomError(nft, "InvalidCidLength");
    });

    it("should revert with empty event name", async function () {
      await expect(
        nft.connect(user1).mintWithFula("", "QmTest", 0, 1)
      ).to.be.revertedWithCustomError(nft, "EventNameEmpty");
    });
  });

  describe("URI", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTestCid123", FULA_PER_NFT, 1);
    });

    it("should return correct URI", async function () {
      const tokenUri = await nft.uri(1);
      expect(tokenUri).to.equal(BASE_URI + "QmTestCid123");
    });

    it("should revert for non-existent token", async function () {
      await expect(nft.uri(999)).to.be.revertedWithCustomError(nft, "InvalidTokenId");
    });
  });

  describe("name and symbol", function () {
    it("should return contract name", async function () {
      expect(await nft.name()).to.equal("FulaFileNFT");
    });

    it("should return contract symbol", async function () {
      expect(await nft.symbol()).to.equal("FFNFT");
    });
  });

  describe("admin functions", function () {
    it("should update base URI", async function () {
      const newUri = "https://new-gateway.example.com/";
      await nft.connect(owner).setBaseUri(newUri);

      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", 0, 1);
      expect(await nft.uri(1)).to.equal(newUri + "QmTest");
    });

    it("should reject non-admin setBaseUri", async function () {
      await expect(
        nft.connect(user1).setBaseUri("https://bad.com/")
      ).to.be.reverted;
    });

    it("should recover ERC20 tokens", async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).transfer(nftAddress, ethers.parseEther("100"));

      const balBefore = await fulaToken.balanceOf(admin.address);
      await nft.connect(owner).recoverERC20(
        await fulaToken.getAddress(),
        ethers.parseEther("100"),
        admin.address
      );
      const balAfter = await fulaToken.balanceOf(admin.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("100"));
    });
  });

  describe("governance", function () {
    it("should pause and unpause", async function () {
      await time.increase(86401);

      await nft.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);

      await nft.connect(owner).emergencyAction(1);
      expect(await nft.paused()).to.be.true;

      await time.increase(1801);

      await nft.connect(owner).emergencyAction(2);
      expect(await nft.paused()).to.be.false;
    });

    it("should reject minting when paused", async function () {
      await time.increase(86401);
      await nft.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
      await nft.connect(owner).emergencyAction(1);

      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmPaused", 0, 1)
      ).to.be.reverted;
    });
  });

  describe("event grouping", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should group tokens by event name", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(3));

      await nft.connect(user1).mintWithFula("photos", "QmPhoto1", FULA_PER_NFT, 1);
      await nft.connect(user1).mintWithFula("photos", "QmPhoto2", FULA_PER_NFT, 1);
      await nft.connect(user1).mintWithFula("videos", "QmVideo1", FULA_PER_NFT, 1);

      const events = await nft.getCreatorEvents(user1.address);
      expect(events.length).to.equal(2);
      expect(events).to.include("photos");
      expect(events).to.include("videos");

      const photoTokens = await nft.getEventTokens(user1.address, "photos", 0, 100);
      expect(photoTokens.length).to.equal(2);

      const videoTokens = await nft.getEventTokens(user1.address, "videos", 0, 100);
      expect(videoTokens.length).to.equal(1);

      expect(await nft.getEventTokenCount(user1.address, "photos")).to.equal(2);
      expect(await nft.getEventTokenCount(user1.address, "videos")).to.equal(1);
    });
  });
});
