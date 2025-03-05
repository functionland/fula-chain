// clear-upgrades-cache.js
const fs = require('fs');
const path = require('path');

// The network you're working with
const network = process.argv[2] || 'unknown';

// Path to the OpenZeppelin upgrades cache
const cachePath = path.join(process.cwd(), '.openzeppelin');

if (!fs.existsSync(cachePath)) {
  console.log('No OpenZeppelin cache directory found.');
  process.exit(0);
}

// Network cache specific to the current deployment
const networkCachePath = path.join(cachePath, network + '.json');

if (fs.existsSync(networkCachePath)) {
  console.log(`Removing cache for network: ${network}`);
  fs.unlinkSync(networkCachePath);
  console.log(`Successfully removed ${networkCachePath}`);
} else {
  console.log(`No cache file found for network: ${network}`);
}

// You might also want to check the unknown.json file if network parameters weren't specified correctly
const unknownCachePath = path.join(cachePath, 'unknown.json');
if (fs.existsSync(unknownCachePath)) {
  console.log('Removing cache for unknown network');
  fs.unlinkSync(unknownCachePath);
  console.log(`Successfully removed ${unknownCachePath}`);
}

console.log('OpenZeppelin cache clearing complete!');