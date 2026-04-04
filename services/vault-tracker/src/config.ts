export const CONFIG = {
  MONGODB_URI:              process.env.MONGODB_URI || '',
  DB_NAME:                  'yieldr',
  PORT:                     parseInt(process.env.PORT || '3000'),

  // Cron intervals
  ACTIVITY_POLL_INTERVAL_MS: parseInt(process.env.ACTIVITY_POLL_INTERVAL_MS || '60000'),   // 1 min
  PROFILE_INTERVAL_MS:       parseInt(process.env.PROFILE_INTERVAL_MS       || '86400000'), // 24 h

  // Polymarket API
  POLYMARKET_API:           'https://data-api.polymarket.com',
  API_DELAY_MS:             200, // delay between consecutive API calls per wallet

  // Conviction multiplier for high-conviction trade detection
  CONVICTION_MULTIPLIER:    parseInt(process.env.CONVICTION_MULTIPLIER || '10'),
} as const;
