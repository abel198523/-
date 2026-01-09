const db = require('../db/database');

class Wallet {
    static async getBalance(userId) {
        const result = await db.query(
            `SELECT balance FROM wallets WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0]?.balance || 0;
    }

    static async deposit(userId, amount, description = 'Deposit') {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const balanceResult = await client.query(
                `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const balanceBefore = parseFloat(balanceResult.rows[0]?.balance || 0);
            const balanceAfter = balanceBefore + parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
                 VALUES ($1, 'deposit', $2, $3, $4, $5)`,
                [userId, amount, balanceBefore, balanceAfter, description]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balanceAfter };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async withdraw(userId, amount, description = 'Withdrawal') {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const balanceResult = await client.query(
                `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const balanceBefore = parseFloat(balanceResult.rows[0]?.balance || 0);
            
            if (balanceBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            const balanceAfter = balanceBefore - parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
                 VALUES ($1, 'withdrawal', $2, $3, $4, $5)`,
                [userId, amount, balanceBefore, balanceAfter, description]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balanceAfter };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async stake(userId, amount, gameId) {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const balanceResult = await client.query(
                `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const balanceBefore = parseFloat(balanceResult.rows[0]?.balance || 0);
            
            if (balanceBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            const balanceAfter = balanceBefore - parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balanceAfter, `Stake for game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balanceAfter };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async win(userId, amount, gameId) {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const balanceResult = await client.query(
                `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const balanceBefore = parseFloat(balanceResult.rows[0]?.balance || 0);
            const balanceAfter = balanceBefore + parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'win', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balanceAfter, `Won game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balanceAfter };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async deductBalance(userId, amount, description = 'Deduction', gameId = null) {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            const balanceResult = await client.query(
                `SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const balanceBefore = parseFloat(balanceResult.rows[0]?.balance || 0);
            
            if (balanceBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            const balanceAfter = balanceBefore - parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balanceAfter, description, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balanceAfter };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    static async getTransactionHistory(userId, limit = 50) {
        const result = await db.query(
            `SELECT * FROM transactions 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }
}

module.exports = Wallet;