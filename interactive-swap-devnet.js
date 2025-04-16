const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const axios = require("axios");
const readline = require("readline");

// Constants
const SLIPPAGE_BPS = 50; // 0.5% slippage
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6"; // Note: This uses the same API but will route differently for devnet
const JUPITER_TOKEN_LIST_URL = "https://token.jup.ag/all"; // This might need to be updated for devnet
const TOKEN_CACHE_FILE = "jupiter_tokens_devnet.json";
const NETWORK = "devnet"; // Changed to devnet
const POPULAR_TOKENS_DEVNET = ["USDC", "SOL", "WSOL"]; // Reduced set for devnet

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Ask question as promise
function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// Load wallet key from file or environment variable
function loadWalletKey(keyPath) {
  try {
    // Check if we have a private key in environment variable
    const privateKeyEnv = process.env.SOLANA_PRIVATE_KEY;
    if (privateKeyEnv) {
      console.log("Using private key from environment variable");
      
      // Handle different formats of the private key
      let privateKeyArray;
      if (privateKeyEnv.includes("[")) {
        // Handle JSON array format
        privateKeyArray = JSON.parse(privateKeyEnv);
      } else if (privateKeyEnv.includes(",")) {
        // Handle comma-separated format
        privateKeyArray = privateKeyEnv.split(",").map(num => parseInt(num.trim()));
      } else {
        // Handle base58 format (convert to Uint8Array)
        const bs58 = require("bs58");
        privateKeyArray = Array.from(bs58.decode(privateKeyEnv));
      }
      
      return Keypair.fromSecretKey(new Uint8Array(privateKeyArray));
    }
    
    // If no environment variable, load from file
    console.log("Loading private key from file");
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
    
    // Filter for tokens available on devnet (this is a simplification)
    // In reality, you would need a proper devnet token list
    const devnetTokens = response.data.filter(token => 
      POPULAR_TOKENS_DEVNET.includes(token.symbol) || 
      token.tags?.includes("devnet")
    );
    
    // Cache for future use
    writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(devnetTokens));
    
    return devnetTokens;
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

// Get user balance for a token on devnet
async function getTokenBalance(connection, walletAddress, tokenMint) {
  try {
    // For devnet, we'll use the native Solana API to get token balances
    // This is more reliable than third-party explorers for devnet
    
    // For SOL balance
    if (tokenMint.toLowerCase() === "solana" || tokenMint.toLowerCase() === "sol") {
      const balance = await connection.getBalance(new PublicKey(walletAddress));
      return balance / 1e9; // Convert lamports to SOL
    }
    
    // For SPL tokens
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(walletAddress),
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
    );
    
    for (const { account } of tokenAccounts.value) {
      const tokenInfo = account.data.parsed.info;
      if (tokenInfo.mint === tokenMint) {
        return parseFloat(tokenInfo.tokenAmount.uiAmountString);
      }
    }
    
    return 0; // No balance found
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
        slippageBps: SLIPPAGE_BPS,
        platformFeeBps: 0,
        onlyDirectRoutes: false,
        asLegacyTransaction: false,
        // Specify we want devnet
        useSharedAccounts: true,
        network: NETWORK
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
      network: NETWORK, // Specify devnet
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
    console.log("\n🪙 Interactive Solana Token Swap 🪙 (DEVNET)");
    console.log("==========================================");
    
    // Check if we have a private key in environment variable
    const hasPrivateKeyEnv = !!process.env.SOLANA_PRIVATE_KEY;
    
    // Get or ask for wallet path only if no private key in env
    let walletKeyPath = process.env.WALLET_KEY_PATH;
    if (!hasPrivateKeyEnv && !walletKeyPath) {
      walletKeyPath = await askQuestion("Enter path to your wallet key file: ");
    }
    
    // Initialize connection to DEVNET
    console.log("\nInitializing connection to Solana DEVNET...");
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");
    const wallet = loadWalletKey(walletKeyPath);
    const walletPublicKey = wallet.publicKey.toString();
    
    console.log(`Wallet: ${walletPublicKey.slice(0, 8)}...${walletPublicKey.slice(-8)}`);
    
    // Get token list
    const tokenList = await getTokenList();
    console.log(`Loaded ${tokenList.length} tokens available on devnet`);
    
    // Ask if they need devnet tokens
    const needsAirdrop = await askQuestion("\nDo you need devnet SOL? (y/n): ");
    if (needsAirdrop.toLowerCase() === 'y') {
      console.log("Requesting airdrop of 1 SOL...");
      const signature = await connection.requestAirdrop(wallet.publicKey, 1000000000);
      await connection.confirmTransaction(signature);
      console.log("Airdrop successful!");
    }
    
    // Ask for input token
    console.log("\nAvailable tokens on devnet: " + POPULAR_TOKENS_DEVNET.join(", "));
    const fromSymbol = await askQuestion("Enter token symbol you want to swap FROM: ");
    const fromToken = findTokenBySymbol(tokenList, fromSymbol);
    
    if (!fromToken) {
      console.error(`Token with symbol '${fromSymbol}' not found on devnet`);
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
    
    // Get quotes for available tokens
    console.log("\nFetching swap quotes on devnet (may have limited liquidity)...");
    
    const quotes = [];
    for (const toSymbol of POPULAR_TOKENS_DEVNET) {
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
        process.stdout.write(`❌ (no route available on devnet)\n`);
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
          process.stdout.write(`❌ (no route available on devnet)\n`);
        }
      } else if (!customToken) {
        console.log(`Token with symbol '${customSearch}' not found on devnet`);
      } else {
        console.log(`Cannot swap to the same token`);
      }
    }
    
    // Display available swaps
    if (quotes.length === 0) {
      console.log("\n❌ No swap routes found on devnet for the selected token and amount");
      console.log("Note: Devnet has much less liquidity than mainnet");
      process.exit(1);
    }
    
    console.log("\nAvailable swaps on devnet:");
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
    const confirm = await askQuestion("Execute this swap on DEVNET? (y/n): ");
    
    if (confirm.toLowerCase() === 'y') {
      const txid = await executeSwap(connection, wallet, selectedQuote.quote);
      
      if (txid) {
        console.log("\n✅ Swap successful on devnet!");
        console.log(`Transaction ID: ${txid}`);
        console.log(`Input: ${amount} ${fromToken.symbol}`);
        console.log(`Output: ~${selectedQuote.outAmount} ${selectedQuote.token.symbol}`);
        console.log(`View transaction: https://explorer.solana.com/tx/${txid}?cluster=devnet`);
      } else {
        console.log("\n❌ Swap failed on devnet!");
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