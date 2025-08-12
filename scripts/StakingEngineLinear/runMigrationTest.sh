#!/bin/bash

# Migration Test Runner Script
# This script sets up a local Hardhat network and runs the comprehensive migration test

echo "🧪 STAKING ENGINE MIGRATION TEST RUNNER 🧪"
echo "=========================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "hardhat.config.ts" ]; then
    print_error "hardhat.config.ts not found. Please run this script from the project root directory."
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    print_warning "node_modules not found. Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        print_error "Failed to install dependencies"
        exit 1
    fi
fi

print_status "Starting Hardhat local network..."

# Kill any existing Hardhat node
pkill -f "hardhat node" 2>/dev/null || true

# Start Hardhat node in background
npx hardhat node > hardhat-node.log 2>&1 &
HARDHAT_PID=$!

# Wait for Hardhat node to start
print_status "Waiting for Hardhat node to start..."
sleep 5

# Check if Hardhat node is running
if ! ps -p $HARDHAT_PID > /dev/null; then
    print_error "Failed to start Hardhat node. Check hardhat-node.log for details."
    exit 1
fi

print_success "Hardhat node started (PID: $HARDHAT_PID)"

# Function to cleanup on exit
cleanup() {
    print_status "Cleaning up..."
    kill $HARDHAT_PID 2>/dev/null || true
    wait $HARDHAT_PID 2>/dev/null || true
    print_success "Cleanup complete"
}

# Set trap to cleanup on script exit
trap cleanup EXIT

print_status "Compiling contracts..."
npx hardhat compile
if [ $? -ne 0 ]; then
    print_error "Contract compilation failed"
    exit 1
fi
print_success "Contracts compiled successfully"

print_status "Running migration test..."
echo ""
echo "This test will:"
echo "1. Deploy original StakingEngineLinear contracts"
echo "2. Perform various staking operations"
echo "3. Extract all data from original contracts"
echo "4. Deploy new contracts with migration capabilities"
echo "5. Migrate all data to new contracts"
echo "6. Verify migration completeness and accuracy"
echo "7. Test functionality of migrated contracts"
echo ""

# Run the migration test
npx hardhat run scripts/StakingEngineLinear/deployAndMigrateLocalStakingEngine.ts --network localhost

TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -eq 0 ]; then
    print_success "Migration test completed successfully!"
    echo ""
    echo "📁 Generated files:"
    echo "- migration-data-local-test.json (extracted data)"
    echo "- migration-test-results-*.json (test results)"
    echo "- hardhat-node.log (node logs)"
    echo ""
    echo "🚀 The migration scripts are ready for mainnet deployment!"
else
    print_error "Migration test failed with exit code $TEST_EXIT_CODE"
    echo ""
    echo "Please check the output above for error details."
    echo "You can also check hardhat-node.log for additional information."
fi

exit $TEST_EXIT_CODE
