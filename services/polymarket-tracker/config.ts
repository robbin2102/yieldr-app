/**
 * Polymarket Tracker Configuration
 */

export const CONFIG = {
  // API Base URL
  API_BASE: 'https://data-api.polymarket.com',

  // Rate Limiting
  API_DELAY_MS: parseInt(process.env.POLYMARKET_API_DELAY_MS || '300'),

  // Polling Interval
  POLL_INTERVAL_MS: parseInt(process.env.POLYMARKET_POLL_INTERVAL_MS || '60000'),

  // Pagination Limits (from Polymarket API)
  LIMITS: {
    OPEN_POSITIONS: 500,      // Max per call
    CLOSED_POSITIONS: 50,     // Max per call
    ACTIVITY: 500,            // Max per call for historical fetch
    POLLING: 50,              // Limit for 60s polling (efficient)
  },

  // Time Ranges
  DAYS: {
    CLOSED_POSITIONS: 30,     // Fetch last 30 days of closed positions
    HISTORICAL_TRADES: 30,    // Fetch last 30 days of trades
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
