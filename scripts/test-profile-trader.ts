#!/usr/bin/env ts-node

/**
 * Test Trader Profiler
 * Profiles a single wallet using the same logic as the working API
 *
 * Usage: npx tsx scripts/test-profile-trader.ts <wallet>
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });

import { MongoClient } from 'mongodb';

const API_BASE = 'https://data-api.polymarket.com';
const PROFILE_DAYS = 30;

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

interface ClosedPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

// Fetch with timeout
async function fetchWithTimeout(url: string, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch activities
async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 3000;

  let allActivities: Activity[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    console.log(`  Fetching activities offset=${offset}...`);

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      console.log(`  API returned ${response.status}, stopping`);
      break;
    }

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    for (const activity of batch) {
      if (activity.timestamp >= cutoffTs) {
        allActivities.push(activity);
      } else {
        return allActivities;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  return allActivities;
}

// Fetch open positions
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&sortBy=CURRENT_VALUE&sortDirection=DESC`;
  console.log('  Fetching open positions...');

  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  return response.json();
}

// Fetch closed positions
async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;

  let allClosed: ClosedPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/positions/closed?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    console.log(`  Fetching closed positions offset=${offset}...`);

    const response = await fetchWithTimeout(url);
    if (!response.ok) break;

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= cutoffTs) {
        allClosed.push(pos);
      } else {
        return allClosed;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  return allClosed;
}

// Compute metrics from activities
function computeMetrics(activities: Activity[], openPositions: OpenPosition[], closedPositions: ClosedPosition[]) {
  // Count trades
  const trades = activities.filter(a => a.type === 'TRADE');
  const buys = trades.filter(t => t.side === 'BUY');
  const sells = trades.filter(t => t.side === 'SELL');
  const redeems = activities.filter(a => a.type === 'REDEEM');

  // Calculate volumes
  const buyVolume = buys.reduce((sum, t) => sum + t.usdcSize, 0);
  const sellVolume = sells.reduce((sum, t) => sum + t.usdcSize, 0);
  const redeemVolume = redeems.reduce((sum, r) => sum + r.usdcSize, 0);

  // Open position stats
  const openUnrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);

  // Closed position stats
  const closedRealizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);

  // Calculate cash-flow based P&L
  // P&L = Sells + Redeems + EndingValue - Buys
  const cashFlowPnl = sellVolume + redeemVolume + openValue - buyVolume;

  // Win rate from closed positions
  const winningPositions = closedPositions.filter(p => p.realizedPnl > 0);
  const winRate = closedPositions.length > 0
    ? (winningPositions.length / closedPositions.length) * 100
    : 0;

  // Trades per day
  const days = PROFILE_DAYS;
  const tradesPerDay = trades.length / days;

  // Unique markets traded
  const uniqueMarkets = new Set(activities.map(a => a.conditionId));

  // Last activity
  const lastActivityTs = activities.length > 0 ? Math.max(...activities.map(a => a.timestamp)) : null;

  return {
    totalTrades: trades.length,
    buys: buys.length,
    sells: sells.length,
    redeems: redeems.length,
    buyVolume,
    sellVolume,
    redeemVolume,
    totalVolume: buyVolume + sellVolume,
    openPositions: openPositions.length,
    openValue,
    openUnrealizedPnl,
    closedPositions: closedPositions.length,
    closedRealizedPnl,
    cashFlowPnl,
    totalPnl: closedRealizedPnl + openUnrealizedPnl,
    winRate,
    tradesPerDay,
    uniqueMarkets: uniqueMarkets.size,
    lastActivityTs,
    lastActivityDate: lastActivityTs ? new Date(lastActivityTs * 1000).toISOString() : null,
  };
}

// Extract database name from URI
function extractDbName(mongoUri: string): string {
  try {
    const url = new URL(mongoUri);
    const dbName = url.pathname.replace('/', '');
    return dbName || 'yieldr';
  } catch {
    const match = mongoUri.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] || 'yieldr';
  }
}

async function main() {
  const wallet = process.argv[2];
  if (!wallet) {
    console.error('Usage: npx tsx scripts/test-profile-trader.ts <wallet>');
    process.exit(1);
  }

  console.log('\n===========================================');
  console.log('  TRADER PROFILER TEST');
  console.log('===========================================\n');
  console.log('Wallet:', wallet);
  console.log('Profile period:', PROFILE_DAYS, 'days\n');

  // Fetch data from Polymarket API
  console.log('--- Fetching from Polymarket API ---\n');

  const activities = await fetchActivities(wallet, PROFILE_DAYS);
  console.log(`  Total activities: ${activities.length}`);

  const openPositions = await fetchOpenPositions(wallet);
  console.log(`  Open positions: ${openPositions.length}`);

  const closedPositions = await fetchClosedPositions(wallet, PROFILE_DAYS);
  console.log(`  Closed positions: ${closedPositions.length}`);

  // Compute metrics
  console.log('\n--- Computing Metrics ---\n');
  const metrics = computeMetrics(activities, openPositions, closedPositions);

  console.log('Trading Activity:');
  console.log(`  Total trades: ${metrics.totalTrades}`);
  console.log(`  Buys: ${metrics.buys} ($${metrics.buyVolume.toFixed(2)})`);
  console.log(`  Sells: ${metrics.sells} ($${metrics.sellVolume.toFixed(2)})`);
  console.log(`  Redeems: ${metrics.redeems} ($${metrics.redeemVolume.toFixed(2)})`);
  console.log(`  Total volume: $${metrics.totalVolume.toFixed(2)}`);
  console.log(`  Trades/day: ${metrics.tradesPerDay.toFixed(2)}`);
  console.log(`  Unique markets: ${metrics.uniqueMarkets}`);

  console.log('\nPositions:');
  console.log(`  Open: ${metrics.openPositions} (value: $${metrics.openValue.toFixed(2)})`);
  console.log(`  Closed: ${metrics.closedPositions}`);

  console.log('\nP&L:');
  console.log(`  Open unrealized P&L: $${metrics.openUnrealizedPnl.toFixed(2)}`);
  console.log(`  Closed realized P&L: $${metrics.closedRealizedPnl.toFixed(2)}`);
  console.log(`  Cash-flow P&L: $${metrics.cashFlowPnl.toFixed(2)}`);
  console.log(`  Total P&L: $${metrics.totalPnl.toFixed(2)}`);
  console.log(`  Win rate: ${metrics.winRate.toFixed(1)}%`);

  console.log('\nActivity:');
  console.log(`  Last activity: ${metrics.lastActivityDate}`);

  // Save to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    console.log('\n--- Saving to MongoDB ---\n');

    const client = new MongoClient(mongoUri);
    await client.connect();
    const db = client.db(extractDbName(mongoUri));

    const profile = {
      wallet: wallet.toLowerCase(),
      profiledAt: new Date(),
      periodDays: PROFILE_DAYS,
      ...metrics,
    };

    await db.collection('polymarket-traderProfiles').updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: profile },
      { upsert: true }
    );

    console.log('  Saved to polymarket-traderProfiles');

    await client.close();
  }

  console.log('\n===========================================');
  console.log('  DONE');
  console.log('===========================================\n');
}

main().catch(console.error);
