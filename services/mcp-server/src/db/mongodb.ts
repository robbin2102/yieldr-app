/**
 * MongoDB Connection for MCP Server
 * Connects to the same database as indexers
 */

import { MongoClient, Db } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

const DB_NAME = 'yieldr';

export async function connectDB(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);

  console.log('[DB] Connected to MongoDB');

  return db;
}

export async function getDB(): Promise<Db> {
  if (!db) {
    return connectDB();
  }
  return db;
}

export async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[DB] Connection closed');
  }
}

// Collection names - matches indexer services
export const COLLECTIONS = {
  // Polymarket collections
  PM_TRACKED_TRADERS: 'polymarket-trackedTraders',
  PM_TRADER_PROFILES: 'polymarket-traderProfiles',
  PM_OPEN_POSITIONS: 'polymarket-openPositions',
  PM_TRADES: 'polymarket-trades',
  PM_CLOSED_POSITIONS: 'polymarket-closedPositions',

  // Hyperliquid collections
  HL_TRACKED_WALLETS: 'hyperliquid-trackedWallets',
  HL_METRICS: 'hyperliquidmetrics',
  HL_FILLS: 'hyperliquidfills',
  HL_POSITIONS: 'hyperliquidpositions',
  HL_PNL_SNAPSHOTS: 'hyperliquidpnlsnapshots',

  // Avantis collections (future)
  AV_TRACKED_WALLETS: 'avantis-trackedWallets',
  AV_METRICS: 'avantismetrics',
  AV_POSITIONS: 'avantispositions',

  // Market intelligence collections
  MARKET_SNAPSHOTS: 'market_snapshots',
  MARKET_STRUCTURE: 'market_structure_history',
  LIQUIDATION_LEVELS: 'liquidation_levels',
  CHART_PATTERNS: 'chart_patterns',
  MACRO_DAILY: 'macro_daily',
  TRACKED_COINS: 'tracked_coins',

  // Binance fetcher collections (written by Singapore binance-fetcher service)
  BINANCE_FUNDING_8H: 'binance_funding_8h',
  BINANCE_DERIVATIVES_15M: 'binance_derivatives_15m',
} as const;
