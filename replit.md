# ROYAL BINGO - Telegram Bingo Game

## Overview
ROYAL BINGO is a real-time Bingo game built as a Telegram Mini App with integrated payment system (deposits/withdrawals) and admin panel.

## Recent Changes (January 2026)
- Migrated to standard Replit environment.
- Configured PostgreSQL database using Replit PostgreSQL.
- Bot configured and running in polling mode.
- Integrated Upstash Redis for live session management.

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
The project uses Replit's built-in PostgreSQL. The schema is automatically initialized on server start.

## Environment Variables
- `TELEGRAM_BOT_TOKEN`: Telegram Bot API token.
- `DATABASE_URL`: Automatically provided by Replit PostgreSQL.
- `REDIS_URL`: Upstash Redis connection string.
- `ADMIN_CHAT_ID`: Admin Telegram Chat ID.
- `SESSION_SECRET`: Session security string.
