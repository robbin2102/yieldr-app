#!/usr/bin/env ts-node

/**
 * Verify metrics for a single trader
 * Usage: npx tsx scripts/verify-single-trader.ts <wallet>
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const API_BASE = 'https://data-api.polymarket.com';
const PROFILE_DAYS = 30;

// Get wallet from command line or use default
const WALLET = process.argv[2] || '0xdc876e6873772d38716fda7f2452a78d426d7ab6';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchActivities(wallet: string): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (PROFILE_DAYS * 24 * 60 * 60);
  let all: any[] = [];
  let offset = 0;

  while (offset <= 5000) {
    await sleep(100);
    const url = `${API_BASE}/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    const batch = await res.json() as any[];
    if (batch.length === 0) break;

    for (const a of batch) {
      if (a.timestamp >= startTs) all.push(a);
      else return all;
    }
    if (batch.length < 500) break;
    offset += 500;
  }
  return all;
}

async function fetchOpenPositions(wallet: string): Promise<any[]> {
  await sleep(100);
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const res = await fetch(url);
  return res.json() as Promise<any[]>;
}

async function fetchClosedPositions(wallet: string): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (PROFILE_DAYS * 24 * 60 * 60);
  let all: any[] = [];
  let offset = 0;

  while (offset <= 5000) {
    await sleep(100);
    const url = `${API_BASE}/positions?user=${wallet}&limit=500&offset=${offset}&sortBy=LATEST_TRADE_TIMESTAMP&sortDirection=DESC&sizeThreshold=0&redeemed=true`;
    const res = await fetch(url);
    const batch = await res.json() as any[];
    if (batch.length === 0) break;

    for (const p of batch) {
      if (p.timestamp >= startTs) all.push(p);
    }
    if (batch.some((p: any) => p.timestamp < startTs) || batch.length < 500) break;
    offset += 500;
  }
  return all;
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('           SINGLE TRADER METRICS VERIFICATION');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not found');
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  const db = mongoose.connection.db;
  if (!db) { console.error('No DB'); process.exit(1); }

  // Get stored profile
  const stored = await db.collection('polymarket-traderProfiles').findOne({ wallet: WALLET.toLowerCase() });

  if (!stored) {
    console.log(`No profile found for wallet: ${WALLET}`);
    await mongoose.connection.close();
    return;
  }

  console.log(`Wallet: ${WALLET}`);
  console.log(`Stored Label: ${stored.label || 'N/A'}\n`);

  // Fetch fresh data
  console.log('📡 Fetching fresh data from Polymarket API...\n');

  const activities = await fetchActivities(WALLET);
  const openPositions = await fetchOpenPositions(WALLET);
  const closedPositions = await fetchClosedPositions(WALLET);

  console.log(`  Activities (30d): ${activities.length}`);
  console.log(`  Open positions: ${openPositions.length}`);
  console.log(`  Closed positions (30d): ${closedPositions.length}\n`);

  // ══════════════════════════════════════════════════════════════
  // COMPUTE METRICS
  // ══════════════════════════════════════════════════════════════

  const trades = activities.filter(a => a.type === 'TRADE');
  const buyCount = trades.filter(t => t.side === 'BUY').length;
  const sellCount = trades.filter(t => t.side === 'SELL').length;
  const totalTrades = buyCount + sellCount;

  const realizedPnl = closedPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;

  const wins = closedPositions.filter(p => p.realizedPnl >= 0).length;
  const losses = closedPositions.filter(p => p.realizedPnl < 0).length;
  const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

  const grossProfit = closedPositions.filter(p => p.realizedPnl > 0).reduce((sum, p) => sum + p.realizedPnl, 0);
  const grossLoss = Math.abs(closedPositions.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.realizedPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  const tradeSizes = trades.map(t => t.usdcSize).filter(s => s > 0);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;

  // ══════════════════════════════════════════════════════════════
  // COMPARE
  // ══════════════════════════════════════════════════════════════

  console.log('════════════════════════════════════════════════════════════════');
  console.log('                    METRICS COMPARISON');
  console.log('════════════════════════════════════════════════════════════════\n');

  const compare = (name: string, computed: number, storedVal: number | undefined, tolerance: number = 0.01) => {
    const storedNum = storedVal ?? 0;
    const diff = Math.abs(computed - storedNum);
    const pctDiff = storedNum !== 0 ? (diff / Math.abs(storedNum)) * 100 : (computed === 0 ? 0 : 100);
    const match = pctDiff <= tolerance * 100;

    console.log(`${name}:`);
    console.log(`  Computed: ${computed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`  Stored:   ${storedNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`  Diff:     ${pctDiff.toFixed(2)}% ${match ? '✅' : '❌'}`);
    console.log('');
    return match;
  };

  const results: boolean[] = [];

  // Check if stored has old schema (netPnl) or new schema (totalPnl)
  const storedPnl = stored.totalPnl ?? stored.netPnl;
  const storedWinRate = stored.winRate;
  const storedProfitFactor = stored.profitFactor;
  const storedTotalTrades = stored.totalTrades;
  const storedAvgTradeSize = stored.avgTradeSize;
  const storedClosedCount = stored.closedPositionsCount;
  const storedOpenCount = stored.openPositionsCount;
  const storedUnrealizedPnl = stored.unrealizedPnl;

  console.log('─── P&L ───\n');
  results.push(compare('Realized P&L', realizedPnl, stored.realizedPnl, 0.05));
  results.push(compare('Unrealized P&L', unrealizedPnl, storedUnrealizedPnl, 0.10)); // More tolerance - positions change
  results.push(compare('Total P&L', totalPnl, storedPnl, 0.05));

  console.log('─── TRADING STATS ───\n');
  results.push(compare('Total Trades', totalTrades, storedTotalTrades, 0.05));
  results.push(compare('Win Rate (%)', winRate, storedWinRate, 0.05));
  results.push(compare('Profit Factor', profitFactor, storedProfitFactor, 0.10));
  results.push(compare('Avg Trade Size', avgTradeSize, storedAvgTradeSize, 0.05));

  console.log('─── POSITION COUNTS ───\n');
  results.push(compare('Closed Positions', closedPositions.length, storedClosedCount, 0.05));
  results.push(compare('Open Positions', openPositions.length, storedOpenCount, 0.20)); // More tolerance

  // Consistency metrics (if new schema)
  if (stored.consistency) {
    console.log('─── CONSISTENCY (stored values) ───\n');
    console.log(`  Trading Days: ${stored.consistency.tradingDays}`);
    console.log(`  Profitable Days: ${stored.consistency.profitableDays}`);
    console.log(`  Consistency Score: ${stored.consistency.consistencyScore?.toFixed(3)}`);
    console.log(`  Longest Win Streak: ${stored.consistency.longestWinStreak}`);
    console.log(`  Longest Loss Streak: ${stored.consistency.longestLossStreak}`);
    console.log('');
  }

  if (stored.risk) {
    console.log('─── RISK (stored values) ───\n');
    console.log(`  Max Drawdown: $${stored.risk.maxDrawdown?.toLocaleString()}`);
    console.log(`  Max Drawdown %: ${stored.risk.maxDrawdownPercent?.toFixed(1)}%`);
    console.log(`  Return on Capital 7d: ${stored.risk.returnOnCapital7d?.toFixed(2)}%`);
    console.log('');
  }

  if (stored.edgeLoss) {
    console.log('─── EDGE LOSS (stored values) ───\n');
    console.log(`  Baseline Win Rate: ${stored.edgeLoss.baselineWinRate?.toFixed(1)}%`);
    console.log(`  Recent Win Rate: ${stored.edgeLoss.recentWinRate?.toFixed(1)}%`);
    console.log(`  Win Rate Decline: ${stored.edgeLoss.winRateDecline?.toFixed(1)}%`);
    console.log(`  Has Warning: ${stored.edgeLoss.signals?.hasEdgeLossWarning ? 'YES ⚠️' : 'NO'}`);
    console.log('');
  }

  // Summary
  const passCount = results.filter(r => r).length;
  console.log('════════════════════════════════════════════════════════════════');
  console.log('                        SUMMARY');
  console.log('════════════════════════════════════════════════════════════════\n');
  console.log(`  Checks Passed: ${passCount}/${results.length}`);
  console.log(`  Result: ${passCount === results.length ? '✅ ALL METRICS MATCH' : '⚠️ SOME DIFFERENCES (may be due to time elapsed)'}`);
  console.log('');

  await mongoose.connection.close();
  console.log('MongoDB connection closed');
}

main().catch(console.error);
