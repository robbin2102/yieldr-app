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
    // x-agent-highConvictionTrades indexes (materialized view)
    const hcTrades = database.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);
    await hcTrades.createIndex({ transactionHash: 1 }, { unique: true });
    await hcTrades.createIndex({ detectedAt: -1 });
    await hcTrades.createIndex({ sizeMultiplier: -1 });
    await hcTrades.createIndex({ usdcValue: -1 });
    await hcTrades.createIndex({ postedToX: 1 });

    // polymarket-openPositions indexes (materialized view)
    const openPos = database.collection(COLLECTIONS.OPEN_POSITIONS);
    await openPos.createIndex({ wallet: 1, title: 1, outcome: 1 });
    await openPos.createIndex({ title: 'text' });

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
  // Pipeline output collections (written by scripts)
  LEADERBOARD_SNAPSHOTS: 'polymarket-leaderboardSnapshots',
  CONSISTENT_TRADERS: 'polymarket-consistentTraders',
  TRADER_PROFILES: 'polymarket-traderProfiles',
  TRADER_POSITIONS: 'polymarket-traderPositions',
  EDGE_RANKED_TRADERS: 'ahf-edgeRankedTraders',

  // Markets (written by market indexer)
  POLY_MARKETS: 'polyMarkets',

  // Materialized views (written by materialize.ts after pipeline)
  HIGH_CONVICTION_TRADES: 'x-agent-highConvictionTrades',
  OPEN_POSITIONS: 'polymarket-openPositions',

  // Vault collections (read-only, populated by vault logging service)
  VAULTS: 'vaults',
  VAULT_SNAPSHOTS: 'vault_daily_snapshots',
  VAULT_TRADES: 'vault_trades',
  VAULT_POSITIONS: 'vault_openPositions',
} as const;
