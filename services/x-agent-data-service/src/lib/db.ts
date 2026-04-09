/**
 * MongoDB Connection for X Agent Data Service
 */

import { MongoClient, Db } from 'mongodb';
import { CONFIG } from '../config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  const uri = CONFIG.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(CONFIG.DB_NAME);

  console.log('[DB] Connected to MongoDB');

  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  try {
    // x-agent-tradeActivities indexes
    const activities = database.collection(COLLECTIONS.TRADE_ACTIVITIES);
    await activities.createIndex(
      { wallet: 1, transactionHash: 1 },
      { unique: true }
    );
    await activities.createIndex({ wallet: 1, timestamp: -1 });
    await activities.createIndex({ timestamp: -1 });

    // x-agent-highConvictionTrades indexes
    const hcTrades = database.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);
    await hcTrades.createIndex(
      { transactionHash: 1 },
      { unique: true }
    );
    await hcTrades.createIndex({ detectedAt: -1 });
    await hcTrades.createIndex({ sizeMultiplier: -1 });
    await hcTrades.createIndex({ usdcValue: -1 });

    console.log('[DB] Indexes verified');
  } catch (error: any) {
    console.error('[DB] Index setup error:', error.message);
  }
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

/**
 * Collection names used by this service
 */
export const COLLECTIONS = {
  // Source collections (read-only, populated by other services/scripts)
  EDGE_RANKED_TRADERS: 'ahf-edgeRankedTraders',
  TRADER_PROFILES: 'polymarket-traderProfiles',
  TRACKED_TRADERS: 'polymarket-trackedTraders',

  // Markets (written by market indexer)
  POLY_MARKETS: 'polyMarkets',
  POLY_MARKET_HOLDERS: 'polyMarketHolders',

  // Positions (shared with polymarket-indexer)
  OPEN_POSITIONS: 'polymarket-openPositions',
  CLOSED_POSITIONS: 'polymarket-closedPositions',
  TRADES: 'polymarket-trades',

  // New collections created by this service
  TRADE_ACTIVITIES: 'x-agent-tradeActivities',
  HIGH_CONVICTION_TRADES: 'x-agent-highConvictionTrades',

  // Vault collections (read-only)
  VAULTS: 'vaults',
  VAULT_SNAPSHOTS: 'vault_daily_snapshots',
  VAULT_TRADES: 'vault_trades',
  VAULT_POSITIONS: 'vault_openPositions',
  VAULT_DEPOSITS: 'vault_deposits',
} as const;
