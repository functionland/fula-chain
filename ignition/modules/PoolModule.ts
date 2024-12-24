import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { tokenModule } from "./TokenModule";

export const poolModule = buildModule("PoolModule", (m) => {
    const { token } = m.useModule(tokenModule);
    
    const pool = m.contract("StoragePool");
    const proxy = m.contract("TransparentUpgradeableProxy", [
        pool,
        m.getAccount(0),
        "0x"
    ]);
    
    return { pool, proxy };
});

export default poolModule;
