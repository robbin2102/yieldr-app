/**
 * X Agent Data Service Configuration
 */

export const CONFIG = {
  // Server
  PORT: parseInt(process.env.PORT || '3000'),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI || '',
  DB_NAME: 'yieldr',

  // Polymarket APIs
  DATA_API_BASE: 'https://data-api.polymarket.com',
  GAMMA_API_BASE: 'https://gamma-api.polymarket.com',
  API_DELAY_MS: 300, // Rate limiting delay between API calls

  // Monitor intervals
  INTERVALS: {
    MARKET_INDEX: 6 * 60 * 60 * 1000,    // 6 hours - fetch all live markets
    ACTIVITY_TRACK: 15 * 60 * 1000,       // 15 minutes - fetch trader activities
    POSITION_TRACK: 15 * 60 * 1000,       // 15 minutes - fetch open positions
    HIGH_CONVICTION: 15 * 60 * 1000,      // 15 minutes - detect high conviction trades
    PROFILE_REFRESH: 60 * 60 * 1000,      // 1 hour - re-profile traders (heavy operation)
  },

  // Trader tracking
  TOP_TRADERS_LIMIT: 100,                  // Track top 100 edge-ranked traders

  // Market indexing
  MARKET_DAYS_WINDOW: 30,                  // Markets ending within 30 days
  MARKET_MIN_VOLUME: 50000,               // Minimum $50k volume
  MARKETS_PER_PAGE: 100,                  // Gamma API pagination limit

  // High conviction thresholds
  HIGH_CONVICTION: {
    MIN_SIZE_MULTIPLIER: 50,               // 50x average trade size
    MIN_USDC_VALUE: 25000,                 // Minimum $25,000
    FALLBACK_SIZE_MULTIPLIER: 10,          // 10x for broader detection
  },

  // Profiler settings
  PROFILER: {
    ACTIVITY_DAYS: 90,                     // Look back 90 days for profiling
    CONVICTION_MULTIPLIER: 10,             // 10x avg trade = high conviction
  },

  // API pagination limits
  LIMITS: {
    ACTIVITIES: 500,
    POSITIONS: 500,
    CLOSED_POSITIONS: 50,
  },
} as const;
