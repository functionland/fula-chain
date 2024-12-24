import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { tokenModule } from "./TokenModule";  // Import from TokenModule, not ProxyModule

const upgradeModule = buildModule("UpgradeModule", (m) => {
    const proxyAdminOwner = m.getAccount(0);
    const { proxy, token } = m.useModule(tokenModule);  // Use tokenModule
    const tokenV1 = m.contract("StorageTokenV1");
    
    const encodedFunctionCall = m.encodeFunctionCall(tokenV1, "initialize", []);

    m.call(proxy, "upgradeAndCall", [
        token, 
        tokenV1, 
        encodedFunctionCall
    ], {
        from: proxyAdminOwner,
    });

    return { proxy, token };
});

export default upgradeModule;
