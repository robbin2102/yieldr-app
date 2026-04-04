import { MongoClient, Db, Collection } from 'mongodb';
import { CONFIG } from './config';
import { createLogger } from './utils/logger';

const log = createLogger('DB');

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectDB(): Promise<Db> {
  if (db) return db;

  if (!CONFIG.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  client = new MongoClient(CONFIG.MONGODB_URI);
  await client.connect();
  db = client.db(CONFIG.DB_NAME);
  log.success(`Connected to MongoDB → db: ${CONFIG.DB_NAME}`);
  return db;
}

export async function closeDB(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    log.info('MongoDB connection closed');
  }
}

export function getDB(): Db {
  if (!db) throw new Error('DB not connected — call connectDB() first');
  return db;
}

// ── Typed collection getters ──────────────────────────────────

export interface VaultDoc {
  wallet: string;
  status: 'active' | 'paused' | 'upcoming';
  traderLabel?: string;
  initial_capital_usdc?: number;
  vault_size_usdc?: number;
  last_polled_activity_ts?: number; // unix seconds — updated by activity poller
  profiledAt?: Date;
  [key: string]: unknown;
}

export interface VaultOpenPositionsDoc {
  wallet: string;
  profiledAt: Date;
  topOpenPositions: OpenPosition[];
  recentClosedPositions: unknown[];
  recentHighConvictionTrades: unknown[];
  market_titles_summary: unknown[];
  entryOddsBreakdown: unknown[];
  strengths: unknown[];
  weaknesses: unknown[];
  dailyPnLByFrame: Record<string, number[]>;
}

export interface OpenPosition {
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

export interface VaultTradeDoc {
  wallet: string;
  market: string;
  side: 'YES' | 'NO';
  entry_price: number;
  exit_price: number | null;
  size_usdc: number;
  pnl_usdc: number | null;
  status: 'open' | 'win' | 'loss';
  condition_id: string | null;
  opened_at: Date;
  closed_at: Date | null;
}

export interface VaultDailySnapshotDoc {
  wallet: string;
  date: Date;
  cumulative_pnl_usdc: number;
  daily_pnl_usdc: number;
  vault_size_usdc: number;
}

export function getCollections() {
  const database = getDB();
  return {
    vaults:               database.collection<VaultDoc>('vaults'),
    vaultOpenPositions:   database.collection<VaultOpenPositionsDoc>('vault_openPositions'),
    vaultTrades:          database.collection<VaultTradeDoc>('vault_trades'),
    vaultDailySnapshots:  database.collection<VaultDailySnapshotDoc>('vault_daily_snapshots'),
  };
}
