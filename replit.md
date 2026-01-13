# ROYAL BINGO - Telegram Bingo Game

## Overview
ROYAL BINGO is a real-time Bingo game built as a Telegram Mini App with integrated payment system (deposits/withdrawals) and admin panel. It is officially deployed on Render, and this Replit environment is used for maintenance and testing.

## Recent Changes (January 2026)
- Migrated to standard Replit environment.
- Configured PostgreSQL database using Replit PostgreSQL.
- Bot configured and running in polling mode.
- Investigated winning balance logic: Winnings are currently handled in `models/Game.js` via `setWinner` which updates `wallets.balance`.
- Confirmed that the dual balance system (Main vs Winning) is mentioned in `replit.md` but implementation details need verification in the schema.

## Project Architecture

### Backend (Node.js/Express)
- `server.js` - Main server with Express API, WebSocket, and Telegram Bot logic
- `db/database.js` - PostgreSQL database connection and initialization
- `models/` - Data models (User, Wallet, Game)
- `data/cards.js` - Bingo card validation logic

### Frontend
- `public/index.html` - Main game interface
- `public/game.js` - Game client logic
- `public/style.css` - Styling
- `public/admin.html` - Admin panel for transaction management

## Database Setup
The project uses Replit's built-in PostgreSQL for testing, while the production uses Render's database. The schema is automatically initialized on server start.

## Environment Variables
- `TELEGRAM_BOT_TOKEN`: Telegram Bot API token.
- `DATABASE_URL`: Automatically provided by Replit/Render.
- `REDIS_URL`: Upstash Redis connection string.
- `ADMIN_CHAT_ID`: Admin Telegram Chat ID.
- `SESSION_SECRET`: Session security string.
- `MINI_APP_URL`: The URL where the Mini App is hosted.

## Maintenance Guidelines
- This code is meant to be portable between Replit and Render.
- Avoid Replit-specific dependencies that won't work on Render.
- Ensure all environment variables are correctly configured in both environments.
