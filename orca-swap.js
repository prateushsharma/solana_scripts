// Load environment variables from .env file
require('dotenv').config();

const { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction, 
  sendAndConfirmTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} = require("@solana/web3.js");
const { 
  Token, 
  TOKEN_PROGRAM_ID, 
  ASSOCIATED_TOKEN_PROGRAM_ID 
} = require("@solana/spl-token");
const { readFileSync } = require("fs");
const readline = require("readline");
const bs58 = require("bs58");

// Constants
const NETWORK = process.env.SOLANA_NETWORK || "devnet";

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

// USDC mint address (devnet)
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

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

// Find associated token address
async function findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
  return (
    await PublicKey.findProgramAddressSync(
      [
        walletAddress.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        tokenMintAddress.toBuffer(),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )[0];
}

// Get user balance
async function getBalance(connection, wallet) {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (err) {
    console.error("Error getting balance:", err.message);
    return null;
  }
}

// Get token balance
async function getTokenBalance(connection, walletAddress, tokenMintAddress) {
  try {
    // Find associated token address
    const tokenAccount = await findAssociatedTokenAddress(
      walletAddress,
      tokenMintAddress
    );
    
    try {
      // Try to get account info (will throw if account doesn't exist)
      const accountInfo = await connection.getAccountInfo(tokenAccount);
      
      if (!accountInfo) {
        // Token account doesn't exist yet
        return 0;
      }
      
      // Get token account balance
      const tokenAmount = await connection.getTokenAccountBalance(tokenAccount);
      return tokenAmount.value.uiAmount;
    } catch (e) {
      // Account not found
      return 0;
    }
  } catch (err) {
    console.error("Error getting token balance:", err.message);
    return null;
  }
}

// Create token account if it doesn't exist
async function createTokenAccountIfNeeded(
  connection,
  payer,
  tokenMintAddress,
  owner
) {
  const associatedToken = await findAssociatedTokenAddress(
    owner,
    tokenMintAddress
  );

  // Check if the token account exists
  const tokenAccount = await connection.getAccountInfo(associatedToken);
  
  if (!tokenAccount) {
    console.log(`Creating token account ${associatedToken.toString()}`);
    
    const transaction = new Transaction();
    
    transaction.add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        tokenMintAddress,
        associatedToken,
        owner,
        payer.publicKey
      )
    );
    
    await sendAndConfirmTransaction(connection, transaction, [payer], {
      commitment: "confirmed",
    });
  }
  
  return associatedToken;
}

// Main function
async function main() {
  try {
    const networkConfig = NETWORK_CONFIG[NETWORK] || NETWORK_CONFIG["devnet"];
    const explorerBaseUrl = networkConfig.explorerUrl;
    const explorerQueryParams = networkConfig.explorerParams || "";
    
    console.log(`\n🚀 Solana Direct Token Transfer 🚀`);
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
    
    // Get SOL balance
    const solBalance = await getBalance(connection, wallet);
    console.log(`SOL Balance: ${solBalance} SOL`);
    
    // Ask if they need devnet tokens
    if (NETWORK === "devnet") {
      const needsAirdrop = await askQuestion("\nDo you need devnet SOL? (y/n): ");
      if (needsAirdrop.toLowerCase() === 'y') {
        console.log("Requesting airdrop of 1 SOL...");
        try {
          const signature = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
          await connection.confirmTransaction(signature);
          console.log("Airdrop successful!");
          const newBalance = await getBalance(connection, wallet);
          console.log(`New SOL Balance: ${newBalance} SOL`);
        } catch (err) {
          console.error("Airdrop failed:", err.message);
        }
      }
    }
    
    // Check if user has USDC
    const usdcMint = new PublicKey(USDC_MINT_DEVNET);
    const usdcBalance = await getTokenBalance(connection, wallet.publicKey, usdcMint);
    
    if (usdcBalance !== null) {
      console.log(`USDC Balance: ${usdcBalance} USDC`);
    }
    
    // Show options
    console.log("\nWhat would you like to do?");
    console.log("1. Send SOL to someone");
    console.log("2. Create USDC token account (if you don't have one)");
    console.log("3. Exit");
    
    const choice = await askQuestion("Enter your choice (1-3): ");
    
    if (choice === "1") {
      // Send SOL
      const recipient = await askQuestion("Enter recipient wallet address: ");
      
      try {
        // Check if it's a valid address
        const recipientPubkey = new PublicKey(recipient);
        
        const amount = parseFloat(await askQuestion("Enter amount of SOL to send: "));
        
        if (isNaN(amount) || amount <= 0) {
          console.error("Invalid amount");
          process.exit(1);
        }
        
        // Check if amount exceeds balance
        if (amount > solBalance) {
          console.warn(`⚠️ Warning: Amount (${amount}) exceeds your balance (${solBalance})`);
          const proceed = await askQuestion("Do you want to proceed anyway? (y/n): ");
          if (proceed.toLowerCase() !== 'y') {
            process.exit(0);
          }
        }
        
        // Confirm transaction
        const confirm = await askQuestion(`\nSend ${amount} SOL to ${recipient}? (y/n): `);
        
        if (confirm.toLowerCase() === 'y') {
          console.log("Creating transaction...");
          
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: recipientPubkey,
              lamports: Math.floor(amount * LAMPORTS_PER_SOL),
            })
          );
          
          console.log("Sending transaction...");
          const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet]
          );
          
          console.log("\n✅ Transaction successful!");
          console.log(`Transaction ID: ${signature}`);
          console.log(`View transaction: ${explorerBaseUrl}/${signature}${explorerQueryParams}`);
          
          // Update balance
          const newBalance = await getBalance(connection, wallet);
          console.log(`New SOL Balance: ${newBalance} SOL`);
        } else {
          console.log("Transaction cancelled");
        }
      } catch (err) {
        console.error("Error:", err.message);
      }
    } else if (choice === "2") {
      // Create USDC token account
      console.log("Creating USDC token account...");
      
      try {
        const usdcTokenAccount = await createTokenAccountIfNeeded(
          connection,
          wallet,
          usdcMint,
          wallet.publicKey
        );
        
        console.log(`\n✅ USDC Token account created or already exists: ${usdcTokenAccount.toString()}`);
        
        // Check USDC balance again
        const newUsdcBalance = await getTokenBalance(connection, wallet.publicKey, usdcMint);
        console.log(`USDC Balance: ${newUsdcBalance} USDC`);
        
        console.log("\nNote: This is just creating the account. To get USDC on devnet,");
        console.log("you would typically need to use a faucet or a devnet swap service.");
      } catch (err) {
        console.error("Error creating token account:", err.message);
      }
    } else {
      console.log("Exiting...");
    }
    
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    rl.close();
  }
}

// Run the main function
main();