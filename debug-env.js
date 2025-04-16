// A simple script to check if environment variables are properly set

console.log("Environment Variables Check");
console.log("==========================");
console.log("");

console.log("SOLANA_PRIVATE_KEY:");
if (process.env.SOLANA_PRIVATE_KEY) {
  // Only show part of the key for security
  const key = process.env.SOLANA_PRIVATE_KEY;
  const displayKey = key.length > 10 
    ? `${key.substring(0, 5)}...${key.substring(key.length - 5)}` 
    : key;
  console.log(`- Set: Yes (starting with ${displayKey})`);
} else {
  console.log("- Set: No");
}

console.log("\nWALLET_KEY_PATH:");
if (process.env.WALLET_KEY_PATH) {
  console.log(`- Set: Yes (${process.env.WALLET_KEY_PATH})`);
} else {
  console.log("- Set: No");
}

// Check for BS58 module which is needed for base58 encoded keys
console.log("\nBS58 module check:");
try {
  const bs58 = require("bs58");
  console.log("- BS58 module installed: Yes");
} catch (error) {
  console.log("- BS58 module installed: No (may need to run 'npm install bs58')");
}

console.log("\nNode.js version:", process.version);
console.log("Platform:", process.platform);

console.log("\nAll environment variables:");
const safeEnvVars = { ...process.env };
// Redact any sensitive environment variables
for (const key in safeEnvVars) {
  if (key.includes("KEY") || key.includes("SECRET") || key.includes("PASS") || key.includes("TOKEN")) {
    safeEnvVars[key] = "[REDACTED]";
  }
}
console.log(safeEnvVars);