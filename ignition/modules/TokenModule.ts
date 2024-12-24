// ignition/modules/TokenModule.ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export const tokenModule = buildModule("TokenModule", (m) => {
    const proxyAdminOwner = m.getAccount(0);
    const token = m.contract("StorageToken");
    const proxy = m.contract("TransparentUpgradeableProxy", [
        token,
        proxyAdminOwner,
        m.encodeFunctionCall(token, "initialize", [])
    ]);
    
    return { token, proxy };
});

export default tokenModule;