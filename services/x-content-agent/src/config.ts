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

  // Content calendar (IST times, optimized for US/EU traffic)
  POSTING_WINDOWS: [
    { ist: '19:30', edt: '06:00', content: ['HIGH_CONVICTION', 'TRADER_PROFILE'] },
    { ist: '21:30', edt: '08:00', content: ['MARKETS_ALPHA', 'VAULT_PERFORMANCE'] },
    { ist: '23:30', edt: '10:00', content: ['TRADER_PROFILE', 'BASE_POSTING'] },
    { ist: '02:00', edt: '13:00', content: ['HIGH_CONVICTION', 'MARKETS_ALPHA'] },
    { ist: '05:30', edt: '16:00', content: ['HIGH_CONVICTION', 'TRADER_PROFILE'] },
    { ist: '08:30', edt: '19:00', content: ['VAULT_PERFORMANCE', 'MARKETS_ALPHA'] },
    { ist: '11:00', edt: '21:30', content: ['TRADER_PROFILE', 'HIGH_CONVICTION', 'VAULT_PERFORMANCE', 'BASE_POSTING'] },
  ],

  // Daily post limits
  DAILY_LIMITS: {
    TRADER_PROFILE: 4,
    MARKETS_ALPHA: 3,
    HIGH_CONVICTION: 4,
    VAULT_PERFORMANCE: 3,
    BASE_POSTING: 2,
    BASE_REPLIES: 12,
    PM_REPLIES: 8,
    TOTAL: 18,
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
