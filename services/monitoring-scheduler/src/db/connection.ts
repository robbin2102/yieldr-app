import { MongoClient, Db, Collection } from 'mongodb';

let client: MongoClient | null = null;
let db: Db | null = null;

const DB_NAME = 'yieldr';

export const COLLECTIONS = {
  MONITORING_TASKS: 'monitoring_tasks',
  MONITORING_ALERTS: 'monitoring_alerts',
  MONITORING_TASK_LOGS: 'monitoring_task_logs',
  USER_POSITIONS: 'user_positions',
  AGENTS: 'agents',
} as const;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);

  console.log('[DB] Connected to MongoDB');
  await ensureIndexes(db);

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
    console.log('[DB] Connection closed');
  }
}

export function getCollection<T extends Document = any>(name: string): Collection<T> {
  if (!db) throw new Error('DB not connected — call connectDB() first');
  return db.collection<T>(name);
}

async function ensureIndexes(db: Db): Promise<void> {
  const tasks = db.collection(COLLECTIONS.MONITORING_TASKS);
  const alerts = db.collection(COLLECTIONS.MONITORING_ALERTS);
  const logs = db.collection(COLLECTIONS.MONITORING_TASK_LOGS);
  const positions = db.collection(COLLECTIONS.USER_POSITIONS);

  await Promise.all([
    // monitoring_tasks
    tasks.createIndex({ userId: 1, status: 1 }),
    tasks.createIndex({ status: 1, nextRunAt: 1 }),
    tasks.createIndex({ agentId: 1 }),

    // monitoring_alerts
    alerts.createIndex({ userId: 1, read: 1, createdAt: -1 }),
    alerts.createIndex({ agentId: 1, createdAt: -1 }),
    alerts.createIndex({ taskId: 1, createdAt: -1 }),
    alerts.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }), // 30d TTL

    // monitoring_task_logs
    logs.createIndex({ taskId: 1, timestamp: -1 }),
    logs.createIndex({ agentId: 1, timestamp: -1 }),
    logs.createIndex({ timestamp: 1 }, { expireAfterSeconds: 604800 }), // 7d TTL

    // user_positions
    positions.createIndex({ userId: 1, platform: 1 }, { unique: true }),
    positions.createIndex({ lastUpdated: 1 }),
  ]);

  console.log('[DB] Indexes ensured');
}
