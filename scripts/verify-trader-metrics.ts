#!/usr/bin/env ts-node

/**
 * Metrics Verification Test - NEW SCHEMA ONLY
 *
 * Picks one profitable and one losing trader from NEW schema profiles,
 * re-computes all metrics, and compares with stored values.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const API_BASE = 'https://data-api.polymarket.com';
const PROFILE_DAYS = 30;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchClosedPositions(wallet: string, days: number): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 5000;

  let allPositions: any[] = [];
  let offset = 0;

  console.log(`    Fetching closed positions (last ${days} days)...`);

  while (offset <= MAX_OFFSET) {
    await sleep(150);
    const url = `${API_BASE}/positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=LATEST_TRADE_TIMESTAMP&sortDirection=DESC&sizeThreshold=0&redeemed=true`;

    try {
      const response = await fetch(url);
      const batch = await response.json() as any[];

      if (!Array.isArray(batch) || batch.length === 0) {
        console.log(`    Offset ${offset}: 0 positions returned`);
        break;
      }

      let countInRange = 0;
      let hitOldData = false;

      for (const pos of batch) {
        if (pos.timestamp >= startTs) {
          allPositions.push(pos);
          countInRange++;
        } else {
          hitOldData = true;
        }
      }

      console.log(`    Offset ${offset}: ${batch.length} fetched, ${countInRange} in 30d range`);

      if (hitOldData || batch.length < LIMIT) break;
      offset += LIMIT;
    } catch (error) {
      console.log(`    Error at offset ${offset}:`, error);
      break;
    }
  }

  return allPositions;
}

async function fetchOpenPositions(wallet: string): Promise<any[]> {
  await sleep(150);
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const response = await fetch(url);
  return response.json() as Promise<any[]>;
}

async function verifyTrader(wallet: string, stored: any): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`VERIFYING: ${wallet}`);
  console.log(`Stored Label: ${stored.label || 'N/A'}`);
  console.log(`Stored Total P&L: $${stored.totalPnl?.toLocaleString()}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Fetch fresh data
  console.log('📡 Fetching fresh data from Polymarket API...\n');

  const closedPositions = await fetchClosedPositions(wallet, PROFILE_DAYS);
  const openPositions = await fetchOpenPositions(wallet);

  console.log(`\n  Total closed positions (30d): ${closedPositions.length}`);
  console.log(`  Total open positions: ${openPositions.length}\n`);

  // ════════════════════════════════════════════════════════════════
  // COMPUTE METRICS
  // ════════════════════════════════════════════════════════════════

  const realizedPnl = closedPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const totalPnl = realizedPnl + unrealizedPnl;

  const wins = closedPositions.filter(p => (p.realizedPnl || 0) >= 0).length;
  const losses = closedPositions.filter(p => (p.realizedPnl || 0) < 0).length;
  const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

  const grossProfit = closedPositions.filter(p => (p.realizedPnl || 0) > 0).reduce((sum, p) => sum + p.realizedPnl, 0);
  const grossLoss = Math.abs(closedPositions.filter(p => (p.realizedPnl || 0) < 0).reduce((sum, p) => sum + p.realizedPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  // ════════════════════════════════════════════════════════════════
  // COMPARE METRICS
  // ════════════════════════════════════════════════════════════════

  console.log('════════════════════════════════════════════════════════════════');
  console.log('                    METRICS COMPARISON');
  console.log('════════════════════════════════════════════════════════════════\n');

  const compare = (name: string, computed: number, storedVal: number | undefined, tolerancePct: number = 5) => {
    const storedNum = storedVal ?? 0;
    const diff = Math.abs(computed - storedNum);
    const pctDiff = storedNum !== 0 ? (diff / Math.abs(storedNum)) * 100 : (computed === 0 ? 0 : 100);
    const match = pctDiff <= tolerancePct;

    console.log(`${name}:`);
    console.log(`  Computed: ${computed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`  Stored:   ${storedNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`  Diff:     ${pctDiff.toFixed(2)}% ${match ? '✅' : '❌'}`);
    console.log('');
    return match;
  };

  const results: boolean[] = [];

  console.log('─── P&L ───\n');
  results.push(compare('Realized P&L', realizedPnl, stored.realizedPnl, 10));
  results.push(compare('Unrealized P&L', unrealizedPnl, stored.unrealizedPnl, 20));
  results.push(compare('Total P&L', totalPnl, stored.totalPnl, 10));

  console.log('─── TRADING STATS ───\n');
  results.push(compare('Win Rate (%)', winRate, stored.winRate, 5));
  results.push(compare('Profit Factor', profitFactor, stored.profitFactor, 15));

  console.log('─── POSITION COUNTS ───\n');
  results.push(compare('Closed Positions', closedPositions.length, stored.closedPositionsCount, 10));
  results.push(compare('Open Positions', openPositions.length, stored.openPositionsCount, 30));

  // Show consistency metrics from stored profile
  if (stored.consistency) {
    console.log('─── STORED CONSISTENCY METRICS ───\n');
    console.log(`  Trading Days: ${stored.consistency.tradingDays}`);
    console.log(`  Profitable Days: ${stored.consistency.profitableDays}`);
    console.log(`  Losing Days: ${stored.consistency.losingDays}`);
    console.log(`  Consistency Score: ${stored.consistency.consistencyScore?.toFixed(3)}`);
    console.log(`  Longest Win Streak: ${stored.consistency.longestWinStreak} days`);
    console.log(`  Longest Loss Streak: ${stored.consistency.longestLossStreak} days`);
    console.log('');
  }

  if (stored.risk) {
    console.log('─── STORED RISK METRICS ───\n');
    console.log(`  Max Drawdown: $${stored.risk.maxDrawdown?.toLocaleString()}`);
    console.log(`  Max Drawdown %: ${stored.risk.maxDrawdownPercent?.toFixed(1)}%`);
    console.log(`  Return on Capital 7d: ${stored.risk.returnOnCapital7d?.toFixed(2)}%`);
    console.log('');
  }

  if (stored.edgeLoss) {
    console.log('─── STORED EDGE LOSS SIGNALS ───\n');
    console.log(`  Baseline Win Rate: ${stored.edgeLoss.baselineWinRate?.toFixed(1)}%`);
    console.log(`  Recent Win Rate: ${stored.edgeLoss.recentWinRate?.toFixed(1)}%`);
    console.log(`  Win Rate Decline: ${stored.edgeLoss.winRateDecline?.toFixed(1)}%`);
    console.log(`  Has Warning: ${stored.edgeLoss.signals?.hasEdgeLossWarning ? 'YES ⚠️' : 'NO ✅'}`);
    console.log('');
  }

  // Summary
  const passCount = results.filter(r => r).length;
  console.log('════════════════════════════════════════════════════════════════');
  console.log('                      VERIFICATION SUMMARY');
  console.log('════════════════════════════════════════════════════════════════\n');
  console.log(`  Checks Passed: ${passCount}/${results.length}`);

  if (passCount === results.length) {
    console.log(`  Result: ✅ ALL CORE METRICS MATCH`);
  } else if (passCount >= results.length - 2) {
    console.log(`  Result: ⚠️ MOSTLY MATCHING (small differences due to time elapsed)`);
  } else {
    console.log(`  Result: ❌ SIGNIFICANT DIFFERENCES - may need investigation`);
  }
  console.log('');
}

async function main(): Promise<void> {
  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                                                              █');
  console.log('█         TRADER METRICS VERIFICATION (NEW SCHEMA)             █');
  console.log('█                                                              █');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not found');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  const db = mongoose.connection.db;
  if (!db) {
    console.error('ERROR: Database not available');
    process.exit(1);
  }

  const collection = db.collection('polymarket-traderProfiles');

  try {
    // First, count how many profiles we have with new schema
    const totalNewSchema = await collection.countDocuments({ consistency: { $exists: true } });
    console.log(`Total profiles with NEW schema: ${totalNewSchema.toLocaleString()}\n`);

    if (totalNewSchema === 0) {
      console.log('ERROR: No profiles with new schema found!');
      await mongoose.connection.close();
      return;
    }

    // Find profitable traders with new schema
    console.log('Searching for profitable traders (totalPnl > $1000, 10+ closed positions)...');

    const profitableTraders = await collection
      .find({
        consistency: { $exists: true },
        totalPnl: { $gt: 1000 },
        closedPositionsCount: { $gte: 10 }
      })
      .sort({ totalPnl: -1 })
      .limit(50)
      .toArray();

    console.log(`Found ${profitableTraders.length} profitable traders\n`);

    // Find losing traders with new schema
    console.log('Searching for losing traders (totalPnl < -$500, 10+ closed positions)...');

    const losingTraders = await collection
      .find({
        consistency: { $exists: true },
        totalPnl: { $lt: -500 },
        closedPositionsCount: { $gte: 10 }
      })
      .sort({ totalPnl: 1 })
      .limit(50)
      .toArray();

    console.log(`Found ${losingTraders.length} losing traders\n`);

    // Pick random traders
    const randomProfitable = profitableTraders.length > 0
      ? profitableTraders[Math.floor(Math.random() * Math.min(20, profitableTraders.length))]
      : null;

    const randomLosing = losingTraders.length > 0
      ? losingTraders[Math.floor(Math.random() * Math.min(20, losingTraders.length))]
      : null;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    SELECTED TRADERS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (randomProfitable) {
      console.log(`PROFITABLE: ${randomProfitable.wallet}`);
      console.log(`  P&L: $${randomProfitable.totalPnl?.toLocaleString()}`);
      console.log(`  Win Rate: ${randomProfitable.winRate?.toFixed(1)}%`);
      console.log(`  Closed Positions: ${randomProfitable.closedPositionsCount}`);
    } else {
      console.log('PROFITABLE: None found matching criteria');
    }

    console.log('');

    if (randomLosing) {
      console.log(`LOSING: ${randomLosing.wallet}`);
      console.log(`  P&L: $${randomLosing.totalPnl?.toLocaleString()}`);
      console.log(`  Win Rate: ${randomLosing.winRate?.toFixed(1)}%`);
      console.log(`  Closed Positions: ${randomLosing.closedPositionsCount}`);
    } else {
      console.log('LOSING: None found matching criteria');
    }

    console.log('');

    // Verify profitable trader
    if (randomProfitable) {
      await verifyTrader(randomProfitable.wallet, randomProfitable);
    }

    // Verify losing trader
    if (randomLosing) {
      await verifyTrader(randomLosing.wallet, randomLosing);
    }

    if (!randomProfitable && !randomLosing) {
      console.log('\n⚠️ No traders found matching criteria.');
      console.log('Try running these queries in MongoDB to debug:\n');
      console.log('db.getCollection("polymarket-traderProfiles").findOne({ consistency: { $exists: true } })');
      console.log('db.getCollection("polymarket-traderProfiles").countDocuments({ totalPnl: { $gt: 1000 } })');
    }

    console.log('\n████████████████████████████████████████████████████████████████');
    console.log('█                  VERIFICATION COMPLETE                        █');
    console.log('████████████████████████████████████████████████████████████████\n');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

main().catch(console.error);
