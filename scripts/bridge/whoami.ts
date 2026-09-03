// Read-only pre-flight: which account will sign, and is it funded on this network?
// Prints NO private key. Run before any testnet deployment.
//   npx hardhat run scripts/bridge/whoami.ts --network sepolia
//   npx hardhat run scripts/bridge/whoami.ts --network base-sepolia
import { ethers, network } from "hardhat";

async function main() {
  const signers = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`network      : ${network.name} (chainId ${net.chainId})`);
  console.log(`block        : ${await ethers.provider.getBlockNumber()}`);
  console.log(`signers      : ${signers.length}`);

  if (signers.length === 0) {
    console.log("\nNO SIGNING ACCOUNT CONFIGURED for this network.");
    console.log("Set it with:  npx hardhat vars set PK");
    return;
  }

  for (const s of signers) {
    const bal = await ethers.provider.getBalance(s.address);
    const nonce = await ethers.provider.getTransactionCount(s.address);
    console.log(
      `  ${s.address}  balance ${ethers.formatEther(bal).padEnd(22)} nonce ${nonce}`
    );
  }

  const fee = await ethers.provider.getFeeData();
  console.log(`gasPrice     : ${fee.gasPrice ? ethers.formatUnits(fee.gasPrice, "gwei") + " gwei" : "n/a"}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
