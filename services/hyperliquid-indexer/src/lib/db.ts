/**
 * MongoDB Connection for Hyperliquid Indexer
 */

import { MongoClient, Db, Collection } from 'mongodb';

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

  // Ensure indexes exist
  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  try {
    // Fills collection indexes
    const fillsCollection = database.collection(COLLECTIONS.FILLS);
    await fillsCollection.createIndex({ walletAddress: 1, tid: 1 }, { unique: true });
    await fillsCollection.createIndex({ walletAddress: 1, time: -1 });
    await fillsCollection.createIndex({ walletAddress: 1, coin: 1, time: -1 });

    // Positions collection indexes
    const positionsCollection = database.collection(COLLECTIONS.POSITIONS);
    await positionsCollection.createIndex({ walletAddress: 1, coin: 1 }, { unique: true });
    await positionsCollection.createIndex({ walletAddress: 1 });

    // Metrics collection indexes
    const metricsCollection = database.collection(COLLECTIONS.METRICS);
    await metricsCollection.createIndex({ walletAddress: 1 }, { unique: true });
    await metricsCollection.createIndex({ pnl_allTime: -1 });
    await metricsCollection.createIndex({ winRate: -1 });
    await metricsCollection.createIndex({ sharpeRatio: -1 });

    // PnL snapshots collection indexes
    const snapshotsCollection = database.collection(COLLECTIONS.PNL_SNAPSHOTS);
    await snapshotsCollection.createIndex({ walletAddress: 1, timestamp: -1 });

    // Tracked wallets collection indexes
    const walletsCollection = database.collection(COLLECTIONS.TRACKED_WALLETS);
    await walletsCollection.createIndex({ walletAddress: 1 }, { unique: true });
    await walletsCollection.createIndex({ isActive: 1 });

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

// Collection names
export const COLLECTIONS = {
  FILLS: 'hyperliquidfills',
  POSITIONS: 'hyperliquidpositions',
  METRICS: 'hyperliquidmetrics',
  PNL_SNAPSHOTS: 'hyperliquidpnlsnapshots',
  TRACKED_WALLETS: 'hyperliquid-trackedWallets',
} as const;

// Helper to get typed collections
export async function getCollections() {
  const database = await getDB();
  return {
    fills: database.collection(COLLECTIONS.FILLS),
    positions: database.collection(COLLECTIONS.POSITIONS),
    metrics: database.collection(COLLECTIONS.METRICS),
    pnlSnapshots: database.collection(COLLECTIONS.PNL_SNAPSHOTS),
    trackedWallets: database.collection(COLLECTIONS.TRACKED_WALLETS),
  };
}
