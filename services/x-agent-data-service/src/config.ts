/**
 * X Agent Data Service Configuration
 *
 * Runs two scheduled jobs:
 * 1. Market Indexer — fetches active Polymarket markets (every 24h)
 * 2. Trader Pipeline — 4-step profiling from leaderboard to edge-ranked (every 24h)
 */

export const CONFIG = {
  // Server
  PORT: parseInt(process.env.PORT || '3000'),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || '',
  DB_NAME: 'yieldr',

  // Polymarket APIs (used by market indexer)
  DATA_API_BASE: 'https://data-api.polymarket.com',
  GAMMA_API_BASE: 'https://gamma-api.polymarket.com',
  API_DELAY_MS: 300,

  // Scheduled intervals
  INTERVALS: {
    MARKET_INDEX: 24 * 60 * 60 * 1000,      // 24 hours
    PIPELINE: 24 * 60 * 60 * 1000,           // 24 hours (once daily)
  },

  // Market indexing
  MARKET_DAYS_WINDOW: 30,
  MARKET_MIN_VOLUME: 50000,
  MARKETS_PER_PAGE: 100,

  // API pagination limits (for market indexer)
  LIMITS: {
    ACTIVITIES: 500,
    POSITIONS: 500,
    CLOSED_POSITIONS: 50,
  },
} as const;
