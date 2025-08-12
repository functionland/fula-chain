@echo off
setlocal enabledelayedexpansion

REM Migration Test Runner Script for Windows
REM This script sets up a local Hardhat network and runs the comprehensive migration test

echo 🧪 STAKING ENGINE MIGRATION TEST RUNNER 🧪
echo ==========================================

REM Check if we're in the right directory
if not exist "hardhat.config.ts" (
    echo [ERROR] hardhat.config.ts not found. Please run this script from the project root directory.
    exit /b 1
)

REM Check if node_modules exists
if not exist "node_modules" (
    echo [WARNING] node_modules not found. Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies
        exit /b 1
    )
)

echo [INFO] Starting Hardhat local network...

REM Kill any existing Hardhat node processes
taskkill /f /im node.exe 2>nul >nul

REM Start Hardhat node in background
start /b cmd /c "npx hardhat node > hardhat-node.log 2>&1"

REM Wait for Hardhat node to start
echo [INFO] Waiting for Hardhat node to start...
timeout /t 5 /nobreak >nul

echo [SUCCESS] Hardhat node started

echo [INFO] Compiling contracts...
call npx hardhat compile
if errorlevel 1 (
    echo [ERROR] Contract compilation failed
    exit /b 1
)
echo [SUCCESS] Contracts compiled successfully

echo [INFO] Running migration test...
echo.
echo This test will:
echo 1. Deploy original StakingEngineLinear contracts
echo 2. Perform various staking operations
echo 3. Extract all data from original contracts
echo 4. Deploy new contracts with migration capabilities
echo 5. Migrate all data to new contracts
echo 6. Verify migration completeness and accuracy
echo 7. Test functionality of migrated contracts
echo.

REM Run the migration test
call npx hardhat run scripts/StakingEngineLinear/deployAndMigrateLocalStakingEngine.ts --network localhost

if errorlevel 1 (
    echo [ERROR] Migration test failed
    echo.
    echo Please check the output above for error details.
    echo You can also check hardhat-node.log for additional information.
    exit /b 1
) else (
    echo [SUCCESS] Migration test completed successfully!
    echo.
    echo 📁 Generated files:
    echo - migration-data-local-test.json (extracted data)
    echo - migration-test-results-*.json (test results)
    echo - hardhat-node.log (node logs)
    echo.
    echo 🚀 The migration scripts are ready for mainnet deployment!
)

echo.
echo Press any key to exit...
pause >nul
