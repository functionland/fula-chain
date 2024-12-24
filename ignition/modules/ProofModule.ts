import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { tokenModule } from "./TokenModule";
import { poolModule } from "./PoolModule";

export const proofModule = buildModule("ProofModule", (m) => {
    const { token } = m.useModule(tokenModule);
    const { pool } = m.useModule(poolModule);
    
    const proof = m.contract("StorageProof");
    const proxy = m.contract("TransparentUpgradeableProxy", [
        proof,
        m.getAccount(0),
        m.encodeFunctionCall(proof, "initialize", [
            token.address,
            pool.address
        ])
    ]);
    
    // Initialize proof system parameters
    m.call(proof, "setStorageCost", [
        ethers.parseEther("0.001") // 0.001 tokens per TB/year
    ]);
    
    m.call(proof, "setMiningReward", [
        ethers.parseEther("100") // 100 tokens per day
    ]);
    
    return { proof, proxy };
});

export default proofModule;
