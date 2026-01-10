const { Pool } = require('pg');
const Redis = require('ioredis');
const { Redis: UpstashRedis } = require('@upstash/redis');

// PostgreSQL Connection Pool
// prioritized for external databases (Supabase, etc.)
const pool = new Pool({
    connectionString: process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { 
        rejectUnauthorized: false
    }, 
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000,
    keepalive: true,
    keepaliveInitialDelayMillis: 10000
});

// Redis Client logic with Upstash fallback support
let redis = null;

if (process.env.REDIS_URL) {
    if (process.env.REDIS_URL.includes('upstash.io') && !process.env.REDIS_URL.startsWith('rediss://')) {
        // Handle Upstash REST format if provided incorrectly by user
        console.log('Detected Upstash REST config, using @upstash/redis client');
        const urlMatch = process.env.REDIS_URL.match(/URL="(https:\/\/[^"]+)"/);
        const tokenMatch = process.env.REDIS_URL.match(/TOKEN="([^"]+)"/);
        
        if (urlMatch && tokenMatch) {
            redis = new UpstashRedis({
                url: urlMatch[1],
                token: tokenMatch[1],
            });
        }
    } else {
        // Standard ioredis connection
        redis = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: 3,
            connectTimeout: 15000,
        });
    }
}

if (redis) {
    console.log('Redis initialized (Live Sessions)');
    if (typeof redis.on === 'function') {
        redis.on('error', (err) => console.error('Redis connection error:', err));
    }
} else {
    console.warn('REDIS_URL not configured correctly. Real-time game state will fallback to memory.');
}

pool.on('connect', () => {
    console.log('Connected to PostgreSQL database (Persistent Data)');
});

pool.on('error', (err) => {
    console.error('Database connection error:', err);
});

async function initializeDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50),
                telegram_id VARCHAR(100) UNIQUE,
                phone_number VARCHAR(20),
                password_hash VARCHAR(255),
                is_registered BOOLEAN DEFAULT false,
                referred_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );

            CREATE TABLE IF NOT EXISTS wallets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                balance DECIMAL(10, 2) DEFAULT 0.00,
                currency VARCHAR(10) DEFAULT 'ETB',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(20) NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                balance_before DECIMAL(10, 2),
                balance_after DECIMAL(10, 2),
                description TEXT,
                game_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS games (
                id SERIAL PRIMARY KEY,
                stake_amount DECIMAL(10, 2) NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                winner_id INTEGER REFERENCES users(id),
                winning_card INTEGER,
                called_numbers INTEGER[],
                total_pot DECIMAL(10, 2) DEFAULT 0.00,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS game_participants (
                id SERIAL PRIMARY KEY,
                game_id INTEGER REFERENCES games(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                card_id INTEGER NOT NULL,
                stake_amount DECIMAL(10, 2) NOT NULL,
                is_winner BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(game_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS deposits (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(10, 2) NOT NULL,
                payment_method VARCHAR(20),
                confirmation_code VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                confirmed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                amount DECIMAL(10, 2) NOT NULL,
                phone_number VARCHAR(20),
                account_name VARCHAR(100),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                processed_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                telegram_id VARCHAR(50) UNIQUE,
                username VARCHAR(50),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS referrals (
                id SERIAL PRIMARY KEY,
                referrer_id INTEGER REFERENCES users(id),
                referred_id INTEGER REFERENCES users(id),
                bonus_amount DECIMAL(10, 2) DEFAULT 0.00,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Database tables initialized');
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        client.release();
    }
}

module.exports = {
    pool,
    redis,
    initializeDatabase,
    query: (text, params) => pool.query(text, params)
};