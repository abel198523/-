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
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api'); 

const db = require('./db/database');
const User = require('./models/User');
const Wallet = require('./models/Wallet');
const Game = require('./models/Game');
const { validateBingo } = require('./data/cards');

// Force verbatim result order for Replit internal DB
const dns = require('dns');
dns.setDefaultResultOrder('verbatim');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 5000;
const MINI_APP_URL = process.env.MINI_APP_URL || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = new Map();

// --- Game Engine State ---
let activeGame = null;
let gameTimer = null;
let countdownSeconds = 45;
let calledNumbers = [];
let ballTimer = null;
const participants = new Map(); // Map<tg_id, {cardId, stake, userId}>

async function startNewGame() {
    try {
        console.log("Starting a new game cycle...");
        const game = await Game.create(10);
        activeGame = {
            id: game.id,
            stake: 10,
            status: 'waiting',
            startTime: Date.now() + (45 * 1000)
        };
        countdownSeconds = 45;
        calledNumbers = [];
        participants.clear();
        
        broadcast({ type: 'game_state', state: 'waiting', timer: countdownSeconds, playerCount: 0, prizePool: 0 });
        
        if (gameTimer) clearInterval(gameTimer);
        gameTimer = setInterval(() => {
            countdownSeconds--;
            if (countdownSeconds <= 0) {
                clearInterval(gameTimer);
                startGameFlow();
            } else {
                broadcast({ type: 'timer_update', seconds: countdownSeconds });
            }
        }, 1000);
    } catch (err) {
        console.error('Failed to start new game:', err);
        setTimeout(startNewGame, 5000);
    }
}

async function startGameFlow() {
    if (!activeGame) return;
    
    activeGame.status = 'playing';
    console.log(`Game #${activeGame.id} is now playing.`);
    broadcast({ type: 'game_state', state: 'playing', playerCount: participants.size, prizePool: participants.size * 10 * 0.8 });
    
    if (ballTimer) clearInterval(ballTimer);
    ballTimer = setInterval(() => {
        if (calledNumbers.length >= 75) {
            clearInterval(ballTimer);
            console.log("All balls drawn. Game ended without winner.");
            setTimeout(startNewGame, 10000);
            return;
        }
        
        let nextNum;
        do {
            nextNum = Math.floor(Math.random() * 75) + 1;
        } while (calledNumbers.includes(nextNum));
        
        calledNumbers.push(nextNum);
        broadcast({ type: 'new_ball', number: nextNum, calledNumbers });
    }, 5000);
}

function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// WebSocket Connection
wss.on('connection', (ws) => {
    console.log("New WebSocket client connected");
    
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'confirm_card') {
                const { cardId, stake, tg_id } = data;
                if (!tg_id) return;
                
                if (activeGame && activeGame.status === 'waiting') {
                    try {
                        const userLookup = await db.query('SELECT id FROM users WHERE telegram_id = $1', [tg_id.toString()]);
                        if (userLookup.rows.length > 0) {
                            const userId = userLookup.rows[0].id;
                            await Game.addParticipant(activeGame.id, userId, cardId, stake);
                            participants.set(tg_id.toString(), { cardId, stake, userId });
                            broadcast({ 
                                type: 'player_joined', 
                                count: participants.size, 
                                prizePool: participants.size * stake * 0.8 
                            });
                            console.log(`Player ${tg_id} joined Game #${activeGame.id} with card ${cardId}`);
                        }
                    } catch (err) {
                        console.error('Participant join error:', err);
                    }
                }
            } else if (data.type === 'claim_bingo') {
                const { tg_id, cardId } = data;
                if (!tg_id) return;
                
                const p = participants.get(tg_id.toString());
                if (p && p.cardId === cardId && activeGame && activeGame.status === 'playing') {
                    try {
                        // Validate Bingo card locally before finalizing
                        const isValid = validateBingo(cardId, calledNumbers);
                        if (isValid) {
                            clearInterval(ballTimer);
                            activeGame.status = 'completed';
                            
                            const winner = await Game.setWinner(activeGame.id, p.userId, cardId, calledNumbers);
                            const winnerUsername = (await db.query('SELECT username FROM users WHERE id = $1', [p.userId])).rows[0]?.username || 'Player';
                            
                            broadcast({ 
                                type: 'game_over', 
                                winner: tg_id, 
                                winner_name: winnerUsername,
                                prize: winner.total_pot * 0.8
                            });
                            console.log(`Player ${tg_id} WON Game #${activeGame.id}!`);
                            setTimeout(startNewGame, 15000);
                        }
                    } catch (err) {
                        console.error('Bingo claim error:', err);
                    }
                }
            }
        } catch (e) { console.error('WS Message Error:', e); }
    });
    
    if (activeGame) {
        ws.send(JSON.stringify({ 
            type: 'game_state', 
            state: activeGame.status, 
            timer: countdownSeconds,
            calledNumbers,
            playerCount: participants.size,
            prizePool: participants.size * 10 * 0.8
        }));
    }
});

// Bot Functions
function getMainKeyboard(telegramId) {
    let currentUrl = MINI_APP_URL || '';
    if (currentUrl.endsWith('/')) currentUrl = currentUrl.slice(0, -1);
    const miniAppUrlWithId = `${currentUrl}?tg_id=${telegramId}`;
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
        try { await bot.sendMessage(ADMIN_CHAT_ID, message, finalOptions); } catch (err) {}
    }
}

// Bot Handlers
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    try {
        const result = await db.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId.toString()]);
        if (result.rows.length > 0) {
            bot.sendMessage(chatId, "እንኳን ደህና መጡ! 'Play' ን ይጫኑ።", { reply_markup: getMainKeyboard(telegramId) });
        } else {
            bot.sendMessage(chatId, "እንኳን ደህና መጡ! እባክዎ መጀመሪያ ይመዝገቡ።", {
                reply_markup: { keyboard: [[{ text: "📱 Register", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
            });
        }
    } catch (e) { console.error('Start error:', e); }
});

bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;
    const phoneNumber = msg.contact.phone_number;
    try {
        const existing = await db.query('SELECT id FROM users WHERE telegram_id = $1', [senderId.toString()]);
        if (existing.rows.length > 0) return;

        const userResult = await db.query(
            'INSERT INTO users (telegram_id, username, phone_number, is_registered) VALUES ($1, $2, $3, $4) RETURNING id',
            [senderId.toString(), msg.from.username || `Player_${senderId}`, phoneNumber, true]
        );
        await db.query('INSERT INTO wallets (user_id, balance) VALUES ($1, $2)', [userResult.rows[0].id, 0.00]);
        bot.sendMessage(chatId, "✅ በተሳካ ሁኔታ ተመዝግበዋል! አሁን መጫወት ይችላሉ።", { reply_markup: getMainKeyboard(senderId) });
    } catch (e) { bot.sendMessage(chatId, "ምዝገባው አልተሳካም። እባክዎ ድጋሚ ይሞክሩ።"); }
});

bot.onText(/💰 Check Balance/, async (msg) => {
    const telegramId = msg.from.id;
    try {
        const result = await db.query('SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1', [telegramId.toString()]);
        if (result.rows.length > 0) {
            bot.sendMessage(msg.chat.id, `💰 የእርስዎ ቀሪ ሒሳብ: ${parseFloat(result.rows[0].balance).toFixed(2)} ብር`);
        } else {
            bot.sendMessage(msg.chat.id, "እባክዎ መጀመሪያ ይመዝገቡ።");
        }
    } catch (e) {}
});

bot.onText(/💳 Deposit/, async (msg) => {
    const telegramId = msg.from.id;
    userStates.set(telegramId, { action: 'deposit', step: 'amount' });
    bot.sendMessage(msg.chat.id, "ማስገባት የሚፈልጉትን መጠን ያስገቡ (ቢያንስ 20 ብር):", {
        reply_markup: { keyboard: [[{ text: "❌ ሰርዝ" }]], resize_keyboard: true }
    });
});

bot.on('message', async (msg) => {
    if (msg.contact || !msg.text || msg.text.startsWith('/') || msg.text.includes('▶️')) return;
    const state = userStates.get(msg.from.id);
    if (!state) return;

    if (msg.text === '❌ ሰርዝ') {
        userStates.delete(msg.from.id);
        return bot.sendMessage(msg.chat.id, "ተሰርዟል።", { reply_markup: getMainKeyboard(msg.from.id) });
    }

    if (state.action === 'deposit') {
        if (state.step === 'amount') {
            const amt = parseFloat(msg.text);
            if (isNaN(amt) || amt < 20) return bot.sendMessage(msg.chat.id, "❌ ስህተት፡ ቢያንስ 20 ብር ያስገቡ።");
            state.amount = amt;
            state.step = 'code';
            bot.sendMessage(msg.chat.id, `ለ 📱 0980682889 ${amt} ብር ከላኩ በኋላ የደረሰዎትን የቴሌብር ሜሴጅ ሙሉውን ኮፒ አድርገው እዚህ ይላኩ።`);
        } else if (state.step === 'code') {
            const rawText = msg.text;
            const txIdMatch = rawText.match(/(?:ቁጥርዎ|receipt\/|Transaction ID:|Ref:|transaction number is)\s*([A-Z0-9]{8,25})/i);
            let code = txIdMatch ? txIdMatch[1].toUpperCase() : (rawText.match(/[A-Z0-9]{10,25}/i)?.[0] || rawText.substring(0, 20)).toUpperCase();
            
            try {
                await db.query('INSERT INTO deposits (user_id, amount, payment_method, confirmation_code, status) SELECT id, $1, \'telebirr\', $2, \'pending\' FROM users WHERE telegram_id = $3', [state.amount, code, msg.from.id.toString()]);
                notifyAdmin(`💰 <b>አዲስ ዲፖዚት ጥያቄ</b>\n\nተጠቃሚ: ${msg.from.username || msg.from.id}\nመጠን: ${state.amount} ብር\nኮድ: ${code}`);
                bot.sendMessage(msg.chat.id, "✅ ጥያቄዎ ተልኳል፣ ሲረጋገጥ ባላንስዎ ላይ ይጨመራል።", { reply_markup: getMainKeyboard(msg.from.id) });
                userStates.delete(msg.from.id);
            } catch (err) { bot.sendMessage(msg.chat.id, "ስህተት ተፈጥሯል። እባክዎ ድጋሚ ይሞክሩ።"); }
        }
    }
});

// API Routes
app.get('/api/check-registration/:telegramId', async (req, res) => {
    try {
        const result = await db.query('SELECT id FROM users WHERE telegram_id = $1', [req.params.telegramId]);
        res.json({ registered: result.rows.length > 0 });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/wallet/:telegramId', async (req, res) => {
    try {
        const result = await db.query('SELECT w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1', [req.params.telegramId]);
        res.json({ balance: result.rows[0]?.balance || 0 });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

app.get('/api/profile/:telegramId', async (req, res) => {
    try {
        const result = await db.query('SELECT u.id, u.username, u.telegram_id as "telegramId", u.phone_number as "phoneNumber", w.balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1', [req.params.telegramId]);
        res.json({ success: result.rows.length > 0, profile: result.rows[0] });
    } catch (e) { res.status(500).json({ error: 'DB error' }); }
});

// Initialize and Start
startNewGame();
server.listen(PORT, '0.0.0.0', () => { 
    console.log(`Server running on port ${PORT}`); 
});
