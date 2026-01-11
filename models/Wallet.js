const db = require('../db/database');

class Wallet {
    static async getBalance(userId) {
        const result = await db.query(
            `SELECT balance, winning_balance FROM wallets WHERE user_id = $1`,
            [userId]
        );
        return {
            balance: result.rows[0]?.balance || 0,
            winningBalance: result.rows[0]?.winning_balance || 0,
            total: (parseFloat(result.rows[0]?.balance || 0) + parseFloat(result.rows[0]?.winning_balance || 0))
        };
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
                `SELECT winning_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const winningBalanceBefore = parseFloat(balanceResult.rows[0]?.winning_balance || 0);
            
            if (winningBalanceBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient winning balance for withdrawal' };
            }
            
            const winningBalanceAfter = winningBalanceBefore - parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET winning_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [winningBalanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
                 VALUES ($1, 'withdrawal', $2, $3, $4, $5)`,
                [userId, amount, winningBalanceBefore, winningBalanceAfter, description]
            );
            
            await client.query('COMMIT');
            
            return { success: true, winningBalance: winningBalanceAfter };
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
                `SELECT balance, winning_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let mainBalance = parseFloat(balanceResult.rows[0]?.balance || 0);
            let winningBalance = parseFloat(balanceResult.rows[0]?.winning_balance || 0);
            const totalBefore = mainBalance + winningBalance;
            
            if (totalBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient total balance' };
            }
            
            let amountToDeduct = amount;
            
            // Deduct from main balance first
            if (mainBalance >= amountToDeduct) {
                mainBalance -= amountToDeduct;
                amountToDeduct = 0;
            } else {
                amountToDeduct -= mainBalance;
                mainBalance = 0;
                // Deduct remaining from winning balance
                winningBalance -= amountToDeduct;
            }
            
            await client.query(
                `UPDATE wallets SET balance = $1, winning_balance = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
                [mainBalance, winningBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, totalBefore, (mainBalance + winningBalance), `Stake for game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: mainBalance + winningBalance };
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
                `SELECT winning_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            const winningBalanceBefore = parseFloat(balanceResult.rows[0]?.winning_balance || 0);
            const winningBalanceAfter = winningBalanceBefore + parseFloat(amount);
            
            await client.query(
                `UPDATE wallets SET winning_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [winningBalanceAfter, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'win', $2, $3, $4, $5, $6)`,
                [userId, amount, winningBalanceBefore, winningBalanceAfter, `Won game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, winningBalance: winningBalanceAfter };
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
                `SELECT balance, winning_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let mainBalance = parseFloat(balanceResult.rows[0]?.balance || 0);
            let winningBalance = parseFloat(balanceResult.rows[0]?.winning_balance || 0);
            const totalBefore = mainBalance + winningBalance;
            
            if (totalBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            let amountToDeduct = amount;
            
            // Deduct from main balance first
            if (mainBalance >= amountToDeduct) {
                mainBalance -= amountToDeduct;
                amountToDeduct = 0;
            } else {
                amountToDeduct -= mainBalance;
                mainBalance = 0;
                winningBalance -= amountToDeduct;
            }
            
            await client.query(
                `UPDATE wallets SET balance = $1, winning_balance = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
                [mainBalance, winningBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, totalBefore, (mainBalance + winningBalance), description, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: mainBalance + winningBalance };
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