const db = require('../db/database');

class Wallet {
    static async getBalance(userId) {
        const result = await db.query(
            `SELECT game_balance, withdrawable_balance, balance FROM wallets WHERE user_id = $1`,
            [userId]
        );
        const row = result.rows[0];
        const gameBalance = parseFloat(row?.game_balance || 0);
        const withdrawableBalance = parseFloat(row?.withdrawable_balance || 0);
        
        return {
            game_balance: gameBalance,
            withdrawable_balance: withdrawableBalance,
            total: gameBalance + withdrawableBalance
        };
    }

    static async deposit(userId, amount, description = 'Deposit') {
        const client = await db.pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Get total deposit history
            const depositHistory = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id = $1 AND status = 'confirmed'`,
                [userId]
            );
            const totalDeposited = parseFloat(depositHistory.rows[0].total) + parseFloat(amount);
            
            const walletResult = await client.query(
                `SELECT game_balance, withdrawable_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let gameBalance = parseFloat(walletResult.rows[0]?.game_balance || 0);
            let withdrawableBalance = parseFloat(walletResult.rows[0]?.withdrawable_balance || 0);
            const balanceBefore = gameBalance + withdrawableBalance;
            
            if (totalDeposited >= 100) {
                // If they crossed 100 ETB, move everything to withdrawable
                withdrawableBalance += gameBalance + parseFloat(amount);
                gameBalance = 0;
            } else {
                gameBalance += parseFloat(amount);
            }
            
            const balanceAfter = gameBalance + withdrawableBalance;
            
            await client.query(
                `UPDATE wallets SET game_balance = $1, withdrawable_balance = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
                [gameBalance, withdrawableBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
                 VALUES ($1, 'deposit', $2, $3, $4, $5)`,
                [userId, amount, balanceBefore, balanceAfter, description]
            );
            
            await client.query('COMMIT');
            
            return { success: true, game_balance: gameBalance, withdrawable_balance: withdrawableBalance, total: balanceAfter };
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
            
            const walletResult = await client.query(
                `SELECT withdrawable_balance, game_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let withdrawableBalance = parseFloat(walletResult.rows[0]?.withdrawable_balance || 0);
            let gameBalance = parseFloat(walletResult.rows[0]?.game_balance || 0);
            const balanceBefore = withdrawableBalance + gameBalance;
            
            if (withdrawableBalance < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient withdrawable balance' };
            }
            
            withdrawableBalance -= parseFloat(amount);
            const balanceAfter = withdrawableBalance + gameBalance;
            
            await client.query(
                `UPDATE wallets SET withdrawable_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [withdrawableBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description)
                 VALUES ($1, 'withdrawal', $2, $3, $4, $5)`,
                [userId, amount, balanceBefore, balanceAfter, description]
            );
            
            await client.query('COMMIT');
            
            return { success: true, withdrawable_balance: withdrawableBalance, total: balanceAfter };
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
            
            const walletResult = await client.query(
                `SELECT game_balance, withdrawable_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let gameBalance = parseFloat(walletResult.rows[0]?.game_balance || 0);
            let withdrawableBalance = parseFloat(walletResult.rows[0]?.withdrawable_balance || 0);
            const balanceBefore = gameBalance + withdrawableBalance;
            
            if (balanceBefore < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            // Deduct from game_balance first, then withdrawable_balance
            let remainingToDeduct = parseFloat(amount);
            if (gameBalance >= remainingToDeduct) {
                gameBalance -= remainingToDeduct;
                remainingToDeduct = 0;
            } else {
                remainingToDeduct -= gameBalance;
                gameBalance = 0;
                withdrawableBalance -= remainingToDeduct;
            }
            
            const balanceAfter = gameBalance + withdrawableBalance;
            
            await client.query(
                `UPDATE wallets SET game_balance = $1, withdrawable_balance = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
                [gameBalance, withdrawableBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balanceAfter, `Stake for game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, total: balanceAfter };
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
            
            const depositHistory = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as total FROM deposits WHERE user_id = $1 AND status = 'confirmed'`,
                [userId]
            );
            const totalDeposited = parseFloat(depositHistory.rows[0].total);
            
            const walletResult = await client.query(
                `SELECT game_balance, withdrawable_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
                [userId]
            );
            
            let gameBalance = parseFloat(walletResult.rows[0]?.game_balance || 0);
            let withdrawableBalance = parseFloat(walletResult.rows[0]?.withdrawable_balance || 0);
            const balanceBefore = gameBalance + withdrawableBalance;
            
            if (totalDeposited >= 100) {
                withdrawableBalance += parseFloat(amount);
            } else {
                gameBalance += parseFloat(amount);
            }
            
            const balanceAfter = gameBalance + withdrawableBalance;
            
            await client.query(
                `UPDATE wallets SET game_balance = $1, withdrawable_balance = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3`,
                [gameBalance, withdrawableBalance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'win', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balanceAfter, `Won game #${gameId}`, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, total: balanceAfter };
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
            
            let balance = parseFloat(balanceResult.rows[0]?.balance || 0);
            
            if (balance < amount) {
                await client.query('ROLLBACK');
                return { success: false, error: 'Insufficient balance' };
            }
            
            const balanceBefore = balance;
            balance -= amount;
            
            await client.query(
                `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
                [balance, userId]
            );
            
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, description, game_id)
                 VALUES ($1, 'stake', $2, $3, $4, $5, $6)`,
                [userId, amount, balanceBefore, balance, description, gameId]
            );
            
            await client.query('COMMIT');
            
            return { success: true, balance: balance };
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