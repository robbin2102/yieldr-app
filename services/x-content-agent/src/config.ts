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

  // Channel toggles (set via Railway env vars)
  ENABLE_X: process.env.ENABLE_X !== 'false',
  ENABLE_TG: process.env.ENABLE_TG !== 'false',

  // MCP Server (for fetching data)
  MCP_SERVER_URL: process.env.MCP_SERVER_URL || 'http://localhost:3001',

  // Content calendar (IST times, 2 windows, 10h+ gap)
  POSTING_WINDOWS: [
    { ist: '20:00', edt: '10:30', content: ['VAULT_PERFORMANCE'], channels: ['x', 'tg'] },
    { ist: '06:00', edt: '20:30', content: ['TRADER_PROFILE', 'HIGH_CONVICTION'], channels: ['x', 'tg'] },
  ],

  // Daily post limits (2 posts/day)
  DAILY_LIMITS: {
    VAULT_PERFORMANCE: 1,
    TRADER_PROFILE: 1,
    HIGH_CONVICTION: 1,
    PROJECT_PRIMER: 0,
    COMMUNITY_PROMPT: 0,
    MARKETS_ALPHA: 0,
    BASE_POSTING: 0,
    TOTAL: 2,
  },

  // Reply monitoring (15min to reduce API costs)
  REPLY_POLL_INTERVAL_MS: 15 * 60 * 1000,
  MAX_REPLY_LATENCY_MS: 15 * 60 * 1000,

  // Jitter range for posting (ms)
  JITTER_MIN_MS: 15 * 60 * 1000,
  JITTER_MAX_MS: 30 * 60 * 1000,

  // Top 20 Base accounts to monitor
  BASE_ACCOUNTS: [
    'jessepollak',
    'base',
    'BuildOnBase',
    'coinaboratory',
    'BaseGods',
  ],
} as const;
