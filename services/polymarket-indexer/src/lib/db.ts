/**
 * MongoDB Connection for Polymarket Indexer
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

  console.log('[DB] Connected to MongoDB (v2)');

  // Ensure indexes exist
  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  try {
    // STEP 1: Drop ALL stale indexes first
    const closedPosCollection = database.collection(COLLECTIONS.CLOSED_POSITIONS);
    const openPosCollection = database.collection(COLLECTIONS.OPEN_POSITIONS);

    // Drop stale indexes - wrap each in try/catch
    // These include indexes from both polymarket-indexer AND polymarket-worker
    const staleIndexes = [
      { collection: closedPosCollection, name: 'tradeId_1', desc: 'closedPositions.tradeId_1' },
      { collection: openPosCollection, name: 'wallet_1_conditionId_1', desc: 'openPositions.wallet_1_conditionId_1' },
      { collection: openPosCollection, name: 'walletAddress_1_conditionId_1_asset_1', desc: 'openPositions.walletAddress_1_conditionId_1_asset_1' },
    ];

    for (const idx of staleIndexes) {
      try {
        await idx.collection.dropIndex(idx.name);
        console.log(`[DB] Dropped stale index: ${idx.desc}`);
      } catch {
        // Index doesn't exist, ignore
      }
    }

    // STEP 2: Clean up bad data (documents with null wallet/walletAddress from both services)
    const deleteResult = await openPosCollection.deleteMany({
      $or: [{ wallet: null }, { walletAddress: null }]
    });
    if (deleteResult.deletedCount > 0) {
      console.log(`[DB] Cleaned up ${deleteResult.deletedCount} documents with null wallet from openPositions`);
    }

    const closedDeleteResult = await closedPosCollection.deleteMany({ wallet: null });
    if (closedDeleteResult.deletedCount > 0) {
      console.log(`[DB] Cleaned up ${closedDeleteResult.deletedCount} documents with null wallet from closedPositions`);
    }

    // STEP 3: Create indexes
    // Tracked traders collection indexes
    const trackedCollection = database.collection(COLLECTIONS.TRACKED_TRADERS);
    await trackedCollection.createIndex({ wallet: 1 }, { unique: true });
    await trackedCollection.createIndex({ isActive: 1 });

    // Trader profiles collection indexes
    const profilesCollection = database.collection(COLLECTIONS.TRADER_PROFILES);
    await profilesCollection.createIndex({ wallet: 1 }, { unique: true });
    await profilesCollection.createIndex({ 'metrics.netPnl': -1 });
    await profilesCollection.createIndex({ 'metrics.winRate': -1 });
    await profilesCollection.createIndex({ 'metrics.profitFactor': -1 });
    await profilesCollection.createIndex({ 'specialty': 1 });

    // Open positions collection indexes - include outcome for Yes/No positions
    await openPosCollection.createIndex({ wallet: 1, conditionId: 1, outcome: 1 }, { unique: true });
    await openPosCollection.createIndex({ wallet: 1 });

    // Trades collection indexes
    const tradesCollection = database.collection(COLLECTIONS.TRADES);
    await tradesCollection.createIndex({ wallet: 1, transactionHash: 1 }, { unique: true });
    await tradesCollection.createIndex({ wallet: 1, timestamp: -1 });

    // Closed positions collection indexes
    await closedPosCollection.createIndex(
      { wallet: 1, conditionId: 1, outcome: 1 },
      { unique: true }
    );
    await closedPosCollection.createIndex({ wallet: 1, timestamp: -1 });

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

// Collection names - matches polymarket-worker
export const COLLECTIONS = {
  TRACKED_TRADERS: 'polymarket-trackedTraders',
  TRADER_PROFILES: 'polymarket-traderProfiles',
  OPEN_POSITIONS: 'polymarket-openPositions',
  TRADES: 'polymarket-trades',
  CLOSED_POSITIONS: 'polymarket-closedPositions',
} as const;

// Helper to get typed collections
export async function getCollections() {
  const database = await getDB();
  return {
    trackedTraders: database.collection(COLLECTIONS.TRACKED_TRADERS),
    traderProfiles: database.collection(COLLECTIONS.TRADER_PROFILES),
    openPositions: database.collection(COLLECTIONS.OPEN_POSITIONS),
    trades: database.collection(COLLECTIONS.TRADES),
    closedPositions: database.collection(COLLECTIONS.CLOSED_POSITIONS),
  };
}
