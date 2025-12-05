import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from the main app's .env.local
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

export const config = {
  // MongoDB connection (reuse from main app)
  mongodbUri: process.env.MONGODB_URI || '',

  // Polymarket configuration
  polymarket: {
    // Comma-separated wallet addresses to track
    wallets: (process.env.POLYMARKET_WALLETS || '').split(',').filter(Boolean),

    // Poll interval in milliseconds (default: 60 seconds)
    pollIntervalMs: parseInt(process.env.POLYMARKET_POLL_INTERVAL_MS || '60000'),

    // Delay between API calls in milliseconds (default: 300ms)
    apiDelayMs: parseInt(process.env.POLYMARKET_API_DELAY_MS || '300'),

    // Number of days to fetch for historical data
    historicalDays: 30,
  },

  // Notifications
  webhookUrl: process.env.POLYMARKET_WEBHOOK_URL || '',
  errorEmail: process.env.POLYMARKET_ERROR_EMAIL || 'robbin@yieldr.org',

  // API endpoints
  api: {
    baseUrl: 'https://data-api.polymarket.com',
    endpoints: {
      positions: '/positions',
      closedPositions: '/closed-positions',
      activity: '/activity',
    },
  },
};

// Validate required config
if (!config.mongodbUri) {
  throw new Error('MONGODB_URI is required in .env.local');
}

if (config.polymarket.wallets.length === 0) {
  console.warn('[Config] Warning: No wallets configured. Add POLYMARKET_WALLETS to .env.local');
}

console.log('[Config] Loaded configuration:');
console.log(`  - MongoDB URI: ${config.mongodbUri.substring(0, 20)}...`);
console.log(`  - Wallets to track: ${config.polymarket.wallets.length}`);
console.log(`  - Poll interval: ${config.polymarket.pollIntervalMs}ms`);
console.log(`  - API delay: ${config.polymarket.apiDelayMs}ms`);
