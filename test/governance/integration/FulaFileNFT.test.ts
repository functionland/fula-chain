import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { FulaFileNFT, StorageToken, MockERC20, MockERC1155 } from "../../../typechain-types";
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

  /** Generate a random secret and its corresponding claimKey */
  function generateClaimKeyPair(): { secret: string; claimKey: string } {
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const claimKey = ethers.keccak256(secret);
    return { secret, claimKey };
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

      const tx = await nft.connect(user1).mintWithFula(DEFAULT_EVENT, metadataCid, FULA_PER_NFT, count, 0);

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
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 1, 0);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should auto-increment token IDs", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(2));

      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFirst", FULA_PER_NFT, 1, 0);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmSecond", FULA_PER_NFT, 1, 0);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      expect(await nft.balanceOf(user1.address, 2)).to.equal(1);

      const tokens = await nft.getEventTokens(user1.address, DEFAULT_EVENT, 0, 100);
      expect(tokens.length).to.equal(2);
    });

    it("should revert with zero count", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", FULA_PER_NFT, 0, 0)
      ).to.be.revertedWithCustomError(nft, "ZeroAmount");
    });

    it("should revert with insufficient FULA allowance", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", FULA_PER_NFT, 1, 0)
      ).to.be.reverted;
    });
  });

  describe("createClaimOffer and claimNFT", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmClaim", FULA_PER_NFT, 1, 0);
    });

    it("should create a claim offer and claim it", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const nftAddress = await nft.getAddress();

      const { secret, claimKey } = generateClaimKeyPair();

      const tx = await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);
      const receipt = await tx.wait();

      // Verify ClaimOfferCreated event emits the correct claimKey
      const event = receipt?.logs.find(
        (log: any) => {
          try {
            return nft.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
          } catch { return false; }
        }
      );
      const parsed = nft.interface.parseLog({ topics: event!.topics as string[], data: event!.data });
      expect(parsed!.args[0]).to.equal(claimKey);

      expect(await nft.balanceOf(nftAddress, 1)).to.equal(1);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(0);

      // Verify claim offer (tokenId, sender, claimer, expiresAt, status)
      const offer = await nft.getClaimOffer(claimKey);
      expect(offer[0]).to.equal(1); // tokenId
      expect(offer[1]).to.equal(user1.address); // sender
      expect(offer[2]).to.equal(user2.address); // claimer
      expect(offer[4]).to.equal(0); // status: active

      const claimTx = await nft.connect(user2).claimNFT(secret);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
      expect(await nft.balanceOf(nftAddress, 1)).to.equal(0);

      await expect(claimTx)
        .to.emit(nft, "NftClaimed")
        .withArgs(claimKey, 1, user2.address);

      // Verify claimer address is stored on-chain
      const offerAfter = await nft.claimOffers(claimKey);
      expect(offerAfter[2]).to.equal(user2.address); // claimer updated to actual claimer
      expect(offerAfter[4]).to.equal(1); // status: claimed
    });

    it("should revert claim by wrong recipient (targeted offer)", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      await expect(
        nft.connect(owner).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "NotClaimRecipient");
    });

    it("should revert expired claim", async function () {
      const expiresAt = (await time.latest()) + 100;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      await time.increase(200);

      await expect(
        nft.connect(user2).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "ClaimExpired");
    });

    it("should revert double claim", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDouble", FULA_PER_NFT, 1, 0);

      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      await nft.connect(user2).claimNFT(secret);

      await expect(
        nft.connect(user2).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("should revert create with past expiry", async function () {
      const pastExpiry = (await time.latest()) - 100;
      const { claimKey } = generateClaimKeyPair();
      await expect(
        nft.connect(user1).createClaimOffer(1, user2.address, pastExpiry, claimKey)
      ).to.be.revertedWithCustomError(nft, "InvalidExpiryTime");
    });

    it("should revert claimNFT with wrong secret", async function () {
      const { claimKey } = generateClaimKeyPair();
      const expiresAt = (await time.latest()) + 86400;
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      const wrongSecret = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        nft.connect(user2).claimNFT(wrongSecret)
      ).to.be.revertedWithCustomError(nft, "ClaimNotFound");
    });

    it("should revert createClaimOffer with duplicate claimKey", async function () {
      const { claimKey } = generateClaimKeyPair();
      const expiresAt = (await time.latest()) + 86400;

      // Mint a second token
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDup", FULA_PER_NFT, 1, 0);

      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      await expect(
        nft.connect(user1).createClaimOffer(2, user2.address, expiresAt, claimKey)
      ).to.be.revertedWithCustomError(nft, "ClaimKeyExists");
    });
  });

  describe("open claims (claimer = address(0))", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(3));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmOpen", FULA_PER_NFT, 3, 0);
    });

    it("should create an open offer with claimer = address(0)", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);

      const offer = await nft.getClaimOffer(claimKey);
      expect(offer[2]).to.equal(ZeroAddress); // claimer is address(0)
    });

    it("should allow anyone to claim an open offer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);

      await nft.connect(user2).claimNFT(secret);
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
    });

    it("should allow owner to claim an open offer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);

      await nft.connect(owner).claimNFT(secret);
      expect(await nft.balanceOf(owner.address, 1)).to.equal(1);
    });

    it("should prevent double-claim on open offers", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);

      await nft.connect(user2).claimNFT(secret);

      await expect(
        nft.connect(owner).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "AlreadyClaimed");
    });

    it("should respect expiry on open offers", async function () {
      const expiresAt = (await time.latest()) + 100;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);

      await time.increase(200);

      await expect(
        nft.connect(user2).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "ClaimExpired");
    });

    it("should still restrict targeted offers to designated claimer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      await expect(
        nft.connect(owner).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "NotClaimRecipient");

      await nft.connect(user2).claimNFT(secret);
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
    });
  });

  describe("burn", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(5));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmBurn", FULA_PER_NFT, 5, 0);

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
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 1, 0);
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
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmLocked", FULA_PER_NFT, count, 0);
      expect(await nft.totalLockedFula()).to.equal(totalMintFula);

      // Transfer 1 to user2, then burn — FULA released to creator (user1)
      await nft.connect(user1).safeTransferFrom(user1.address, user2.address, 1, 1, "0x");
      await nft.connect(user2).burn(user2.address, 1, 1);
      expect(await nft.totalLockedFula()).to.equal(totalMintFula - FULA_PER_NFT);
    });

    it("should be zero after free mint", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFree", 0, 5, 0);
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
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDrain", FULA_PER_NFT, 1, 0);

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
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmSurplus", FULA_PER_NFT, 1, 0);

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
    let secret: string;
    let claimKey: string;

    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmCancel", FULA_PER_NFT, 1, 0);

      const pair = generateClaimKeyPair();
      secret = pair.secret;
      claimKey = pair.claimKey;

      const expiresAt = (await time.latest()) + 300;
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);
    });

    it("should allow sender to cancel after expiry", async function () {
      await time.increase(301);

      const tx = await nft.connect(user1).cancelClaimOffer(claimKey);

      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);

      await expect(tx)
        .to.emit(nft, "ClaimOfferCancelled")
        .withArgs(claimKey, 1, user1.address, user1.address);

      // Verify status is cancelled (2), not claimed
      await expect(
        nft.connect(user2).claimNFT(secret)
      ).to.be.revertedWithCustomError(nft, "OfferCancelled");
    });

    it("should allow admin to cancel before expiry", async function () {
      await nft.connect(owner).cancelClaimOffer(claimKey);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should allow sender to cancel before expiry", async function () {
      await nft.connect(user1).cancelClaimOffer(claimKey);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
    });

    it("should reject non-sender non-admin cancelling before expiry", async function () {
      await expect(
        nft.connect(user2).cancelClaimOffer(claimKey)
      ).to.be.revertedWithCustomError(nft, "NotAuthorizedToCancel");
    });
  });

  describe("metadataCid validation", function () {
    it("should revert with empty CID", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "", 0, 1, 0)
      ).to.be.revertedWithCustomError(nft, "InvalidCidLength");
    });

    it("should revert with CID longer than 256 bytes", async function () {
      const longCid = "Q" + "m".repeat(256);
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, longCid, 0, 1, 0)
      ).to.be.revertedWithCustomError(nft, "InvalidCidLength");
    });

    it("should revert with empty event name", async function () {
      await expect(
        nft.connect(user1).mintWithFula("", "QmTest", 0, 1, 0)
      ).to.be.revertedWithCustomError(nft, "EventNameEmpty");
    });
  });

  describe("URI", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTestCid123", FULA_PER_NFT, 1, 0);
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

      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmTest", 0, 1, 0);
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
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmPaused", 0, 1, 0)
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

      await nft.connect(user1).mintWithFula("photos", "QmPhoto1", FULA_PER_NFT, 1, 0);
      await nft.connect(user1).mintWithFula("photos", "QmPhoto2", FULA_PER_NFT, 1, 0);
      await nft.connect(user1).mintWithFula("videos", "QmVideo1", FULA_PER_NFT, 1, 0);

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

  describe("ERC-2981 royalties", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should return correct royalty info for token with royalty", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT);

      // Mint with 5% royalty (500 basis points)
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmRoyalty", FULA_PER_NFT, 1, 500);

      const salePrice = ethers.parseEther("100");
      const [receiver, royaltyAmount] = await nft.royaltyInfo(1, salePrice);

      expect(receiver).to.equal(user1.address);
      // 5% of 100 = 5
      expect(royaltyAmount).to.equal(ethers.parseEther("5"));
    });

    it("should return zero royalty for token minted with 0 bps", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmNoRoyalty", 0, 1, 0);

      const salePrice = ethers.parseEther("100");
      const [receiver, royaltyAmount] = await nft.royaltyInfo(1, salePrice);

      expect(receiver).to.equal(user1.address);
      expect(royaltyAmount).to.equal(0);
    });

    it("should support 100% royalty (10000 bps)", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmFullRoyalty", 0, 1, 10000);

      const salePrice = ethers.parseEther("100");
      const [, royaltyAmount] = await nft.royaltyInfo(1, salePrice);

      expect(royaltyAmount).to.equal(salePrice);
    });

    it("should revert with royalty > 10000 bps", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmBadRoyalty", 0, 1, 10001)
      ).to.be.revertedWithCustomError(nft, "RoyaltyTooHigh");
    });

    it("should report ERC-2981 interface support", async function () {
      // ERC-2981 interfaceId = 0x2a55205a
      expect(await nft.supportsInterface("0x2a55205a")).to.be.true;
    });

    it("should revert royaltyInfo for non-existent token", async function () {
      await expect(nft.royaltyInfo(999, 100)).to.be.revertedWithCustomError(nft, "InvalidTokenId");
    });
  });

  // ===========================================================================
  // SECURITY AUDIT — NEW TESTS
  // ===========================================================================

  /** Helper: extract claimKey from a createClaimOffer transaction */
  async function extractClaimKey(nftContract: FulaFileNFT, tx: any): Promise<string> {
    const receipt = await tx.wait();
    const event = receipt?.logs.find((log: any) => {
      try {
        return nftContract.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === "ClaimOfferCreated";
      } catch { return false; }
    });
    return nftContract.interface.parseLog({ topics: event!.topics as string[], data: event!.data })!.args[0];
  }

  describe("boundary conditions", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should mint exactly MAX_MINT_COUNT (1000) successfully", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmMax1000", 0, 1000, 0);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1000);
    });

    it("should revert mint with count > MAX_MINT_COUNT (1001)", async function () {
      await expect(
        nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmOver", 0, 1001, 0)
      ).to.be.revertedWithCustomError(nft, "ExceedsMaxMintCount");
    });

    it("should create claim offer at exactly MAX_CLAIM_DURATION (365 days)", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDur", 0, 1, 0);
      const now = await time.latest();
      const expiresAt = now + 365 * 24 * 60 * 60;
      const { claimKey } = generateClaimKeyPair();
      // Should succeed without reverting
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);
    });

    it("should revert claim offer with expiry > MAX_CLAIM_DURATION", async function () {
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmDur2", 0, 1, 0);
      const now = await time.latest();
      // +2 because block.timestamp advances by at least 1 when the tx is mined
      const expiresAt = now + 365 * 24 * 60 * 60 + 2;
      const { claimKey } = generateClaimKeyPair();
      await expect(
        nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey)
      ).to.be.revertedWithCustomError(nft, "ExpiryTooFar");
    });

    it("should accept event name at exactly MAX_EVENT_NAME_LENGTH (128 chars)", async function () {
      const name128 = "a".repeat(128);
      await nft.connect(user1).mintWithFula(name128, "QmLen128", 0, 1, 0);
      const events = await nft.getCreatorEvents(user1.address);
      expect(events).to.include(name128);
    });

    it("should revert with event name > MAX_EVENT_NAME_LENGTH (129 chars)", async function () {
      const name129 = "a".repeat(129);
      await expect(
        nft.connect(user1).mintWithFula(name129, "QmLen129", 0, 1, 0)
      ).to.be.revertedWithCustomError(nft, "EventNameTooLong");
    });
  });

  describe("pausable coverage", function () {
    let claimSecret: string;
    let claimClaimKey: string;

    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();

      // Mint tokens and create a claim offer BEFORE pausing
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(5));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmPause", FULA_PER_NFT, 5, 0);

      // Create a claim offer for claimNFT / cancelClaimOffer tests
      const pair = generateClaimKeyPair();
      claimSecret = pair.secret;
      claimClaimKey = pair.claimKey;
      const expiresAt = (await time.latest()) + 86400;
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimClaimKey);

      // Send surplus FULA so recoverERC20 has something to recover
      await fulaToken.connect(user1).transfer(nftAddress, ethers.parseEther("50"));

      // Pause the contract
      await time.increase(86401);
      await nft.connect(owner).setRoleQuorum(ADMIN_ROLE, 2);
      await nft.connect(owner).emergencyAction(1);
      expect(await nft.paused()).to.be.true;
    });

    it("should revert createClaimOffer when paused", async function () {
      const { claimKey } = generateClaimKeyPair();
      await expect(
        nft.connect(user1).createClaimOffer(1, user2.address, (await time.latest()) + 86400, claimKey)
      ).to.be.reverted;
    });

    it("should revert claimNFT when paused", async function () {
      await expect(
        nft.connect(user2).claimNFT(claimSecret)
      ).to.be.reverted;
    });

    it("should revert burn when paused", async function () {
      await expect(
        nft.connect(user1).burn(user1.address, 1, 1)
      ).to.be.reverted;
    });

    it("should revert cancelClaimOffer when paused", async function () {
      await expect(
        nft.connect(user1).cancelClaimOffer(claimClaimKey)
      ).to.be.reverted;
    });

    it("should revert setBaseUri when paused", async function () {
      await expect(
        nft.connect(owner).setBaseUri("https://new.example.com/")
      ).to.be.reverted;
    });

    it("should revert recoverERC20 when paused", async function () {
      await expect(
        nft.connect(owner).recoverERC20(
          await fulaToken.getAddress(),
          ethers.parseEther("1"),
          admin.address
        )
      ).to.be.reverted;
    });
  });

  describe("claim state machine", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).approve(nftAddress, FULA_PER_NFT * BigInt(3));
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmState", FULA_PER_NFT, 3, 0);
    });

    it("should revert cancel on already-claimed offer", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { secret, claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, claimKey);

      // Claim it
      await nft.connect(user2).claimNFT(secret);

      // Try to cancel — should revert with OfferNotActive
      await expect(
        nft.connect(user1).cancelClaimOffer(claimKey)
      ).to.be.revertedWithCustomError(nft, "OfferNotActive");
    });

    it("should revert burn when tokens are escrowed in claim offer", async function () {
      // user1 has 3 tokens. Escrow 2 via claim offers.
      const expiresAt = (await time.latest()) + 86400;
      const pair1 = generateClaimKeyPair();
      const pair2 = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, pair1.claimKey);
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, pair2.claimKey);

      // user1 now has 1 token, contract has 2. Try to burn 2 from user1.
      expect(await nft.balanceOf(user1.address, 1)).to.equal(1);
      await expect(
        nft.connect(user1).burn(user1.address, 1, 2)
      ).to.be.reverted; // ERC1155InsufficientBalance
    });
  });

  describe("recoverERC20 edge cases", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();
    });

    it("should revert recoverERC20 with to = address(0)", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).transfer(nftAddress, ethers.parseEther("10"));

      await expect(
        nft.connect(owner).recoverERC20(
          await fulaToken.getAddress(),
          ethers.parseEther("10"),
          ZeroAddress
        )
      ).to.be.revertedWithCustomError(nft, "InvalidAddress");
    });

    it("should revert recoverERC20 from non-admin", async function () {
      const nftAddress = await nft.getAddress();
      await fulaToken.connect(user1).transfer(nftAddress, ethers.parseEther("10"));

      await expect(
        nft.connect(user1).recoverERC20(
          await fulaToken.getAddress(),
          ethers.parseEther("10"),
          user1.address
        )
      ).to.be.reverted; // AccessControl
    });

    it("should recover non-FULA ERC20 without surplus check", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockERC20Factory.deploy(ethers.parseEther("1000")) as MockERC20;
      await mockToken.waitForDeployment();

      const nftAddress = await nft.getAddress();
      const amount = ethers.parseEther("100");

      // Send mock tokens to NFT contract
      await mockToken.transfer(nftAddress, amount);
      expect(await mockToken.balanceOf(nftAddress)).to.equal(amount);

      // Recover — should succeed without surplus check
      const balBefore = await mockToken.balanceOf(admin.address);
      await nft.connect(owner).recoverERC20(
        await mockToken.getAddress(),
        amount,
        admin.address
      );
      const balAfter = await mockToken.balanceOf(admin.address);
      expect(balAfter - balBefore).to.equal(amount);
    });
  });

  describe("ERC1155 receiver rejection", function () {
    let mockErc1155: MockERC1155;

    beforeEach(async function () {
      const MockERC1155Factory = await ethers.getContractFactory("MockERC1155");
      mockErc1155 = await MockERC1155Factory.deploy() as MockERC1155;
      await mockErc1155.waitForDeployment();

      // Mint external ERC1155 tokens to user1 (EOA — no receiver check)
      await mockErc1155.mint(user1.address, 1, 10);
      await mockErc1155.mintBatch(user1.address, [2, 3], [5, 5]);
    });

    it("should reject external ERC1155 single transfer", async function () {
      const nftAddress = await nft.getAddress();
      await expect(
        mockErc1155.connect(user1).safeTransferFrom(user1.address, nftAddress, 1, 1, "0x")
      ).to.be.revertedWithCustomError(nft, "ExternalTokensRejected");
    });

    it("should reject external ERC1155 batch transfer", async function () {
      const nftAddress = await nft.getAddress();
      await expect(
        mockErc1155.connect(user1).safeBatchTransferFrom(
          user1.address, nftAddress, [2, 3], [1, 1], "0x"
        )
      ).to.be.revertedWithCustomError(nft, "ExternalTokensRejected");
    });
  });

  describe("double initialization", function () {
    it("should revert when initialize is called again", async function () {
      await expect(
        nft.initialize(owner.address, admin.address, await fulaToken.getAddress(), BASE_URI)
      ).to.be.reverted; // InvalidInitialization
    });
  });

  // ============================================================================
  // META-TX GASLESS CLAIMS (creator-sponsored gas on Base)
  // ============================================================================

  describe("meta-tx gasless claims", function () {
    let secret: string;
    let claimKey: string;
    const metadataCid = "QmMetaTxTest";

    // EIP-712 domain and types for signTypedData (ethers v6)
    function getDomain(contractAddress: string, chainId: number) {
      return {
        name: "FulaFileNFT",
        version: "1",
        chainId,
        verifyingContract: contractAddress,
      };
    }

    const claimTypes = {
      ClaimNFTMeta: [
        { name: "claimKey", type: "bytes32" },
        { name: "claimer", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const burnTypes = {
      BurnMeta: [
        { name: "claimKey", type: "bytes32" },
        { name: "tokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "holder", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };

    const transferBackTypes = {
      TransferBackMeta: [
        { name: "claimKey", type: "bytes32" },
        { name: "tokenId", type: "uint256" },
        { name: "holder", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    };

    async function signClaimMetaRaw(
      signer: SignerWithAddress,
      claimKey: string,
      claimer: string,
      deadline: number,
      nonce: number,
      contractAddress: string,
      chainId: number
    ) {
      const domain = getDomain(contractAddress, chainId);
      const value = { claimKey, claimer, deadline, nonce };
      return signer.signTypedData(domain, claimTypes, value);
    }

    async function signBurnMetaRaw(
      signer: SignerWithAddress,
      claimKey: string,
      tokenId: number,
      amount: number,
      holder: string,
      deadline: number,
      nonce: number,
      contractAddress: string,
      chainId: number
    ) {
      const domain = getDomain(contractAddress, chainId);
      const value = { claimKey, tokenId, amount, holder, deadline, nonce };
      return signer.signTypedData(domain, burnTypes, value);
    }

    async function signTransferBackMetaRaw(
      signer: SignerWithAddress,
      claimKey: string,
      tokenId: number,
      holder: string,
      deadline: number,
      nonce: number,
      contractAddress: string,
      chainId: number
    ) {
      const domain = getDomain(contractAddress, chainId);
      const value = { claimKey, tokenId, holder, deadline, nonce };
      return signer.signTypedData(domain, transferBackTypes, value);
    }

    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      // Mint 5 free NFTs for user1
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, metadataCid, 0, 5, 0);

      // Generate secret/claimKey pair
      const pair = generateClaimKeyPair();
      secret = pair.secret;
      claimKey = pair.claimKey;

      // Create claim offer with gas deposit (0.01 ETH)
      const expiresAt = (await time.latest()) + 86400;
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey, {
        value: ethers.parseEther("0.01"),
      });
    });

    it("should store gas deposit with createClaimOffer{value}", async function () {
      const deposit = await nft.claimGasDeposits(claimKey);
      expect(deposit).to.equal(ethers.parseEther("0.01"));
    });

    it("should create claim offer without value (backward compat)", async function () {
      const expiresAt = (await time.latest()) + 86400;
      const { claimKey: ck } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, ck);
      const deposit = await nft.claimGasDeposits(ck);
      expect(deposit).to.equal(0);
    });

    it("should claimNFTMeta with valid EIP-712 sig → NFT to claimer + relay reimbursed", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;
      const nonce = Number(await nft.metaNonces(user2.address));

      // Sign over claimKey (public key), not secret
      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, nonce, nftAddress, Number(chainId));

      // Admin acts as relay — pass secret (not claimKey) to claimNFTMeta
      const balanceBefore = await ethers.provider.getBalance(admin.address);
      const tx = await nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, nonce, sig);
      const receipt = await tx.wait();

      // NFT goes to claimer
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);

      // Nonce incremented
      expect(await nft.metaNonces(user2.address)).to.equal(1);

      // Gas deposit decreased (relay was reimbursed)
      const depositAfter = await nft.claimGasDeposits(claimKey);
      expect(depositAfter).to.be.lt(ethers.parseEther("0.01"));
    });

    it("should revert claimNFTMeta with wrong signer", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;
      const nonce = 0;

      // user1 signs but we say claimer is user2
      const sig = await signClaimMetaRaw(user1, claimKey, user2.address, deadline, nonce, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, nonce, sig)
      ).to.be.revertedWithCustomError(nft, "InvalidMetaSignature");
    });

    it("should revert claimNFTMeta with expired deadline", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) - 1; // already expired
      const nonce = 0;

      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, nonce, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, nonce, sig)
      ).to.be.revertedWithCustomError(nft, "MetaTxExpired");
    });

    it("should revert claimNFTMeta with wrong nonce", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;
      const wrongNonce = 99;

      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, wrongNonce, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, wrongNonce, sig)
      ).to.be.revertedWithCustomError(nft, "InvalidNonce");
    });

    it("should prevent replay attack (same sig used twice)", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;
      const nonce = 0;

      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, nonce, nftAddress, Number(chainId));

      // First call succeeds — pass secret to claimNFTMeta
      await nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, nonce, sig);

      // Create a second claim offer for replay attempt
      const expiresAt = (await time.latest()) + 86400;
      const pair2 = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, pair2.claimKey, {
        value: ethers.parseEther("0.01"),
      });

      // Second call with same sig reverts (nonce was incremented)
      await expect(
        nft.connect(admin).claimNFTMeta(pair2.secret, user2.address, deadline, nonce, sig)
      ).to.be.revertedWithCustomError(nft, "InvalidNonce");
    });

    it("should burnMeta after meta-claim", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // First: claim via meta-tx — pass secret to claimNFTMeta
      const claimDeadline = (await time.latest()) + 300;
      const claimNonce = 0;
      const claimSig = await signClaimMetaRaw(user2, claimKey, user2.address, claimDeadline, claimNonce, nftAddress, Number(chainId));
      await nft.connect(admin).claimNFTMeta(secret, user2.address, claimDeadline, claimNonce, claimSig);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);

      // Then: burn via meta-tx — burnMeta takes claimKey (not secret)
      const burnDeadline = (await time.latest()) + 300;
      const burnNonce = 1; // incremented from claim
      const burnSig = await signBurnMetaRaw(user2, claimKey, 1, 1, user2.address, burnDeadline, burnNonce, nftAddress, Number(chainId));
      await nft.connect(admin).burnMeta(claimKey, 1, 1, user2.address, burnDeadline, burnNonce, burnSig);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(0);
    });

    it("should transferBackMeta → NFT to creator + relay reimbursed", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // First: claim via meta-tx — pass secret to claimNFTMeta
      const claimDeadline = (await time.latest()) + 300;
      const claimNonce = 0;
      const claimSig = await signClaimMetaRaw(user2, claimKey, user2.address, claimDeadline, claimNonce, nftAddress, Number(chainId));
      await nft.connect(admin).claimNFTMeta(secret, user2.address, claimDeadline, claimNonce, claimSig);

      const creatorBalBefore = await nft.balanceOf(user1.address, 1);

      // Then: transfer back via meta-tx — transferBackMeta takes claimKey (not secret)
      const tbDeadline = (await time.latest()) + 300;
      const tbNonce = 1;
      const tbSig = await signTransferBackMetaRaw(user2, claimKey, 1, user2.address, tbDeadline, tbNonce, nftAddress, Number(chainId));
      await nft.connect(admin).transferBackMeta(claimKey, 1, user2.address, tbDeadline, tbNonce, tbSig);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(0);
      expect(await nft.balanceOf(user1.address, 1)).to.equal(creatorBalBefore + BigInt(1));
    });

    it("should withdrawGasDeposit by creator after claim", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Claim via meta-tx — pass secret to claimNFTMeta
      const deadline = (await time.latest()) + 300;
      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, 0, nftAddress, Number(chainId));
      await nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, 0, sig);

      // Offer is now claimed (status=1), creator can withdraw remaining deposit
      const depositBefore = await nft.claimGasDeposits(claimKey);
      if (depositBefore > 0) {
        const balBefore = await ethers.provider.getBalance(user1.address);
        await nft.connect(user1).withdrawGasDeposit(claimKey);
        const balAfter = await ethers.provider.getBalance(user1.address);
        // Balance should increase (minus gas cost for the withdraw tx)
        expect(await nft.claimGasDeposits(claimKey)).to.equal(0);
      }
    });

    it("should revert withdrawGasDeposit while offer is still active", async function () {
      await expect(
        nft.connect(user1).withdrawGasDeposit(claimKey)
      ).to.be.revertedWithCustomError(nft, "OfferStillActive");
    });

    it("should still support old claimNFT(secret) flow (backward compat)", async function () {
      // Create a new claim offer without gas deposit
      const expiresAt = (await time.latest()) + 86400;
      const { secret: newSecret, claimKey: newClaimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, user2.address, expiresAt, newClaimKey);

      // Old-style claim still works — pass secret
      await nft.connect(user2).claimNFT(newSecret);
      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);
    });

    // ===========================================================================
    // SECURITY AUDIT — Meta-tx additional tests
    // ===========================================================================

    it("should revert claimNFTMeta with wrong chainId (cross-chain replay)", async function () {
      const nftAddress = await nft.getAddress();
      const deadline = (await time.latest()) + 300;
      const nonce = 0;

      // Sign with wrong chainId (9999 instead of hardhat's 31337)
      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, nonce, nftAddress, 9999);

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, nonce, sig)
      ).to.be.revertedWithCustomError(nft, "InvalidMetaSignature");
    });

    it("should revert claimNFTMeta with skipped nonce (nonce=2 when expected=0)", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;

      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, 2, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, 2, sig)
      ).to.be.revertedWithCustomError(nft, "InvalidNonce");
    });

    it("should revert burnMeta with insufficient balance (burn 10, own 1)", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // First claim to get 1 NFT — pass secret to claimNFTMeta
      const claimDeadline = (await time.latest()) + 300;
      const claimSig = await signClaimMetaRaw(user2, claimKey, user2.address, claimDeadline, 0, nftAddress, Number(chainId));
      await nft.connect(admin).claimNFTMeta(secret, user2.address, claimDeadline, 0, claimSig);

      expect(await nft.balanceOf(user2.address, 1)).to.equal(1);

      // Try to burn 10 via meta-tx when only holding 1 — burnMeta takes claimKey
      const burnDeadline = (await time.latest()) + 300;
      const burnSig = await signBurnMetaRaw(user2, claimKey, 1, 10, user2.address, burnDeadline, 1, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).burnMeta(claimKey, 1, 10, user2.address, burnDeadline, 1, burnSig)
      ).to.be.reverted; // ERC1155InsufficientBalance
    });

    it("should revert transferBackMeta when holder has no tokens", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;

      // user2 doesn't own token 1 — sign transferBack anyway — transferBackMeta takes claimKey
      const sig = await signTransferBackMetaRaw(user2, claimKey, 1, user2.address, deadline, 0, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).transferBackMeta(claimKey, 1, user2.address, deadline, 0, sig)
      ).to.be.reverted; // ERC1155InsufficientBalance
    });

    it("should revert withdrawGasDeposit by non-creator (gas deposit theft)", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;

      // Claim the NFT so offer is no longer active (status=1) — pass secret
      const deadline = (await time.latest()) + 300;
      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, 0, nftAddress, Number(chainId));
      await nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, 0, sig);

      // Non-creator (user2) tries to withdraw gas deposit
      await expect(
        nft.connect(user2).withdrawGasDeposit(claimKey)
      ).to.be.revertedWithCustomError(nft, "NotAuthorizedToCancel");
    });

    it("should emit MetaNonceUsed on claimNFTMeta", async function () {
      const nftAddress = await nft.getAddress();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const deadline = (await time.latest()) + 300;

      const sig = await signClaimMetaRaw(user2, claimKey, user2.address, deadline, 0, nftAddress, Number(chainId));

      await expect(
        nft.connect(admin).claimNFTMeta(secret, user2.address, deadline, 0, sig)
      ).to.emit(nft, "MetaNonceUsed").withArgs(user2.address, 1);
    });
  });

  // ===========================================================================
  // SECURITY AUDIT — Upgrade timelock tests (F1 fix)
  // ===========================================================================

  describe("security: upgrade timelock", function () {
    it("should revert upgrade without proposal", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await expect(
        nft.connect(owner).upgradeToAndCall(newAddr, "0x")
      ).to.be.revertedWithCustomError(nft, "UpgradeNotProposed");
    });

    it("should revert upgrade before 48h timelock expires", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await nft.connect(owner).proposeUpgrade(newAddr);

      // Try immediately
      await expect(
        nft.connect(owner).upgradeToAndCall(newAddr, "0x")
      ).to.be.revertedWithCustomError(nft, "UpgradeTimelockActive");

      // Try after 24h (still too early)
      await time.increase(24 * 60 * 60);
      await expect(
        nft.connect(owner).upgradeToAndCall(newAddr, "0x")
      ).to.be.revertedWithCustomError(nft, "UpgradeTimelockActive");
    });

    it("should allow upgrade after 48h timelock", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await nft.connect(owner).proposeUpgrade(newAddr);

      // Wait 48 hours + 1 second
      await time.increase(48 * 60 * 60 + 1);

      // Upgrade should succeed
      await nft.connect(owner).upgradeToAndCall(newAddr, "0x");
    });

    it("should revert proposeUpgrade by non-admin", async function () {
      await expect(
        nft.connect(user1).proposeUpgrade(user1.address)
      ).to.be.reverted; // AccessControl
    });

    it("should revert upgrade by non-admin", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      // Admin proposes
      await nft.connect(owner).proposeUpgrade(newAddr);
      await time.increase(48 * 60 * 60 + 1);

      // Non-admin tries to execute
      await expect(
        nft.connect(user1).upgradeToAndCall(newAddr, "0x")
      ).to.be.reverted; // AccessControl
    });

    it("should revert proposeUpgrade when proposal already exists", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await nft.connect(owner).proposeUpgrade(newAddr);

      await expect(
        nft.connect(owner).proposeUpgrade(newAddr)
      ).to.be.revertedWithCustomError(nft, "UpgradeAlreadyProposed");
    });

    it("should cancelUpgrade and allow re-proposal", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await nft.connect(owner).proposeUpgrade(newAddr);
      await nft.connect(owner).cancelUpgrade(newAddr);

      // pendingUpgrade should be cleared
      expect(await nft.pendingUpgrade(newAddr)).to.equal(0);

      // Re-proposal should succeed
      await nft.connect(owner).proposeUpgrade(newAddr);
      expect(await nft.pendingUpgrade(newAddr)).to.be.gt(0);
    });

    it("should revert cancelUpgrade for non-existent proposal", async function () {
      await expect(
        nft.connect(owner).cancelUpgrade(user1.address)
      ).to.be.revertedWithCustomError(nft, "UpgradeNotPending");
    });

    it("should revert cancelUpgrade by non-admin", async function () {
      const Factory = await ethers.getContractFactory("FulaFileNFT");
      const newImpl = await Factory.deploy();
      const newAddr = await newImpl.getAddress();

      await nft.connect(owner).proposeUpgrade(newAddr);

      await expect(
        nft.connect(user1).cancelUpgrade(newAddr)
      ).to.be.reverted; // AccessControl
    });
  });

  // ===========================================================================
  // SECURITY AUDIT — Admin role management (F8 fix)
  // ===========================================================================

  describe("security: admin role management", function () {
    it("should revert admin renounceRole when adminCount is 2 (minimum)", async function () {
      expect(await nft.adminCount()).to.equal(2);

      await expect(
        nft.connect(owner).renounceRole(ADMIN_ROLE, owner.address)
      ).to.be.revertedWithCustomError(nft, "MinimumAdminRequired");

      // adminCount should still be 2
      expect(await nft.adminCount()).to.equal(2);
      expect(await nft.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("should track adminCount via _grantRole during initialization", async function () {
      // _grantRole is called during __GovernanceModule_init for both owner and admin
      // adminCount should be 2 (set by _grantRole override, not manual assignment)
      expect(await nft.adminCount()).to.equal(2);
      expect(await nft.hasRole(ADMIN_ROLE, owner.address)).to.be.true;
      expect(await nft.hasRole(ADMIN_ROLE, admin.address)).to.be.true;

      // Verify that a fresh deploy with a new proxy also gets adminCount = 2
      const FulaFileNFTFactory = await ethers.getContractFactory("FulaFileNFT");
      const nft2 = await upgrades.deployProxy(
        FulaFileNFTFactory,
        [owner.address, admin.address, await fulaToken.getAddress(), BASE_URI],
        { kind: 'uups', initializer: 'initialize' }
      ) as FulaFileNFT;
      await nft2.waitForDeployment();
      expect(await nft2.adminCount()).to.equal(2);
    });
  });

  // ===========================================================================
  // SECURITY AUDIT — ETH handling (F3 fix)
  // ===========================================================================

  describe("security: ETH handling", function () {
    it("should reject direct ETH transfer (receive removed)", async function () {
      const nftAddress = await nft.getAddress();

      await expect(
        owner.sendTransaction({ to: nftAddress, value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });

  // ===========================================================================
  // SECURITY AUDIT — Minimum gas deposit (F4 fix)
  // ===========================================================================

  describe("security: minimum gas deposit", function () {
    beforeEach(async function () {
      await setupQuorumAndWhitelist();

      // Mint free NFTs for user1
      await nft.connect(user1).mintWithFula(DEFAULT_EVENT, "QmMinDeposit", 0, 5, 0);
    });

    it("should revert createClaimOffer with deposit below minimum", async function () {
      await nft.connect(owner).setMinGasDeposit(ethers.parseEther("0.001"));

      const expiresAt = (await time.latest()) + 86400;
      const { claimKey } = generateClaimKeyPair();
      await expect(
        nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey, {
          value: 1n, // 1 wei, far below minimum
        })
      ).to.be.revertedWithCustomError(nft, "DepositTooLow");
    });

    it("should accept deposit at exactly minimum", async function () {
      const minDeposit = ethers.parseEther("0.001");
      await nft.connect(owner).setMinGasDeposit(minDeposit);

      const expiresAt = (await time.latest()) + 86400;
      const { claimKey } = generateClaimKeyPair();
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey, {
        value: minDeposit,
      });
      const hash = await extractClaimKey(nft, tx);
      expect(await nft.claimGasDeposits(hash)).to.equal(minDeposit);
    });

    it("should allow any deposit when minGasDeposit is 0 (default)", async function () {
      // Default minGasDeposit is 0 — any amount should work
      expect(await nft.minGasDeposit()).to.equal(0);

      const expiresAt = (await time.latest()) + 86400;
      const { claimKey } = generateClaimKeyPair();
      const tx = await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey, {
        value: 1n, // 1 wei
      });
      const hash = await extractClaimKey(nft, tx);
      expect(await nft.claimGasDeposits(hash)).to.equal(1);
    });

    it("should allow creating offer without deposit when minimum is set", async function () {
      await nft.connect(owner).setMinGasDeposit(ethers.parseEther("0.001"));

      // No value sent — should succeed (deposit check only applies when msg.value > 0)
      const expiresAt = (await time.latest()) + 86400;
      const { claimKey } = generateClaimKeyPair();
      await nft.connect(user1).createClaimOffer(1, ZeroAddress, expiresAt, claimKey);
    });

    it("should revert setMinGasDeposit by non-admin", async function () {
      await expect(
        nft.connect(user1).setMinGasDeposit(ethers.parseEther("1"))
      ).to.be.reverted; // AccessControl
    });
  });
});
