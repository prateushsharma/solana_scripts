const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
const axios = require("axios");
const fs = require("fs");

const HELIUS_API_KEY = "b4c3e2cf-d421-4c15-bf66-d7bd989c80a1";
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Add colorful console output support
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m"
};

const address = process.argv[2];

if (!address) {
  console.error(`${colors.red}⚠️  Error: No address provided${colors.reset}`);
  console.error(`${colors.bright}Usage: node get-tokens.js <SolanaAddress>${colors.reset}`);
  process.exit(1);
}

// Function to fetch asset details from Helius
async function getAssetDetails(mint) {
  try {
    const response = await axios.post(
      HELIUS_RPC_URL,
      {
        jsonrpc: "2.0",
        id: "test",
        method: "getAsset",
        params: {
          id: mint
        }
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
    
    if (response.data && response.data.result) {
      return response.data.result;
    }
    return null;
  } catch (error) {
    console.error(`Error fetching asset details for ${mint}:`, error.message);
    return null;
  }
}

(async () => {
  try {
    console.log(`\n${colors.cyan}🚀 Starting token scanner for address: ${colors.bright}${address}${colors.reset}`);
    
    const connection = new Connection(clusterApiUrl("mainnet-beta"), "confirmed");
    const publicKey = new PublicKey(address);
    
    console.log(`\n${colors.yellow}⏳ Fetching token accounts...${colors.reset}`);
    
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
      console.log(`\n${colors.yellow}💬 No tokens found.${colors.reset}`);
      return;
    }
    
    console.log(`\n${colors.green}✅ Found ${colors.bright}${tokens.length}${colors.reset}${colors.green} tokens with non-zero balance.${colors.reset}`);
    console.log(`\n${colors.yellow}⏳ Fetching token metadata...${colors.reset}`);
    
    // Fetch Jupiter token list (has the most comprehensive token metadata)
    console.log(`${colors.yellow}⏳ Downloading Jupiter token list...${colors.reset}`);
    const jupiterResponse = await axios.get("https://token.jup.ag/all");
    const jupiterTokens = jupiterResponse.data;
    console.log(`${colors.green}✅ Downloaded metadata for ${colors.bright}${jupiterTokens.length}${colors.reset}${colors.green} tokens${colors.reset}`);
    
    // Create a map for faster lookups
    const jupiterTokenMap = new Map();
    jupiterTokens.forEach(token => {
      jupiterTokenMap.set(token.address, token);
    });
    
    // Cache the Jupiter token list locally for future use
    fs.writeFileSync("jupiter_tokens.json", JSON.stringify(jupiterTokens));
    console.log(`${colors.green}💾 Cached Jupiter token list to jupiter_tokens.json${colors.reset}`);
    
    // First pass - identify tokens using Jupiter list and collect unknown tokens
    console.log(`\n🪙 Tokens held by ${address}:\n`);
    const unknownTokens = [];
    let tokenCounter = 1;
    
    for (const token of tokens) {
      const tokenInfo = jupiterTokenMap.get(token.mint);
      
      if (tokenInfo) {
        // Token found in Jupiter list
        console.log(`${tokenCounter}. ✅ ${tokenInfo.name} (${tokenInfo.symbol})`);
        console.log(`   💰 Amount: ${token.amount}`);
        console.log(`   🔑 Mint: ${token.mint}`);
        
        if (tokenInfo.logoURI) {
          console.log(`   🖼️ Logo: ${tokenInfo.logoURI}`);
        }
        console.log(""); // Empty line for better readability
        tokenCounter++;
      } else {
        // Token not found in Jupiter list, add to unknown tokens for second pass
        unknownTokens.push(token);
      }
    }
    
    // Second pass - try to identify unknown tokens using Helius API
    if (unknownTokens.length > 0) {
      console.log(`\n🔍 Fetching details for ${unknownTokens.length} unknown tokens using Helius API...\n`);
      
      for (const token of unknownTokens) {
        console.log(`⏳ Processing token: ${token.mint.slice(0, 8)}...${token.mint.slice(-8)}`);
        const assetDetails = await getAssetDetails(token.mint);
        
        if (assetDetails && assetDetails.content && assetDetails.content.metadata) {
          // Extract name and symbol from metadata
          const name = assetDetails.content.metadata.name || "Unknown";
          const symbol = assetDetails.content.metadata.symbol || "???";
          
          console.log(`${tokenCounter}. ✅ ${name} (${symbol})`);
          console.log(`   💰 Amount: ${token.amount}`);
          console.log(`   🔑 Mint: ${token.mint}`);
          
          // Try to get the image URL from files or links
          let logoURI = null;
          
          if (assetDetails.content.files && assetDetails.content.files.length > 0) {
            for (const file of assetDetails.content.files) {
              if (file.uri && (file.mime === "image/png" || file.mime === "image/jpeg")) {
                logoURI = file.uri;
                break;
              }
            }
          }
          
          // If no image found in files, try links.image
          if (!logoURI && assetDetails.content.links && assetDetails.content.links.image) {
            logoURI = assetDetails.content.links.image;
          }
          
          if (logoURI) {
            console.log(`   🖼️ Logo: ${logoURI}`);
          }
          
          console.log(""); // Empty line for better readability
          tokenCounter++;
        } else {
          // Still unknown after Helius API
          console.log(`${tokenCounter}. ❓ Unknown Token`);
          console.log(`   💰 Amount: ${token.amount}`);
          console.log(`   🔑 Mint: ${token.mint}`);
          console.log(""); // Empty line for better readability
          tokenCounter++;
        }
      }
    }
    
    // Count how many tokens were identified through Jupiter
    const jupiterKnownCount = tokens.length - unknownTokens.length;
    console.log(`\nIdentified ${jupiterKnownCount} out of ${tokens.length} tokens via Jupiter (${Math.round(jupiterKnownCount/tokens.length*100)}%)`);
    
    // Summary section with statistics and emojis
    
    // Jupiter stats
    // const jupiterKnownCount = tokens.length - unknownTokens.length;
    const jupiterPercentage = Math.round(jupiterKnownCount/tokens.length*100);
    console.log(`\n📊 Token Identification Summary:`);
    console.log(`   ✨ ${jupiterKnownCount} out of ${tokens.length} tokens identified via Jupiter (${jupiterPercentage}%)`);
    
    // Track how many tokens were identified through Helius
    let heliusIdentifiedCount = 0;
    let stillUnknownTokens = [];
    
    // We'll process this in the second pass
    for (const token of unknownTokens) {
      // If we already identified this token with Helius in the previous loop
      const assetDetails = await getAssetDetails(token.mint);
      if (assetDetails && assetDetails.content && assetDetails.content.metadata && assetDetails.content.metadata.name) {
        heliusIdentifiedCount++;
      } else {
        stillUnknownTokens.push(token);
      }
    }
    
    if (heliusIdentifiedCount > 0) {
      console.log(`   🌟 ${heliusIdentifiedCount} additional tokens identified via Helius API`);
    }
    
    // Calculate total identified tokens
    const totalIdentified = jupiterKnownCount + heliusIdentifiedCount;
    const totalPercentage = Math.round(totalIdentified/tokens.length*100);
    console.log(`   🏆 Total identified: ${totalIdentified} out of ${tokens.length} tokens (${totalPercentage}%)`);
    
    // List remaining unknown tokens
    if (stillUnknownTokens.length > 0) {
      console.log(`\n❓ ${stillUnknownTokens.length} tokens remain unknown. You can look them up on Solscan:`);
      let unknownCounter = 1;
      stillUnknownTokens.forEach(t => {
        console.log(`   ${unknownCounter}. 🔍 https://solscan.io/token/${t.mint}`);
        unknownCounter++;
      });
    }
    
  } catch (err) {
    console.error(`\n${colors.red}❌ Error: ${err.message}${colors.reset}`);
  } finally {
    console.log(`\n${colors.cyan}🏁 Token scan complete.${colors.reset}`);
  }
})();