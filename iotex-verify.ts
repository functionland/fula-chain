import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import glob from 'glob';

// Configuration
const CONTRACT_ADDRESS = "0x13Cd0bd6f577d937AD3268688D4907Afa4209DCb"; // Your contract
const CONTRACT_NAME = "StorageToken"; // Update with your contract name
const TEMP_DIR = "./temp-verify";

async function main() {
    console.log("Creating temporary files for IoTeX verification...");
    
    // Create temp directory
    if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    
    // Copy contracts directory
    fs.cpSync("./contracts", `${TEMP_DIR}/contracts`, { recursive: true });
    
    // Find all Solidity files and modify pragma
    const files = glob.sync(`${TEMP_DIR}/contracts/**/*.sol`);
    
    for (const file of files) {
        console.log(`Updating pragma in ${file}`);
        let content = fs.readFileSync(file, 'utf8');
        
        // Replace pragma
        content = content.replace(
            /pragma solidity (\^|>=)0\.8\.(2[4-9]|[3-9][0-9]);/g,
            'pragma solidity ^0.8.23;'
        );
        
        fs.writeFileSync(file, content);
        console.log(`Updated pragma in ${file}`);
    }
    console.log("Pragma updated in all Solidity files");
    
    // Create temporary hardhat config
    const tempHardhatConfig = `
module.exports = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 300
      },
      viaIR: true,
      evmVersion: "london"
    }
  },
  networks: {
    hardhat: {}
  }
};
    `;
    
    fs.writeFileSync(`${TEMP_DIR}/hardhat.config.js`, tempHardhatConfig);
    console.log("Hardhat config created");
    
    // Create package.json in temp dir
    const tempPackageJson = `
{
  "name": "temp-verification",
  "dependencies": {
    "hardhat": "^2.19.0",
    "@openzeppelin/contracts": "^4.9.3"
  }
}
    `;
    
    fs.writeFileSync(`${TEMP_DIR}/package.json`, tempPackageJson);
    console.log("Package.json created");
    
    // Copy node_modules to temp dir
    fs.cpSync("./node_modules", `${TEMP_DIR}/node_modules`, { recursive: true });
    console.log("Node_modules copied");
    
    // Compile with 0.8.23
    console.log("Compiling with Solidity 0.8.23...");
    try {
        execSync("npx hardhat compile", { 
            cwd: TEMP_DIR,
            stdio: 'inherit' 
        });
    } catch (error) {
        console.error("Error compiling with 0.8.23:", error);
        return;
    }
    
    // Flatten the contract
    console.log("Flattening the contract...");
    try {
        execSync(`npx hardhat flatten contracts/${CONTRACT_NAME}.sol > ${CONTRACT_NAME}_flattened.sol`, { 
            cwd: TEMP_DIR,
            stdio: 'inherit' 
        });
    } catch (error) {
        console.error("Error flattening contract:", error);
        return;
    }
    
    // Copy flattened file back to main directory
    fs.copyFileSync(
        `${TEMP_DIR}/${CONTRACT_NAME}_flattened.sol`, 
        `./${CONTRACT_NAME}_flattened_0.8.23.sol`
    );
    
    console.log(`\nVerification file created: ./${CONTRACT_NAME}_flattened_0.8.23.sol`);
    console.log("\nNow you can manually verify on IoTeX explorer with:");
    console.log(`- Contract Address: ${CONTRACT_ADDRESS}`);
    console.log(`- Contract Name: ${CONTRACT_NAME}`);
    console.log("- Compiler Version: v0.8.23");
    console.log("- Optimization: Enabled with 300 runs");
    console.log(`- Source Code: Copy from ${CONTRACT_NAME}_flattened_0.8.23.sol`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });