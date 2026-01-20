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

// Collection names
export const COLLECTIONS = {
  TRACKED_TRADERS: 'polymarket-trackedTraders',
  TRADER_PROFILES: 'polymarket-traderProfiles',
  OPEN_POSITIONS: 'polymarket-openPositions',
  TRADE_ALERTS: 'polymarket-tradeAlerts',
  COPY_POSITIONS: 'polymarket-copyPositions',
  WORKER_CONFIG: 'polymarket-workerConfig',
} as const;
