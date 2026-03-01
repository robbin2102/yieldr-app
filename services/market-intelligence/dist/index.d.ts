/**
 * Yieldr Market Intelligence Service
 *
 * Ingests TAAPI + CoinGlass data every hour and stores snapshots in MongoDB.
 * Runs as a standalone Railway service.
 *
 * Environment Variables:
 *   MONGODB_URI           — MongoDB connection string
 *   TAAPI_API_KEY         — TAAPI.io Pro API key
 *   COINGLASS_API_KEY     — CoinGlass Hobby API key
 *   TAAPI_RATE_DELAY_MS   — Delay between TAAPI requests (default: 600)
 *   COINGLASS_RATE_DELAY_MS — Delay between CoinGlass requests (default: 2200)
 *   PORT                  — HTTP health check port (default: 3000)
 */
export {};
