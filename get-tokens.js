const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
const { TokenListProvider } = require("@solana/spl-token-registry");
const axios = require("axios");
const fs = require("fs");

const address = process.argv[2];

if (!address) {
  console.error("Usage: node get-tokens.js <SolanaAddress>");
  process.exit(1);
}

(async () => {
  try {
    const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");
    const publicKey = new PublicKey(address);
    
    console.log("Fetching token accounts...");
    
    // Get token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
      }
    );
    
    // Filter tokens with non-zero balance
    const tokens = tokenAccounts.value
      .map(({ account }) => account.data.parsed.info)
      .filter(info => parseFloat(info.tokenAmount.uiAmount) > 0)
      .map(info => ({
        mint: info.mint,
        amount: info.tokenAmount.uiAmount
      }));
    
    if (tokens.length === 0) {
      console.log("No tokens found.");
      return;
    }
    
    console.log(`Found ${tokens.length} tokens. Fetching metadata...`);
    
    // Fetch Jupiter token list (has the most comprehensive token metadata)
    console.log("Downloading Jupiter token list...");
    const jupiterResponse = await axios.get("https://token.jup.ag/all");
    const jupiterTokens = jupiterResponse.data;
    console.log(`Downloaded metadata for ${jupiterTokens.length} tokens`);
    
    // Create a map for faster lookups
    const jupiterTokenMap = new Map();
    jupiterTokens.forEach(token => {
      jupiterTokenMap.set(token.address, token);
    });
    
    // Cache the Jupiter token list locally for future use
    fs.writeFileSync("jupiter_tokens.json", JSON.stringify(jupiterTokens));
    console.log("Cached Jupiter token list to jupiter_tokens.json");
    
    // Print results
    console.log(`\nTokens held by ${address}:\n`);
    tokens.forEach(token => {
      const tokenInfo = jupiterTokenMap.get(token.mint);
      const name = tokenInfo ? tokenInfo.name : "Unknown";
      const symbol = tokenInfo ? tokenInfo.symbol : "???";
      
      console.log(
        `Name: ${name} (${symbol}) | Mint: ${token.mint} | Amount: ${token.amount}`
      );
    });
    
    // Count how many tokens were found in Jupiter list
    const knownCount = tokens.filter(t => jupiterTokenMap.has(t.mint)).length;
    console.log(`\nIdentified ${knownCount} out of ${tokens.length} tokens (${Math.round(knownCount/tokens.length*100)}%)`);
    
    if (knownCount < tokens.length) {
      console.log("\nFor unknown tokens, you can look them up on Solscan:");
      tokens.filter(t => !jupiterTokenMap.has(t.mint)).forEach(t => {
        console.log(`https://solscan.io/token/${t.mint}`);
      });
    }
    
  } catch (err) {
    console.error("Error:", err.message);
  }
})();