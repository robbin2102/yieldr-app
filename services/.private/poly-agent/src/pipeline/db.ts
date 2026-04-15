/**
 * MongoDB Connection for the Trader Pipeline
 *
 * Separate from the trading bot's Mongoose connection (src/db/connection.ts).
 * Uses the native MongoDB driver (not Mongoose) to match the x-agent-data-service pattern.
 */

import { MongoClient, Db } from 'mongodb';
import { PIPELINE_CONFIG } from './pipeline-config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectPipelineDB(): Promise<Db> {
  if (db) return db;

  const uri = PIPELINE_CONFIG.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is required');

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(PIPELINE_CONFIG.DB_NAME);

  console.log('[PipelineDB] Connected to MongoDB');
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  try {
    // x-agent-highConvictionTrades (materialized view)
    const hcTrades = database.collection(COLLECTIONS.HIGH_CONVICTION_TRADES);
    await hcTrades.createIndex({ transactionHash: 1 }, { unique: true });
    await hcTrades.createIndex({ detectedAt: -1 });
    await hcTrades.createIndex({ sizeMultiplier: -1 });
    await hcTrades.createIndex({ usdcValue: -1 });
    await hcTrades.createIndex({ postedToX: 1 });

    // polymarket-openPositions (materialized view)
    const openPos = database.collection(COLLECTIONS.OPEN_POSITIONS);
    await openPos.createIndex({ wallet: 1, title: 1, outcome: 1 });
    await openPos.createIndex({ title: 'text' });

    console.log('[PipelineDB] Indexes verified');
  } catch (error: any) {
    console.error('[PipelineDB] Index setup error:', error.message);
  }
}

export async function getPipelineDB(): Promise<Db> {
  if (!db) return connectPipelineDB();
  return db;
}

export async function closePipelineDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[PipelineDB] Connection closed');
  }
}

/**
 * Collection names used by the trader ranking pipeline
 */
export const COLLECTIONS = {
  // Pipeline output collections (written by scripts)
  LEADERBOARD_SNAPSHOTS: 'polymarket-leaderboardSnapshots',
  CONSISTENT_TRADERS:    'polymarket-consistentTraders',
  TRADER_PROFILES:       'polymarket-traderProfiles',
  TRADER_POSITIONS:      'polymarket-traderPositions',
  EDGE_RANKED_TRADERS:   'ahf-edgeRankedTraders',

  // Markets (written by market indexer)
  POLY_MARKETS: 'polyMarkets',

  // Materialized views (written by materialize.ts after pipeline)
  HIGH_CONVICTION_TRADES: 'x-agent-highConvictionTrades',
  OPEN_POSITIONS:         'polymarket-openPositions',
} as const;
