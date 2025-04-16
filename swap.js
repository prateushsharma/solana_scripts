// Load environment variables from .env file
require('dotenv').config();

const { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { readFileSync, writeFileSync, existsSync } = require("fs");
const axios = require("axios");
const readline = require("readline");

// Constants
const SLIPPAGE_BPS = 50; // 0.5% slippage
const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";
const JUPITER_TOKEN_LIST_URL = "https://token.jup.ag/all";
const TOKEN_CACHE_FILE = "jupiter_tokens.json"; // Changed to mainnet tokens by default
const NETWORK = process.env.SOLANA_NETWORK || "devnet"; // Default to devnet now
const POPULAR_TOKENS = ["USDC", "SOL", "WSOL"]; // Simplified tokens list for devnet

// Configure network specifics
const NETWORK_CONFIG = {
  "mainnet-beta": {
    endpoint: "https://api.mainnet-beta.solana.com",
    explorerUrl: "https://explorer.solana.com/tx"
  },
  "devnet": {
    endpoint: "https://api.devnet.solana.com",
    explorerUrl: "https://explorer.solana.com/tx",
    explorerParams: "?cluster=devnet"
  }
};

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
  const cacheFile = NETWORK === "devnet" ? "jupiter_tokens_devnet.json" : "jupiter_tokens.json";
  
  try {
    // Try to load from cache first
    if (existsSync(cacheFile)) {
      console.log("Using cached token list...");
      return JSON.parse(readFileSync(cacheFile, "utf-8"));
    }
    
    // If no cache, fetch from Jupiter
    console.log("Downloading Jupiter token list...");
    const response = await axios.get(JUPITER_TOKEN_LIST_URL);
    const tokens = response.data;
    
    // For devnet, filter to likely devnet tokens
    let filteredTokens = tokens;
    if (NETWORK === "devnet") {
      filteredTokens = tokens.filter(token => 
        POPULAR_TOKENS.includes(token.symbol) || 
        token.tags?.includes("devnet")
      );
    }
    
    // Cache for future use
    writeFileSync(cacheFile, JSON.stringify(filteredTokens));
    
    return filteredTokens;
  } catch (err) {
    console.error("Error fetching token list:", err.message);
    process.exit(1);
  }
}

// Find token by symbol
function findTokenBySymbol(tokenList, symbol) {
  // Special case for native SOL
  if (symbol.toUpperCase() === "SOL") {
    // Return a custom native SOL token object
    // Use WSOL's mint address but mark it as native
    const wsolToken = tokenList.find(t => 
      t.address === "So11111111111111111111111111111111111111112");
      
    if (wsolToken) {
      return {
        ...wsolToken,
        name: "Native SOL",
        symbol: "SOL",
        isNative: true
      };
    }
  }
  
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
async function getTokenBalance(connection, walletAddress, token) {
  try {
    // Special case for Native SOL
    if (token.isNative || token.symbol.toUpperCase() === "SOL") {
      // Get native SOL balance
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
      if (tokenInfo.mint === token.address) {
        return parseFloat(tokenInfo.tokenAmount.uiAmountString);
      }
    }
    
    return 0; // No balance found
  } catch (err) {
    console.warn(`Couldn't fetch balance for ${token.symbol}:`, err.message);
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
        onlyDirectRoutes: false,
        asLegacyTransaction: NETWORK === "devnet", // Use legacy transactions for devnet
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

// Execute swap - Fixed to match Jupiter API v6 requirements
async function executeSwap(connection, wallet, quoteResponse) {
  try {
    console.log("Preparing swap transaction...");
    
    // Add more details about the swap
    console.log(`Swap: ${formatTokenAmount(quoteResponse.inAmount, quoteResponse.inputDecimals || 9)} ${quoteResponse.inputSymbol || 'SOL'} → ${formatTokenAmount(quoteResponse.outAmount, quoteResponse.outputDecimals || 6)} ${quoteResponse.outputSymbol || 'USDC'}`);
    
    // Prepare the swap request with the complete quoteResponse
    const swapRequest = {
      quoteResponse,
      userPublicKey: wallet.publicKey.toString(),
      wrapAndUnwrapSol: true
    };
    
    console.log("Sending request to Jupiter swap API...");
    
    const swapResponse = await axios.post(`${JUPITER_API_BASE}/swap`, swapRequest);
    
    if (!swapResponse.data || !swapResponse.data.swapTransaction) {
      throw new Error("Failed to get swap transaction");
    }
    
    console.log("Transaction received from Jupiter, preparing to sign and send...");
    
    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, "base64");
    
    // Check if it's a versioned transaction
    let signedTransaction;
    const { VersionedTransaction } = require("@solana/web3.js");
    
    try {
      // Try to deserialize as a versioned transaction
      const versionedTransaction = VersionedTransaction.deserialize(swapTransactionBuf);
      console.log("Using versioned transaction format");
      
      // Important: For versioned transactions, we need to sign it
      versionedTransaction.sign([wallet]);
      signedTransaction = versionedTransaction;
    } catch (err) {
      console.log("Falling back to legacy transaction format");
      // If versioned transaction deserialization fails, try as a legacy transaction
      const transaction = Transaction.from(swapTransactionBuf);
      
      // For legacy transactions, we'll use sendAndConfirmTransaction which handles signing
      const txid = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet],
        { commitment: "confirmed" }
      );
      return txid;
    }
    
    console.log("Sending signed transaction to Solana network...");
    
    // For versioned transactions, send the signed transaction
    const txid = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    
    console.log("Transaction sent, waiting for confirmation...");
    await connection.confirmTransaction(txid, "confirmed");
    
    return txid;
  } catch (err) {
    console.error("Failed to execute swap:", err.message);
    
    // Check if it's a transaction simulation error and get more details
    if (err.constructor.name === 'SendTransactionError') {
      console.error("Transaction simulation error:", err.message);
      if (err.logs) {
        console.error("Transaction logs:", err.logs);
      }
    }
    
    if (err.response && err.response.data) {
      console.error("API error details:", JSON.stringify(err.response.data, null, 2));
      if (err.response.data.error) {
        console.error("Error message:", err.response.data.error);
      }
      console.error("Status code:", err.response.status);
    }
    return null;
  }
}

// Main function
async function main() {
  try {
    const networkConfig = NETWORK_CONFIG[NETWORK] || NETWORK_CONFIG["mainnet-beta"];
    const explorerBaseUrl = networkConfig.explorerUrl;
    const explorerQueryParams = networkConfig.explorerParams || "";
    
    console.log(`\n🪙 Interactive Solana Token Swap 🪙`);
    console.log(`==========================================`);
    console.log(`Network: ${NETWORK}`);
    
    // Check if we have a private key in environment variable
    const hasPrivateKeyEnv = !!process.env.SOLANA_PRIVATE_KEY;
    
    // Get or ask for wallet path only if no private key in env
    let walletKeyPath = process.env.WALLET_KEY_PATH;
    if (!hasPrivateKeyEnv && !walletKeyPath) {
      walletKeyPath = await askQuestion("Enter path to your wallet key file: ");
    }
    
    // Initialize connection to Solana
    console.log(`\nInitializing connection to Solana ${NETWORK}...`);
    const connection = new Connection(networkConfig.endpoint, "confirmed");
    const wallet = loadWalletKey(walletKeyPath);
    const walletPublicKey = wallet.publicKey.toString();
    
    console.log(`Wallet: ${walletPublicKey}`);
    
    // Get token list
    const tokenList = await getTokenList();
    console.log(`Loaded ${tokenList.length} tokens`);
    
    // Ask if they need devnet tokens
    if (NETWORK === "devnet") {
      const needsAirdrop = await askQuestion("\nDo you need devnet SOL? (y/n): ");
      if (needsAirdrop.toLowerCase() === 'y') {
        console.log("Requesting airdrop of 1 SOL...");
        try {
          const signature = await connection.requestAirdrop(wallet.publicKey, 1000000000);
          await connection.confirmTransaction(signature);
          console.log("Airdrop successful!");
        } catch (err) {
          console.error("Airdrop failed:", err.message);
        }
      }
    }
    
    // Ask for input token
    console.log("\nPopular tokens: " + POPULAR_TOKENS.join(", "));
    const fromSymbol = await askQuestion("Enter token symbol you want to swap FROM: ");
    const fromToken = findTokenBySymbol(tokenList, fromSymbol);
    
    if (!fromToken) {
      console.error(`Token with symbol '${fromSymbol}' not found`);
      process.exit(1);
    }
    
    // Get token balance
    const balance = await getTokenBalance(connection, walletPublicKey, fromToken);
    
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
          quoteResponse: quote,
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
            quoteResponse: customQuote,
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
      if (NETWORK === "devnet") {
        console.log("Note: Devnet has much less liquidity than mainnet");
      }
      process.exit(1);
    }
    
    console.log("\nAvailable swaps:");
    console.log("-------------------------------------");
    
    quotes.forEach((q, i) => {
      console.log(`${i+1}. ${amount} ${fromToken.symbol} → ${q.outAmount} ${q.token.symbol}`);
      
      // Safely display price impact if available
      if (q.quoteResponse.priceImpactPct !== undefined) {
        const priceImpact = typeof q.quoteResponse.priceImpactPct === 'number' 
          ? q.quoteResponse.priceImpactPct.toFixed(2) 
          : q.quoteResponse.priceImpactPct;
        console.log(`   Price impact: ${priceImpact}%`);
      }
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
      const txid = await executeSwap(connection, wallet, selectedQuote.quoteResponse);
      
      if (txid) {
        console.log("\n✅ Swap successful!");
        console.log(`Transaction ID: ${txid}`);
        console.log(`Input: ${amount} ${fromToken.symbol}`);
        console.log(`Output: ~${selectedQuote.outAmount} ${selectedQuote.token.symbol}`);
        console.log(`View transaction: ${explorerBaseUrl}/${txid}${explorerQueryParams}`);
      } else {
        console.log("\n❌ Swap failed!");
      }
    } else {
      console.log("Swap cancelled");
    }
    
  } catch (err) {
    console.error("Error:", err.message);
    if (err.stack) {
      console.error("Stack trace:", err.stack);
    }
  } finally {
    rl.close();
  }
}

// Run the main function
main();