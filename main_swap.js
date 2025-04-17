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
const NETWORK = process.env.SOLANA_NETWORK || "mainnet-beta"; // Default to mainnet-beta
const POPULAR_TOKENS = ["USDC", "SOL", "WSOL"]; // Simplified tokens list
const TRANSACTION_TIMEOUT_MS = 60000; // Increase timeout to 60 seconds

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

// Sleep function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

// Check transaction status
async function checkTransactionStatus(connection, signature, maxRetries = 10, initialDelayMs = 500) {
  let retries = 0;
  let delay = initialDelayMs;
  
  while (retries < maxRetries) {
    try {
      const status = await connection.getSignatureStatus(signature, {searchTransactionHistory: true});
      
      if (status && status.value) {
        if (status.value.err) {
          return { confirmed: false, error: status.value.err };
        } else if (status.value.confirmationStatus === 'confirmed' || 
                  status.value.confirmationStatus === 'finalized') {
          return { confirmed: true };
        }
      }
      
      // Transaction not found or not confirmed yet, wait and retry
      await sleep(delay);
      delay *= 1.5; // Exponential backoff
      retries++;
    } catch (error) {
      console.log(`Error checking transaction status (attempt ${retries}):`, error.message);
      await sleep(delay);
      delay *= 1.5;
      retries++;
    }
  }
  
  // We've exhausted retries, let's do one final check with transaction history
  try {
    const transaction = await connection.getParsedTransaction(signature, {maxSupportedTransactionVersion: 0});
    if (transaction) {
      return { confirmed: true }; // If we can get the transaction, it exists
    }
  } catch (error) {
    console.log("Final transaction check failed:", error.message);
  }
  
  return { confirmed: null }; // Unknown status after all retries
}

// Execute swap - Fixed to match Jupiter API v6 requirements
async function executeSwap(connection, wallet, quoteResponse, networkConfig) {
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
    let txid;
    const { VersionedTransaction } = require("@solana/web3.js");
    
    try {
      // Try to deserialize as a versioned transaction
      const versionedTransaction = VersionedTransaction.deserialize(swapTransactionBuf);
      console.log("Using versioned transaction format");
      
      // Important: For versioned transactions, we need to sign it
      versionedTransaction.sign([wallet]);
      
      console.log("Sending signed transaction to Solana network...");
      
      // For versioned transactions, send the signed transaction
      txid = await connection.sendRawTransaction(versionedTransaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed"
      });
    } catch (err) {
      console.log("Falling back to legacy transaction format");
      // If versioned transaction deserialization fails, try as a legacy transaction
      const transaction = Transaction.from(swapTransactionBuf);
      
      try {
        // For legacy transactions, we'll use sendAndConfirmTransaction which handles signing
        txid = await sendAndConfirmTransaction(
          connection,
          transaction,
          [wallet],
          { commitment: "confirmed" }
        );
        return txid; // If this succeeds, return directly
      } catch (txError) {
        // Check if this is a timeout error but the TX was actually submitted
        if (txError.message.includes("was not confirmed") && txError.message.includes("It is unknown if it succeeded")) {
          // Extract the transaction signature from the error message
          const signatureMatch = txError.message.match(/Check signature ([A-Za-z0-9]+)/);
          if (signatureMatch && signatureMatch[1]) {
            txid = signatureMatch[1];
            console.log(`Transaction submitted but confirmation timed out. Signature: ${txid}`);
          } else {
            throw txError; // Re-throw if we can't find the signature
          }
        } else {
          throw txError; // Re-throw other errors
        }
      }
    }
    
    // At this point we have a txid but don't know if it's confirmed
    console.log(`Transaction submitted with ID: ${txid}`);
    console.log(`View transaction: ${networkConfig.explorerUrl}/${txid}${networkConfig.explorerParams || ""}`);
    console.log("Waiting for confirmation...");
    
    // Start with a short delay to allow the transaction to propagate
    await sleep(1000);
    
    try {
      // First try to confirm with standard method (with increased timeout)
      await connection.confirmTransaction({
        signature: txid,
        lastValidBlockHeight: await connection.getBlockHeight(),
        blockhash: (await connection.getLatestBlockhash()).blockhash
      }, "confirmed");
      console.log("Transaction confirmed!");
      return txid;
    } catch (confirmError) {
      console.log("Standard confirmation timed out, checking transaction status manually...");
      
      // If standard confirmation fails, check status manually
      const status = await checkTransactionStatus(connection, txid);
      
      if (status.confirmed === true) {
        console.log("Transaction is confirmed!");
        return txid;
      } else if (status.confirmed === false) {
        console.log("Transaction failed:", status.error);
        return null;
      } else {
        console.log("Transaction status is unknown. Please check manually using the explorer link above.");
        // Return the txid anyway since it might still succeed
        return txid;
      }
    }
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
      // Execute the swap and get transaction ID
      const txid = await executeSwap(connection, wallet, selectedQuote.quoteResponse, networkConfig);
      
      if (txid) {
        // Check if the balance has actually changed
        console.log("\nVerifying swap by checking token balance...");
        await sleep(5000); // Wait a bit for the transaction to fully finalize
        
        const newToTokenBalance = await getTokenBalance(connection, walletPublicKey, selectedQuote.token);
        const newFromTokenBalance = await getTokenBalance(connection, walletPublicKey, fromToken);
        
        console.log(`Transaction ID: ${txid}`);
        console.log(`View transaction: ${explorerBaseUrl}/${txid}${explorerQueryParams}`);
        
        // Try to determine if swap was successful by checking balance change
        if (newToTokenBalance !== null && newFromTokenBalance !== null) {
          // We don't have the previous balance of destination token, but the source token should have decreased
          if (newFromTokenBalance < balance) {
            console.log("\n✅ Swap successful! (verified by balance change)");
          } else {
            console.log("\n⚠️ Transaction was submitted, but balance hasn't changed yet. Please check the explorer link above.");
          }
        } else {
          console.log("\n⚠️ Transaction was submitted, but unable to verify the outcome. Please check the explorer link above.");
        }
        
        console.log(`Input: ${amount} ${fromToken.symbol}`);
        console.log(`Expected output: ~${selectedQuote.outAmount} ${selectedQuote.token.symbol}`);
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