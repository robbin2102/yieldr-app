/**
 * MongoDB Connection for X Content Agent
 */

import { MongoClient, Db } from 'mongodb';
import { CONFIG } from '../config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  const uri = CONFIG.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable is required');

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(CONFIG.DB_NAME);

  console.log('[DB] Connected to MongoDB');
  return db;
}

export async function getDB(): Promise<Db> {
  if (!db) return connectDB();
  return db;
}

export async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

export const COLLECTIONS = {
  // Content tracking
  X_POSTS: 'x_posts',
  X_REPLIES: 'x_replies',
  X_MENTIONS: 'x_mentions',
  X_ENGAGEMENT_LOG: 'x_engagement_log',
  X_BASE_ACCOUNTS: 'x_base_accounts',
  X_CONTENT_LOG: 'x-agent-content-log',   // generated content log (test + prod)

  // Data source collections (read-only, from x-agent-data-service)
  EDGE_RANKED_TRADERS: 'ahf-edgeRankedTraders',
  HIGH_CONVICTION_TRADES: 'x-agent-highConvictionTrades',
  TRADE_ACTIVITIES: 'x-agent-tradeActivities',
  POLY_MARKETS: 'polyMarkets',
  OPEN_POSITIONS: 'polymarket-openPositions',
  VAULTS: 'vaults',
  VAULT_SNAPSHOTS: 'vault_daily_snapshots',
  VAULT_TRADES: 'vault_trades',
} as const;
