/**
 * Pipeline-specific configuration
 * Separate from the trading bot's config.ts to avoid conflicts.
 */

export const PIPELINE_CONFIG = {
  // Server
  PORT: parseInt(process.env.PIPELINE_PORT || process.env.PORT || '3001'),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || '',
  DB_NAME: process.env.MONGODB_DB_NAME || 'yieldr',

  // Polymarket APIs
  DATA_API_BASE: 'https://data-api.polymarket.com',
  GAMMA_API_BASE: 'https://gamma-api.polymarket.com',
  API_DELAY_MS: 300,

  // Scheduled intervals
  INTERVALS: {
    MARKET_INDEX: 24 * 60 * 60 * 1000,   // 24 hours
    PIPELINE:     24 * 60 * 60 * 1000,   // 24 hours (once daily)
  },

  // Market indexing
  MARKET_DAYS_WINDOW: 30,
  MARKET_MIN_VOLUME:  50_000,
  MARKETS_PER_PAGE:   100,

  // API pagination limits
  LIMITS: {
    ACTIVITIES:        500,
    POSITIONS:         500,
    CLOSED_POSITIONS:   50,
  },
} as const;
