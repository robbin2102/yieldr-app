/**
 * X Content Agent Configuration
 */

export const CONFIG = {
  // Server
  PORT: parseInt(process.env.PORT || '3000'),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || '',
  DB_NAME: 'yieldr',

  // xAI / Grok
  XAI_API_KEY: process.env.XAI_API_KEY || '',
  XAI_MODEL: 'grok-4-1-fast-reasoning',
  XAI_BASE_URL: 'https://api.x.ai/v1',

  // X API v2 (Twitter)
  X_API_KEY: process.env.X_API_KEY || '',
  X_API_SECRET: process.env.X_API_SECRET || '',
  X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN || '',
  X_ACCESS_SECRET: process.env.X_ACCESS_SECRET || '',
  X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || '',

  // Telegram Bot
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID || '',

  // MCP Server (for fetching data)
  MCP_SERVER_URL: process.env.MCP_SERVER_URL || 'http://localhost:3001',

  // Content calendar (IST times, 5 windows)
  POSTING_WINDOWS: [
    { ist: '19:30', edt: '10:00', content: ['PROJECT_PRIMER'], channels: ['x', 'tg'] },
    { ist: '22:00', edt: '12:30', content: ['VAULT_PERFORMANCE'], channels: ['x', 'tg'] },
    { ist: '00:00', edt: '14:30', content: ['COMMUNITY_PROMPT'], channels: ['x', 'tg'] },
    { ist: '03:00', edt: '17:30', content: ['HIGH_CONVICTION'], channels: ['x'] },
    { ist: '06:00', edt: '20:30', content: ['TRADER_PROFILE'], channels: ['x'] },
  ],

  // Daily post limits (5 on X, 3 on TG)
  DAILY_LIMITS: {
    PROJECT_PRIMER: 1,
    VAULT_PERFORMANCE: 1,
    COMMUNITY_PROMPT: 1,
    HIGH_CONVICTION: 1,
    TRADER_PROFILE: 1,
    MARKETS_ALPHA: 0,
    BASE_POSTING: 0,
    BASE_REPLIES: 12,
    PM_REPLIES: 8,
    TOTAL: 5,
  },

  // Reply monitoring
  REPLY_POLL_INTERVAL_MS: 3 * 60 * 1000, // 3 minutes
  MAX_REPLY_LATENCY_MS: 15 * 60 * 1000,  // 15 minutes

  // Jitter range for posting (ms)
  JITTER_MIN_MS: 15 * 60 * 1000, // 15 minutes
  JITTER_MAX_MS: 30 * 60 * 1000, // 30 minutes

  // Top 20 Base accounts to monitor
  BASE_ACCOUNTS: [
    // To be configured - example accounts
    'jessepollak',
    'base',
    'BuildOnBase',
    'coinaboratory',
    'BaseGods',
  ],
} as const;
