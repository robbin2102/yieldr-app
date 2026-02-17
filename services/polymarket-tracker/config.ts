/**
 * Polymarket Tracker Configuration
 */

export const CONFIG = {
  // API Base URLs
  API_BASE: 'https://data-api.polymarket.com',
  GAMMA_API_BASE: 'https://gamma-api.polymarket.com',

  // Rate Limiting
  API_DELAY_MS: parseInt(process.env.POLYMARKET_API_DELAY_MS || '300'),

  // Polling Intervals
  POLL_INTERVAL_MS: parseInt(process.env.POLYMARKET_POLL_INTERVAL_MS || '60000'),           // Trade polling (default: 60s)
  POSITION_REFRESH_MS: parseInt(process.env.POLYMARKET_POSITION_REFRESH_MS || '300000'),    // Position refresh (default: 5min)

  // Pagination Limits (from Polymarket API)
  LIMITS: {
    OPEN_POSITIONS: 500,      // Max per call
    CLOSED_POSITIONS: 50,     // Max per call
    ACTIVITY: 500,            // Max per call for historical fetch
    POLLING: 50,              // Limit for 60s polling (efficient)
    MARKETS: 99,              // Max markets per call (using max-1 for safety)
    HOLDERS: 15,              // Top holders per side (API caps at 20)
  },

  // Time Ranges
  DAYS: {
    CLOSED_POSITIONS: 30,     // Fetch last 30 days of closed positions
    HISTORICAL_TRADES: 30,    // Fetch last 30 days of trades
    MARKET_END_WINDOW: 30,    // Fetch markets ending within 30 days
  },

  // Market Indexer Config
  MARKET_INDEX: {
    MIN_VOLUME: 50000,        // $50k minimum volume
    MIN_HOLDERS_BALANCE: 1,   // Minimum balance for holders
  },

  // Tracked Wallets (comma-separated in env)
  WALLETS: (process.env.POLYMARKET_WALLETS || '').split(',').filter(Boolean),
};

// Activity types to track
export const ACTIVITY_TYPES = {
  TRADE: 'TRADE',       // Buy/Sell activity
  REDEEM: 'REDEEM',     // Position redemptions
} as const;

export type ActivityType = typeof ACTIVITY_TYPES[keyof typeof ACTIVITY_TYPES];
