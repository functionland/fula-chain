// ignition/modules/TokenModule.ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { proxyModule } from "./ProxyModule";

export const tokenModule = buildModule("TokenModule", (m) => {
    const { proxy, proxyAdmin } = m.useModule(proxyModule);
    const token = m.contractAt("StorageToken", proxy);
    
    return { token, proxy, proxyAdmin };
});

export default tokenModule;