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

  // Ensure proper indexes exist
  await ensureIndexes(db);

  return db;
}

async function ensureIndexes(database: Db): Promise<void> {
  try {
    const alertsCollection = database.collection(COLLECTIONS.TRADE_ALERTS);

    // Check if old txHash_1 index exists and drop it
    const indexes = await alertsCollection.indexes();
    const oldIndex = indexes.find(idx => idx.name === 'txHash_1');
    if (oldIndex) {
      console.log('[DB] Dropping old txHash_1 index...');
      await alertsCollection.dropIndex('txHash_1');
    }

    // Create proper unique index on transactionHash
    await alertsCollection.createIndex(
      { transactionHash: 1 },
      { unique: true, name: 'transactionHash_1' }
    );

    // Create index on traderWallet for faster queries
    await alertsCollection.createIndex(
      { traderWallet: 1, timestamp: -1 },
      { name: 'traderWallet_timestamp' }
    );

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
  TRACKED_TRADERS: 'polymarket-trackedTraders',
  TRADER_PROFILES: 'polymarket-traderProfiles',
  OPEN_POSITIONS: 'polymarket-openPositions',
  TRADE_ALERTS: 'polymarket-tradeAlerts',
  COPY_POSITIONS: 'polymarket-copyPositions',
  WORKER_CONFIG: 'polymarket-workerConfig',
} as const;
