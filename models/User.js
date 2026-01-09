const db = require('../db/database');
const bcrypt = require('bcryptjs');

class User {
    static async create(username, password, telegramId = null) {
        const passwordHash = password ? await bcrypt.hash(password, 10) : null;
        const tgId = telegramId ? parseInt(telegramId) : null;
        
        const result = await db.query(
            `INSERT INTO users (username, password_hash, telegram_id) 
             VALUES ($1, $2, $3) 
             RETURNING id, username, telegram_id, created_at`,
            [username, passwordHash, tgId]
        );
        
        const user = result.rows[0];
        
        await db.query(
            `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.00)`,
            [user.id]
        );
        
        return user;
    }

    static async findByUsername(username) {
        const result = await db.query(
            `SELECT u.*, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.username = $1`,
            [username]
        );
        return result.rows[0];
    }

    static async findByTelegramId(telegramId) {
        const tgId = parseInt(telegramId) || 0;
        const result = await db.query(
            `SELECT u.*, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.telegram_id = $1`,
            [tgId]
        );
        return result.rows[0];
    }

    static async findById(id) {
        const result = await db.query(
            `SELECT u.*, w.balance 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE u.id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async verifyPassword(user, password) {
        if (!user.password_hash) return false;
        return bcrypt.compare(password, user.password_hash);
    }

    static async updateLastLogin(userId) {
        await db.query(
            `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1`,
            [userId]
        );
    }

    static async findOrCreateByTelegram(telegramId, username) {
        let user = await this.findByTelegramId(telegramId);
        
        if (!user) {
            user = await this.create(username, null, telegramId);
        }
        
        await this.updateLastLogin(user.id);
        return user;
    }
}

module.exports = User;