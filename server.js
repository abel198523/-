require('dotenv').config();

// Fix: Ensure DATABASE_URL is available by falling back to EXTERNAL_DATABASE_URL
if (!process.env.DATABASE_URL && process.env.EXTERNAL_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.EXTERNAL_DATABASE_URL;
}

const express = require('express');
const http = require('http');
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

const pool = db.pool;

const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const app = express();

const MAINTENANCE_MODE = false;

app.use((req, res, next) => {
    if (MAINTENANCE_MODE) {
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

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDER_SERVER_URL = process.env.RENDER_SERVER_URL;

let MINI_APP_URL = process.env.MINI_APP_URL;

if (!MINI_APP_URL) {
    if (process.env.REPLIT_DOMAINS && typeof process.env.REPLIT_DOMAINS === 'string') {
        MINI_APP_URL = `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`;
    } else if (process.env.RENDER_EXTERNAL_URL) {
        MINI_APP_URL = process.env.RENDER_EXTERNAL_URL;
    } else if (process.env.RENDER_SERVER_URL) {
        MINI_APP_URL = process.env.RENDER_SERVER_URL;
    } else if (RENDER_SERVER_URL) {
        MINI_APP_URL = RENDER_SERVER_URL;
    }
}

const PORT = process.env.PORT || 5000;

if (MINI_APP_URL && MINI_APP_URL.endsWith('/')) {
    MINI_APP_URL = MINI_APP_URL.slice(0, -1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: {
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
        console.warn("Polling conflict detected.");
    } else {
        console.error("Polling error:", error.code, error.message);
    }
});

bot.deleteWebHook({ drop_pending_updates: true }).then(() => {
    console.log("Webhook deleted, starting polling...");
}).catch((err) => {
    console.warn("Failed to delete webhook:", err.message);
});

bot.getMe().then((botInfo) => {
    console.log("Bot running in Polling mode.");
}).catch((err) => {
    console.error("Failed to get bot info:", err.message);
});

const userStates = new Map();
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

function getMainKeyboard(telegramId) {
    let currentUrl = MINI_APP_URL || '';
    if (!currentUrl) {
        if (process.env.REPLIT_DOMAINS) {
            currentUrl = `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`;
        } else if (process.env.RENDER_EXTERNAL_URL) {
            currentUrl = process.env.RENDER_EXTERNAL_URL;
        }
    }
    if (currentUrl.endsWith('/')) {
        currentUrl = currentUrl.slice(0, -1);
    }
    const miniAppUrlWithId = `${currentUrl}${currentUrl.includes('?') ? '&' : '?'}tg_id=${telegramId}`;
    return {
        keyboard: [
            [{ text: "▶️ Play", web_app: { url: String(miniAppUrlWithId) } }],
            [{ text: "💰 Check Balance" }, { text: "🔗 Referral Link" }],
            [{ text: "💳 Deposit" }, { text: "💸 Withdraw" }]
        ],
        resize_keyboard: true
    };
}

async function notifyAdmin(message, options = {}) {
    const finalOptions = { parse_mode: 'HTML', ...options };
    if (ADMIN_CHAT_ID) {
        try {
            await bot.sendMessage(ADMIN_CHAT_ID, message, finalOptions);
        } catch (err) {
            console.error('Failed to notify admin:', err.message);
        }
    }
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

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const referralCode = match ? match[1] : null;

    try {
        const result = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId.toString()]);
        const isRegistered = result.rows.length > 0;

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
                    keyboard: [[{ text: "📱 Register", request_contact: true }]],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
        }
    } catch (err) {
        console.error('[DEBUG] Global /start Error:', err);
    }
});

bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const contact = msg.contact;
    const senderId = msg.from.id;
    const phoneNumber = contact.phone_number;
    
    try {
        const existingUser = await db.query('SELECT id FROM users WHERE telegram_id = $1', [senderId.toString()]);
        if (existingUser.rows.length > 0) {
            bot.sendMessage(chatId, "እርስዎ ቀድሞ ተመዝግበዋል! 'Play' ን ይጫኑ።", {
                reply_markup: getMainKeyboard(senderId)
            });
            return;
        }

        const state = userStates.get(senderId);
        const referrerId = (state?.action === 'register') ? state.referredBy : null;
        const username = msg.from.username || `Player_${senderId}`;
        
        const userResult = await db.query(
            'INSERT INTO users (telegram_id, username, phone_number, is_registered) VALUES ($1, $2, $3, $4) RETURNING id',
            [senderId.toString(), username, phoneNumber, true]
        );
        const userId = userResult.rows[0].id;

        await db.query('INSERT INTO wallets (user_id, balance) VALUES ($1, $2)', [userId, 0.00]);

        if (referrerId) {
            const bonusAmount = 2.00;
            const referrerLookup = await db.query('SELECT id FROM users WHERE telegram_id = $1', [referrerId.toString()]);
            if (referrerLookup.rows.length > 0) {
                const referrerInternalId = referrerLookup.rows[0].id;
                await db.query('INSERT INTO referrals (referrer_id, referred_id, bonus_amount) VALUES ($1, $2, $3)', [referrerInternalId, userId, bonusAmount]);
                await db.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [bonusAmount, referrerInternalId]);
                bot.sendMessage(referrerId.toString(), `🎁 አዲስ ሰው በግብዣ ሊንክዎ ስለተመዘገበ የ ${bonusAmount} ብር ቦነስ አግኝተዋል!`);
            }
        }
        
        userStates.delete(senderId);
        bot.sendMessage(chatId, "✅ በተሳካ ሁኔታ ተመዝግበዋል! አሁን 'Play' ን ይጫኑ!", {
            reply_markup: getMainKeyboard(senderId)
        });
    } catch (error) {
        console.error('Registration error:', error);
        bot.sendMessage(chatId, `ይቅርታ፣ በመመዝገብ ላይ ችግር ተፈጥሯል።`);
    }
});

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
        bot.sendMessage(chatId, "ይቅርታ፣ ሒሳብዎን ማግኘት አልተቻለም።");
    }
});

bot.onText(/🔗 Referral Link/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const botInfo = await bot.getMe();
    const referralLink = `https://t.me/${botInfo.username}?start=${telegramId}`;
    const message = `🎁 <b>የሪፈራል ፕሮግራም</b>\n\n🔗 የእርስዎ ሊንክ:\n<code>${referralLink}</code>`;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

bot.onText(/💳 Deposit/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    try {
        const userResult = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId.toString()]);
        if (userResult.rows.length === 0) {
            await bot.sendMessage(chatId, '❌ እባክዎ መጀመሪያ ይመዝገቡ። /start ይላኩ።');
            return;
        }
        userStates.set(telegramId, { action: 'deposit', step: 'method', userId: userResult.rows[0].id });
        await bot.sendMessage(chatId, '💳 ዲፖዚት ለማድረግ የክፍያ ዘዴ ይምረጡ:', { 
            reply_markup: { 
                keyboard: [[{ text: "📱 Telebirr" }, { text: "🏦 CBE Birr" }], [{ text: "❌ ሰርዝ" }]], 
                resize_keyboard: true 
            } 
        });
    } catch (error) {
        bot.sendMessage(chatId, 'ይቅርታ፣ ስህተት ተፈጥሯል።');
    }
});

bot.onText(/📱 Telebirr/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const state = userStates.get(telegramId);
    if (state?.action === 'deposit' && state?.step === 'method') {
        state.paymentMethod = 'telebirr';
        state.step = 'amount';
        userStates.set(telegramId, state);
        await bot.sendMessage(chatId, '📱 Telebirr ተመርጧል\n\n💵 ማስገባት የሚፈልጉትን መጠን (ብር) ያስገቡ:', { reply_markup: { keyboard: [[{ text: "❌ ሰርዝ" }]], resize_keyboard: true } });
    }
});

bot.onText(/❌ ሰርዝ/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, '❌ ተሰርዟል።', { reply_markup: getMainKeyboard(telegramId) });
});

bot.on('message', async (msg) => {
    if (msg.contact || !msg.text || msg.text.startsWith('/') || msg.text.includes('💰') || msg.text.includes('💳') || msg.text.includes('❌')) return;
    
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const text = msg.text.trim();
    const state = userStates.get(telegramId);
    if (!state) return;

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
            const paymentInfo = '📱 Telebirr: <code>0980682889</code>';
            await bot.sendMessage(chatId, `💵 መጠን: ${amount} ብር\n\n${paymentInfo}\n\nገንዘቡን ከላኩ በኋላ ከቴሌብር የሚደርስዎትን ሜሴጅ ሙሉውን ኮፒ አድርገው እዚ ይላኩ`, { parse_mode: 'HTML' });
        } else if (state.step === 'confirmation_code') {
            const rawText = text;
            const txIdPattern = /(?:ቁጥርዎ|receipt\/|Transaction ID:|Ref:|transaction number is)\s*([A-Z0-9]{8,25})/i;
            const txIdMatch = rawText.match(txIdPattern);
            let finalCode = '';
            if (txIdMatch) {
                finalCode = txIdMatch[1].trim().toUpperCase();
            } else {
                const generalCodeMatch = rawText.match(/[A-Z0-9]{10,25}/i);
                finalCode = generalCodeMatch ? generalCodeMatch[0].toUpperCase() : rawText.substring(0, 50).toUpperCase();
            }

            try {
                const codeToSave = finalCode;
                const normalizedInputCode = codeToSave.replace(/[^A-Z0-9]/gi, '').toUpperCase();
                const existingCheck = await db.query(
                    `SELECT * FROM deposits WHERE (confirmation_code = $1 OR UPPER(REGEXP_REPLACE(confirmation_code, '[^A-Z0-9]', '', 'g')) = $2 OR confirmation_code LIKE '%' || $1 || '%')`,
                    [codeToSave, normalizedInputCode]
                );

                if (existingCheck.rows.length > 0) {
                    const existing = existingCheck.rows[0];
                    if (existing.status === 'confirmed') {
                        await bot.sendMessage(chatId, '⚠️ ይህ የግብይት ቁጥር ቀደም ብሎ ጥቅም ላይ ውሏል።');
                        return;
                    }
                    if (existing.status === 'unmatched') {
                        await db.query('BEGIN');
                        await db.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [existing.amount, state.userId]);
                        await db.query('UPDATE deposits SET user_id = $1, status = $2, confirmed_at = NOW() WHERE id = $3', [state.userId, 'confirmed', existing.id]);
                        await db.query('COMMIT');
                        userStates.delete(telegramId);
                        await bot.sendMessage(chatId, `✅ ዲፖዚትዎ ተረጋግጧል!`, { reply_markup: getMainKeyboard(telegramId) });
                        return;
                    }
                }

                await db.query('INSERT INTO deposits (user_id, amount, payment_method, confirmation_code, status) VALUES ($1, $2, $3, $4, $5)', [state.userId, state.amount, state.paymentMethod, codeToSave, 'pending']);
                const userResultLookup = await db.query('SELECT username FROM users WHERE id = $1', [state.userId]);
                const username = userResultLookup.rows[0]?.username || 'Unknown';

                await notifyAdmin(`💰 <b>አዲስ የዲፖዚት ጥያቄ</b>\n\n👤 ተጠቃሚ: ${username}\n💵 መጠን: ${state.amount} ብር\n🔑 ኮድ: ${codeToSave}`, {
                    reply_markup: { inline_keyboard: [[{ text: '✅ አጽድቅ', callback_data: `confirm_dep_${codeToSave}` }, { text: '❌ ሰርዝ', callback_data: `reject_dep_${codeToSave}` }]] }
                });
                
                userStates.delete(telegramId);
                await bot.sendMessage(chatId, `✅ የዲፖዚት ጥያቄዎ ተልኳል!`, { reply_markup: getMainKeyboard(telegramId) });
            } catch (error) {
                console.error('Deposit error:', error);
                await bot.sendMessage(chatId, 'ይቅርታ፣ ስህተት ተፈጥሯል።');
            }
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
