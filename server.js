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
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAINTENANCE_MODE = false;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 5000;
const MINI_APP_URL = process.env.MINI_APP_URL || '';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = new Map();
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// Game Engine State
let activeGame = null;
let gameTimer = null;
let countdownSeconds = 45;
let calledNumbers = [];
let ballTimer = null;

async function startNewGame() {
    try {
        const game = await Game.create(10);
        activeGame = {
            id: game.id,
            stake: 10,
            participants: new Map(),
            status: 'waiting',
            startTime: Date.now() + (countdownSeconds * 1000)
        };
        broadcast({ type: 'game_state', state: 'waiting', timer: countdownSeconds });
        
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
    }
}

function startGameFlow() {
    activeGame.status = 'playing';
    calledNumbers = [];
    broadcast({ type: 'game_state', state: 'playing' });
    
    ballTimer = setInterval(() => {
        if (calledNumbers.length >= 75) {
            clearInterval(ballTimer);
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

wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'confirm_card') {
            // Logic to handle card confirmation
        } else if (data.type === 'claim_bingo') {
            // Logic to handle bingo claim
        }
    });
    
    // Send current state to new connection
    if (activeGame) {
        ws.send(JSON.stringify({ 
            type: 'game_state', 
            state: activeGame.status, 
            timer: countdownSeconds,
            calledNumbers 
        }));
    }
});

// Bot & API logic (Simplified for space)
app.get('/api/check-registration/:telegramId', async (req, res) => {
    const result = await db.query('SELECT id FROM users WHERE telegram_id = $1', [req.params.telegramId]);
    res.json({ registered: result.rows.length > 0 });
});

app.get('/api/wallet/:telegramId', async (req, res) => {
    const result = await db.query('SELECT balance FROM users u JOIN wallets w ON u.id = w.user_id WHERE u.telegram_id = $1', [req.params.telegramId]);
    res.json({ balance: result.rows[0]?.balance || 0 });
});

// Initialize first game
startNewGame();

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
