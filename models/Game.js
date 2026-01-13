const db = require('../db/database');

class Game {
    static async create(stakeAmount) {
        const result = await db.query(
            `INSERT INTO games (stake_amount, status) 
             VALUES ($1, 'active') 
             RETURNING *`,
            [stakeAmount]
        );
        return result.rows[0];
    }

    static async findById(id) {
        const result = await db.query(
            `SELECT * FROM games WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    }

    static async findActive() {
        const result = await db.query(
            `SELECT * FROM games WHERE status = 'active' ORDER BY started_at DESC LIMIT 1`
        );
        return result.rows[0];
    }

    static async addParticipant(gameId, userId, cardId, stakeAmount) {
        const result = await db.query(
            `INSERT INTO game_participants (game_id, user_id, card_id, stake_amount)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (game_id, user_id) DO UPDATE SET card_id = $3
             RETURNING *`,
            [gameId, userId, cardId, stakeAmount]
        );
        
        await db.query(
            `UPDATE games SET total_pot = total_pot + $1 WHERE id = $2`,
            [stakeAmount, gameId]
        );
        
        return result.rows[0];
    }

    static async getParticipants(gameId) {
        const result = await db.query(
            `SELECT gp.*, u.username 
             FROM game_participants gp 
             JOIN users u ON gp.user_id = u.id 
             WHERE gp.game_id = $1`,
            [gameId]
        );
        return result.rows;
    }

    static async getParticipantCount(gameId) {
        const result = await db.query(
            `SELECT COUNT(*) as count FROM game_participants WHERE game_id = $1`,
            [gameId]
        );
        return parseInt(result.rows[0].count);
    }

    static async setWinner(gameId, userId, cardId, calledNumbers) {
        const game = await this.findById(gameId);
        if (!game) throw new Error('Game not found');
        
        const totalPot = parseFloat(game.total_pot || 0);
        const winnerPrize = totalPot * 0.8;
        const platformFee = totalPot * 0.2;

        const result = await db.query(
            `UPDATE games 
             SET winner_id = $1, winning_card = $2, called_numbers = $3, 
                 status = 'completed', ended_at = CURRENT_TIMESTAMP,
                 total_pot = $4
             WHERE id = $5
             RETURNING *`,
            [userId, cardId, calledNumbers, totalPot, gameId]
        );
        
        await db.query(
            `UPDATE game_participants SET is_winner = true WHERE game_id = $1 AND user_id = $2`,
            [gameId, userId]
        );

        /* 
        // Update winner's wallet balance - TEMPORARILY DISABLED
        await db.query(
            `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
            [winnerPrize, userId]
        );
        */
        
        return result.rows[0];
    }

    static async cancel(gameId) {
        await db.query(
            `UPDATE games SET status = 'cancelled', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [gameId]
        );
    }

    static async getUserGameHistory(userId, limit = 20) {
        const result = await db.query(
            `SELECT g.*, gp.card_id, gp.is_winner, gp.stake_amount as my_stake,
                    u.username as winner_username
             FROM game_participants gp
             JOIN games g ON gp.game_id = g.id
             LEFT JOIN users u ON g.winner_id = u.id
             WHERE gp.user_id = $1 AND g.status = 'completed'
             ORDER BY g.ended_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }

    static async getUserStats(userId) {
        const result = await db.query(
            `SELECT 
                COUNT(*) as total_games,
                SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as wins,
                SUM(stake_amount) as total_staked,
                SUM(CASE WHEN is_winner THEN g.total_pot ELSE 0 END) as total_won
             FROM game_participants gp
             JOIN games g ON gp.game_id = g.id
             WHERE gp.user_id = $1 AND g.status = 'completed'`,
            [userId]
        );
        return result.rows[0];
    }
}

module.exports = Game;