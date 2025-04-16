const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const axios = require("axios");
const readline = require("readline");

// Constants
const SLIPPAGE_BPS = 50; // 0.5% slippage
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";
const JUPITER_TOKEN_LIST_URL = "https://token.jup.ag/all";
const TOKEN_CACHE_FILE = "jupiter_tokens.json";
const POPULAR_TOKENS = ["USDC", "SOL", "BONK", "USDT", "ETH", "JUP", "RAY"];

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ask question as promise
function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Load wallet key
function loadWalletKey(keyPath) {
  try {
    const key = JSON.parse(readFileSync(keyPath, "utf-8"));
    return Keypair.fromSecretKey(new Uint8Array(key));
  } catch (err) {
    console.error("Error loading wallet key:", err.message);
    process.exit(1);
  }
}

// Get token list (from cache or Jupiter API)
async function getTokenList() {
  try {
    // Try to load from cache first
    if (existsSync(TOKEN_CACHE_FILE)) {
      console.log("Using cached token list...");
      return JSON.parse(readFileSync(TOKEN_CACHE_FILE, "utf-8"));
    }
    
    // If no cache, fetch from Jupiter
    console.log("Downloading Jupiter token list...");
    const response = await axios.get(JUPITER_TOKEN_LIST_URL);
    
    // Cache for future use
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(response.data));
    
    return response.data;
  } catch (err) {
    console.error("Error fetching token list:", err.message);
    process.exit(1);
  }
}

// Find token by symbol
function findTokenBySymbol(tokenList, symbol) {
  symbol = symbol.toUpperCase();
  
  // Try exact match first
  let token = tokenList.find(t => 
    t.symbol.toUpperCase() === symbol);
  
  // If no exact match, try partial match
  if (!token) {
    const matches = tokenList.filter(t => 
      t.symbol.toUpperCase().includes(symbol));
    
    // If multiple matches, prioritize verified tokens
    if (matches.length > 1) {
      const verifiedMatch = matches.find(t => t.tags?.includes("verified"));
      if (verifiedMatch) token = verifiedMatch;
      else token = matches[0]; // Just take the first one
    } else if (matches.length === 1) {
      token = matches[0];
    }
  }
  
  return token;
}

// Format token amount for display
function formatTokenAmount(amount, decimals) {
  const amountNum = parseFloat(amount) / Math.pow(10, decimals);
  return amountNum.toLocaleString('en-US', { 
    maximumFractionDigits: decimals 
  });
}

// Get user balance for a token
async function getTokenBalance(connection, walletAddress, tokenMint) {
  try {
    const url = `https://public-api.solscan.io/account/tokens?account=${walletAddress}`;
    const response = await axios.get(url);
    
    if (response.data && Array.isArray(response.data)) {
      const tokenAccount = response.data.find(t => t.tokenAddress === tokenMint);
      if (tokenAccount) {
        return tokenAccount.tokenAmount.uiAmount;
      }
    }
    return null;
  } catch (err) {
    console.warn(`Couldn't fetch balance for ${tokenMint}:`, err.message);
    return null;
  }
}

// Get swap quote from Jupiter
async function getSwapQuote(inputMint, outputMint, amount) {
  try {
    const response = await axios.get(`${JUPITER_API_BASE}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps: SLIPPAGE_BPS
      }
    });
    
    return response.data;
  } catch (err) {
    if (err.response && err.response.data) {
      console.error("Error fetching quote:", err.response.data);
    } else {
      console.error("Error fetching quote:", err.message);
    }
    return null;
  }
}

// Execute swap
async function executeSwap(connection, wallet, route) {
  try {
    const swapResponse = await axios.post(`${JUPITER_API_BASE}/swap`, {
      route: route,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true,
    });
    
    if (!swapResponse.data || !swapResponse.data.swapTransaction) {
      throw new Error("Failed to get swap transaction");
    }
    
    // Deserialize and execute the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, "base64");
    const transaction = Transaction.from(swapTransactionBuf);
    
    console.log("Sending swap transaction...");
    const txid = await sendAndConfirmTransaction(
      connection,
      transaction,
      [wallet],
      { commitment: "confirmed" }
    );
    
    return txid;
  } catch (err) {
    console.error("Failed to execute swap:", err.message);
    if (err.response && err.response.data) {
      console.error("API error details:", err.response.data);
    }
    return null;
  }
}

// Main function
async function main() {
  try {
    console.log("\n🪙 Interactive Solana Token Swap 🪙");
    console.log("==========================================");
    
    // Get or ask for wallet path
    let walletKeyPath = process.env.WALLET_KEY_PATH;
    if (!walletKeyPath) {
      walletKeyPath = await askQuestion("Enter path to your wallet key file: ");
    }
    
    // Initialize connection
    console.log("\nInitializing connection to Solana...");
    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const wallet = loadWalletKey(walletKeyPath);
    const walletPublicKey = wallet.publicKey.toString();
    
    console.log(`Wallet: ${walletPublicKey.slice(0, 8)}...${walletPublicKey.slice(-8)}`);
    
    // Get token list
    const tokenList = await getTokenList();
    console.log(`Loaded ${tokenList.length} tokens from Jupiter`);
    
    // Ask for input token
    console.log("\nPopular tokens: " + POPULAR_TOKENS.join(", "));
    const fromSymbol = await askQuestion("Enter token symbol you want to swap FROM: ");
    const fromToken = findTokenBySymbol(tokenList, fromSymbol);
    
    if (!fromToken) {
      console.error(`Token with symbol '${fromSymbol}' not found`);
      process.exit(1);
    }
    
    // Get token balance
    const balance = await getTokenBalance(connection, walletPublicKey, fromToken.address);
    
    console.log(`\nSelected: ${fromToken.name} (${fromToken.symbol})`);
    if (balance !== null) {
      console.log(`Your balance: ${balance} ${fromToken.symbol}`);
    }
    
    // Ask for amount
    const amount = await askQuestion(`Enter amount of ${fromToken.symbol} to swap: `);
    const inputAmountInSmallestUnit = Math.floor(parseFloat(amount) * Math.pow(10, fromToken.decimals));
    
    if (isNaN(inputAmountInSmallestUnit) || inputAmountInSmallestUnit <= 0) {
      console.error("Invalid amount");
      process.exit(1);
    }
    
    // Check if amount exceeds balance
    if (balance !== null && parseFloat(amount) > balance) {
      console.warn(`⚠️ Warning: Amount (${amount}) exceeds your balance (${balance})`);
      const proceed = await askQuestion("Do you want to proceed anyway? (y/n): ");
      if (proceed.toLowerCase() !== 'y') {
        process.exit(0);
      }
    }
    
    // Get quotes for popular tokens
    console.log("\nFetching swap quotes...");
    
    const quotes = [];
    for (const toSymbol of POPULAR_TOKENS) {
      // Skip if it's the same as input token
      if (toSymbol.toUpperCase() === fromToken.symbol.toUpperCase()) continue;
      
      const toToken = findTokenBySymbol(tokenList, toSymbol);
      if (!toToken) continue;
      
      process.stdout.write(`Getting quote for ${toToken.symbol}... `);
      const quote = await getSwapQuote(fromToken.address, toToken.address, inputAmountInSmallestUnit);
      
      if (quote) {
        quotes.push({
          token: toToken,
          quote: quote,
          outAmount: formatTokenAmount(quote.outAmount, toToken.decimals)
        });
        process.stdout.write(`✅ (get ${quotes[quotes.length-1].outAmount} ${toToken.symbol})\n`);
      } else {
        process.stdout.write(`❌ (no route available)\n`);
      }
    }
    
    // Allow user to input custom token
    console.log("\nYou can also enter a custom token symbol to check its rate.");
    const customSearch = await askQuestion("Enter token symbol to check (or press Enter to skip): ");
    
    if (customSearch.trim()) {
      const customToken = findTokenBySymbol(tokenList, customSearch);
      if (customToken && customToken.address !== fromToken.address) {
        process.stdout.write(`Getting quote for ${customToken.symbol}... `);
        const customQuote = await getSwapQuote(fromToken.address, customToken.address, inputAmountInSmallestUnit);
        
        if (customQuote) {
          quotes.push({
            token: customToken,
            quote: customQuote,
            outAmount: formatTokenAmount(customQuote.outAmount, customToken.decimals)
          });
          process.stdout.write(`✅ (get ${quotes[quotes.length-1].outAmount} ${customToken.symbol})\n`);
        } else {
          process.stdout.write(`❌ (no route available)\n`);
        }
      } else if (!customToken) {
        console.log(`Token with symbol '${customSearch}' not found`);
      } else {
        console.log(`Cannot swap to the same token`);
      }
    }
    
    // Display available swaps
    if (quotes.length === 0) {
      console.log("\n❌ No swap routes found for the selected token and amount");
      process.exit(1);
    }
    
    console.log("\nAvailable swaps:");
    console.log("-------------------------------------");
    
    quotes.forEach((q, i) => {
      console.log(`${i+1}. ${amount} ${fromToken.symbol} → ${q.outAmount} ${q.token.symbol}`);
      console.log(`   Price impact: ${q.quote.priceImpactPct.toFixed(2)}%`);
    });
    
    // Ask user to select a swap
    const selection = await askQuestion("\nSelect a swap to execute (enter number, or 0 to cancel): ");
    const selectedIndex = parseInt(selection) - 1;
    
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= quotes.length) {
      console.log("Swap cancelled or invalid selection");
      process.exit(0);
    }
    
    const selectedQuote = quotes[selectedIndex];
    console.log(`\nYou selected: ${amount} ${fromToken.symbol} → ${selectedQuote.outAmount} ${selectedQuote.token.symbol}`);
    
    // Confirm swap execution
    const confirm = await askQuestion("Execute this swap? (y/n): ");
    
    if (confirm.toLowerCase() === 'y') {
      const txid = await executeSwap(connection, wallet, selectedQuote.quote);
      
      if (txid) {
        console.log("\n✅ Swap successful!");
        console.log(`Transaction ID: ${txid}`);
        console.log(`Input: ${amount} ${fromToken.symbol}`);
        console.log(`Output: ~${selectedQuote.outAmount} ${selectedQuote.token.symbol}`);
        console.log(`View transaction: https://solscan.io/tx/${txid}`);
      } else {
        console.log("\n❌ Swap failed!");
      }
    } else {
      console.log("Swap cancelled");
    }
    
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    rl.close();
  }
}

// Run the main function
main();