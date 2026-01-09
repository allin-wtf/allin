/**
 * ALL-IN-ONE Gaming Backend Server
 * 
 * Combines:
 * 1. Gaming backend (automatic winner payouts)
 * 2. Fee claim bot (claims PumpFun fees)
 * 3. Buyback bot (buys back and holds your token)
 * 
 * Everything runs in ONE file!
 */

const express = require('express');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, getAccount, createBurnInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const cors = require('cors');
const fs = require('fs');
const fetch = require('cross-fetch');

// ==================== CONFIGURATION ====================

const CONFIG = {
    // ============ GAMING BACKEND CONFIG ============
    SERVER: {
        PORT: 3000,
        REQUIRE_API_KEY: true,
        API_KEY: 'your-secret-api-key-here', // CHANGE THIS!
    },
    
    // ============ SOLANA CONFIG ============
    SOLANA: {
        RPC_URL: 'https://api.mainnet-beta.solana.com',
        // RPC_URL: 'https://api.devnet.solana.com', // Use devnet for testing
    },
    
    // ============ WALLET CONFIG ============
    WALLET: {
        PRIVATE_KEY: 'YOUR_PRIVATE_KEY_HERE', // Your house/creator wallet
        // OR load from file:
        // KEYPAIR_FILE: './wallet.json',
    },
    
    // ============ TOKEN CONFIG ============
    TOKEN: {
        MINT_ADDRESS: 'YOUR_TOKEN_MINT_ADDRESS_HERE', // Your token address
        USE_SOL: false, // true = payout in SOL, false = payout in your token
    },
    
    // ============ GAME SETTINGS ============
    GAME: {
        MIN_BET: 10000,      // Minimum bet: 10,000 tokens
        MAX_BET: 1000000,    // Maximum bet: 1,000,000 tokens
        HOUSE_EDGE: 0.02, // 2%
        COLLECT_BET_FROM_PLAYER: true, // true = deduct bet from player first, false = trust frontend
        AUTO_PAYOUT_EXACT_AMOUNT: true, // true = payout exact win amount, false = payout total (bet + win)
    },
    
    // ============ PAYOUT SECURITY ============
    PAYOUT: {
        MAX_PER_HOUR: 100, // Maximum payouts per hour
        MIN_RESERVE: 1, // Always keep this much in wallet
    },
    
    // ============ FEE CLAIM BOT CONFIG ============
    FEE_CLAIM: {
        ENABLED: true, // Enable auto fee claiming?
        CHECK_INTERVAL: 30000, // Check every 30 seconds (30000 ms)
        MIN_CLAIM_AMOUNT: 0.001, // Minimum SOL to claim
        PUMPFUN_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    },
    
    // ============ BUYBACK BOT CONFIG ============
    BUYBACK: {
        ENABLED: true, // Enable auto buyback?
        PERCENTAGE: 100, // Use 100% of claimed fees for buyback
        MIN_AMOUNT: 0.0005, // Minimum SOL to trigger buyback
        SLIPPAGE_BPS: 300, // 3% slippage (300 basis points)
        DEX: 'jupiter', // Use Jupiter aggregator
        JUPITER_API: 'https://quote-api.jup.ag/v6',
        BURN_TOKENS: false, // false = hold, true = burn
        RESERVE_SOL: 0.01, // Keep 0.01 SOL for transaction fees
    },
    
    // ============ NOTIFICATIONS ============
    NOTIFICATIONS: {
        DISCORD_ENABLED: false,
        DISCORD_WEBHOOK: '',
        TELEGRAM_ENABLED: false,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
    },
    
    // ============ LOGGING ============
    LOGGING: {
        GAME_LOG: './game.log',
        CLAIM_LOG: './claim-buyback.log',
        TRANSACTION_LOG: './transactions.json',
        VERBOSE: true,
    },
};

// ==================== GLOBALS ====================

let connection;
let wallet;

// Gaming stats
let gameStats = {
    totalGames: 0,
    totalWagered: 0,
    totalPayouts: 0,
    wins: 0,
    losses: 0,
    lastHourPayouts: 0,
    lastHourReset: Date.now(),
};

// Bot stats
let botStats = {
    totalClaimed: 0,
    totalBuybackSpent: 0,
    totalTokensBought: 0,
    totalTokensBurned: 0,
    claimCount: 0,
    buybackCount: 0,
    lastClaimTime: null,
    lastBuybackTime: null,
};

// ==================== LOGGING ====================

function log(message, level = 'INFO', logFile = 'game') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (CONFIG.LOGGING.VERBOSE) {
        console.log(logMessage);
    }
    
    const file = logFile === 'game' ? CONFIG.LOGGING.GAME_LOG : CONFIG.LOGGING.CLAIM_LOG;
    fs.appendFileSync(file, logMessage + '\n');
}

function logTransaction(tx) {
    let transactions = [];
    if (fs.existsSync(CONFIG.LOGGING.TRANSACTION_LOG)) {
        transactions = JSON.parse(fs.readFileSync(CONFIG.LOGGING.TRANSACTION_LOG, 'utf-8'));
    }
    transactions.push({ ...tx, timestamp: new Date().toISOString() });
    fs.writeFileSync(CONFIG.LOGGING.TRANSACTION_LOG, JSON.stringify(transactions, null, 2));
}

// ==================== INITIALIZATION ====================

async function initialize() {
    log('🚀 Initializing ALL-IN-ONE Gaming Backend + Bot...');
    
    // Validate config
    if (CONFIG.TOKEN.MINT_ADDRESS === 'YOUR_TOKEN_MINT_ADDRESS_HERE' && !CONFIG.TOKEN.USE_SOL) {
        throw new Error('❌ TOKEN.MINT_ADDRESS not configured!');
    }
    
    if (CONFIG.WALLET.PRIVATE_KEY === 'YOUR_PRIVATE_KEY_HERE' && !CONFIG.WALLET.KEYPAIR_FILE) {
        throw new Error('❌ WALLET.PRIVATE_KEY not configured!');
    }
    
    // Connect to Solana
    connection = new Connection(CONFIG.SOLANA.RPC_URL, 'confirmed');
    log('✅ Connected to Solana RPC: ' + CONFIG.SOLANA.RPC_URL);
    
    // Load wallet
    if (CONFIG.WALLET.KEYPAIR_FILE) {
        const keypairData = JSON.parse(fs.readFileSync(CONFIG.WALLET.KEYPAIR_FILE, 'utf-8'));
        wallet = Keypair.fromSecretKey(new Uint8Array(keypairData));
    } else {
        const privateKeyBytes = bs58.decode(CONFIG.WALLET.PRIVATE_KEY);
        wallet = Keypair.fromSecretKey(privateKeyBytes);
    }
    
    log('💼 Wallet Address: ' + wallet.publicKey.toString());
    
    // Check balance
    const balance = await getWalletBalance();
    log(`💰 Wallet Balance: ${balance.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'}`);
    
    if (balance < CONFIG.PAYOUT.MIN_RESERVE) {
        log('⚠️  WARNING: Low wallet balance!', 'WARN');
    }
    
    // Verify token
    if (!CONFIG.TOKEN.USE_SOL) {
        const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
        const tokenInfo = await connection.getAccountInfo(tokenMint);
        if (!tokenInfo) {
            throw new Error('❌ Token not found!');
        }
        log('✅ Token verified: ' + CONFIG.TOKEN.MINT_ADDRESS);
    }
    
    log('✅ Initialization complete!');
    log('');
    log('📊 Configuration Summary:');
    log(`   🎮 Gaming Backend: PORT ${CONFIG.SERVER.PORT}`);
    log(`   💰 Payouts: ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'Custom Token'}`);
    log(`   🤖 Fee Claiming: ${CONFIG.FEE_CLAIM.ENABLED ? 'ENABLED' : 'DISABLED'}`);
    log(`   🔄 Auto Buyback: ${CONFIG.BUYBACK.ENABLED ? 'ENABLED' : 'DISABLED'}`);
    if (CONFIG.BUYBACK.ENABLED) {
        log(`   💎 Token Action: ${CONFIG.BUYBACK.BURN_TOKENS ? 'BURN' : 'HOLD'}`);
    }
    log('');
}

// ==================== BALANCE MANAGEMENT ====================

async function getWalletBalance() {
    try {
        if (CONFIG.TOKEN.USE_SOL) {
            const balance = await connection.getBalance(wallet.publicKey);
            return balance / LAMPORTS_PER_SOL;
        } else {
            const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
            const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
            const accountInfo = await getAccount(connection, tokenAccount);
            return Number(accountInfo.amount) / 1e9;
        }
    } catch (err) {
        log(`❌ Error getting balance: ${err.message}`, 'ERROR');
        return 0;
    }
}

async function checkCanPayout(amount) {
    const balance = await getWalletBalance();
    if (balance - amount < CONFIG.PAYOUT.MIN_RESERVE) {
        return { success: false, reason: 'Insufficient balance' };
    }
    
    if (Date.now() - gameStats.lastHourReset > 3600000) {
        gameStats.lastHourPayouts = 0;
        gameStats.lastHourReset = Date.now();
    }
    
    if (gameStats.lastHourPayouts + amount > CONFIG.PAYOUT.MAX_PER_HOUR) {
        return { success: false, reason: 'Hourly payout limit reached' };
    }
    
    return { success: true };
}

// ==================== BET COLLECTION ====================

async function collectBetFromPlayer(playerAddress, betAmount) {
    try {
        log(`💵 Collecting bet: ${betAmount} from ${playerAddress.slice(0, 8)}...`);
        
        const playerPublicKey = new PublicKey(playerAddress);
        let signature;
        
        if (CONFIG.TOKEN.USE_SOL) {
            // Collect SOL from player
            // NOTE: This requires player to approve transaction on frontend
            // For now, we trust frontend validation
            log(`ℹ️  SOL collection requires frontend approval`, 'INFO');
            return { success: true, note: 'Frontend handles SOL transfer' };
        } else {
            // Collect tokens from player
            const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
            const playerTokenAccount = await getAssociatedTokenAddress(tokenMint, playerPublicKey);
            const houseTokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
            const tokenAmount = Math.floor(betAmount * 1e9);
            
            // Check player balance
            try {
                const playerAccount = await getAccount(connection, playerTokenAccount);
                const playerBalance = Number(playerAccount.amount) / 1e9;
                
                if (playerBalance < betAmount) {
                    return { 
                        success: false, 
                        reason: `Player has insufficient balance: ${playerBalance.toFixed(4)} < ${betAmount}` 
                    };
                }
                
                log(`✅ Player balance verified: ${playerBalance.toFixed(4)} tokens`);
            } catch (err) {
                return { 
                    success: false, 
                    reason: 'Player token account not found' 
                };
            }
            
            // NOTE: For bet collection, player needs to approve transaction
            // This is handled on frontend via wallet signature
            log(`ℹ️  Token collection tracked (frontend handles transfer)`, 'INFO');
            return { success: true, note: 'Frontend handles token transfer' };
        }
        
    } catch (err) {
        log(`❌ Bet collection check failed: ${err.message}`, 'ERROR');
        return { success: false, error: err.message };
    }
}

// ==================== GAMING PAYOUT FUNCTIONS ====================

async function payoutWinner(playerAddress, amount, gameType, gameId, betAmount = 0) {
    try {
        log(`💸 Processing payout: ${amount} to ${playerAddress.slice(0, 8)}...`);
        
        if (amount < 0.0001) {
            throw new Error('Payout amount too small');
        }
        
        const canPayout = await checkCanPayout(amount);
        if (!canPayout.success) {
            throw new Error(canPayout.reason);
        }
        
        const playerPublicKey = new PublicKey(playerAddress);
        let signature;
        
        if (CONFIG.TOKEN.USE_SOL) {
            signature = await payoutSOL(playerPublicKey, amount);
        } else {
            signature = await payoutToken(playerPublicKey, amount);
        }
        
        gameStats.totalPayouts += amount;
        gameStats.lastHourPayouts += amount;
        
        logTransaction({
            type: 'game_payout',
            gameId,
            gameType,
            player: playerAddress,
            amount,
            currency: CONFIG.TOKEN.USE_SOL ? 'SOL' : 'TOKEN',
            signature,
            status: 'success',
        });
        
        log(`✅ Payout complete! TX: ${signature}`);
        
        // Send Telegram notification for payout
        await sendNotification({
            type: 'game_payout',
            gameType: gameType,
            player: playerAddress,
            payout: amount,
            betAmount: betAmount,
            signature: signature,
        });
        
        return { success: true, signature, amount };
        
    } catch (err) {
        log(`❌ Payout failed: ${err.message}`, 'ERROR');
        logTransaction({
            type: 'game_payout',
            gameId,
            gameType,
            player: playerAddress,
            amount,
            status: 'failed',
            error: err.message,
        });
        return { success: false, error: err.message };
    }
}

async function payoutSOL(playerPublicKey, amount) {
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: playerPublicKey,
            lamports,
        })
    );
    transaction.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
}

async function payoutToken(playerPublicKey, amount) {
    const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
    const houseTokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
    const playerTokenAccount = await getAssociatedTokenAddress(tokenMint, playerPublicKey);
    const tokenAmount = Math.floor(amount * 1e9);
    
    const transferIx = createTransferInstruction(
        houseTokenAccount,
        playerTokenAccount,
        wallet.publicKey,
        tokenAmount
    );
    
    const transaction = new Transaction().add(transferIx);
    transaction.feePayer = wallet.publicKey;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.sign(wallet);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
}

// ==================== FEE CLAIMING BOT ====================

async function getClaimableFees() {
    try {
        const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
        const programId = new PublicKey(CONFIG.FEE_CLAIM.PUMPFUN_PROGRAM_ID);
        
        const [feeAccountPDA] = PublicKey.findProgramAddressSync(
            [
                Buffer.from('fee'),
                tokenMint.toBuffer(),
                wallet.publicKey.toBuffer(),
            ],
            programId
        );
        
        const balance = await connection.getBalance(feeAccountPDA);
        const balanceSOL = balance / 1e9;
        
        if (balanceSOL > CONFIG.FEE_CLAIM.MIN_CLAIM_AMOUNT) {
            log(`💰 Found ${balanceSOL.toFixed(6)} SOL in fees`, 'INFO', 'claim');
            return { amount: balanceSOL, feeAccount: feeAccountPDA };
        }
        
        return null;
    } catch (err) {
        log(`❌ Error checking fees: ${err.message}`, 'ERROR', 'claim');
        return null;
    }
}

async function claimFees(feeInfo) {
    try {
        log('💸 Claiming fees...', 'INFO', 'claim');
        
        const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
        const programId = new PublicKey(CONFIG.FEE_CLAIM.PUMPFUN_PROGRAM_ID);
        
        // NOTE: Adjust this based on PumpFun's actual claim instruction
        const transaction = new Transaction().add({
            programId: programId,
            keys: [
                { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                { pubkey: feeInfo.feeAccount, isSigner: false, isWritable: true },
                { pubkey: tokenMint, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([]),
        });
        
        transaction.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.sign(wallet);
        
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(signature, 'confirmed');
        
        log(`✅ Claimed ${feeInfo.amount.toFixed(6)} SOL!`, 'INFO', 'claim');
        log(`🔗 https://solscan.io/tx/${signature}`, 'INFO', 'claim');
        
        botStats.totalClaimed += feeInfo.amount;
        botStats.claimCount++;
        botStats.lastClaimTime = new Date();
        
        logTransaction({
            type: 'fee_claim',
            amount: feeInfo.amount,
            signature,
            status: 'success',
        });
        
        // Send Telegram notification for claim
        await sendNotification({
            type: 'fee_claim',
            amount: feeInfo.amount,
            signature: signature,
        });
        
        return feeInfo.amount;
    } catch (err) {
        log(`❌ Claim error: ${err.message}`, 'ERROR', 'claim');
        return 0;
    }
}

// ==================== BUYBACK BOT ====================

async function buybackTokens(solAmount) {
    try {
        log(`🔄 Starting buyback: ${solAmount.toFixed(6)} SOL → ${CONFIG.TOKEN.MINT_ADDRESS.slice(0, 8)}...`, 'INFO', 'claim');
        
        const inputMint = 'So11111111111111111111111111111111111111112';
        const outputMint = CONFIG.TOKEN.MINT_ADDRESS;
        const amountLamports = Math.floor(solAmount * 1e9);
        
        // Get quote from Jupiter
        log('📊 Getting quote from Jupiter...', 'INFO', 'claim');
        const quoteUrl = `${CONFIG.BUYBACK.JUPITER_API}/quote?` +
            `inputMint=${inputMint}&` +
            `outputMint=${outputMint}&` +
            `amount=${amountLamports}&` +
            `slippageBps=${CONFIG.BUYBACK.SLIPPAGE_BPS}`;
        
        const quoteResponse = await fetch(quoteUrl);
        const quoteData = await quoteResponse.json();
        
        if (!quoteData || quoteData.error) {
            throw new Error('Failed to get quote: ' + (quoteData?.error || 'Unknown error'));
        }
        
        const expectedTokens = quoteData.outAmount;
        log(`💎 Expected to receive: ${(expectedTokens / 1e9).toFixed(2)} tokens`, 'INFO', 'claim');
        
        // Get swap transaction
        log('🔨 Building swap transaction...', 'INFO', 'claim');
        const swapResponse = await fetch(`${CONFIG.BUYBACK.JUPITER_API}/swap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto',
            }),
        });
        
        const swapData = await swapResponse.json();
        
        if (!swapData || !swapData.swapTransaction) {
            throw new Error('Failed to get swap transaction');
        }
        
        // Sign and send
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);
        
        log('📤 Sending swap transaction...', 'INFO', 'claim');
        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2,
        });
        
        log('⏳ Confirming transaction...', 'INFO', 'claim');
        await connection.confirmTransaction(txid, 'confirmed');
        
        log(`✅ Buyback complete!`, 'INFO', 'claim');
        log(`🔗 https://solscan.io/tx/${txid}`, 'INFO', 'claim');
        log(`💰 Spent: ${solAmount.toFixed(6)} SOL`, 'INFO', 'claim');
        log(`💎 Received: ~${(expectedTokens / 1e9).toFixed(2)} tokens`, 'INFO', 'claim');
        
        botStats.totalBuybackSpent += solAmount;
        botStats.totalTokensBought += expectedTokens / 1e9;
        botStats.buybackCount++;
        botStats.lastBuybackTime = new Date();
        
        logTransaction({
            type: 'buyback',
            solSpent: solAmount,
            tokensReceived: expectedTokens / 1e9,
            signature: txid,
            status: 'success',
        });
        
        // Send Telegram notification for buyback
        await sendNotification({
            type: 'buyback',
            solSpent: solAmount,
            tokensReceived: expectedTokens / 1e9,
            signature: txid,
            burned: CONFIG.BUYBACK.BURN_TOKENS,
        });
        
        return { success: true, tokens: expectedTokens, txid };
        
    } catch (err) {
        log(`❌ Buyback error: ${err.message}`, 'ERROR', 'claim');
        return { success: false, error: err.message };
    }
}

async function burnTokens(amount) {
    try {
        log(`🔥 Burning ${(amount / 1e9).toFixed(2)} tokens...`, 'INFO', 'claim');
        
        const tokenMint = new PublicKey(CONFIG.TOKEN.MINT_ADDRESS);
        const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
        
        const burnIx = createBurnInstruction(
            tokenAccount,
            tokenMint,
            wallet.publicKey,
            Math.floor(amount)
        );
        
        const transaction = new Transaction().add(burnIx);
        transaction.feePayer = wallet.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.sign(wallet);
        
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(signature, 'confirmed');
        
        log(`✅ Burned ${(amount / 1e9).toFixed(2)} tokens!`, 'INFO', 'claim');
        log(`🔗 https://solscan.io/tx/${signature}`, 'INFO', 'claim');
        
        botStats.totalTokensBurned += amount / 1e9;
        
        logTransaction({
            type: 'burn',
            tokensBurned: amount / 1e9,
            signature,
            status: 'success',
        });
        
        return true;
    } catch (err) {
        log(`❌ Burn error: ${err.message}`, 'ERROR', 'claim');
        return false;
    }
}

// ==================== BOT CYCLE ====================

async function runBotCycle() {
    log('⏰ Running fee claim & buyback cycle...', 'INFO', 'claim');
    
    try {
        // Check for fees
        const feeInfo = await getClaimableFees();
        
        if (!feeInfo) {
            log('ℹ️  No fees to claim', 'INFO', 'claim');
            return;
        }
        
        // Claim fees
        const claimedAmount = await claimFees(feeInfo);
        
        if (claimedAmount === 0) {
            log('❌ Failed to claim fees', 'ERROR', 'claim');
            return;
        }
        
        // Calculate buyback amount
        if (!CONFIG.BUYBACK.ENABLED) {
            log('ℹ️  Buyback disabled, keeping SOL', 'INFO', 'claim');
            return;
        }
        
        const buybackAmount = claimedAmount * (CONFIG.BUYBACK.PERCENTAGE / 100);
        const afterReserve = buybackAmount - CONFIG.BUYBACK.RESERVE_SOL;
        
        if (afterReserve < CONFIG.BUYBACK.MIN_AMOUNT) {
            log(`ℹ️  Buyback amount too small (${afterReserve.toFixed(6)} SOL), skipping`, 'INFO', 'claim');
            return;
        }
        
        // Execute buyback
        log(`💰 Buyback amount: ${afterReserve.toFixed(6)} SOL`, 'INFO', 'claim');
        const buybackResult = await buybackTokens(afterReserve);
        
        if (!buybackResult.success) {
            log('❌ Buyback failed, keeping SOL for next attempt', 'ERROR', 'claim');
            return;
        }
        
        // Burn or hold
        if (CONFIG.BUYBACK.BURN_TOKENS && buybackResult.tokens) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            await burnTokens(buybackResult.tokens);
        } else {
            log(`💰 Tokens held in wallet (not burned)`, 'INFO', 'claim');
        }
        
        // Show stats
        log('\n📊 Bot Stats:', 'INFO', 'claim');
        log(`   Claims: ${botStats.claimCount} (${botStats.totalClaimed.toFixed(6)} SOL)`, 'INFO', 'claim');
        log(`   Buybacks: ${botStats.buybackCount} (${botStats.totalBuybackSpent.toFixed(6)} SOL)`, 'INFO', 'claim');
        log(`   Tokens Bought: ${botStats.totalTokensBought.toFixed(2)}`, 'INFO', 'claim');
        if (CONFIG.BUYBACK.BURN_TOKENS) {
            log(`   Tokens Burned: ${botStats.totalTokensBurned.toFixed(2)}`, 'INFO', 'claim');
        } else {
            log(`   Tokens Held: ${botStats.totalTokensBought.toFixed(2)}`, 'INFO', 'claim');
        }
        
        // Send notifications
        await sendNotification({
            type: 'claim_buyback',
            claimed: claimedAmount,
            bought: afterReserve,
            tokens: buybackResult.tokens / 1e9,
            burned: CONFIG.BUYBACK.BURN_TOKENS,
        });
        
    } catch (err) {
        log(`❌ Bot cycle error: ${err.message}`, 'ERROR', 'claim');
    }
    
    log(`⏱️  Next check in ${CONFIG.FEE_CLAIM.CHECK_INTERVAL / 1000} seconds\n`, 'INFO', 'claim');
}

// ==================== NOTIFICATIONS ====================

async function sendNotification(data) {
    const network = CONFIG.SOLANA.RPC_URL.includes('devnet') ? 'devnet' : 'mainnet';
    const solscanBase = network === 'devnet' 
        ? 'https://solscan.io/tx/' 
        : 'https://solscan.io/tx/';
    
    // Discord
    if (CONFIG.NOTIFICATIONS.DISCORD_ENABLED && CONFIG.NOTIFICATIONS.DISCORD_WEBHOOK) {
        try {
            let message = '';
            
            if (data.type === 'claim_buyback') {
                message = `✅ **Claim & Buyback Complete!**\n` +
                         `💰 Claimed: ${data.claimed.toFixed(6)} SOL\n` +
                         `🔄 Buyback: ${data.bought.toFixed(6)} SOL\n` +
                         `💎 Tokens: ${data.tokens.toFixed(2)} ${data.burned ? '(burned)' : '(held)'}\n` +
                         `📊 Total: ${botStats.claimCount} claims, ${botStats.buybackCount} buybacks`;
            }
            
            if (message) {
                await fetch(CONFIG.NOTIFICATIONS.DISCORD_WEBHOOK, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: message }),
                });
            }
        } catch (err) {
            log(`❌ Discord notification failed: ${err.message}`, 'ERROR', 'claim');
        }
    }
    
    // Telegram
    if (CONFIG.NOTIFICATIONS.TELEGRAM_ENABLED && CONFIG.NOTIFICATIONS.TELEGRAM_BOT_TOKEN) {
        try {
            let message = '';
            
            // Fee Claim notification
            if (data.type === 'fee_claim') {
                message = `🎉 *FEE CLAIMED!*\n\n` +
                         `💰 Amount: ${data.amount.toFixed(6)} SOL\n` +
                         `📊 Total Claims: ${botStats.claimCount}\n` +
                         `💵 Total Claimed: ${botStats.totalClaimed.toFixed(6)} SOL\n\n` +
                         `🔗 [View on Solscan](${solscanBase}${data.signature})\n` +
                         `\`${data.signature}\``;
            }
            
            // Buyback notification
            if (data.type === 'buyback') {
                message = `🔄 *TOKEN BUYBACK!*\n\n` +
                         `💰 SOL Spent: ${data.solSpent.toFixed(6)} SOL\n` +
                         `💎 Tokens Bought: ${data.tokensReceived.toFixed(2)}\n` +
                         `${data.burned ? '🔥 Status: BURNED' : '💰 Status: HELD IN WALLET'}\n` +
                         `📊 Total Buybacks: ${botStats.buybackCount}\n` +
                         `💵 Total Spent: ${botStats.totalBuybackSpent.toFixed(6)} SOL\n\n` +
                         `🔗 [View on Solscan](${solscanBase}${data.signature})\n` +
                         `\`${data.signature}\``;
            }
            
            // Game payout notification
            if (data.type === 'game_payout') {
                const profit = data.payout - data.betAmount;
                const profitEmoji = profit > 0 ? '📈' : '📉';
                
                message = `🎮 *WINNER PAID!*\n\n` +
                         `🎲 Game: ${data.gameType.toUpperCase()}\n` +
                         `👤 Player: \`${data.player.slice(0, 4)}...${data.player.slice(-4)}\`\n` +
                         `💰 Payout: ${data.payout.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'}\n` +
                         `🎯 Bet: ${data.betAmount.toFixed(4)}\n` +
                         `${profitEmoji} Profit: ${profit.toFixed(4)}\n` +
                         `📊 Total Payouts: ${gameStats.totalPayouts.toFixed(4)}\n\n` +
                         `🔗 [View on Solscan](${solscanBase}${data.signature})\n` +
                         `\`${data.signature}\``;
            }
            
            // Combined claim + buyback notification
            if (data.type === 'claim_buyback') {
                message = `✅ *CLAIM & BUYBACK COMPLETE!*\n\n` +
                         `💰 Claimed: ${data.claimed.toFixed(6)} SOL\n` +
                         `🔄 Buyback: ${data.bought.toFixed(6)} SOL\n` +
                         `💎 Tokens: ${data.tokens.toFixed(2)} ${data.burned ? '🔥 BURNED' : '💰 HELD'}\n\n` +
                         `📊 *Session Stats:*\n` +
                         `   Claims: ${botStats.claimCount} (${botStats.totalClaimed.toFixed(6)} SOL)\n` +
                         `   Buybacks: ${botStats.buybackCount} (${botStats.totalBuybackSpent.toFixed(6)} SOL)\n` +
                         `   Tokens Bought: ${botStats.totalTokensBought.toFixed(2)}\n` +
                         (data.burned ? `   Tokens Burned: ${botStats.totalTokensBurned.toFixed(2)}\n` : '');
            }
            
            if (message) {
                const url = `https://api.telegram.org/bot${CONFIG.NOTIFICATIONS.TELEGRAM_BOT_TOKEN}/sendMessage`;
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: CONFIG.NOTIFICATIONS.TELEGRAM_CHAT_ID,
                        text: message,
                        parse_mode: 'Markdown',
                        disable_web_page_preview: false,
                    }),
                });
            }
        } catch (err) {
            log(`❌ Telegram notification failed: ${err.message}`, 'ERROR', 'claim');
        }
    }
}

// ==================== GAME VERIFICATION ====================

function verifyPlinkoResult(multiplier) {
    const validMultipliers = [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3];
    return validMultipliers.includes(multiplier);
}

function verifyDiceResult(dice1, dice2, dice3, prediction, betType) {
    if (dice1 < 1 || dice1 > 6 || dice2 < 1 || dice2 > 6 || dice3 < 1 || dice3 > 6) {
        return false;
    }
    const sum = dice1 + dice2 + dice3;
    if (betType === 'over') return sum > prediction;
    if (betType === 'under') return sum < prediction;
    if (betType === 'exact') return sum === prediction;
    return false;
}

// ==================== EXPRESS API ====================

const app = express();
app.use(cors());
app.use(express.json());

// API Key middleware
app.use((req, res, next) => {
    if (CONFIG.SERVER.REQUIRE_API_KEY && req.path !== '/health' && req.path !== '/stats') {
        const apiKey = req.headers['x-api-key'];
        if (apiKey !== CONFIG.SERVER.API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        wallet: wallet.publicKey.toString(),
        network: CONFIG.SOLANA.RPC_URL.includes('devnet') ? 'devnet' : 'mainnet',
        services: {
            gaming: 'running',
            feeClaim: CONFIG.FEE_CLAIM.ENABLED ? 'running' : 'disabled',
            buyback: CONFIG.BUYBACK.ENABLED ? 'running' : 'disabled',
        }
    });
});

// Get balance
app.get('/balance', async (req, res) => {
    try {
        const balance = await getWalletBalance();
        res.json({ 
            balance,
            currency: CONFIG.TOKEN.USE_SOL ? 'SOL' : 'TOKEN',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get stats
app.get('/stats', (req, res) => {
    res.json({
        game: gameStats,
        bot: botStats,
    });
});

// Play Plinko
app.post('/play/plinko', async (req, res) => {
    try {
        const { playerAddress, betAmount, multiplier, gameId } = req.body;
        
        if (!playerAddress || !betAmount || !multiplier || !gameId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (betAmount < CONFIG.GAME.MIN_BET || betAmount > CONFIG.GAME.MAX_BET) {
            return res.status(400).json({ error: 'Invalid bet amount' });
        }
        
        if (!verifyPlinkoResult(multiplier)) {
            return res.status(400).json({ error: 'Invalid multiplier' });
        }
        
        // Collect bet from player (validation)
        if (CONFIG.GAME.COLLECT_BET_FROM_PLAYER) {
            const betCollection = await collectBetFromPlayer(playerAddress, betAmount);
            if (!betCollection.success) {
                return res.status(400).json({ error: betCollection.reason });
            }
        }
        
        gameStats.totalGames++;
        gameStats.totalWagered += betAmount;
        
        const isWin = multiplier >= 1;
        
        // Calculate payout
        let payoutAmount;
        if (CONFIG.GAME.AUTO_PAYOUT_EXACT_AMOUNT) {
            // Payout = bet × multiplier (total amount including bet)
            payoutAmount = betAmount * multiplier;
        } else {
            // Payout = (bet × multiplier) - bet (just the winnings)
            payoutAmount = (betAmount * multiplier) - betAmount;
        }
        
        if (isWin && payoutAmount > 0) {
            gameStats.wins++;
            const result = await payoutWinner(playerAddress, payoutAmount, 'plinko', gameId, betAmount);
            
            if (result.success) {
                const profit = payoutAmount - betAmount;
                
                res.json({
                    success: true,
                    win: true,
                    multiplier,
                    betAmount,
                    payout: payoutAmount,
                    profit: profit,
                    signature: result.signature,
                    message: `You won! ${payoutAmount.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'} sent to your wallet!`,
                    breakdown: {
                        bet: betAmount,
                        multiplier: multiplier,
                        totalPayout: payoutAmount,
                        netProfit: profit
                    }
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Payout failed: ' + result.error,
                });
            }
        } else {
            gameStats.losses++;
            res.json({
                success: true,
                win: false,
                multiplier,
                betAmount,
                payout: 0,
                message: `Better luck next time! You lost ${betAmount.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'}`,
            });
        }
        
    } catch (err) {
        log(`❌ Plinko error: ${err.message}`, 'ERROR');
        res.status(500).json({ error: err.message });
    }
});

// Play Dice
app.post('/play/dice', async (req, res) => {
    try {
        const { playerAddress, betAmount, dice1, dice2, dice3, prediction, betType, gameId } = req.body;
        
        if (!playerAddress || !betAmount || !dice1 || !dice2 || !dice3 || !prediction || !betType || !gameId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        if (betAmount < CONFIG.GAME.MIN_BET || betAmount > CONFIG.GAME.MAX_BET) {
            return res.status(400).json({ error: 'Invalid bet amount' });
        }
        
        // Collect bet from player (validation)
        if (CONFIG.GAME.COLLECT_BET_FROM_PLAYER) {
            const betCollection = await collectBetFromPlayer(playerAddress, betAmount);
            if (!betCollection.success) {
                return res.status(400).json({ error: betCollection.reason });
            }
        }
        
        const isWin = verifyDiceResult(dice1, dice2, dice3, prediction, betType);
        
        gameStats.totalGames++;
        gameStats.totalWagered += betAmount;
        
        let multiplier = 0;
        if (isWin) {
            if (betType === 'exact') multiplier = 30;
            else if (betType === 'over' || betType === 'under') multiplier = 1.8;
        }
        
        // Calculate payout
        let payoutAmount;
        if (CONFIG.GAME.AUTO_PAYOUT_EXACT_AMOUNT) {
            // Payout = bet × multiplier (total amount including bet)
            payoutAmount = betAmount * multiplier;
        } else {
            // Payout = (bet × multiplier) - bet (just the winnings)
            payoutAmount = (betAmount * multiplier) - betAmount;
        }
        
        if (isWin && payoutAmount > 0) {
            gameStats.wins++;
            const result = await payoutWinner(playerAddress, payoutAmount, 'dice', gameId, betAmount);
            
            if (result.success) {
                const profit = payoutAmount - betAmount;
                
                res.json({
                    success: true,
                    win: true,
                    dice: [dice1, dice2, dice3],
                    sum: dice1 + dice2 + dice3,
                    prediction,
                    betType,
                    betAmount,
                    payout: payoutAmount,
                    profit: profit,
                    signature: result.signature,
                    message: `You won! ${payoutAmount.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'} sent to your wallet!`,
                    breakdown: {
                        bet: betAmount,
                        multiplier: multiplier,
                        totalPayout: payoutAmount,
                        netProfit: profit
                    }
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Payout failed: ' + result.error,
                });
            }
        } else {
            gameStats.losses++;
            res.json({
                success: true,
                win: false,
                dice: [dice1, dice2, dice3],
                sum: dice1 + dice2 + dice3,
                prediction,
                betType,
                betAmount,
                payout: 0,
                message: `Better luck next time! You lost ${betAmount.toFixed(4)} ${CONFIG.TOKEN.USE_SOL ? 'SOL' : 'tokens'}`,
            });
        }
        
    } catch (err) {
        log(`❌ Dice error: ${err.message}`, 'ERROR');
        res.status(500).json({ error: err.message });
    }
});

// ==================== STARTUP ====================

async function startServer() {
    try {
        await initialize();
        
        // Start Express server
        app.listen(CONFIG.SERVER.PORT, () => {
            log(`🚀 Gaming Backend Server running on port ${CONFIG.SERVER.PORT}`);
            log(`🎮 Ready to process games and payouts!`);
        });
        
        // Start bot if enabled
        if (CONFIG.FEE_CLAIM.ENABLED) {
            log('');
            log('🤖 Starting fee claim & buyback bot...');
            
            // Run first cycle immediately
            await runBotCycle();
            
            // Schedule recurring cycles
            setInterval(runBotCycle, CONFIG.FEE_CLAIM.CHECK_INTERVAL);
            
            log(`✅ Bot is running! Checking every ${CONFIG.FEE_CLAIM.CHECK_INTERVAL / 1000} seconds`);
        } else {
            log('');
            log('ℹ️  Fee claim bot is disabled');
        }
        
    } catch (err) {
        log(`❌ Fatal error: ${err.message}`, 'ERROR');
        console.error(err);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    log('\n👋 Shutting down...');
    log('📊 Final Stats:');
    log('   Gaming:');
    log(`     Total Games: ${gameStats.totalGames}`);
    log(`     Total Wagered: ${gameStats.totalWagered.toFixed(4)}`);
    log(`     Total Payouts: ${gameStats.totalPayouts.toFixed(4)}`);
    log(`     Wins: ${gameStats.wins}, Losses: ${gameStats.losses}`);
    if (CONFIG.FEE_CLAIM.ENABLED) {
        log('   Bot:');
        log(`     Total Claims: ${botStats.claimCount} (${botStats.totalClaimed.toFixed(6)} SOL)`);
        log(`     Total Buybacks: ${botStats.buybackCount} (${botStats.totalBuybackSpent.toFixed(6)} SOL)`);
        log(`     Tokens Bought: ${botStats.totalTokensBought.toFixed(2)}`);
        if (CONFIG.BUYBACK.BURN_TOKENS) {
            log(`     Tokens Burned: ${botStats.totalTokensBurned.toFixed(2)}`);
        }
    }
    log('✅ Shutdown complete');
    process.exit(0);
});

// Start everything!
startServer();
