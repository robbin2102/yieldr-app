#!/usr/bin/env ts-node

/**
 * Metrics Verification Test
 *
 * Picks one profitable and one losing trader, re-computes all metrics,
 * and compares with stored values to verify correctness.
 *
 * Usage:
 *   npx tsx scripts/verify-trader-metrics.ts
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const API_BASE = 'https://data-api.polymarket.com';
const PROFILE_DAYS = 30;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
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

// ═══════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 5000;

  let allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    await sleep(100);
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    const batch = await response.json() as Activity[];

    if (batch.length === 0) break;

    for (const activity of batch) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        done = true;
        break;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
  }

  return allActivities;
}

async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  await sleep(100);
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const response = await fetch(url);
  return response.json() as Promise<OpenPosition[]>;
}

async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 5000;

  let allPositions: ClosedPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    await sleep(100);
    const url = `${API_BASE}/positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=LATEST_TRADE_TIMESTAMP&sortDirection=DESC&sizeThreshold=0&redeemed=true`;
    const response = await fetch(url);
    const batch = await response.json() as ClosedPosition[];

    if (batch.length === 0) break;

    let hitOldData = false;
    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        hitOldData = true;
      }
    }

    if (hitOldData || batch.length < LIMIT) break;
    offset += LIMIT;
  }

  return allPositions;
}

function categorizeMarket(title: string): string {
  const t = title.toLowerCase();
  if (t.includes('trump') || t.includes('biden') || t.includes('president') || t.includes('election') || t.includes('congress') || t.includes('senate') || t.includes('governor')) return 'Politics';
  if (t.includes('bitcoin') || t.includes('btc') || t.includes('ethereum') || t.includes('eth') || t.includes('crypto') || t.includes('solana') || t.includes('doge')) return 'Crypto';
  if (t.includes('nfl') || t.includes('nba') || t.includes('mlb') || t.includes('ufc') || t.includes('football') || t.includes('basketball') || t.includes('soccer') || t.includes('tennis') || t.includes('super bowl')) return 'Sports';
  if (t.includes('fed') || t.includes('interest rate') || t.includes('inflation') || t.includes('gdp') || t.includes('unemployment') || t.includes('cpi') || t.includes('stock') || t.includes('s&p')) return 'Finance';
  if (t.includes('ai') || t.includes('openai') || t.includes('chatgpt') || t.includes('google') || t.includes('apple') || t.includes('tesla') || t.includes('spacex') || t.includes('elon')) return 'Tech';
  return 'Other';
}

// ═══════════════════════════════════════════════════════════════
// Verification Logic
// ═══════════════════════════════════════════════════════════════

async function verifyTrader(wallet: string, storedProfile: any): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`VERIFYING: ${wallet}`);
  console.log(`Name: ${storedProfile.name || 'N/A'}`);
  console.log(`Stored Total P&L: $${storedProfile.totalPnl?.toLocaleString()}`);
  console.log(`${'═'.repeat(70)}\n`);

  // Fetch fresh data
  console.log('📡 Fetching fresh data from Polymarket API...\n');

  const activities = await fetchActivities(wallet, PROFILE_DAYS);
  const openPositions = await fetchOpenPositions(wallet);
  const closedPositions = await fetchClosedPositions(wallet, PROFILE_DAYS);

  console.log(`  Activities fetched: ${activities.length}`);
  console.log(`  Open positions: ${openPositions.length}`);
  console.log(`  Closed positions: ${closedPositions.length}\n`);

  // ═══════════════════════════════════════════════════════════════
  // 1. P&L METRICS
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 1. P&L METRICS ───\n');

  const realizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const totalPnl = realizedPnl + unrealizedPnl;

  console.log('  REALIZED P&L (from closed positions):');
  console.log(`    Formula: SUM(closedPositions.realizedPnl)`);
  console.log(`    Computed: $${realizedPnl.toLocaleString()}`);
  console.log(`    Stored:   $${storedProfile.realizedPnl?.toLocaleString()}`);
  console.log(`    Match: ${Math.abs(realizedPnl - storedProfile.realizedPnl) < 1 ? '✅' : '❌'}\n`);

  console.log('  UNREALIZED P&L (from open positions):');
  console.log(`    Formula: SUM(openPositions.cashPnl)`);
  console.log(`    Computed: $${unrealizedPnl.toLocaleString()}`);
  console.log(`    Stored:   $${storedProfile.unrealizedPnl?.toLocaleString()}`);
  console.log(`    Match: ${Math.abs(unrealizedPnl - storedProfile.unrealizedPnl) < 1 ? '✅' : '⚠️ (positions may have changed)'}\n`);

  console.log('  TOTAL P&L:');
  console.log(`    Formula: realizedPnl + unrealizedPnl`);
  console.log(`    Computed: $${totalPnl.toLocaleString()}`);
  console.log(`    Stored:   $${storedProfile.totalPnl?.toLocaleString()}\n`);

  // ═══════════════════════════════════════════════════════════════
  // 2. WIN RATE & PROFIT FACTOR
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 2. WIN RATE & PROFIT FACTOR ───\n');

  const wins = closedPositions.filter(p => p.realizedPnl >= 0).length;
  const losses = closedPositions.filter(p => p.realizedPnl < 0).length;
  const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;

  console.log('  WIN RATE:');
  console.log(`    Formula: (wins / totalClosedPositions) * 100`);
  console.log(`    Wins: ${wins}, Losses: ${losses}, Total: ${closedPositions.length}`);
  console.log(`    Computed: ${winRate.toFixed(2)}%`);
  console.log(`    Stored:   ${storedProfile.winRate?.toFixed(2)}%`);
  console.log(`    Match: ${Math.abs(winRate - storedProfile.winRate) < 0.5 ? '✅' : '❌'}\n`);

  const grossProfit = closedPositions.filter(p => p.realizedPnl > 0).reduce((sum, p) => sum + p.realizedPnl, 0);
  const grossLoss = Math.abs(closedPositions.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.realizedPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  console.log('  PROFIT FACTOR:');
  console.log(`    Formula: grossProfit / grossLoss`);
  console.log(`    Gross Profit: $${grossProfit.toLocaleString()}`);
  console.log(`    Gross Loss: $${grossLoss.toLocaleString()}`);
  console.log(`    Computed: ${profitFactor.toFixed(2)}`);
  console.log(`    Stored:   ${storedProfile.profitFactor?.toFixed(2)}`);
  console.log(`    Match: ${Math.abs(profitFactor - storedProfile.profitFactor) < 0.1 ? '✅' : '❌'}\n`);

  // ═══════════════════════════════════════════════════════════════
  // 3. TRADING ACTIVITY
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 3. TRADING ACTIVITY ───\n');

  const trades = activities.filter(a => a.type === 'TRADE');
  const buyCount = trades.filter(t => t.side === 'BUY').length;
  const sellCount = trades.filter(t => t.side === 'SELL').length;
  const totalTrades = buyCount + sellCount;

  console.log('  TRADE COUNTS:');
  console.log(`    Buy trades: ${buyCount} (stored: ${storedProfile.buyCount})`);
  console.log(`    Sell trades: ${sellCount} (stored: ${storedProfile.sellCount})`);
  console.log(`    Total: ${totalTrades} (stored: ${storedProfile.totalTrades})\n`);

  const tradeSizes = trades.map(t => t.usdcSize).filter(s => s > 0);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;

  console.log('  TRADE SIZING:');
  console.log(`    Avg trade size: $${avgTradeSize.toFixed(2)} (stored: $${storedProfile.avgTradeSize?.toFixed(2)})\n`);

  // ═══════════════════════════════════════════════════════════════
  // 4. CONSISTENCY METRICS
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 4. CONSISTENCY METRICS ───\n');

  const now = Math.floor(Date.now() / 1000);
  const day7Ago = now - (7 * 24 * 60 * 60);
  const day15Ago = now - (15 * 24 * 60 * 60);

  // Daily P&L
  const pnlByDay: Record<string, number> = {};
  closedPositions.forEach(p => {
    const day = new Date(p.timestamp * 1000).toISOString().split('T')[0];
    pnlByDay[day] = (pnlByDay[day] || 0) + p.realizedPnl;
  });

  const allDays = Object.keys(pnlByDay).sort();
  const dailyPnls = allDays.map(d => pnlByDay[d]);

  console.log('  DAILY P&L BREAKDOWN:');
  console.log(`    Trading days: ${allDays.length} (stored: ${storedProfile.consistency?.tradingDays})`);
  allDays.slice(-7).forEach(day => {
    const pnl = pnlByDay[day];
    const sign = pnl >= 0 ? '+' : '';
    console.log(`      ${day}: ${sign}$${pnl.toFixed(2)}`);
  });
  console.log('');

  const pnl7d = closedPositions.filter(p => p.timestamp >= day7Ago).reduce((sum, p) => sum + p.realizedPnl, 0);
  const pnl15d = closedPositions.filter(p => p.timestamp >= day15Ago).reduce((sum, p) => sum + p.realizedPnl, 0);

  console.log('  PERIOD P&L:');
  console.log(`    7-day P&L: $${pnl7d.toLocaleString()} (stored: $${storedProfile.consistency?.pnl7d?.toLocaleString()})`);
  console.log(`    15-day P&L: $${pnl15d.toLocaleString()} (stored: $${storedProfile.consistency?.pnl15d?.toLocaleString()})\n`);

  const profitableDays = dailyPnls.filter(p => p > 0).length;
  const losingDays = dailyPnls.filter(p => p < 0).length;
  const profitableDayRate = dailyPnls.length > 0 ? (profitableDays / dailyPnls.length) * 100 : 0;

  console.log('  DAY SUCCESS RATE:');
  console.log(`    Profitable days: ${profitableDays}`);
  console.log(`    Losing days: ${losingDays}`);
  console.log(`    Profitable day rate: ${profitableDayRate.toFixed(1)}% (stored: ${storedProfile.consistency?.profitableDayRate?.toFixed(1)}%)\n`);

  // Consistency Score (Sharpe-like)
  const avgDailyPnl = dailyPnls.length > 0 ? dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length : 0;
  const variance = dailyPnls.length > 0 ? dailyPnls.reduce((sum, p) => sum + Math.pow(p - avgDailyPnl, 2), 0) / dailyPnls.length : 0;
  const stdDev = Math.sqrt(variance);
  const consistencyScore = stdDev > 0 ? avgDailyPnl / stdDev : (avgDailyPnl > 0 ? 999 : 0);

  console.log('  CONSISTENCY SCORE (Sharpe-like):');
  console.log(`    Formula: avgDailyPnl / stdDev(dailyPnls)`);
  console.log(`    Avg Daily P&L: $${avgDailyPnl.toFixed(2)}`);
  console.log(`    Std Dev: $${stdDev.toFixed(2)}`);
  console.log(`    Computed: ${consistencyScore.toFixed(3)}`);
  console.log(`    Stored:   ${storedProfile.consistency?.consistencyScore?.toFixed(3)}`);
  console.log(`    Match: ${Math.abs(consistencyScore - (storedProfile.consistency?.consistencyScore || 0)) < 0.1 ? '✅' : '⚠️'}\n`);

  // Streaks
  let longestWinStreak = 0, longestLossStreak = 0;
  let currentStreak = 0;
  let currentStreakType: 'win' | 'loss' | null = null;

  for (const pnl of dailyPnls) {
    if (pnl > 0) {
      if (currentStreakType === 'win') currentStreak++;
      else { currentStreak = 1; currentStreakType = 'win'; }
      longestWinStreak = Math.max(longestWinStreak, currentStreak);
    } else if (pnl < 0) {
      if (currentStreakType === 'loss') currentStreak++;
      else { currentStreak = 1; currentStreakType = 'loss'; }
      longestLossStreak = Math.max(longestLossStreak, currentStreak);
    }
  }

  console.log('  STREAKS (based on daily P&L):');
  console.log(`    Longest win streak: ${longestWinStreak} days (stored: ${storedProfile.consistency?.longestWinStreak})`);
  console.log(`    Longest loss streak: ${longestLossStreak} days (stored: ${storedProfile.consistency?.longestLossStreak})\n`);

  // ═══════════════════════════════════════════════════════════════
  // 5. RISK METRICS
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 5. RISK METRICS ───\n');

  let maxDrawdown = 0, maxDrawdownPercent = 0, runningPnl = 0, peak = 0;
  for (const day of allDays) {
    runningPnl += pnlByDay[day];
    if (runningPnl > peak) peak = runningPnl;
    const drawdown = peak - runningPnl;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
    }
  }

  console.log('  MAX DRAWDOWN:');
  console.log(`    Formula: (peak - trough) / peak * 100`);
  console.log(`    Max Drawdown: $${maxDrawdown.toFixed(2)} (stored: $${storedProfile.risk?.maxDrawdown?.toFixed(2)})`);
  console.log(`    Max Drawdown %: ${maxDrawdownPercent.toFixed(1)}% (stored: ${storedProfile.risk?.maxDrawdownPercent?.toFixed(1)}%)\n`);

  const losingPositions = closedPositions.filter(p => p.realizedPnl < 0);
  const largestSingleLoss = losingPositions.length > 0 ? Math.min(...losingPositions.map(p => p.realizedPnl)) : 0;
  const avgLossSize = losingPositions.length > 0 ? losingPositions.reduce((sum, p) => sum + p.realizedPnl, 0) / losingPositions.length : 0;

  console.log('  LOSS ANALYSIS:');
  console.log(`    Largest single loss: $${largestSingleLoss.toFixed(2)} (stored: $${storedProfile.risk?.largestSingleLoss?.toFixed(2)})`);
  console.log(`    Avg loss size: $${avgLossSize.toFixed(2)} (stored: $${storedProfile.risk?.avgLossSize?.toFixed(2)})\n`);

  // ═══════════════════════════════════════════════════════════════
  // 6. EDGE LOSS DETECTION
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 6. EDGE LOSS DETECTION ───\n');

  const baselinePositions = closedPositions.filter(p => p.timestamp < day7Ago);
  const recentPositions = closedPositions.filter(p => p.timestamp >= day7Ago);

  const baselineWins = baselinePositions.filter(p => p.realizedPnl >= 0).length;
  const baselineWinRate = baselinePositions.length > 0 ? (baselineWins / baselinePositions.length) * 100 : 0;

  const recentWins = recentPositions.filter(p => p.realizedPnl >= 0).length;
  const recentWinRate = recentPositions.length > 0 ? (recentWins / recentPositions.length) * 100 : 0;

  const winRateDecline = baselineWinRate - recentWinRate;

  console.log('  WIN RATE COMPARISON:');
  console.log(`    Baseline (days 8-30): ${baselinePositions.length} positions, ${baselineWinRate.toFixed(1)}% win rate`);
  console.log(`    Recent (last 7 days): ${recentPositions.length} positions, ${recentWinRate.toFixed(1)}% win rate`);
  console.log(`    Win Rate Decline: ${winRateDecline.toFixed(1)}% (stored: ${storedProfile.edgeLoss?.winRateDecline?.toFixed(1)}%)`);
  console.log(`    Alert threshold: >12%`);
  console.log(`    Status: ${winRateDecline > 12 ? '⚠️ DECLINING' : '✅ STABLE'}\n`);

  // ═══════════════════════════════════════════════════════════════
  // 7. MARKET SPECIALIZATION
  // ═══════════════════════════════════════════════════════════════
  console.log('─── 7. MARKET SPECIALIZATION ───\n');

  const byCategory: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const pos of closedPositions) {
    const category = categorizeMarket(pos.title);
    if (!byCategory[category]) byCategory[category] = { trades: 0, wins: 0, pnl: 0 };
    byCategory[category].trades++;
    byCategory[category].pnl += pos.realizedPnl;
    if (pos.realizedPnl >= 0) byCategory[category].wins++;
  }

  const catStats = Object.entries(byCategory)
    .map(([cat, stats]) => ({
      category: cat,
      trades: stats.trades,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      pnl: stats.pnl,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  console.log('  CATEGORY PERFORMANCE:');
  catStats.forEach(stat => {
    const sign = stat.pnl >= 0 ? '+' : '';
    console.log(`    ${stat.category.padEnd(12)}: ${stat.trades} trades, ${stat.winRate.toFixed(0)}% WR, ${sign}$${stat.pnl.toFixed(0)}`);
  });
  console.log(`\n  Specialty: ${catStats[0]?.category || 'N/A'} (stored: ${storedProfile.specialty})\n`);

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                      VERIFICATION SUMMARY                      ');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const checks = [
    { name: 'Realized P&L', match: Math.abs(realizedPnl - storedProfile.realizedPnl) < 1 },
    { name: 'Win Rate', match: Math.abs(winRate - storedProfile.winRate) < 0.5 },
    { name: 'Profit Factor', match: Math.abs(profitFactor - storedProfile.profitFactor) < 0.1 },
    { name: 'Trading Days', match: allDays.length === storedProfile.consistency?.tradingDays },
    { name: 'Win Streak', match: longestWinStreak === storedProfile.consistency?.longestWinStreak },
    { name: 'Loss Streak', match: longestLossStreak === storedProfile.consistency?.longestLossStreak },
  ];

  checks.forEach(check => {
    console.log(`  ${check.match ? '✅' : '❌'} ${check.name}`);
  });

  const passCount = checks.filter(c => c.match).length;
  console.log(`\n  Result: ${passCount}/${checks.length} checks passed\n`);
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                                                              █');
  console.log('█              TRADER METRICS VERIFICATION                     █');
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
    // Pick one profitable trader (random from top 100)
    console.log('Selecting test traders...\n');

    const profitableTraders = await collection
      .find({ totalPnl: { $gt: 10000 }, closedPositionCount: { $gte: 20 } })
      .sort({ totalPnl: -1 })
      .limit(100)
      .toArray();

    const randomProfitable = profitableTraders[Math.floor(Math.random() * Math.min(50, profitableTraders.length))];

    // Pick one losing trader (random from bottom 100)
    const losingTraders = await collection
      .find({ totalPnl: { $lt: -1000 }, closedPositionCount: { $gte: 20 } })
      .sort({ totalPnl: 1 })
      .limit(100)
      .toArray();

    const randomLosing = losingTraders[Math.floor(Math.random() * Math.min(50, losingTraders.length))];

    console.log(`Selected PROFITABLE trader: ${randomProfitable?.wallet} (P&L: $${randomProfitable?.totalPnl?.toLocaleString()})`);
    console.log(`Selected LOSING trader: ${randomLosing?.wallet} (P&L: $${randomLosing?.totalPnl?.toLocaleString()})\n`);

    // Verify profitable trader
    if (randomProfitable) {
      await verifyTrader(randomProfitable.wallet, randomProfitable);
    }

    // Verify losing trader
    if (randomLosing) {
      await verifyTrader(randomLosing.wallet, randomLosing);
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
