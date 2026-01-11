require('dotenv').config();

// Fix: Ensure DATABASE_URL is available by falling back to EXTERNAL_DATABASE_URL
if (!process.env.DATABASE_URL && process.env.EXTERNAL_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.EXTERNAL_DATABASE_URL;
}

const express = require('express');
const http = require('http'); // ✅ የተስተካከለ
const WebSocket = require('ws'); 
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');

// Setup multer for image uploads
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api'); 

const db = require('./db/database');
const User = require('./models/User');
const Wallet = require('./models/Wallet');
const Game = require('./models/Game');
const { validateBingo } = require('./data/cards');

// Replace all instances of db.query with db.query to use the correct database connection
// and ensure the pool is not re-declared in server.js
const pool = db.pool;

// Force verbatim result order for Replit internal DB
const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const app = express();

// Maintenance Mode Flag
const MAINTENANCE_MODE = false; // Disabled as requested, logic moved to game restriction

app.use((req, res, next) => {
    if (MAINTENANCE_MODE) {
        // Skip maintenance for admin-related API paths or if a special admin header/param is present
        const isAdminRequest = req.path.startsWith('/api/check-admin') || 
                             req.path.startsWith('/api/admin') ||
                             req.query.admin === 'true';

        if (!isAdminRequest && (req.path === '/' || req.path.endsWith('.html'))) {
             return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Maintenance - ሮያል ቢንጎ</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { background: #1a1a2e; color: white; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                        .container { padding: 20px; background: rgba(255,255,255,0.05); border-radius: 15px; border: 1px solid #ffcc00; }
                        h1 { color: #ffcc00; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🚧 በጥገና ላይ ነን</h1>
                        <p>ሮያል ቢንጎ ለጥቂት ጊዜ ለጥገና ተዘግቷል።</p>
                        <p>በቅርቡ እንመለሳለን፣ ስለ ትዕግስትዎ እናመሰግናለን! 🙏</p>
                    </div>
                </body>
                </html>
            `);
        }
    }
    next();
});

// ✅ Body parser MUST come first before any routes
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Telegram Bot Logic Added ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_SERVER_URL = process.env.RENDER_SERVER_URL;

// Dynamically determine the app URL
let MINI_APP_URL = process.env.MINI_APP_URL;

if (!MINI_APP_URL) {
    if (process.env.REPLIT_DOMAINS) {
        MINI_APP_URL = `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`;
    } else if (process.env.RENDER_EXTERNAL_URL) {
        MINI_APP_URL = process.env.RENDER_EXTERNAL_URL;
    } else if (process.env.RENDER_SERVER_URL) { // Render sometimes uses this
        MINI_APP_URL = process.env.RENDER_SERVER_URL;
    } else if (RENDER_SERVER_URL) {
        MINI_APP_URL = RENDER_SERVER_URL;
    }
}

// Ensure MINI_APP_URL doesn't have trailing slash for consistency
if (MINI_APP_URL && MINI_APP_URL.endsWith('/')) {
    MINI_APP_URL = MINI_APP_URL.slice(0, -1);
}

console.log('MINI_APP_URL configuration:', {
    MINI_APP_URL: MINI_APP_URL,
    REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
    RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL,
    RENDER_SERVER_URL: RENDER_SERVER_URL
});

// Use polling but handle conflicts gracefully
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: {
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Explicitly delete webhook to ensure polling works
bot.deleteWebHook().then(() => {
    console.log("Webhook deleted, starting polling...");
}).catch((err) => {
    console.warn("Failed to delete webhook:", err.message);
});

// Catch-all for any message to debug
// bot.on('message', (msg) => {
//     console.log('--- Received ANY message ---');
//     console.log('Text:', msg.text);
//     console.log('From:', msg.from.id);
// });

bot.getMe().then((botInfo) => {
    console.log("Bot running in Polling mode.");
    console.log("Bot username:", botInfo.username);
    console.log("Bot ID:", botInfo.id);
    if (MINI_APP_URL) {
        console.log(`Mini App URL: ${MINI_APP_URL}`);
    }
}).catch((err) => {
    console.error("Failed to get bot info:", err.message);
});

// Catch-all for any message to debug
bot.on('message', (msg) => {
    console.log('--- Received ANY message ---');
    console.log('Text:', msg.text);
    console.log('From:', msg.from.id);
});

// Handle the /start command
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    const referralCode = match ? match[1] : null;

    console.log(`[DEBUG] /start from ${telegramId} in chat ${chatId}`);

    try {
        // Step 1: Check database connection
        let result;
        try {
            result = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId.toString()]);
        } catch (dbErr) {
            console.error('[DEBUG] DB Query Error:', dbErr.message);
            await bot.sendMessage(chatId, `❌ የዳታቤዝ ስህተት (DB Error): ${dbErr.message}\nDATABASE_URL ተዋቅሯል? ${!!process.env.DATABASE_URL}`);
            return;
        }

        const isRegistered = result.rows.length > 0;
        console.log(`[DEBUG] User ${telegramId} registered: ${isRegistered}`);

        if (isRegistered) {
            await bot.sendMessage(chatId, "እንኳን ደህና መጡ! ጨዋታውን ለመጀመር 'Play' የሚለውን ቁልፍ ይጫኑ።", {
                reply_markup: getMainKeyboard(telegramId)
            });
        } else {
            if (referralCode) {
                userStates.set(telegramId, { action: 'register', referredBy: referralCode });
            }

            await bot.sendMessage(chatId, "እንኳን ደህና መጡ ወደ ROYAL BINGO! 🎉\n\nጨዋታውን ለመጀመር እባክዎ መጀመሪያ ይመዝገቡ።", {
                reply_markup: {
                    keyboard: [
                        [{ text: "📱 Register", request_contact: true }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        }
    } catch (err) {
        console.error('[DEBUG] Global /start Error:', err);
        await bot.sendMessage(chatId, `❌ ያልታወቀ ስህተት (Bot Error): ${err.message}\nStack: ${err.stack.split('\n')[0]}`);
    }
});

// Handle contact sharing for registration
bot.on('contact', async (msg) => {
    console.log('Received contact message:', JSON.stringify(msg));
    const chatId = msg.chat.id;
    const contact = msg.contact;
    
    // Crucial: We must use the message sender's ID (msg.from.id) 
    // to ensure the registration is linked to the correct user.
    // Sometimes contact.user_id might be different or missing.
    const senderId = msg.from.id;
    const phoneNumber = contact.phone_number;
    
    console.log(`Processing registration for Sender ID: ${senderId}, Phone: ${phoneNumber}, Chat ID: ${chatId}`);
    
    try {
        // Check if already registered
        const existingUser = await db.query('SELECT * FROM users WHERE telegram_id = $1', [senderId.toString()]);
        
        if (existingUser.rows.length > 0) {
            console.log(`User ${senderId} already registered. Showing keyboard.`);
            bot.sendMessage(chatId, "እርስዎ ቀድሞ ተመዝግበዋል! 'Play' ን ይጫኑ።", {
                reply_markup: getMainKeyboard(senderId)
            });
            return;
        }

        // Get referral info from state using senderId
        const state = userStates.get(senderId);
        const referrerId = (state?.action === 'register') ? state.referredBy : null;

        // Register new user with 20 ETB bonus
        const username = msg.from.username || `Player_${senderId}`;
        console.log(`Attempting to register user: ${senderId}, Phone: ${phoneNumber}, Referrer: ${referrerId}`);
        
        // Ensure referrals table exists by using a sub-query or checking for column
        const userResult = await db.query(
            'INSERT INTO users (telegram_id, username, phone_number, is_registered) VALUES ($1, $2, $3, $4) RETURNING id',
            [senderId.toString(), username, phoneNumber, true]
        );
        
        if (!userResult.rows || userResult.rows.length === 0) {
            throw new Error('User insertion failed');
        }
        const userId = userResult.rows[0].id;

        // Create wallet with 10 ETB bonus
        await db.query(
            'INSERT INTO wallets (user_id, balance) VALUES ($1, $2)',
            [userId, 10.00]
        );

        // If referred, handle referral bonus
        if (referrerId) {
            const bonusAmount = 2.00;
            // Ensure referrals table exists and handle bonus
            try {
                await db.query('INSERT INTO referrals (referrer_id, referred_id, bonus_amount) VALUES ($1, $2, $3)', [referrerId, userId, bonusAmount]);
                await db.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [bonusAmount, referrerId]);
                
                // Notify referrer
                const referrerResult = await db.query('SELECT telegram_id FROM users WHERE id = $1', [referrerId]);
                if (referrerResult.rows.length > 0) {
                    const referrerTelegramId = referrerResult.rows[0].telegram_id;
                    const bonusMsg = `🎁 አዲስ ሰው በግብዣ ሊንክዎ ስለተመዘገበ የ ${bonusAmount} ብር ቦነስ አግኝተዋል!\n\n` +
                                   `👤 አዲስ ተመዝጋቢ: ${username}`;
                    bot.sendMessage(referrerTelegramId.toString(), bonusMsg);
                }
            } catch (refErr) {
                console.error('Referral bonus error:', refErr);
            }
        }
        
        userStates.delete(senderId);
        console.log(`New user registered successfully: ${senderId} - ${phoneNumber}`);
        
        bot.sendMessage(chatId, "✅ በተሳካ ሁኔታ ተመዝግበዋል!\n\n🎁 10 ብር የእንኳን ደህና መጡ ቦነስ አግኝተዋል!\n\nአሁን 'Play' ን ይጫኑ!", {
            reply_markup: getMainKeyboard(senderId)
        });
        
    } catch (error) {
        console.error('Registration error details:', error);
        bot.sendMessage(chatId, `ይቅርታ፣ በመመዝገብ ላይ ችግር ተፈጥሯል።\nError: ${error.message}`);
    }
});

// Handle Check Balance button
bot.onText(/💰 Check Balance/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    try {
        const result = await db.query(
            'SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [telegramId.toString()]
        );
        
        if (result.rows.length > 0) {
            const balance = parseFloat(result.rows[0].balance).toFixed(2);
            bot.sendMessage(chatId, `💰 የእርስዎ ቀሪ ሒሳብ: ${balance} ብር`);
        } else {
            bot.sendMessage(chatId, "እባክዎ መጀመሪያ ይመዝገቡ። /start ይላኩ።");
        }
    } catch (error) {
        console.error('Balance check error:', error);
        bot.sendMessage(chatId, "ይቅርታ፣ ሒሳብዎን ማግኘት አልተቻለም።");
    }
});

// User conversation state tracking
const userStates = new Map();

// Admin Telegram IDs - Add admin IDs here
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Helper function to get main keyboard
function getMainKeyboard(telegramId) {
    const miniAppUrlWithId = `${MINI_APP_URL}${MINI_APP_URL.includes('?') ? '&' : '?'}tg_id=${telegramId}`;
    
    return {
        keyboard: [
            [{ text: "▶️ Play", web_app: { url: String(miniAppUrlWithId) } }],
            [{ text: "💰 Check Balance" }, { text: "🔗 Referral Link" }],
            [{ text: "💳 Deposit" }, { text: "💸 Withdraw" }]
        ],
        resize_keyboard: true
    };
}

// Handle Referral Link button
bot.onText(/🔗 Referral Link/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const botInfo = await bot.getMe();
    const referralLink = `https://t.me/${botInfo.username}?start=${telegramId}`;
    
    const message = `🎁 <b>የሪፈራል ፕሮግራም</b>\n\n` +
                    `ይህንን ሊንክ ለጓደኞችዎ ይላኩ። በሊንክዎ ለሚመዘገብ ለእያንዳንዱ ሰው የ <b>2 ብር</b> ቦነስ ያገኛሉ!\n\n` +
                    `🔗 የእርስዎ ሊንክ:\n<code>${referralLink}</code>`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Notify admin
async function notifyAdmin(message, options = {}) {
    const finalOptions = { parse_mode: 'HTML', ...options };
    if (ADMIN_CHAT_ID) {
        try {
            await bot.sendMessage(ADMIN_CHAT_ID, message, finalOptions);
        } catch (err) {
            console.error('Failed to notify admin:', err.message);
        }
    }
    
    // Also notify any registered active admins
    try {
        const activeAdmins = await db.query('SELECT telegram_id FROM admin_users WHERE is_active = true');
        for (const admin of activeAdmins.rows) {
            if (admin.telegram_id !== ADMIN_CHAT_ID) {
                await bot.sendMessage(admin.telegram_id, message, finalOptions);
            }
        }
    } catch (err) {
        console.error('Failed to notify database admins:', err.message);
    }
}

// Helper to check withdrawal eligibility
async function checkWithdrawEligibility(telegramId) {
    try {
        const userResult = await db.query(
            'SELECT u.id FROM users u WHERE u.telegram_id = $1',
            [telegramId.toString()]
        );
        
        if (userResult.rows.length === 0) {
            return { eligible: false, reason: 'not_registered' };
        }
        
        const userId = userResult.rows[0].id;
        
        // Check total confirmed deposits
        const depositResult = await db.query(
            'SELECT COALESCE(SUM(amount), 0) as total_amount, COUNT(*) as count FROM deposits WHERE user_id = $1 AND status = $2',
            [userId, 'confirmed']
        );
        
        const totalDepositAmount = parseFloat(depositResult.rows[0].total_amount);
        const deposits = parseInt(depositResult.rows[0].count);

        // Check total wins
        const winCount = await db.query(
            'SELECT COUNT(*) as count FROM game_participants WHERE user_id = $1 AND is_winner = true',
            [userId]
        );
        const wins = parseInt(winCount.rows[0].count);
        
        // Rule 1: Deposits > 100 ETB can withdraw directly
        if (totalDepositAmount >= 100) {
            return { eligible: true, deposits, wins, userId, type: 'depositor' };
        }
        
        // Rule 2: Bonus users (or < 100 ETB deposit) must have 100 ETB deposit AND 2 wins
        if (totalDepositAmount < 100) {
            if (totalDepositAmount < 100 && wins < 2) {
                return { 
                    eligible: false, 
                    reason: 'insufficient_requirements', 
                    deposits, 
                    wins, 
                    totalDepositAmount,
                    requiredDeposit: 100,
                    requiredWins: 2
                };
            }
            // They have at least some deposit but maybe not enough? 
            // The instruction says: "ምንም ዲፖዚት ያላረገ ሰው... ቢያንስ 100 ብር ዲፖዚት እና ሁለት ጨዋታ የአሸናፊነት ሂስትሪ ሊኖረው ይገባል"
            // And: "ከመቶ ብር በላይ ዲፖዚት ሂስትሪ ያለው ሰው በቀጥታ ዊዝድሮው ያድርግ"
            if (totalDepositAmount < 100) {
                return { 
                    eligible: false, 
                    reason: 'insufficient_deposit', 
                    deposits, 
                    wins, 
                    totalDepositAmount,
                    requiredDeposit: 100
                };
            }
        }
        
        return { eligible: true, deposits, wins, userId };
    } catch (error) {
        console.error('Eligibility check error:', error);
        return { eligible: false, reason: 'error' };
    }
}

// Handle Withdraw button
bot.onText(/💸 Withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    try {
        const balanceResult = await db.query(
            'SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [telegramId.toString()]
        );
        
        if (balanceResult.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ እባክዎ መጀመሪያ ይመዝገቡ።');
            return;
        }

        const balance = parseFloat(balanceResult.rows[0].balance);

        if (balance < 100) {
            await bot.sendMessage(chatId, `❌ በቂ ሒሳብ የለም። ገንዘብ ለማውጣት ቢያንስ 100 ብር ሊኖርዎት ይገባል።\n\n💰 የእርስዎ ቀሪ ሒሳብ: ${balance.toFixed(2)} ብር`);
            return;
        }

        const eligibility = await checkWithdrawEligibility(telegramId);
        
        if (!eligibility.eligible) {
            let message = '';
            if (eligibility.reason === 'not_registered') {
                message = '❌ እባክዎ መጀመሪያ ይመዝገቡ።';
            } else if (eligibility.reason === 'insufficient_requirements') {
                message = `❌ ገንዘብ ለማውጣት መስፈርቶችን አላሟሉም።\n\n` +
                          `📊 የእርስዎ ሁኔታ:\n` +
                          `• ጠቅላላ ዲፖዚት: ${eligibility.totalDepositAmount} ብር\n` +
                          `• አሸናፊነቶች: ${eligibility.wins}\n\n` +
                          `💡 መስፈርቶች:\n` +
                          `• ቢያንስ 100 ብር ዲፖዚት\n` +
                          `• ቢያንስ 2 ጊዜ ማሸነፍ`;
            } else if (eligibility.reason === 'insufficient_deposit') {
                message = `❌ ገንዘብ ለማውጣት ቢያንስ 100 ብር ዲፖዚት ማድረግ አለብዎ።\n\n` +
                          `📊 የእርስዎ ሁኔታ:\n` +
                          `• ጠቅላላ ዲፖዚት: ${eligibility.totalDepositAmount} ብር\n` +
                          `• አሸናፊነቶች: ${eligibility.wins}`;
            } else {
                message = '❌ ይቅርታ፣ ስህተት ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።';
            }
            
            await bot.sendMessage(chatId, message, { reply_markup: getMainKeyboard(telegramId) });
            return;
        }
        
        userStates.set(telegramId, { 
            action: 'withdraw', 
            step: 'amount',
            userId: eligibility.userId 
        });
        
        await bot.sendMessage(chatId, 
            `✅ መስፈርቶቹን አሟልተዋል!\n\n💰 ቀሪ ሒሳብ: ${balance.toFixed(2)} ብር\n\n💵 ማውጣት የሚፈልጉትን መጠን ያስገቡ:`,
            { reply_markup: { keyboard: [[{ text: "❌ ሰርዝ" }]], resize_keyboard: true } }
        );
    } catch (error) {
        console.error('Withdraw button error:', error);
        await bot.sendMessage(chatId, '❌ ይቅርታ፣ ስህተት ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።');
    }
});

// Handle Deposit button
bot.onText(/💳 Deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    try {
        const userResult = await db.query(
            'SELECT id FROM users WHERE telegram_id = $1',
            [telegramId.toString()]
        );
        
        if (userResult.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ እባክዎ መጀመሪያ ይመዝገቡ። /start ይላኩ።');
            return;
        }
        
        userStates.set(telegramId, { 
            action: 'deposit', 
            step: 'method',
            userId: userResult.rows[0].id 
        });
        
        await bot.sendMessage(chatId, 
            '💳 ዲፖዚት ለማድረግ የክፍያ ዘዴ ይምረጡ:',
            { 
                reply_markup: { 
                    keyboard: [
                        [{ text: "📱 Telebirr" }, { text: "🏦 CBE Birr" }],
                        [{ text: "❌ ሰርዝ" }]
                    ], 
                    resize_keyboard: true 
                } 
            }
        );
    } catch (error) {
        console.error('Deposit error:', error);
        await bot.sendMessage(chatId, 'ይቅርታ፣ ስህተት ተፈጥሯል።');
    }
});

// Handle Telebirr selection
bot.onText(/📱 Telebirr/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const state = userStates.get(telegramId);
    
    if (state?.action === 'deposit' && state?.step === 'method') {
        state.paymentMethod = 'telebirr';
        state.step = 'amount';
        userStates.set(telegramId, state);
        
        await bot.sendMessage(chatId, 
            '📱 Telebirr ተመርጧል\n\n💵 ማስገባት የሚፈልጉትን መጠን (ብር) ያስገቡ:',
            { reply_markup: { keyboard: [[{ text: "❌ ሰርዝ" }]], resize_keyboard: true } }
        );
    }
});

// Handle CBE Birr selection
bot.onText(/🏦 CBE Birr/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const state = userStates.get(telegramId);
    
    if (state?.action === 'deposit' && state?.step === 'method') {
        await bot.sendMessage(chatId, 
            '🏦 CBE Birr ለጊዜው በጥገና ላይ ነው (Under Maintenance)።\n\nእባክዎ ለጊዜው በ 📱 Telebirr ይጠቀሙ።',
            { reply_markup: getMainKeyboard(telegramId) }
        );
        userStates.delete(telegramId);
    }
});

// Handle Cancel
bot.onText(/❌ ሰርዝ/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, '❌ ተሰርዟል።', { reply_markup: getMainKeyboard(telegramId) });
});

// Handle general text messages for conversation flow
bot.on('message', async (msg) => {
    // Handle contact shared as a generic message (sometimes triggers here instead of 'contact' event)
    if (msg.contact) {
        // The logic for registration is already handled by the bot.on('contact', ...) listener
        // No need to call a non-existent handleRegistration function
        return;
    }

    if (!msg.text || msg.text.startsWith('/') || 
        msg.text.includes('💰') || msg.text.includes('💸') || 
        msg.text.includes('💳') || msg.text.includes('📱 Telebirr') || 
        msg.text.includes('🏦 CBE Birr') || msg.text.includes('❌') ||
        msg.text.includes('▶️') || msg.text.includes('📱 Register')) {
        return;
    }
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const text = msg.text.trim();
    const state = userStates.get(telegramId);
    
    if (!state) return;
    
    // Handle Withdraw flow
    if (state.action === 'withdraw') {
        if (state.step === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount <= 0) {
                await bot.sendMessage(chatId, '❌ እባክዎ ትክክለኛ መጠን ያስገቡ።');
                return;
            }
            
            const balanceResult = await db.query(
                'SELECT w.balance FROM wallets w JOIN users u ON w.user_id = u.id WHERE u.telegram_id = $1',
                [telegramId.toString()]
            );
            const balance = parseFloat(balanceResult.rows[0]?.balance || 0);
            
            if (amount > balance) {
                await bot.sendMessage(chatId, `❌ በቂ ሒሳብ የለም። ቀሪ: ${balance.toFixed(2)} ብር`);
                return;
            }
            
            state.amount = amount;
            state.step = 'phone';
            userStates.set(telegramId, state);
            
            await bot.sendMessage(chatId, '📞 ገንዘቡ የሚላክበትን ስልክ ቁጥር ያስገቡ:');
        } else if (state.step === 'phone') {
            state.phone = text;
            state.step = 'name';
            userStates.set(telegramId, state);
            
            await bot.sendMessage(chatId, '👤 የአካውንት ባለቤት ስም ያስገቡ:');
        } else if (state.step === 'name') {
            state.accountName = text;
            
            try {
                // Security Fix: Deduct balance immediately upon request to prevent double-spending
                const deductionSuccess = await Wallet.deductBalance(state.userId, state.amount, `Withdrawal request: ${state.amount} ETB to ${state.phone}`);
                
                if (!deductionSuccess) {
                    await bot.sendMessage(chatId, '❌ በቂ ሒሳብ የለም ወይም ስህተት ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።');
                    userStates.delete(telegramId);
                    return;
                }

                await db.query(
                    'INSERT INTO withdrawals (user_id, amount, phone_number, account_name, status) VALUES ($1, $2, $3, $4, $5)',
                    [state.userId, state.amount, state.phone, state.accountName, 'pending']
                );
                
                const userResult = await db.query(
                    'SELECT username FROM users WHERE id = $1',
                    [state.userId]
                );
                const username = userResult.rows[0]?.username || 'Unknown';
                
                await notifyAdmin(
                    `🔔 <b>አዲስ የገንዘብ ማውጣት ጥያቄ</b>\n\n` +
                    `👤 ተጠቃሚ: ${username}\n` +
                    `💵 መጠን: ${state.amount} ብር\n` +
                    `📞 ስልክ: ${state.phone}\n` +
                    `🏷 ስም: ${state.accountName}\n` +
                    `📅 ቀን: ${new Date().toLocaleString('am-ET')}`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ ፍቀድ (Approve)', callback_data: `approve_with_${state.userId}_${state.amount}_${state.phone}` },
                                    { text: '❌ ውድቅ (Reject)', callback_data: `reject_with_${state.userId}` }
                                ]
                            ]
                        }
                    }
                );
                
                userStates.delete(telegramId);
                await bot.sendMessage(chatId, 
                    `✅ የገንዘብ ማውጣት ጥያቄዎ ተልኳል!\n\n` +
                    `💵 መጠን: ${state.amount} ብር\n` +
                    `📞 ስልክ: ${state.phone}\n` +
                    `🏷 ስም: ${state.accountName}\n\n` +
                    `⏳ አድሚኑ ሲያጸድቀው ገንዘቡ ይላክላችኋል። ሒሳብዎ ላይ ተቀንሷል።`,
                    { reply_markup: getMainKeyboard(telegramId) }
                );
            } catch (error) {
                console.error('Withdrawal request error:', error);
                await bot.sendMessage(chatId, 'ይቅርታ፣ ስህተት ተፈጥሯል።');
            }
        }
    }
    
    // Handle Deposit flow
    if (state.action === 'deposit') {
        if (state.step === 'amount') {
            const amount = parseFloat(text);
            if (isNaN(amount) || amount < 20) {
                await bot.sendMessage(chatId, '❌ ዝቅተኛው ዲፖዚት 20 ብር ነው። እባክዎ ከ20 ብር በላይ ያስገቡ።');
                return;
            }
            
            state.amount = amount;
            state.step = 'confirmation_code';
            userStates.set(telegramId, state);
            
            const paymentInfo = state.paymentMethod === 'telebirr' 
                ? '📱 Telebirr: <code>0980682889</code>' 
                : '🏦 CBE: <code>1000123456789</code>';
            
            await bot.sendMessage(chatId, 
                `💵 መጠን: ${amount} ብር\n\n` +
                `${paymentInfo}\n\n` +
                `ገንዘቡን ከላኩ በኋላ ከቴሌብር የሚደርስዎት ሜሴጅ ላይ የማረጋገጫ ኮድዎን ኮፒ አድርገው ይላኩ ወይንም ሙሉ ቴክስቱን ኮፒ አድርገው እዚ ይላኩ።`,
                { parse_mode: 'HTML' }
            );
        } else if (state.step === 'confirmation_code') {
            const rawText = text.trim();
            
            // ✅ 100% PERFECT PARSING: Extract Transaction ID and Amount from various Amharic SMS formats
            const txIdPattern = /(?:ቁጥርዎ|receipt\/|ቁጥርዎ\s*)\s*([A-Z0-9]{8,15})/i;
            const amountPattern = /([\d,.]+)\s*ብር/;
            
            const txIdMatch = rawText.match(txIdPattern);
            const amountMatch = rawText.match(amountPattern);
            
            let finalCode = rawText;
            let finalAmount = state.amount;
            
            if (txIdMatch) {
                finalCode = txIdMatch[1].trim().toUpperCase();
                console.log(`Extracted Transaction ID from user input: ${finalCode}`);
            } else if (/^[A-Z0-9]{8,15}$/i.test(rawText)) {
                // If it's just a plain code
                finalCode = rawText.toUpperCase();
            } else if (rawText.length > 20) {
                // If the text is long and doesn't match the specific patterns, 
                // we treat the first 15 chars as a potential code or just use a snippet
                finalCode = rawText.substring(0, 50); // Keep more for admin to see
            }
            
            if (amountMatch) {
                const parsedAmount = parseFloat(amountMatch[1].replace(/,/g, ''));
                if (!isNaN(parsedAmount)) {
                    finalAmount = parsedAmount;
                    console.log(`Extracted Amount from user input: ${finalAmount}`);
                }
            }

            // ✅ VALIDATION: Minimum deposit amount 20 ETB
            if (finalAmount < 20) {
                await bot.sendMessage(chatId, '❌ ዝቅተኛው ዲፖዚት 20 ብር ነው። እባክዎ ከ20 ብር በላይ ያስገቡ።');
                return;
            }

            try {
                // Step 1: Normalize ID for comparison
                const normalizedInputCode = finalCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();

                // Step 2: Check for ANY existing record with this code (prevent duplicates)
                console.log(`Checking existing deposit for code: ${finalCode}, normalized: ${normalizedInputCode}`);
                const existingCheck = await db.query(
                    `SELECT * FROM deposits 
                     WHERE (
                        confirmation_code = $1 
                        OR UPPER(REGEXP_REPLACE(confirmation_code, '[^A-Z0-9]', '', 'g')) = $2
                     )`,
                    [finalCode, normalizedInputCode]
                );
                
                console.log(`Found ${existingCheck.rows.length} existing records`);

                if (existingCheck.rows.length > 0) {
                    const existing = existingCheck.rows[0];
                    console.log(`Existing record status: ${existing.status}`);
                    
                    if (existing.status === 'confirmed') {
                        await bot.sendMessage(chatId, '⚠️ ይህ የግብይት ቁጥር ቀደም ብሎ ጥቅም ላይ ውሏል።');
                        return;
                    }
                    
                    if (existing.status === 'unmatched') {
                        // Match found! Auto-approve
                        await db.query('BEGIN');
                        await db.query(
                            'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
                            [existing.amount, state.userId]
                        );
                        await db.query(
                            'UPDATE deposits SET user_id = $1, status = $2, confirmed_at = NOW() WHERE id = $3',
                            [state.userId, 'confirmed', existing.id]
                        );
                        await db.query('COMMIT');

                        userStates.delete(telegramId);
                        await bot.sendMessage(chatId, 
                            `✅ ዲፖዚትዎ ተረጋግጧል!\n\n💵 መጠን: ${existing.amount} ብር\n🔑 ኮድ: ${existing.confirmation_code}\n\nሒሳብዎ ላይ ተጨምሯል። መልካም ጨዋታ!`,
                            { reply_markup: getMainKeyboard(telegramId) }
                        );
                        return;
                    }
                    
                    if (existing.status === 'pending') {
                        await bot.sendMessage(chatId, '⏳ ይህ ግብይት ቀደም ብሎ ተልኮ በመጠባበቅ ላይ ነው። እባክዎ አድሚኑ እስኪያጸድቀው ይጠብቁ።');
                        return;
                    }
                }

                // If no record exists, save as pending for admin approval (or until SMS arrives)
                await db.query(
                    'INSERT INTO deposits (user_id, amount, payment_method, confirmation_code, status) VALUES ($1, $2, $3, $4, $5)',
                    [state.userId, state.amount, state.paymentMethod, rawText, 'pending']
                );
                
                const userResult = await db.query(
                    'SELECT username FROM users WHERE id = $1',
                    [state.userId]
                );
                const username = userResult.rows[0]?.username || 'Unknown';
                
                await notifyAdmin(
                    `🔔 <b>አዲስ ዲፖዚት ጥያቄ</b>\n\n` +
                    `👤 ተጠቃሚ: ${username}\n` +
                    `💵 መጠን: ${finalAmount} ብር\n` +
                    `💳 ዘዴ: ${state.paymentMethod === 'telebirr' ? 'Telebirr' : 'CBE Birr'}\n` +
                    `🔑 ኮድ: ${finalCode}\n` +
                    `📅 ቀን: ${new Date().toLocaleString('am-ET')}`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ ፍቀድ (Approve)', callback_data: `approve_dep_${state.userId}_${finalAmount}_${state.paymentMethod}` },
                                    { text: '❌ ውድቅ (Reject)', callback_data: `reject_dep_${state.userId}` }
                                ]
                            ]
                        }
                    }
                );
                
                userStates.delete(telegramId);
                await bot.sendMessage(chatId, 
                    `✅ የዲፖዚት ጥያቄዎ ተልኳል!\n\n` +
                    `💵 መጠን: ${finalAmount} ብር\n` +
                    `💳 ዘዴ: ${state.paymentMethod === 'telebirr' ? 'Telebirr' : 'CBE Birr'}\n` +
                    `🔑 ኮድ: ${finalCode}\n\n` +
                    `⏳ ከተረጋገጠ በኋላ ሒሳብዎ ይጨምራል።`,
                    { reply_markup: getMainKeyboard(telegramId) }
                );
            } catch (error) {
                console.error('Deposit request error:', error);
                await bot.sendMessage(chatId, 'ይቅርታ፣ ስህተት ተፈጥሯል።');
            }
        }
    }
});

// Admin command to set admin
bot.onText(/\/setadmin/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    
    try {
        await db.query(
            'INSERT INTO admin_users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO UPDATE SET is_active = true',
            [telegramId, msg.from.username || 'Admin']
        );
        
        await bot.sendMessage(chatId, 
            `✅ እርስዎ አድሚን ሆነዋል!\n\nChat ID: ${chatId}\n\nይህን Chat ID ወደ ADMIN_CHAT_ID environment variable ያስገቡ።`
        );
    } catch (error) {
        console.error('Set admin error:', error);
    }
});

// Admin command to view pending transactions
bot.onText(/\/pending/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    
    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }
        
        const pendingDeposits = await db.query(`
            SELECT d.id, d.amount, d.payment_method, d.confirmation_code, d.created_at, u.username, u.id as user_id
            FROM deposits d
            JOIN users u ON d.user_id = u.id
            WHERE d.status = 'pending'
            ORDER BY d.created_at DESC
            LIMIT 5
        `);
        
        const pendingWithdrawals = await db.query(`
            SELECT w.id, w.amount, w.phone_number, w.account_name, w.created_at, u.username, u.id as user_id
            FROM withdrawals w
            JOIN users u ON w.user_id = u.id
            WHERE w.status = 'pending'
            ORDER BY w.created_at DESC
            LIMIT 5
        `);
        
        if (pendingDeposits.rows.length === 0 && pendingWithdrawals.rows.length === 0) {
            await bot.sendMessage(chatId, '✅ በመጠባበቅ ላይ ያለ ግብይት የለም።');
            return;
        }

        // Send each deposit as a separate message with buttons
        for (const d of pendingDeposits.rows) {
            await bot.sendMessage(chatId, 
                `💳 <b>ዲፖዚት ጥያቄ</b>\n\n` +
                `👤: ${d.username}\n` +
                `💵: ${d.amount} ብር\n` +
                `💳: ${d.payment_method}\n` +
                `🔑: ${d.confirmation_code}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ ፍቀድ', callback_data: `approve_dep_id_${d.id}` },
                                { text: '❌ ውድቅ', callback_data: `reject_dep_id_${d.id}` }
                            ]
                        ]
                    }
                }
            );
        }

        // Send each withdrawal as a separate message with buttons
        for (const w of pendingWithdrawals.rows) {
            await bot.sendMessage(chatId, 
                `💸 <b>ማውጣት ጥያቄ</b>\n\n` +
                `👤: ${w.username}\n` +
                `💵: ${w.amount} ብር\n` +
                `📞: ${w.phone_number}\n` +
                `🏷: ${w.account_name}`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ ፍቀድ', callback_data: `approve_with_id_${w.id}` },
                                { text: '❌ ውድቅ', callback_data: `reject_with_id_${w.id}` }
                            ]
                        ]
                    }
                }
            );
        }
    } catch (error) {
        console.error('Pending check error:', error);
        await bot.sendMessage(chatId, 'ስህተት ተፈጥሯል።');
    }
});

// Admin command to adjust balance via Telegram
bot.onText(/\/adjust (\d+) (add|subtract) (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const adminId = msg.from.id.toString();
    const userId = match[1];
    const action = match[2];
    const amount = parseFloat(match[3]);

    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [adminId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }

        const adjustAmount = action === 'subtract' ? -Math.abs(amount) : Math.abs(amount);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
            if (walletRes.rows.length === 0) {
                await client.query('ROLLBACK');
                await bot.sendMessage(chatId, '❌ ተጠቃሚው አልተገኘም ወይም ዋሌት የለውም።');
                return;
            }

            const newBalance = parseFloat(walletRes.rows[0].balance) + adjustAmount;
            if (newBalance < 0) {
                await client.query('ROLLBACK');
                await bot.sendMessage(chatId, '❌ ተቀናሽ ለማድረግ በቂ ባላንስ የለም።');
                return;
            }

            await client.query('UPDATE wallets SET balance = $1 WHERE user_id = $2', [newBalance, userId]);
            await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', 
                [userId, action === 'add' ? 'admin_add' : 'admin_subtract', amount, `Bot adjust: ${action}`]);
            await client.query('COMMIT');

            await bot.sendMessage(chatId, `✅ ተፈጽሟል! ተጠቃሚ #${userId} አዲስ ባላንስ: ${newBalance.toFixed(2)} ብር`);

            // Notify user
            const userRes = await client.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length > 0 && userRes.rows[0].telegram_id) {
                const notifyMsg = action === 'add' ? 
                    `🎁 አድሚኑ ${amount} ብር ወደ ሒሳብዎ ጨምሯል!\nአዲስ ባላንስ: ${newBalance.toFixed(2)} ብር` :
                    `⚠️ አድሚኑ ${amount} ብር ከሒሳብዎ ቀንሷል።\nአዲስ ባላንስ: ${newBalance.toFixed(2)} ብር`;
                bot.sendMessage(userRes.rows[0].telegram_id, notifyMsg).catch(e => console.error('Bot notify fail:', e.message));
            }
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Bot adjust error:', err);
        await bot.sendMessage(chatId, '❌ ስህተት ተፈጥሯል።');
    }
});

// Approve deposit
bot.onText(/\/approve_deposit (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const depositId = parseInt(match[1]);
    
    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }
        
        const deposit = await db.query(
            'SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1',
            [depositId]
        );
        
        if (deposit.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ ዲፖዚት አልተገኘም።');
            return;
        }
        
        const d = deposit.rows[0];
        
        if (d.status !== 'pending') {
            await bot.sendMessage(chatId, '❌ ይህ ዲፖዚት ቀድሞ ተፈጽሟል።');
            return;
        }
        
        await db.query('UPDATE deposits SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', depositId]);
        
        await db.query(
            'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
            [d.amount, d.user_id]
        );
        
        await db.query(
            'INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
            [d.user_id, 'deposit', d.amount, `Deposit via ${d.payment_method}`]
        );
        
        await bot.sendMessage(chatId, `✅ ዲፖዚት #${depositId} ተፈቅዷል! ${d.amount} ብር ወደ ሒሳብ ተጨምሯል።`);
        
        if (d.user_telegram_id) {
            await bot.sendMessage(d.user_telegram_id, 
                `✅ ዲፖዚትዎ ተረጋግጧል!\n\n💵 ${d.amount} ብር ወደ ሒሳብዎ ተጨምሯል።`
            );
        }
    } catch (error) {
        console.error('Approve deposit error:', error);
        await bot.sendMessage(chatId, 'ስህተት ተፈጥሯል።');
    }
});

// Reject deposit
bot.onText(/\/reject_deposit (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const depositId = parseInt(match[1]);
    
    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }
        
        const deposit = await db.query(
            'SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1',
            [depositId]
        );
        
        if (deposit.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ ዲፖዚት አልተገኘም።');
            return;
        }
        
        const d = deposit.rows[0];
        
        await db.query('UPDATE deposits SET status = $1 WHERE id = $2', ['rejected', depositId]);
        
        await bot.sendMessage(chatId, `❌ ዲፖዚት #${depositId} ተቀባይነት አላገኘም።`);
        
        if (d.user_telegram_id) {
            await bot.sendMessage(d.user_telegram_id, 
                `❌ ዲፖዚትዎ ተቀባይነት አላገኘም።\n\nእባክዎ ትክክለኛ መረጃ ይላኩ ወይም ድጋሚ ይሞክሩ።`
            );
        }
    } catch (error) {
        console.error('Reject deposit error:', error);
        await bot.sendMessage(chatId, 'ስህተት ተፈጥሯል።');
    }
});

// Approve withdrawal
bot.onText(/\/approve_withdraw (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const withdrawalId = parseInt(match[1]);
    
    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }
        
        const withdrawal = await db.query(
            'SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1',
            [withdrawalId]
        );
        
        if (withdrawal.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ ማውጣት ጥያቄ አልተገኘም።');
            return;
        }
        
        const w = withdrawal.rows[0];
        
        if (w.status !== 'pending') {
            await bot.sendMessage(chatId, '❌ ይህ ጥያቄ ቀድሞ ተፈጽሟል።');
            return;
        }
        
        const balanceCheck = await db.query(
            'SELECT balance FROM wallets WHERE user_id = $1',
            [w.user_id]
        );
        
        if (parseFloat(balanceCheck.rows[0]?.balance || 0) < w.amount) {
            await bot.sendMessage(chatId, '❌ ተጠቃሚው በቂ ሒሳብ የለውም።');
            return;
        }
        
        await db.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['approved', withdrawalId]);
        
        await db.query(
            'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
            [w.amount, w.user_id]
        );
        
        await db.query(
            'INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
            [w.user_id, 'withdrawal', w.amount, `Withdrawal to ${w.phone_number}`]
        );
        
        await bot.sendMessage(chatId, `✅ ማውጣት #${withdrawalId} ተፈቅዷል! ${w.amount} ብር ወደ ${w.phone_number} ይላካል።`);
        
        if (w.user_telegram_id) {
            await bot.sendMessage(w.user_telegram_id, 
                `✅ የገንዘብ ማውጣት ጥያቄዎ ተፈቅዷል!\n\n💵 ${w.amount} ብር ወደ ${w.phone_number} ተልኳል።`
            );
        }
    } catch (error) {
        console.error('Approve withdrawal error:', error);
        await bot.sendMessage(chatId, 'ስህተት ተፈጥሯል።');
    }
});

// Reject withdrawal
bot.onText(/\/reject_withdraw (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const withdrawalId = parseInt(match[1]);
    
    try {
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        
        if (adminCheck.rows.length === 0 && chatId.toString() !== ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, '❌ የአድሚን መብት የለዎትም።');
            return;
        }
        
        const withdrawal = await db.query(
            'SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1',
            [withdrawalId]
        );
        
        if (withdrawal.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ ማውጣት ጥያቄ አልተገኘም።');
            return;
        }
        
        const w = withdrawal.rows[0];
        
        await db.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', withdrawalId]);
        
        await bot.sendMessage(chatId, `❌ ማውጣት #${withdrawalId} ተቀባይነት አላገኘም።`);
        
        if (w.user_telegram_id) {
            await bot.sendMessage(w.user_telegram_id, 
                `❌ የገንዘብ ማውጣት ጥያቄዎ ተቀባይነት አላገኘም።\n\nለበለጠ መረጃ እባክዎ ያግኙን።`
            );
        }
    } catch (error) {
        console.error('Reject withdrawal error:', error);
        await bot.sendMessage(chatId, 'ስህተት ተፈጥሯል።');
    }
});

// Handle Callback Queries (Buttons)
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const adminTelegramId = callbackQuery.from.id.toString();
    const chatId = message.chat.id;

    console.log(`Callback query received: ${data} from ${adminTelegramId}`);

    try {
        // Verify admin
        const adminCheck = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [adminTelegramId]
        );
        
        const isAdmin = adminCheck.rows.length > 0 || adminTelegramId === ADMIN_CHAT_ID;
        
        if (!isAdmin) {
            console.log(`Unauthorized admin attempt: ${adminTelegramId}`);
            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ የአድሚን መብት የለዎትም።', show_alert: true });
            return;
        }

        // Handle Deposit Approval via ID
        if (data.startsWith('approve_dep_id_')) {
            const depositId = data.replace('approve_dep_id_', '');
            console.log(`Bot approving deposit: ${depositId}`);
            
            const deposit = await db.query(
                'SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1',
                [depositId]
            );
            
            if (deposit.rows.length === 0 || deposit.rows[0].status !== 'pending') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ግብይቱ ቀድሞ ተፈጽሟል ወይም አልተገኘም።' });
                return;
            }

            const d = deposit.rows[0];
            const client = await db.db.db.pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE deposits SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', depositId]);
                await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2', [d.amount, d.user_id]);
                await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', [d.user_id, 'deposit', d.amount, `Deposit via ${d.payment_method}`]);
                await client.query('COMMIT');
                
                await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ ዲፖዚቱ ፀድቋል!' });
                
                const formattedText = message.text.replace(/💳 ዲፖዚት ጥያቄ/g, '✅ <b>ዲፖዚት ጥያቄ (ተፈቅዷል)</b>');
                await bot.editMessageText(formattedText, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML'
                });

                if (d.user_telegram_id) {
                    await bot.sendMessage(d.user_telegram_id, `✅ ዲፖዚትዎ ተረጋግጧል!\n\n💵 ${d.amount} ብር ወደ ሒሳብዎ ተጨምሯል ።`);
                }
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }

        // Handle Deposit Rejection via ID
        if (data.startsWith('reject_dep_id_')) {
            const depositId = data.replace('reject_dep_id_', '');
            console.log(`Bot rejecting deposit: ${depositId}`);
            
            const deposit = await db.query('SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1', [depositId]);
            
            if (deposit.rows.length === 0 || deposit.rows[0].status !== 'pending') {
                await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ አልተገኘም።' });
                return;
            }

            const d = deposit.rows[0];
            await db.query('UPDATE deposits SET status = $1 WHERE id = $2', ['rejected', depositId]);

            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ዲፖዚቱ ውድቅ ተደርጓል!' });
            const formattedText = message.text.replace(/💳 ዲፖዚት ጥያቄ/g, '❌ <b>ዲፖዚት ጥያቄ (ውድቅ ተደርጓል)</b>');
            await bot.editMessageText(formattedText, {
                chat_id: chatId,
                message_id: message.message_id,
                parse_mode: 'HTML'
            });

            if (d.user_telegram_id) {
                await bot.sendMessage(d.user_telegram_id, `❌ ዲፖዚትዎ ተቀባይነት አላገኘም። እባክዎ ትክክለኛ መረጃ ይላኩ።`);
            }
        }

        // Handle Withdrawal Approval via ID
        if (data.startsWith('approve_with_id_')) {
            const withdrawalId = data.replace('approve_with_id_', '');
            console.log(`Bot approving withdrawal: ${withdrawalId}`);
            
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                
                const withdrawal = await client.query('SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1 FOR UPDATE', [withdrawalId]);
                
                if (withdrawal.rows.length === 0 || withdrawal.rows[0].status !== 'pending') {
                    await client.query('ROLLBACK');
                    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ አልተገኘም ወይም ቀድሞ ተፈጽሟል።' });
                    return;
                }

                const w = withdrawal.rows[0];
                
                await client.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['approved', withdrawalId]);
                await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', [w.user_id, 'withdrawal_confirmed', w.amount, `Withdrawal to ${w.phone_number} confirmed`]);
                
                await client.query('COMMIT');

                await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ ማውጣቱ ፀድቋል!' });
                const formattedText = message.text.replace(/💸 ማውጣት ጥያቄ/g, '✅ <b>ማውጣት ጥያቄ (ተፈቅዷል)</b>');
                await bot.editMessageText(formattedText, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML'
                });

                if (w.user_telegram_id) {
                    await bot.sendMessage(w.user_telegram_id, `✅ የገንዘብ ማውጣት ጥያቄዎ ተፈቅዷል!\n\n💵 ${w.amount} ብር ወደ ${w.phone_number} ተልኳል።`);
                }
            } catch (e) {
                await client.query('ROLLBACK');
                console.error('Withdrawal approval error:', e);
                await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ስህተት ተፈጥሯል።' });
            } finally {
                client.release();
            }
        }

        // Handle Withdrawal Rejection via ID
        if (data.startsWith('reject_with_id_')) {
            const withdrawalId = data.replace('reject_with_id_', '');
            console.log(`Bot rejecting withdrawal: ${withdrawalId}`);
            
            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                
                const withdrawal = await client.query('SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1 FOR UPDATE', [withdrawalId]);
                
                if (withdrawal.rows.length === 0 || withdrawal.rows[0].status !== 'pending') {
                    await client.query('ROLLBACK');
                    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ አልተገኘም ወይም ቀድሞ ተረባርቧል።' });
                    return;
                }

                const w = withdrawal.rows[0];
                
                // Refund the balance
                await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2', [w.amount, w.user_id]);
                await client.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', withdrawalId]);
                await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', [w.user_id, 'refund', w.amount, `Refund for rejected withdrawal #${withdrawalId}`]);
                
                await client.query('COMMIT');

                await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ማውጣቱ ውድቅ ተደርጓል (ገንዘቡ ተመልሷል)!' });
                const formattedText = message.text.replace(/💸 ማውጣት ጥያቄ/g, '❌ <b>ማውጣት ጥያቄ (ውድቅ ተደርጓል - ገንዘቡ ተመልሷል)</b>');
                await bot.editMessageText(formattedText, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML'
                });

                if (w.user_telegram_id) {
                    await bot.sendMessage(w.user_telegram_id, `❌ የገንዘብ ማውጣት ጥያቄዎ ተቀባይነት አላገኘም። ${w.amount} ብር ወደ ሒሳብዎ ተመልሷል።`);
                }
            } catch (e) {
                await client.query('ROLLBACK');
                console.error('Withdrawal rejection error:', e);
                await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ስህተት ተፈጥሯል።' });
            } finally {
                client.release();
            }
        }

        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Callback error:', error);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ ስህተት ተፈጥሯል።' });
    }
});

bot.on('error', (error) => {
    console.error("Bot error:", error.message);
});

// --- End of Telegram Bot Logic ---

const server = http.createServer(app);
// Start selection phase loop
if (!global.gameLoopInterval) {
    global.gameLoopInterval = setInterval(gameLoop, 1000);
}

const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'chewatabingo-secret-key-change-in-production';
const SELECTION_TIME = 60; // Increased to 60 seconds for a better flow
const WINNER_DISPLAY_TIME = 10; // Increased for better visibility

let currentGameId = null;
let gameState = {
    phase: 'selection',
    timeLeft: SELECTION_TIME,
    calledNumbers: [],
    masterNumbers: [],
    winner: null,
    players: new Map(),
    stakeAmount: 10
};

/**
 * Syncs critical game state to Redis for low-latency session management.
 */
async function syncGameStateToRedis() {
    if (!db.redis) return;
    try {
        const stateToSync = {
            phase: gameState.phase,
            timeLeft: gameState.timeLeft,
            stakeAmount: gameState.stakeAmount,
            calledNumbers: gameState.calledNumbers,
            currentGameId: currentGameId
        };
        await db.redis.set('royalbingo:live_state', JSON.stringify(stateToSync), 'EX', 3600);
    } catch (err) {
        console.error('Redis sync error:', err);
    }
}

/**
 * Recovers game state from Redis on startup.
 */
async function loadGameStateFromRedis() {
    if (!db.redis) return;
    try {
        const cached = await db.redis.get('royalbingo:live_state');
        if (cached) {
            const parsed = JSON.parse(cached);
            gameState.phase = parsed.phase;
            gameState.timeLeft = parsed.timeLeft;
            gameState.stakeAmount = parsed.stakeAmount;
            gameState.calledNumbers = parsed.calledNumbers;
            currentGameId = parsed.currentGameId;
            console.log('Game state recovered from Redis');
        }
    } catch (err) {
        console.error('Redis recovery error:', err);
    }
}

/**
 * Syncs critical game state to Redis for low-latency session management.
 */
async function syncGameStateToRedis() {
    if (!db.redis) return;
    try {
        const stateToSync = {
            phase: gameState.phase,
            timeLeft: gameState.timeLeft,
            stakeAmount: gameState.stakeAmount,
            calledNumbers: gameState.calledNumbers,
            currentGameId: currentGameId
        };
        await db.redis.set('royalbingo:live_state', JSON.stringify(stateToSync), 'EX', 3600);
    } catch (err) {
        console.error('Redis sync error:', err);
    }
}

/**
 * Recovers game state from Redis on startup.
 */
async function loadGameStateFromRedis() {
    if (!db.redis) return;
    try {
        const cached = await db.redis.get('royalbingo:live_state');
        if (cached) {
            const parsed = JSON.parse(cached);
            gameState.phase = parsed.phase;
            gameState.timeLeft = parsed.timeLeft;
            gameState.stakeAmount = parsed.stakeAmount;
            gameState.calledNumbers = parsed.calledNumbers;
            currentGameId = parsed.currentGameId;
            console.log('Game state recovered from Redis');
        }
    } catch (err) {
        console.error('Redis recovery error:', err);
    }
}

let playerIdCounter = 0;

function initializeMasterNumbers() {
    gameState.masterNumbers = [];
    for (let i = 1; i <= 75; i++) {
        gameState.masterNumbers.push(i);
    }
    gameState.calledNumbers = [];
}

function getLetterForNumber(num) {
    if (num >= 1 && num <= 15) return 'B';
    if (num >= 16 && num <= 30) return 'I';
    if (num >= 31 && num <= 45) return 'N';
    if (num >= 46 && num <= 60) return 'G';
    if (num >= 61 && num <= 75) return 'O';
    return '';
}

function callNumber() {
    const uncalledNumbers = gameState.masterNumbers.filter(
        num => !gameState.calledNumbers.includes(num)
    );
    
    if (uncalledNumbers.length === 0) {
        return null;
    }
    
    const randomIndex = Math.floor(Math.random() * uncalledNumbers.length);
    const calledNumber = uncalledNumbers[randomIndex];
    gameState.calledNumbers.push(calledNumber);
    syncGameStateToRedis(); // Real-time sync to Redis
    
    return {
        number: calledNumber,
        letter: getLetterForNumber(calledNumber)
    };
}

function broadcast(message) {
    // Inject current game stats into every broadcast that needs it
    if (['timer_update', 'phase_change', 'init', 'game_update'].includes(message.type)) {
        message.participantsCount = getConfirmedPlayersCount();
        const grossPot = message.participantsCount * (gameState.stakeAmount || 10);
        message.totalJackpot = grossPot * 0.8; // Show 80% to user as "Derash"
        message.stake = gameState.stakeAmount || 10;
    }
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function getConfirmedPlayersCount() {
    let count = 0;
    gameState.players.forEach((player) => {
        if (player.isCardConfirmed) {
            count++;
        }
    });
    return count;
}

async function startSelectionPhase() {
    gameState.phase = 'selection';
    gameState.timeLeft = SELECTION_TIME;
    gameState.winner = null;
    gameState.calledNumbers = [];
    
    gameState.players.forEach((player, id) => {
        player.selectedCardId = null;
        player.isCardConfirmed = false;
    });
    
    try {
        const game = await Game.create(gameState.stakeAmount);
        currentGameId = game.id;
        console.log(`New game created: #${currentGameId}`);
    } catch (err) {
        console.error('Error creating game:', err);
    }
    
    broadcast({
        type: 'phase_change',
        phase: 'selection',
        timeLeft: gameState.timeLeft,
        gameId: currentGameId
    });
}

function startGamePhase() {
    gameState.phase = 'game';
    gameState.timeLeft = -1;
    gameState.calledNumbers = []; 
    initializeMasterNumbers();
    
    // Explicit broadcast for phase change
    broadcast({
        type: 'phase_change',
        phase: 'game',
        timeLeft: -1,
        players: getPlayersInfo()
    });
}

async function startWinnerDisplay(winnerInfo) {
    stopNumberCalling();
    gameState.phase = 'winner';
    gameState.timeLeft = WINNER_DISPLAY_TIME;
    gameState.winner = winnerInfo;
    
    // Start countdown for winner display phase
    const winnerTimer = setInterval(() => {
        if (gameState.phase === 'winner') {
            gameState.timeLeft--;
            broadcast({
                type: 'timer_update',
                phase: 'winner',
                timeLeft: gameState.timeLeft
            });
            
            if (gameState.timeLeft <= 0) {
                clearInterval(winnerTimer);
                startSelectionPhase();
            }
        } else {
            clearInterval(winnerTimer);
        }
    }, 1000);

    try {
        if (currentGameId && winnerInfo.userId) {
            const game = await Game.setWinner(
                currentGameId, 
                winnerInfo.userId, 
                winnerInfo.cardId,
                gameState.calledNumbers
            );
            
            if (game && game.total_pot > 0) {
                await Wallet.win(winnerInfo.userId, game.total_pot, currentGameId);
                winnerInfo.prize = game.total_pot;
                
                // Send real-time balance update to the winner
                const newBalance = await Wallet.getBalance(winnerInfo.userId);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        const player = gameState.players.get(client.playerId);
                        if (player && player.userId === winnerInfo.userId) {
                            client.send(JSON.stringify({
                                type: 'balance_update',
                                balance: parseFloat(newBalance),
                                prize: game.total_pot
                            }));
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.error('Error recording winner:', err);
    }
    
    broadcast({
        type: 'phase_change',
        phase: 'winner',
        timeLeft: gameState.timeLeft,
        winner: winnerInfo
    });
}

function getPlayersInfo() {
    const players = [];
    gameState.players.forEach((player, id) => {
        if (player.isCardConfirmed) {
            players.push({
                id: id,
                username: player.username,
                cardId: player.selectedCardId
            });
        }
    });
    return players;
}

let numberCallInterval = null;

function startNumberCalling() {
    if (numberCallInterval) clearInterval(numberCallInterval);
    
    numberCallInterval = setInterval(() => {
        if (gameState.phase === 'game') {
            const call = callNumber();
            if (call) {
                broadcast({
                    type: 'number_called',
                    number: call.number,
                    letter: call.letter,
                    calledNumbers: gameState.calledNumbers
                });
            } else {
                stopNumberCalling();
                broadcast({
                    type: 'all_numbers_called'
                });
                setTimeout(() => {
                    if (gameState.phase === 'game') {
                        startSelectionPhase();
                    }
                }, 5000);
            }
        }
    }, 3000);
}

// Global game loop for selection phase
if (!global.selectionInterval) {
    global.selectionInterval = setInterval(() => {
        if (gameState.phase === 'selection') {
            gameState.timeLeft--;
            
            broadcast({
                type: 'timer_update',
                phase: 'selection',
                timeLeft: gameState.timeLeft,
                participantsCount: getConfirmedPlayersCount()
            });

            if (gameState.timeLeft <= 0) {
                const confirmedCount = getConfirmedPlayersCount();
                if (confirmedCount >= 2) { 
                    console.log('Selection phase ended. Starting game with ' + confirmedCount + ' players.');
                    startGamePhase();
                    startNumberCalling();
                } else {
                    console.log('Not enough players. Refunding and resetting selection timer.');
                    
                    // Refund stake to the single player if they exist
                    gameState.players.forEach(async (player) => {
                        if (player.isCardConfirmed && player.selectedCardId) {
                            try {
                                const stakeAmount = gameState.stakeAmount || 10;
                                await Wallet.adjustBalance(player.userId, stakeAmount, 'add', 'Game cancelled: Not enough players');
                                player.balance += stakeAmount;
                                player.isCardConfirmed = false;
                                player.selectedCardId = null;
                                // Find player's websocket and notify
                                wss.clients.forEach(client => {
                                    if (client.playerId === player.id) {
                                        client.send(JSON.stringify({
                                            type: 'game_cancelled',
                                            message: 'በቂ ተጫዋች የለም። ብርዎ ተመላሽ ተደርጓል።',
                                            balance: player.balance
                                        }));
                                    }
                                });
                            } catch (err) {
                                console.error('Refund error:', err);
                            }
                        }
                    });

                    gameState.timeLeft = SELECTION_TIME;
                    broadcast({
                        type: 'timer_update',
                        phase: 'selection',
                        timeLeft: gameState.timeLeft,
                        participantsCount: 0,
                        message: 'በቂ ተጫዋች የለም። ተጨማሪ ተጫዋቾች በመጠባበቅ ላይ...'
                    });
                }
            }
        }
    }, 1000);
}

function stopNumberCalling() {
    if (numberCallInterval) {
        clearInterval(numberCallInterval);
        numberCallInterval = null;
    }
}

async function gameLoop() {
    if (gameState.phase === 'game' || gameState.phase === 'winner') {
        // Double check: if we are in game phase but no numbers are being called, 
        // it might be because the interval didn't start or was cleared.
        if (gameState.phase === 'game' && !numberCallInterval) {
            console.log('--- Restarting number calling for stuck game ---');
            startNumberCalling();
        }
        return;
    }
    
    // Selection phase logic
    if (gameState.phase === 'selection') {
        if (gameState.timeLeft % 5 === 0) syncGameStateToRedis();
        
        if (gameState.timeLeft <= 0) {
            const confirmedCount = getConfirmedPlayersCount();
            if (confirmedCount >= 2) { 
                console.log('--- Starting game phase with', confirmedCount, 'players ---');
                startGamePhase();
                
                setTimeout(() => {
                    if (gameState.phase === 'game') {
                        startNumberCalling();
                    }
                }, 1000);
            } else {
                console.log('--- Not enough players confirmed, refunding and restarting selection ---');
                
                // Refund logic
                gameState.players.forEach(async (player) => {
                    if (player.isCardConfirmed && player.selectedCardId) {
                        try {
                            const stakeAmount = gameState.stakeAmount || 10;
                            await Wallet.adjustBalance(player.userId, stakeAmount, 'add', 'Game cancelled: Not enough players');
                            player.balance += stakeAmount;
                            player.isCardConfirmed = false;
                            player.selectedCardId = null;
                            wss.clients.forEach(client => {
                                if (client.playerId === player.id) {
                                    client.send(JSON.stringify({
                                        type: 'game_cancelled',
                                        message: 'በቂ ተጫዋች የለም። ብርዎ ተመላሽ ተደርጓል።',
                                        balance: player.balance
                                    }));
                                }
                            });
                        } catch (err) {
                            console.error('Refund error:', err);
                        }
                    }
                });

                startSelectionPhase();
            }
        }
    }
}

function getConfirmedPlayersCount() {
    let count = 0;
    gameState.players.forEach(player => {
        if (player.selectedCardId && player.isCardConfirmed) count++;
    });
    return count;
}

wss.on('connection', (ws) => {
    const playerId = ++playerIdCounter;
    const player = {
        id: playerId,
        userId: null,
        username: 'Guest_' + playerId,
        selectedCardId: null,
        isCardConfirmed: false,
        balance: 0
    };
    gameState.players.set(playerId, player);
    
    ws.playerId = playerId;
    
    ws.send(JSON.stringify({
        type: 'init',
        playerId: playerId,
        phase: gameState.phase,
        timeLeft: gameState.timeLeft,
        calledNumbers: gameState.calledNumbers,
        winner: gameState.winner,
        gameId: currentGameId,
        participantsCount: getConfirmedPlayersCount(),
        takenCards: Array.from(gameState.players.values())
            .filter(p => p.isCardConfirmed && p.selectedCardId)
            .map(p => p.selectedCardId)
    }));
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const player = gameState.players.get(playerId);
            
            switch (data.type) {
                case 'auth_telegram':
                    try {
                        const user = await User.findOrCreateByTelegram(
                            data.telegramId,
                            data.username
                        );
                        player.userId = user.id;
                        player.username = user.username;
                        player.balance = parseFloat(user.balance || 0);
                        
                        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            token: token,
                            user: {
                                id: user.id,
                                username: user.username,
                                balance: player.balance
                            }
                        }));
                    } catch (err) {
                        console.error('Auth error:', err);
                        ws.send(JSON.stringify({ type: 'auth_error', error: 'Authentication failed' }));
                    }
                    break;

                case 'auth_token':
                    try {
                        const decoded = jwt.verify(data.token, JWT_SECRET);
                        const user = await User.findById(decoded.userId);
                        
                        if (user) {
                            player.userId = user.id;
                            player.username = user.username;
                            player.balance = parseFloat(user.balance || 0);
                            
                            ws.send(JSON.stringify({
                                type: 'auth_success',
                                user: {
                                    id: user.id,
                                    username: user.username,
                                    balance: player.balance
                                }
                            }));
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
                    }
                    break;

                case 'register':
                    try {
                        const existingUser = await User.findByUsername(data.username);
                        if (existingUser) {
                            ws.send(JSON.stringify({ type: 'register_error', error: 'Username taken' }));
                            break;
                        }
                        
                        const newUser = await User.create(data.username, data.password);
                        player.userId = newUser.id;
                        player.username = newUser.username;
                        player.balance = 0;
                        
                        const token = jwt.sign({ userId: newUser.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'register_success',
                            token: token,
                            user: {
                                id: newUser.id,
                                username: newUser.username,
                                balance: 0
                            }
                        }));
                    } catch (err) {
                        console.error('Register error:', err);
                        ws.send(JSON.stringify({ type: 'register_error', error: 'Registration failed' }));
                    }
                    break;

                case 'login':
                    try {
                        const user = await User.findByUsername(data.username);
                        if (!user || !(await User.verifyPassword(user, data.password))) {
                            ws.send(JSON.stringify({ type: 'login_error', error: 'Invalid credentials' }));
                            break;
                        }
                        
                        player.userId = user.id;
                        player.username = user.username;
                        player.balance = parseFloat(user.balance || 0);
                        await User.updateLastLogin(user.id);
                        
                        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
                        
                        ws.send(JSON.stringify({
                            type: 'login_success',
                            token: token,
                            user: {
                                id: user.id,
                                username: user.username,
                                balance: player.balance
                            }
                        }));
                    } catch (err) {
                        console.error('Login error:', err);
                        ws.send(JSON.stringify({ type: 'login_error', error: 'Login failed' }));
                    }
                    break;
                    
                case 'set_username':
                    if (gameState.players.has(playerId)) {
                        gameState.players.get(playerId).username = data.username;
                    }
                    break;
                    
                case 'select_card':
                    if (gameState.phase === 'selection' && gameState.players.has(playerId)) {
                        // Check if player has at least 10 ETB to select a card
                        const player = gameState.players.get(playerId);
                        if (!player.userId) {
                            ws.send(JSON.stringify({ type: 'error', message: 'እባክዎ መጀመሪያ ይግቡ (Please login)' }));
                            break;
                        }
                        
                        db.query('SELECT balance FROM wallets WHERE user_id = $1', [player.userId])
                            .then(res => {
                                const balance = res.rows.length > 0 ? parseFloat(res.rows[0].balance) : 0;
                                if (balance < 10) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: 'ካርድ ለመምረጥ ቢያንስ 10 ብር ባላንስ ሊኖርዎት ይገባል።'
                                    }));
                                    return;
                                }
                                player.selectedCardId = data.cardId;
                            })
                            .catch(err => console.error('Error checking balance during selection:', err));
                    }
                    break;

                case 'confirm_card':
                    if (gameState.phase === 'selection' && player) {
                        // Double check balance before confirming
                        if (!player.userId) {
                            ws.send(JSON.stringify({ type: 'error', message: 'እባክዎ መጀመሪያ ይግቡ (Please login)' }));
                            break;
                        }

                        db.query('SELECT balance FROM wallets WHERE user_id = $1', [player.userId])
                            .then(async res => {
                                const balance = res.rows.length > 0 ? parseFloat(res.rows[0].balance) : 0;
                                const stakeAmount = 10; // Fixed for now

                                if (balance < stakeAmount) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: 'ካርድ ለማረጋገጥ በቂ ባላንስ የለም።'
                                    }));
                                    return;
                                }

                                const cardIdToConfirm = data.cardId || player.selectedCardId;
                                if (cardIdToConfirm) {
                                    // Check if already taken
                                    const isTaken = Array.from(gameState.players.values())
                                        .some(p => p.isCardConfirmed && p.selectedCardId === cardIdToConfirm);
                                    
                                    if (isTaken) {
                                        ws.send(JSON.stringify({ type: 'error', message: 'ይህ ካርድ ተይዟል!' }));
                                        return;
                                    }

                                    // Deduct stake
                                    const deductionResult = await Wallet.deductBalance(player.userId, stakeAmount, `Stake for game #${currentGameId}`);
                                    if (!deductionResult) {
                                        ws.send(JSON.stringify({ type: 'error', message: 'የሒሳብ ቅነሳ አልተሳካም።' }));
                                        return;
                                    }

                                    player.isCardConfirmed = true;
                                    player.selectedCardId = cardIdToConfirm;
                                    player.balance = balance - stakeAmount;

                                    try {
                                        await Game.addParticipant(currentGameId, player.userId, cardIdToConfirm, stakeAmount);
                                    } catch (err) {
                                        console.error('Error adding participant:', err);
                                    }

                                    ws.send(JSON.stringify({
                                        type: 'card_confirmed',
                                        cardId: cardIdToConfirm,
                                        balance: player.balance
                                    }));

                                    broadcast({
                                        type: 'card_taken',
                                        cardId: cardIdToConfirm
                                    });
                                }
                            })
                            .catch(err => console.error('Error checking balance during confirmation:', err));
                    }
                    break;
                    
                case 'claim_bingo':
                    if (gameState.phase === 'game' && player) {
                        if (player.isCardConfirmed && player.selectedCardId) {
                            // Re-calculate confirmed players to ensure stake is accurate
                            const confirmedPlayersCount = getConfirmedPlayersCount();
                            const winPattern = validateBingo(player.selectedCardId, gameState.calledNumbers);
                            
                            console.log(`Bingo claim from ${player.username} (Card: ${player.selectedCardId}). Pattern found:`, winPattern);
                            
                            if (winPattern) {
                                winPattern.isWin = true;
                                
                                // Calculate prize (80% of pot, 20% fee)
                                const totalPot = confirmedPlayersCount * (gameState.stakeAmount || 10);
                                const prizeAmount = totalPot * 0.8;
                                
                                console.log(`Bingo Validated! User ${player.userId} won ${prizeAmount} ETB (Pot: ${totalPot})`);
                                
                                Wallet.win(player.userId, prizeAmount, gameState.id).then(() => {
                                    startWinnerDisplay({
                                        userId: player.userId,
                                        username: player.username,
                                        cardId: player.selectedCardId,
                                        pattern: winPattern,
                                        prize: prizeAmount
                                    });
                                }).catch(err => {
                                    console.error('Error crediting win prize:', err);
                                    startWinnerDisplay({
                                        userId: player.userId,
                                        username: player.username,
                                        cardId: player.selectedCardId,
                                        pattern: winPattern,
                                        prize: prizeAmount
                                    });
                                });
                            } else {
                                console.log(`Bingo Rejected for ${player.username}. Numbers called: ${gameState.calledNumbers.length}`);
                                ws.send(JSON.stringify({
                                    type: 'bingo_rejected',
                                    error: 'ቢንጎ ትክክል አይደለም'
                                }));
                            }
                        }
                    }
                    break;

                case 'get_balance':
                    if (player.userId) {
                        try {
                            const balance = await Wallet.getBalance(player.userId);
                            player.balance = parseFloat(balance);
                            ws.send(JSON.stringify({
                                type: 'balance_update',
                                balance: player.balance
                            }));
                        } catch (err) {
                            console.error('Balance error:', err);
                        }
                    }
                    break;

                case 'get_transactions':
                    if (player.userId) {
                        try {
                            const transactions = await Wallet.getTransactionHistory(player.userId);
                            ws.send(JSON.stringify({
                                type: 'transactions',
                                transactions: transactions
                            }));
                        } catch (err) {
                            console.error('Transactions error:', err);
                        }
                    }
                    break;

                case 'get_game_history':
                    if (player.userId) {
                        try {
                            const history = await Game.getUserGameHistory(player.userId);
                            const stats = await Game.getUserStats(player.userId);
                            ws.send(JSON.stringify({
                                type: 'game_history',
                                history: history,
                                stats: stats
                            }));
                        } catch (err) {
                            console.error('Game history error:', err);
                        }
                    }
                    break;

                case 'deposit':
                    if (player.userId && data.amount > 0) {
                        try {
                            const result = await Wallet.deposit(player.userId, data.amount);
                            if (result.success) {
                                player.balance = result.balance;
                                ws.send(JSON.stringify({
                                    type: 'deposit_success',
                                    balance: result.balance
                                }));
                            }
                        } catch (err) {
                            ws.send(JSON.stringify({ type: 'deposit_error', error: 'Deposit failed' }));
                        }
                    }
                    break;
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });
    
    ws.on('close', () => {
        gameState.players.delete(playerId);
    });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const existingUser = await User.findByUsername(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already taken' });
        }
        
        const user = await User.create(username, password);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            token, 
            user: { id: user.id, username: user.username, balance: 0 } 
        });
    } catch (err) {
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findByUsername(username);
        if (!user || !(await User.verifyPassword(user, password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        await User.updateLastLogin(user.id);
        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({ 
            token, 
            user: { id: user.id, username: user.username, balance: user.balance } 
        });
    } catch (err) {
        res.status(500).json({ error: 'Login failed' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { userId, phoneNumber } = req.body;
        
        if (!userId || !phoneNumber) {
            return res.status(400).json({ success: false, message: 'userId and phoneNumber are required' });
        }

        const telegramId = parseInt(userId) || 0;
        
        const existingUser = await db.query(
            'SELECT * FROM users WHERE telegram_id = $1',
            [telegramId]
        );

        if (existingUser.rows.length > 0) {
            return res.json({ success: false, message: 'User already registered.' });
        }

        const username = 'Player_' + telegramId;
        const userResult = await db.query(
            `INSERT INTO users (telegram_id, username, phone_number, is_registered) 
             VALUES ($1, $2, $3, TRUE) RETURNING id`,
            [telegramId, username, phoneNumber]
        );

        const newUserId = userResult.rows[0].id;
        
        await db.query(
            `INSERT INTO wallets (user_id, balance, currency) 
             VALUES ($1, 10.00, 'ETB')`,
            [newUserId]
        );

        res.json({ success: true, message: 'Registration successful. 10 ETB welcome bonus added.' });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

app.get('/api/check-registration/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const tgId = parseInt(telegramId) || 0;
        
        const result = await db.query(
            'SELECT id, is_registered FROM users WHERE telegram_id = $1',
            [tgId]
        );

        if (result.rows.length === 0) {
            return res.json({ registered: false });
        }

        res.json({ registered: result.rows[0].is_registered || false });
    } catch (err) {
        console.error('Check registration error:', err);
        res.json({ registered: false });
    }
});

app.get('/api/profile/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const tgId = parseInt(telegramId) || 0;
        
        const userResult = await db.query(
            `SELECT u.id, u.username, u.telegram_id, u.phone_number, u.is_registered, u.created_at, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.telegram_id = $1`,
            [tgId]
        );

        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'User not found' });
        }

        const user = userResult.rows[0];
        
        const gamesResult = await db.query(
            `SELECT COUNT(*) as total_games FROM game_participants WHERE user_id = $1`,
            [user.id]
        );
        
        const winsResult = await db.query(
            `SELECT COUNT(*) as wins FROM game_participants WHERE user_id = $1 AND is_winner = true`,
            [user.id]
        );

        res.json({
            success: true,
            profile: {
                username: user.username || 'Player',
                telegramId: user.telegram_id,
                phoneNumber: user.phone_number || '---',
                balance: parseFloat(user.balance) || 0,
                totalGames: parseInt(gamesResult.rows[0].total_games) || 0,
                wins: parseInt(winsResult.rows[0].wins) || 0,
                memberSince: user.created_at
            }
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ success: false, message: 'Failed to load profile' });
    }
});

app.get('/api/check-admin/:telegramId', async (req, res) => {
    try {
        const { telegramId } = req.params;
        const result = await db.query(
            'SELECT * FROM admin_users WHERE telegram_id = $1 AND is_active = true',
            [telegramId]
        );
        const isAdmin = result.rows.length > 0 || telegramId === process.env.ADMIN_CHAT_ID;
        res.json({ isAdmin });
    } catch (err) {
        console.error('Check admin error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const tgId = parseInt(userId);
        
        const result = await db.query(
            'SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [tgId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ balance: 0 });
        }
        
        res.json({ balance: parseFloat(result.rows[0].balance).toFixed(2) });
    } catch (err) {
        console.error('Wallet balance API error:', err);
        res.status(500).json({ error: 'Failed to fetch balance' });
    }
});

app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const tgId = parseInt(userId);
        
        const userResult = await db.query('SELECT id FROM users WHERE telegram_id = $1', [tgId]);
        if (userResult.rows.length === 0) {
            return res.json({ transactions: [] });
        }
        
        const dbUserId = userResult.rows[0].id;
        
        // Fetch combined history of deposits and withdrawals
        const deposits = await db.query(
            "SELECT 'deposit' as type, amount, status, created_at FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10",
            [dbUserId]
        );
        
        const withdrawals = await db.query(
            "SELECT 'withdrawal' as type, amount, status, created_at FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10",
            [dbUserId]
        );
        
        const transactions = [...deposits.rows, ...withdrawals.rows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 10);
            
        res.json({ transactions });
    } catch (err) {
        console.error('Transactions API error:', err);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.get('/api/wallet-info/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const telegramId = parseInt(userId) || 0;
        
        const result = await db.query(
            `SELECT u.id, u.is_registered, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.telegram_id = $1`,
            [telegramId]
        );

        if (result.rows.length === 0) {
            return res.json({ 
                balance: 0, 
                is_registered: false,
                stake: 10
            });
        }

        const user = result.rows[0];
        res.json({ 
            balance: parseFloat(user.balance) || 0, 
            is_registered: user.is_registered || false,
            stake: 10
        });
    } catch (err) {
        console.error('Wallet info error:', err);
        res.status(500).json({ balance: 0, is_registered: false, stake: 10 });
    }
});

app.post('/api/bet', async (req, res) => {
    try {
        const { userId, stakeAmount } = req.body;
        
        if (!userId || !stakeAmount) {
            return res.status(400).json({ success: false, message: 'userId and stakeAmount are required' });
        }

        const telegramId = parseInt(userId) || 0;

        const userResult = await db.query(
            'SELECT u.id, w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1',
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            return res.json({ success: false, message: 'User not found' });
        }

        const internalUserId = userResult.rows[0].id;
        const currentBalance = parseFloat(userResult.rows[0].balance) || 0;
        
        if (currentBalance < stakeAmount) {
            return res.json({ success: false, message: 'Insufficient balance' });
        }

        const newBalance = currentBalance - stakeAmount;
        
        await db.query(
            'UPDATE wallets SET balance = $1 WHERE user_id = $2',
            [newBalance, internalUserId]
        );

        res.json({ success: true, balance: newBalance });
    } catch (err) {
        console.error('Bet error:', err);
        res.status(500).json({ success: false, message: 'Bet failed' });
    }
});

// ================== Admin API Routes ==================

// Admin Stats
// --- Telebirr Webhook Logic ---
app.get('/health', (req, res) => res.send('OK'));

app.post('/telebirr-webhook', async (req, res) => {
    const { secret_key, message, sender } = req.body;
    
    console.log('Incoming Telebirr Webhook:', JSON.stringify(req.body));

    if (secret_key !== process.env.TELE_SECRET) {
        console.error('Invalid Telebirr secret key');
        return res.status(403).json({ error: 'Unauthorized' });
    }

    if (sender !== '127' && sender !== '0975118009' && sender !== '0989304034' && sender !== '0929878000' && sender !== '{{from}}' && sender !== '{from}') {
        console.log(`Ignoring message from sender: ${sender}`);
        return res.status(200).json({ status: 'ignored', reason: 'invalid_sender' });
    }

    const amharicKeyword = 'ተቀብለዋል';
    const englishKeyword = 'received';
    
    if (!message || (!message.includes(amharicKeyword) && !message.toLowerCase().includes(englishKeyword))) {
        console.log('Message does not contain the required keywords "ተቀብለዋል" or "received"');
        return res.status(200).json({ status: 'ignored', reason: 'missing_keyword' });
    }

    // Regex patterns for Transaction ID and Amount based on Amharic and English formats
    // Amharic: ቁጥርዎ ABC123XYZ ... 100.00 ብር
    // English: ... transaction ABC123XYZ ... 100.00 ETB
    const txIdPattern = /(?:ቁጥርዎ|receipt\/|ቁጥርዎ\s*|transaction\s*|id[:\s]*|ref[:\s]*)\s*([A-Z0-9]{8,15})/i;
    const amountPattern = /([\d,.]+)\s*(?:ብር|ETB|birr)/i;

    const txIdMatch = message.match(txIdPattern);
    const amountMatch = message.match(amountPattern);

    if (!txIdMatch || !amountMatch) {
        console.error('Failed to extract data from message:', message);
        return res.status(422).json({ error: 'Data extraction failed' });
    }

    const transactionId = txIdMatch[1].trim().toUpperCase();
    const amount = parseFloat(amountMatch[1].replace(/,/g, ''));

    // ✅ VALIDATION: Minimum deposit amount 20 ETB
    if (amount < 20) {
        console.log(`Rejecting deposit: Amount ${amount} is below minimum 20 ETB.`);
        return res.status(200).json({ status: 'ignored', reason: 'amount_too_low' });
    }

    console.log(`Extracted Telebirr data: ID=${transactionId}, Amount=${amount}`);

    try {
        // Step 1: Normalize ID for comparison
        const normalizedTxId = transactionId.replace(/[^A-Z0-9]/gi, '').toUpperCase();

        // Step 2: Prevent duplicate confirmations
        const existingRecord = await db.query(
            `SELECT * FROM deposits 
             WHERE (
                confirmation_code = $1 
                OR UPPER(REGEXP_REPLACE(confirmation_code, '[^A-Z0-9]', '', 'g')) = $2
             )`,
            [transactionId, normalizedTxId]
        );

        if (existingRecord.rows.length > 0) {
            const existing = existingRecord.rows[0];
            
            if (existing.status === 'confirmed') {
                console.log(`Transaction ${transactionId} already confirmed.`);
                return res.status(200).json({ success: true, message: 'Already processed' });
            }

            if (existing.status === 'pending') {
        // User already sent the code, now we have the SMS - Approve instantly!
                await db.query('BEGIN');
                
                // Calculate bonus based on deposit amount
                let bonus = 0;
                if (amount >= 500) bonus = 50;
                else if (amount >= 200) bonus = 20;
                else if (amount >= 100) bonus = 10;
                else if (amount >= 50) bonus = 5;
                
                const totalCredit = amount + bonus;
                
                await db.query(
                    'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
                    [totalCredit, existing.user_id]
                );
                await db.query(
                    'UPDATE deposits SET status = $1, confirmed_at = NOW() WHERE id = $2',
                    ['confirmed', existing.id]
                );
                await db.query('COMMIT');

                const userInfo = await db.query('SELECT telegram_id FROM users WHERE id = $1', [existing.user_id]);
                if (userInfo.rows.length > 0) {
                    const userLang = 'am'; // Defaulting to Amharic for now, but could be dynamic
                    let successMsg = '';
                    if (userLang === 'am') {
                        successMsg = `✅ ዲፖዚት ተረጋግጧል! ${amount} ብር ወደ ሒሳብዎ ተጨምሯል (Transaction: ${transactionId})`;
                        if (bonus > 0) successMsg += `\n🎁 የ ${bonus} ብር ተጨማሪ ቦነስ አግኝተዋል!`;
                    } else {
                        successMsg = `✅ Deposit Confirmed! ${amount} ETB added to your wallet (Transaction: ${transactionId})`;
                        if (bonus > 0) successMsg += `\n🎁 You received an additional ${bonus} ETB bonus!`;
                    }
                    bot.sendMessage(userInfo.rows[0].telegram_id, successMsg);
                }
                
                console.log(`Deposit ${existing.id} auto-confirmed via late SMS arrival with bonus: ${bonus}`);
                return res.status(200).json({ success: true });
            }
        }

        // Step 3: No matching record or not pending - save as unmatched
        console.log(`Transaction ${transactionId} not matched yet. Saving as unmatched.`);
        await db.query(
            'INSERT INTO deposits (user_id, amount, payment_method, confirmation_code, status, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
            [null, amount, 'telebirr', transactionId, 'unmatched']
        );

        res.status(200).json({ success: true });
    } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        console.error('Telebirr webhook database error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin Broadcast Endpoint
app.post('/api/admin/broadcast', upload.single('image'), async (req, res) => {
    const { message } = req.body;
    const imageFile = req.file;
    
    if (!message && !imageFile) return res.status(400).json({ error: 'Message or Image is required' });

    try {
        const users = await db.query('SELECT telegram_id FROM users WHERE is_registered = true');
        let successCount = 0;
        let failCount = 0;

        for (const user of users.rows) {
            try {
                if (imageFile) {
                    await bot.sendPhoto(user.telegram_id, imageFile.path, { caption: message });
                } else {
                    await bot.sendMessage(user.telegram_id, message);
                }
                successCount++;
            } catch (err) {
                console.error(`Failed to send broadcast to ${user.telegram_id}:`, err.message);
                failCount++;
            }
        }

        // Clean up uploaded file
        if (imageFile) {
            fs.unlink(imageFile.path, (err) => {
                if (err) console.error('Failed to delete temp file:', err);
            });
        }

        res.json({ success: true, successCount, failCount });
    } catch (error) {
        console.error('Broadcast error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin Advanced Stats
app.get('/api/admin/advanced-stats', async (req, res) => {
    try {
        const stats = {
            daily: { income: 0, expense: 0, games: 0 },
            weekly: { income: 0, expense: 0, games: 0 },
            monthly: { income: 0, expense: 0, games: 0 }
        };

        const intervals = ['day', 'week', 'month'];
        
        for (const interval of intervals) {
            const key = interval === 'day' ? 'daily' : interval === 'week' ? 'weekly' : 'monthly';
            
            // Income (Confirmed Deposits)
            const incomeRes = await db.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE status = 'confirmed' AND confirmed_at > NOW() - INTERVAL '1 ${interval}'`
            );
            stats[key].income = parseFloat(incomeRes.rows[0].total || 0);

            // Expense (Total payouts for won games)
            const expenseRes = await db.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'win' AND created_at > NOW() - INTERVAL '1 ${interval}'`
            );
            stats[key].expense = parseFloat(expenseRes.rows[0].total || 0);

            // Games with at least one participant
            const gamesRes = await db.query(
                `SELECT COUNT(DISTINCT g.id) as count 
                 FROM games g 
                 JOIN game_participants gp ON g.id = gp.game_id 
                 WHERE g.started_at > NOW() - INTERVAL '1 ${interval}'`
            );
            stats[key].games = parseInt(gamesRes.rows[0].count || 0);
        }

        res.json(stats);
    } catch (error) {
        console.error('Advanced stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalUsers = await db.query('SELECT COUNT(*) as count FROM users');
        const pendingDeposits = await db.query('SELECT COUNT(*) as count FROM deposits WHERE status = $1', ['pending']);
        const pendingWithdrawals = await db.query('SELECT COUNT(*) as count FROM withdrawals WHERE status = $1', ['pending']);
        const todayGames = await db.query(
            "SELECT COUNT(*) as count FROM games WHERE started_at >= CURRENT_DATE"
        );
        
        res.json({
            totalUsers: parseInt(totalUsers.rows[0].count),
            pendingDeposits: parseInt(pendingDeposits.rows[0].count),
            pendingWithdrawals: parseInt(pendingWithdrawals.rows[0].count),
            todayGames: parseInt(todayGames.rows[0].count)
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Get all deposits
app.get('/api/admin/deposits', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT d.*, u.username 
            FROM deposits d 
            JOIN users u ON d.user_id = u.id 
            ORDER BY d.created_at DESC 
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin deposits error:', err);
        res.status(500).json({ error: 'Failed to fetch deposits' });
    }
});

// Get all withdrawals
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT w.*, u.username 
            FROM withdrawals w 
            JOIN users u ON w.user_id = u.id 
            ORDER BY w.created_at DESC 
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin withdrawals error:', err);
        res.status(500).json({ error: 'Failed to fetch withdrawals' });
    }
});

// Get all users
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT u.id, u.username, u.phone_number, u.created_at, w.balance 
            FROM users u 
            LEFT JOIN wallets w ON u.id = w.user_id 
            ORDER BY u.created_at DESC 
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get transactions
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT t.*, u.username 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            ORDER BY t.created_at DESC 
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Admin transactions error:', err);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// Approve deposit via API
    // Search user by phone, telegram_id, or user_id
    app.get('/api/admin/users/search', async (req, res) => {
        const { query } = req.query;
        if (!query) return res.status(400).json({ error: 'Search query is required' });

        try {
            const result = await pool.query(
                `SELECT u.id, u.username, u.phone_number, u.telegram_id, w.balance 
                 FROM users u 
                 LEFT JOIN wallets w ON u.id = w.user_id 
                 WHERE u.phone_number LIKE $1 
                    OR u.telegram_id::text LIKE $1 
                    OR u.id::text = $2`,
                [`%${query}%`, isNaN(parseInt(query)) ? '-1' : query]
            );
            res.json(result.rows);
        } catch (err) {
            console.error('Search error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

// Admin: Get all users
app.get('/api/admin/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, u.phone_number, w.balance 
            FROM users u 
            JOIN wallets w ON u.id = w.user_id 
            ORDER BY u.id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

    // Admin: Bulk adjust balance for all users
    app.post('/api/admin/users/bulk-adjust-balance', async (req, res) => {
        const { amount, action, reason } = req.body;

        if (!amount || isNaN(amount) || amount < 0) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        const description = reason || `Bulk admin balance adjustment (${action})`;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            if (action === 'set') {
                // Set all wallets to specific amount
                await client.query(`
                    UPDATE wallets 
                    SET balance = $1,
                    updated_at = NOW()
                `, [amount]);
            } else {
                const adjustAmount = action === 'subtract' ? -Math.abs(amount) : Math.abs(amount);
                // Update all wallets
                await client.query(`
                    UPDATE wallets 
                    SET balance = CASE 
                        WHEN balance + $1 < 0 THEN 0 
                        ELSE balance + $1 
                    END,
                    updated_at = NOW()
                `, [adjustAmount]);
            }

            // Record transaction for all users
            await client.query(`
                INSERT INTO transactions (user_id, type, amount, description)
                SELECT user_id, $1, $2, $3 FROM wallets
            `, [action === 'set' ? 'admin_set' : (action === 'add' ? 'admin_add' : 'admin_subtract'), Math.abs(amount), description]);
            
            await client.query('COMMIT');

            res.json({ success: true, message: `Successfully adjusted balance for all users` });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Bulk balance adjust error:', err);
            res.status(500).json({ error: 'Server error' });
        } finally {
            client.release();
        }
    });

    // Admin: Adjust user balance
    app.post('/api/admin/users/:id/adjust-balance', async (req, res) => {
    const userId = req.params.id;
    const { amount, action, reason } = req.body; // action: 'add' or 'subtract'

    if (!amount || isNaN(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    const adjustAmount = action === 'subtract' ? -Math.abs(amount) : Math.abs(amount);
    const description = reason || `Admin balance adjustment (${action})`;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
        if (walletRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User wallet not found' });
        }

        const newBalance = parseFloat(walletRes.rows[0].balance) + adjustAmount;
        if (newBalance < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient balance for subtraction' });
        }

        await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE user_id = $2', [newBalance, userId]);
        await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', 
            [userId, action === 'add' ? 'admin_add' : 'admin_subtract', Math.abs(amount), description]);
        
        await client.query('COMMIT');

        // Notify user via Bot if possible
        const userRes = await client.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length > 0 && userRes.rows[0].telegram_id) {
            const msg = action === 'add' ? 
                `🎁 አድሚኑ ${amount} ብር ወደ ሒሳብዎ ጨምሯል!\nአዲስ ባላንስ: ${newBalance.toFixed(2)} ብር` :
                `⚠️ አድሚኑ ${amount} ብር ከሒሳብዎ ቀንሷል።\nአዲስ ባላንስ: ${newBalance.toFixed(2)} ብር`;
            bot.sendMessage(userRes.rows[0].telegram_id, msg).catch(e => console.error('Notify fail:', e.message));
        }

        res.json({ success: true, newBalance });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Balance adjust error:', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/deposits/:id/approve', async (req, res) => {
    console.log(`POST /api/admin/deposits/${req.params.id}/approve reached`);
    try {
        const depositId = parseInt(req.params.id);
        if (isNaN(depositId)) {
            return res.status(400).json({ error: 'Invalid deposit ID' });
        }
        console.log(`Approving deposit ID: ${depositId}`);
        
        const deposit = await db.query(
            'SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1',
            [depositId]
        );
        
        if (deposit.rows.length === 0) {
            console.log(`Deposit ${depositId} not found`);
            return res.status(404).json({ error: 'Deposit not found' });
        }
        
        const d = deposit.rows[0];
        
        if (d.status !== 'pending') {
            console.log(`Deposit ${depositId} already processed (status: ${d.status})`);
            return res.status(400).json({ error: 'Deposit already processed' });
        }
        
        // Start a transaction to ensure atomicity
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Calculate bonus based on deposit amount
            let bonus = 0;
            if (d.amount >= 500) bonus = 50;
            else if (d.amount >= 200) bonus = 20;
            else if (d.amount >= 100) bonus = 10;
            else if (d.amount >= 50) bonus = 5;
            
            const totalCredit = parseFloat(d.amount) + bonus;
            
            await client.query('UPDATE deposits SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', depositId]);
            
            await client.query(
                'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2',
                [totalCredit, d.user_id]
            );
            
            await client.query(
                'INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
                [d.user_id, 'deposit', totalCredit, `Deposit via ${d.payment_method}${bonus > 0 ? ' + Bonus' : ''}`]
            );
            
            await client.query('COMMIT');
            console.log(`Successfully approved deposit ${depositId} with bonus: ${bonus}`);
            
            if (d.user_telegram_id && bot) {
                let successMsg = `✅ ዲፖዚትዎ ተረጋግጧል!\n\n💵 ${d.amount} ብር ወደ ሒሳብዎ ተጨምሯል።`;
                if (bonus > 0) successMsg += `\n🎁 የ ${bonus} ብር ተጨማሪ ቦነስ አግኝተዋል!`;
                bot.sendMessage(d.user_telegram_id, successMsg).catch(err => console.error('Telegram notify error:', err));
            }
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Approve deposit error:', err);
        res.status(500).json({ error: 'Failed to approve deposit: ' + err.message });
    }
});

// Reject deposit via API
app.post('/api/admin/deposits/:id/reject', async (req, res) => {
    try {
        const depositId = parseInt(req.params.id);
        console.log(`Rejecting deposit ID: ${depositId}`);
        
        const deposit = await db.query(
            'SELECT d.*, u.telegram_id as user_telegram_id FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.id = $1',
            [depositId]
        );
        
        if (deposit.rows.length === 0) {
            console.log(`Deposit ${depositId} not found`);
            return res.status(404).json({ error: 'Deposit not found' });
        }
        
        const d = deposit.rows[0];
        
        if (d.status !== 'pending') {
            console.log(`Deposit ${depositId} already processed (status: ${d.status})`);
            return res.status(400).json({ error: 'Deposit already processed' });
        }
        
        await db.query('UPDATE deposits SET status = $1 WHERE id = $2', ['rejected', depositId]);
        console.log(`Successfully rejected deposit ${depositId}`);
        
        if (d.user_telegram_id && bot) {
            bot.sendMessage(d.user_telegram_id, 
                `❌ ዲፖዚትዎ ተቀባይነት አላገኘም።\n\nእባክዎ ትክክለኛ መረጃ ይላኩ ወይም ድጋሚ ይሞክሩ።`
            ).catch(err => console.error('Telegram notify error:', err));
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Reject deposit error:', err);
        res.status(500).json({ error: 'Failed to reject deposit: ' + err.message });
    }
});

// Approve withdrawal via API
app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
    try {
        const withdrawalId = parseInt(req.params.id);
        console.log(`Approving withdrawal ID: ${withdrawalId}`);
        
        const withdrawal = await db.query(
            'SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1',
            [withdrawalId]
        );
        
        if (withdrawal.rows.length === 0) {
            console.log(`Withdrawal ${withdrawalId} not found`);
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        const w = withdrawal.rows[0];
        
        if (w.status !== 'pending') {
            console.log(`Withdrawal ${withdrawalId} already processed (status: ${w.status})`);
            return res.status(400).json({ error: 'Withdrawal already processed' });
        }
        
        const balanceCheck = await db.query(
            'SELECT balance FROM wallets WHERE user_id = $1',
            [w.user_id]
        );
        
        if (parseFloat(balanceCheck.rows[0]?.balance || 0) < w.amount) {
            console.log(`Insufficient balance for withdrawal ${withdrawalId}`);
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            
            await client.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['approved', withdrawalId]);
            
            await client.query(
                'UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2',
                [w.amount, w.user_id]
            );
            
            await client.query(
                'INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
                [w.user_id, 'withdrawal', w.amount, `Withdrawal to ${w.phone_number}`]
            );
            
            await client.query('COMMIT');
            console.log(`Successfully approved withdrawal ${withdrawalId}`);
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        
        if (w.user_telegram_id && bot) {
            bot.sendMessage(w.user_telegram_id, 
                `✅ የገንዘብ ማውጣት ጥያቄዎ ተፈቅዷል!\n\n💵 ${w.amount} ብር ወደ ${w.phone_number} ተልኳል።`
            ).catch(err => console.error('Telegram notify error:', err));
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Approve withdrawal error:', err);
        res.status(500).json({ error: 'Failed to approve withdrawal: ' + err.message });
    }
});

// Telebirr Webhook Integration
app.post('/telebirr-webhook', async (req, res) => {
    try {
        // Extract raw string from req.body.message
        const rawData = req.body.message;
        console.log("Raw telebirr data received:", rawData);

        if (!rawData) {
            console.error("Webhook Error: No data received");
            return res.status(400).send("No data received");
        }

        // Use .split('|') to separate the string into three parts
        const parts = rawData.split('|');
        if (parts.length < 3) {
            console.error("Webhook Error: Invalid data format", rawData);
            return res.status(400).send("Invalid data format");
        }

        const messageText = parts[0];   // The Telebirr SMS text
        const sender = parts[1];        // The sender phone number
        const secretKey = parts[2];     // Secret key

        // Security: Verify that the secret key matches "85Ethiopia@"
        if (secretKey !== "85Ethiopia@") {
            console.error("Webhook Security Error: Invalid Secret Key!");
            return res.status(401).send("Invalid Secret Key");
        }

        // Data Extraction (Regex)
        // Extract the Amount using: /([\d,.]+)\s*ብር/
        const amountMatch = messageText.match(/([\d,.]+)\s*ብር/);
        // Extract the Transaction ID using: /ቁጥርዎ\s*([A-Z0-9]+)/
        const idMatch = messageText.match(/ቁጥርዎ\s*([A-Z0-9]+)/);

        if (amountMatch && idMatch) {
            const amount = parseFloat(amountMatch[1].replace(/,/g, ''));
            const transactionId = idMatch[1];
            console.log(`Webhook Debug: Extracted Amount=${amount}, TransactionID=${transactionId} from sender ${sender}`);

            // Database Update
            // Find a 'pending' deposit with the extracted Transaction ID
            const depositCheck = await db.query(
                'SELECT d.*, u.telegram_id as user_telegram_id, u.username FROM deposits d JOIN users u ON d.user_id = u.id WHERE d.transaction_id = $1 AND d.status = $2',
                [transactionId, 'pending']
            );

            if (depositCheck.rows.length > 0) {
                const d = depositCheck.rows[0];
                
                const client = await db.db.db.pool.connect();
                try {
                    await client.query('BEGIN');
                    
                    // Update status to 'confirmed' (mapped from 'completed' in user request to match existing schema status)
                    await client.query('UPDATE deposits SET status = $1, confirmed_at = NOW() WHERE id = $2', ['confirmed', d.id]);
                    
                    // Add the extracted Amount to the user's balance
                    await client.query('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2', [amount, d.user_id]);
                    
                    // Record transaction
                    await client.query('INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, $2, $3, $4)', 
                        [d.user_id, 'deposit', amount, `Automated Telebirr Deposit (ID: ${transactionId})`]);
                    
                    await client.query('COMMIT');
                    console.log(`Webhook Success: Processed deposit for ${d.username}, Amount: ${amount}`);

                    // Admin Alert: Send a Telegram message to Admin
                    if (bot && ADMIN_CHAT_ID) {
                        bot.sendMessage(ADMIN_CHAT_ID, 
                            `🔔 <b>አዲስ አውቶማቲክ ዲፖዚት!</b>\n\n` +
                            `👤 ተጠቃሚ: ${d.username}\n` +
                            `💵 መጠን: ${amount} ETB\n` +
                            `🆔 ትራንዛክሽን: ${transactionId}\n` +
                            `✅ በራስ-ሰር ተረጋግጧል።`,
                            { parse_mode: 'HTML' }
                        ).catch(err => console.error('Admin notify error:', err));
                    }

                    // Notify User
                    if (d.user_telegram_id && bot) {
                        bot.sendMessage(d.user_telegram_id, `✅ የቴሌብር ክፍያዎ በራስ-ሰር ተረጋግጧል!\n\n💵 ${amount} ብር ወደ ሒሳብዎ ተጨምሯል።`).catch(err => console.error('User notify error:', err));
                    }

                    return res.status(200).send("Deposit Processed Successfully");
                } catch (e) {
                    await client.query('ROLLBACK');
                    console.error("Webhook Database Transaction Error:", e);
                    throw e;
                } finally {
                    client.release();
                }
            } else {
                console.log(`Webhook Info: No pending deposit found for transaction ID: ${transactionId}`);
                return res.status(200).send("No matching pending deposit found");
            }
        } else {
            console.error("Webhook Error: Could not extract data from text:", messageText);
            return res.status(400).send("Data extraction failed");
        }
    } catch (error) {
        console.error("Webhook Internal Error:", error);
        res.status(500).send("Internal Server Error");
    }
});

// Reject withdrawal via API
app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
    try {
        const withdrawalId = parseInt(req.params.id);
        console.log(`Rejecting withdrawal ID: ${withdrawalId}`);
        
        const withdrawal = await db.query(
            'SELECT w.*, u.telegram_id as user_telegram_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.id = $1',
            [withdrawalId]
        );
        
        if (withdrawal.rows.length === 0) {
            console.log(`Withdrawal ${withdrawalId} not found`);
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        const w = withdrawal.rows[0];
        
        if (w.status !== 'pending') {
            console.log(`Withdrawal ${withdrawalId} already processed (status: ${w.status})`);
            return res.status(400).json({ error: 'Withdrawal already processed' });
        }
        
        await db.query('UPDATE withdrawals SET status = $1, processed_at = NOW() WHERE id = $2', ['rejected', withdrawalId]);
        console.log(`Successfully rejected withdrawal ${withdrawalId}`);
        
        if (w.user_telegram_id && bot) {
            bot.sendMessage(w.user_telegram_id, 
                `❌ የገንዘብ ማውጣት ጥያቄዎ ተቀባይነት አላገኘም።\n\nለበለጠ መረጃ እባክዎ ያግኙን።`
            ).catch(err => console.error('Telegram notify error:', err));
        }
        
        res.json({ success: true });
    } catch (err) {
        console.error('Reject withdrawal error:', err);
        res.status(500).json({ error: 'Failed to reject withdrawal: ' + err.message });
    }
});

// ================== End Admin API Routes ==================

const PORT = process.env.PORT || 5000;

async function startServer() {
    try {
        await db.initializeDatabase();
        console.log('Database initialized');
        
        // Load game state from Redis on startup if possible
        await loadGameStateFromRedis();
        
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT}`);
            console.log('WebSocket server ready');
            
            initializeMasterNumbers();
            startSelectionPhase();
            
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        
        // Fallback to start server without database connection logic
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port ${PORT} (without database)`);
            console.log('WebSocket server ready');
            
            initializeMasterNumbers();
            startSelectionPhase();
            
        });
    }
}

startServer();
