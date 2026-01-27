#!/usr/bin/env ts-node

/**
 * Top Trader Filter Script
 *
 * Filters profiled traders to find the best candidates for copy trading.
 * Applies multiple criteria: P&L, win rate, consistency, edge loss detection.
 *
 * Usage:
 *   npm run polymarket:filter-traders
 *   npx tsx scripts/filter-top-traders.ts
 *   npx tsx scripts/filter-top-traders.ts --min-pnl=5000 --min-winrate=60
 */

import 'dotenv/config';
import mongoose from 'mongoose';

// ═══════════════════════════════════════════════════════════════
// Configuration & Thresholds
// ═══════════════════════════════════════════════════════════════

const FILTERS = {
  // Minimum thresholds
  MIN_PNL: 5000,                    // Minimum total P&L ($)
  MIN_WIN_RATE: 55,                 // Minimum win rate (%)
  MIN_TRADES: 10,                   // Minimum closed positions
  MIN_TRADING_DAYS: 5,              // Minimum days with activity

  // Edge loss detection thresholds (from user specs)
  MAX_WIN_RATE_DECLINE: 12,         // Alert if win rate dropped >12%
  MAX_LOSS_STREAK: 4,               // Alert if loss streak ≥4 days
  MAX_VOLUME_SPIKE: 1.75,           // Alert if volume spike >1.75x

  // Quality filters
  MIN_CONSISTENCY_SCORE: 0.1,       // Sharpe-like ratio threshold
  MIN_PROFIT_FACTOR: 1.2,           // Gross profit / gross loss
  MAX_DRAWDOWN_PERCENT: 50,         // Max acceptable drawdown %

  // Output limits
  TOP_PER_CATEGORY: 20,             // Top traders per category
  TOP_OVERALL: 100,                 // Top overall traders
};

const COLLECTION_NAME = 'polymarket-traderProfiles';
const OUTPUT_COLLECTION = 'polymarket-topTraders';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface TraderProfile {
  _id: mongoose.Types.ObjectId;
  wallet: string;
  name?: string;
  profiledAt: Date;

  // P&L
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;

  // Trading stats
  totalTrades: number;
  buyCount: number;
  sellCount: number;
  winRate: number;
  profitFactor: number;

  // Position info
  closedPositionCount: number;
  openPositionCount: number;
  openPositionValue: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // Labels
  volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';

  // Specialization
  specialty: string | null;
  marketPerformance: Array<{
    category: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
  }>;
  strengths: Array<{ category: string; totalPnl: number }>;
  weaknesses: Array<{ category: string; totalPnl: number }>;

  // Consistency
  consistency: {
    pnl7d: number;
    pnl15d: number;
    avgDailyPnl: number;
    tradingDays: number;
    profitableDays: number;
    losingDays: number;
    profitableDayRate: number;
    consistencyScore: number;
    stdDev: number;
    longestWinStreak: number;
    longestLossStreak: number;
    currentStreak: number;
    currentStreakType: 'win' | 'loss' | null;
  };

  // Risk
  risk: {
    maxDrawdown: number;
    maxDrawdownPercent: number;
    avgDailyCapital: number;
    capital7d: number;
    capital15d: number;
    returnOnCapital7d: number;
    returnOnCapital15d: number;
    largestSingleLoss: number;
    avgLossSize: number;
  };

  // Edge loss
  edgeLoss: {
    baselineWinRate: number;
    recentWinRate: number;
    winRateDecline: number;
    pnlTrendDecline: number;
    volumeSpikeRatio: number;
    tradeSizeIncreaseRatio: number;
    categoryEdgeLoss: Array<{
      category: string;
      baselineWinRate: number;
      recentWinRate: number;
      decline: number;
    }>;
    signals: string[];
  };
}

interface FilteredTrader extends TraderProfile {
  score: number;
  rank: number;
  flags: string[];
  categoryRanks: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════════
// Scoring Functions
// ═══════════════════════════════════════════════════════════════

function calculateScore(trader: TraderProfile): number {
  // Weighted scoring system
  let score = 0;

  // P&L component (40%)
  const pnlScore = Math.min(trader.totalPnl / 100000, 10) * 4;
  score += pnlScore;

  // Win rate component (25%)
  const winRateScore = (trader.winRate / 100) * 10 * 2.5;
  score += winRateScore;

  // Consistency component (20%)
  const consistencyScore = Math.min(trader.consistency?.consistencyScore || 0, 3) / 3 * 10 * 2;
  score += consistencyScore;

  // Profit factor component (10%)
  const pfScore = Math.min((trader.profitFactor || 0) / 5, 1) * 10;
  score += pfScore;

  // Trading activity component (5%)
  const activityScore = Math.min(trader.totalTrades / 100, 1) * 10 * 0.5;
  score += activityScore;

  // Penalties
  // Edge loss penalty
  if (trader.edgeLoss?.winRateDecline > FILTERS.MAX_WIN_RATE_DECLINE) {
    score -= 5;
  }
  if (trader.consistency?.longestLossStreak >= FILTERS.MAX_LOSS_STREAK) {
    score -= 3;
  }
  if (trader.edgeLoss?.volumeSpikeRatio > FILTERS.MAX_VOLUME_SPIKE) {
    score -= 2;
  }

  // Drawdown penalty
  if (trader.risk?.maxDrawdownPercent > 30) {
    score -= (trader.risk.maxDrawdownPercent - 30) / 10;
  }

  return Math.max(0, score);
}

function getFlags(trader: TraderProfile): string[] {
  const flags: string[] = [];

  // Positive flags
  if (trader.winRate >= 80) flags.push('🎯 HIGH_WIN_RATE');
  if (trader.totalPnl >= 100000) flags.push('💰 HIGH_EARNER');
  if (trader.consistency?.consistencyScore >= 1) flags.push('📈 CONSISTENT');
  if (trader.profitFactor >= 3) flags.push('⚡ HIGH_PROFIT_FACTOR');
  if (trader.consistency?.profitableDayRate >= 70) flags.push('🌟 MOSTLY_GREEN_DAYS');

  // Warning flags
  if (trader.edgeLoss?.winRateDecline > FILTERS.MAX_WIN_RATE_DECLINE) {
    flags.push('⚠️ WIN_RATE_DECLINING');
  }
  if (trader.consistency?.longestLossStreak >= FILTERS.MAX_LOSS_STREAK) {
    flags.push('⚠️ RECENT_LOSS_STREAK');
  }
  if (trader.edgeLoss?.volumeSpikeRatio > FILTERS.MAX_VOLUME_SPIKE) {
    flags.push('⚠️ VOLUME_SPIKE');
  }
  if (trader.risk?.maxDrawdownPercent > 40) {
    flags.push('⚠️ HIGH_DRAWDOWN');
  }
  if (trader.consistency?.currentStreakType === 'loss' && trader.consistency?.currentStreak >= 3) {
    flags.push('🔴 CURRENT_LOSS_STREAK');
  }

  return flags;
}

// ═══════════════════════════════════════════════════════════════
// Main Filter Logic
// ═══════════════════════════════════════════════════════════════

async function filterTopTraders(): Promise<void> {
  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                                                              █');
  console.log('█              TOP TRADER FILTER                               █');
  console.log('█                                                              █');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('\n');

  // Connect to MongoDB
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

  const profilesCollection = db.collection(COLLECTION_NAME);
  const outputCollection = db.collection(OUTPUT_COLLECTION);

  try {
    // ═══════════════════════════════════════════════════════════════
    // Step 1: Load all profiles
    // ═══════════════════════════════════════════════════════════════
    console.log('─── STEP 1: Loading trader profiles ───\n');

    const totalProfiles = await profilesCollection.countDocuments();
    console.log(`Total profiles in database: ${totalProfiles.toLocaleString()}\n`);

    // ═══════════════════════════════════════════════════════════════
    // Step 2: Apply base filters
    // ═══════════════════════════════════════════════════════════════
    console.log('─── STEP 2: Applying filters ───\n');
    console.log('Filter criteria:');
    console.log(`  • Min P&L: $${FILTERS.MIN_PNL.toLocaleString()}`);
    console.log(`  • Min Win Rate: ${FILTERS.MIN_WIN_RATE}%`);
    console.log(`  • Min Trades: ${FILTERS.MIN_TRADES}`);
    console.log(`  • Min Trading Days: ${FILTERS.MIN_TRADING_DAYS}`);
    console.log(`  • Max Drawdown: ${FILTERS.MAX_DRAWDOWN_PERCENT}%`);
    console.log('');

    const baseFilter = {
      totalPnl: { $gte: FILTERS.MIN_PNL },
      winRate: { $gte: FILTERS.MIN_WIN_RATE },
      closedPositionCount: { $gte: FILTERS.MIN_TRADES },
      'consistency.tradingDays': { $gte: FILTERS.MIN_TRADING_DAYS },
      'risk.maxDrawdownPercent': { $lte: FILTERS.MAX_DRAWDOWN_PERCENT },
    };

    const filteredTraders = await profilesCollection
      .find(baseFilter)
      .toArray() as unknown as TraderProfile[];

    console.log(`Traders passing base filters: ${filteredTraders.length.toLocaleString()}\n`);

    // ═══════════════════════════════════════════════════════════════
    // Step 3: Score and rank traders
    // ═══════════════════════════════════════════════════════════════
    console.log('─── STEP 3: Scoring traders ───\n');

    const scoredTraders: FilteredTrader[] = filteredTraders.map(trader => ({
      ...trader,
      score: calculateScore(trader),
      rank: 0,
      flags: getFlags(trader),
      categoryRanks: {},
    }));

    // Sort by score and assign overall rank
    scoredTraders.sort((a, b) => b.score - a.score);
    scoredTraders.forEach((t, i) => t.rank = i + 1);

    console.log(`Scored ${scoredTraders.length} traders\n`);

    // ═══════════════════════════════════════════════════════════════
    // Step 4: Rank by category
    // ═══════════════════════════════════════════════════════════════
    console.log('─── STEP 4: Ranking by category ───\n');

    const byCategory: Record<string, FilteredTrader[]> = {};

    for (const trader of scoredTraders) {
      const specialty = trader.specialty || 'Other';
      if (!byCategory[specialty]) byCategory[specialty] = [];
      byCategory[specialty].push(trader);
    }

    // Sort each category and assign ranks
    for (const category of Object.keys(byCategory)) {
      byCategory[category].sort((a, b) => b.score - a.score);
      byCategory[category].forEach((t, i) => {
        t.categoryRanks[category] = i + 1;
      });
    }

    // Print category summary
    const categoryStats = Object.entries(byCategory)
      .map(([cat, traders]) => ({
        category: cat,
        count: traders.length,
        avgPnl: traders.reduce((sum, t) => sum + t.totalPnl, 0) / traders.length,
        topTraderPnl: traders[0]?.totalPnl || 0,
      }))
      .sort((a, b) => b.count - a.count);

    console.log('Category breakdown:');
    categoryStats.forEach(stat => {
      console.log(`  ${stat.category}: ${stat.count} traders (top: $${stat.topTraderPnl.toLocaleString()})`);
    });
    console.log('');

    // ═══════════════════════════════════════════════════════════════
    // Step 5: Save top traders
    // ═══════════════════════════════════════════════════════════════
    console.log('─── STEP 5: Saving top traders ───\n');

    // Get top overall
    const topOverall = scoredTraders.slice(0, FILTERS.TOP_OVERALL);

    // Get top per category
    const topPerCategory: FilteredTrader[] = [];
    for (const [category, traders] of Object.entries(byCategory)) {
      const top = traders.slice(0, FILTERS.TOP_PER_CATEGORY);
      topPerCategory.push(...top);
    }

    // Dedupe (some might be in both top overall and top category)
    const uniqueTopTraders = new Map<string, FilteredTrader>();
    for (const trader of [...topOverall, ...topPerCategory]) {
      if (!uniqueTopTraders.has(trader.wallet)) {
        uniqueTopTraders.set(trader.wallet, trader);
      }
    }

    const topTraders = Array.from(uniqueTopTraders.values());
    topTraders.sort((a, b) => b.score - a.score);

    console.log(`Top overall: ${topOverall.length}`);
    console.log(`Top per category: ${topPerCategory.length}`);
    console.log(`Unique top traders: ${topTraders.length}\n`);

    // Clear and save
    await outputCollection.deleteMany({});

    const docsToInsert = topTraders.map(t => ({
      ...t,
      filteredAt: new Date(),
      filterVersion: '1.0',
    }));

    await outputCollection.insertMany(docsToInsert);
    console.log(`Saved ${topTraders.length} top traders to ${OUTPUT_COLLECTION}\n`);

    // ═══════════════════════════════════════════════════════════════
    // Step 6: Print summary
    // ═══════════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                         TOP 20 TRADERS                         ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    topTraders.slice(0, 20).forEach((t, i) => {
      const name = t.name || t.wallet.substring(0, 12) + '...';
      const flags = t.flags.slice(0, 3).join(' ');
      console.log(`${(i + 1).toString().padStart(2)}. ${name.padEnd(20)} | $${t.totalPnl.toLocaleString().padStart(12)} | WR: ${t.winRate.toFixed(0)}% | Score: ${t.score.toFixed(1)} | ${flags}`);
    });

    console.log('\n');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    TOP 5 PER CATEGORY                          ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    categoryStats.slice(0, 8).forEach(stat => {
      console.log(`\n─── ${stat.category.toUpperCase()} ───`);
      const catTraders = byCategory[stat.category]?.slice(0, 5) || [];
      catTraders.forEach((t, i) => {
        const name = t.name || t.wallet.substring(0, 12) + '...';
        console.log(`  ${i + 1}. ${name.padEnd(18)} | $${t.totalPnl.toLocaleString().padStart(10)} | WR: ${t.winRate.toFixed(0)}%`);
      });
    });

    // Edge loss warnings
    const tradersWithEdgeLoss = topTraders.filter(t =>
      t.flags.some(f => f.includes('⚠️'))
    );

    if (tradersWithEdgeLoss.length > 0) {
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('                    ⚠️ EDGE LOSS WARNINGS                       ');
      console.log('═══════════════════════════════════════════════════════════════\n');

      tradersWithEdgeLoss.slice(0, 10).forEach(t => {
        const name = t.name || t.wallet.substring(0, 12) + '...';
        const warnings = t.flags.filter(f => f.includes('⚠️') || f.includes('🔴'));
        console.log(`${name}: ${warnings.join(', ')}`);
      });
    }

    console.log('\n');
    console.log('████████████████████████████████████████████████████████████████');
    console.log('█                     FILTERING COMPLETE                        █');
    console.log('████████████████████████████████████████████████████████████████');
    console.log(`\n  Total profiles: ${totalProfiles.toLocaleString()}`);
    console.log(`  Passed filters: ${filteredTraders.length.toLocaleString()}`);
    console.log(`  Top traders saved: ${topTraders.length}`);
    console.log(`  Collection: ${OUTPUT_COLLECTION}\n`);

  } catch (error) {
    console.error('Error filtering traders:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  }
}

// Parse command line args
const args = process.argv.slice(2);
args.forEach(arg => {
  if (arg.startsWith('--min-pnl=')) {
    FILTERS.MIN_PNL = parseInt(arg.split('=')[1], 10);
  }
  if (arg.startsWith('--min-winrate=')) {
    FILTERS.MIN_WIN_RATE = parseInt(arg.split('=')[1], 10);
  }
  if (arg.startsWith('--min-trades=')) {
    FILTERS.MIN_TRADES = parseInt(arg.split('=')[1], 10);
  }
  if (arg.startsWith('--top-overall=')) {
    FILTERS.TOP_OVERALL = parseInt(arg.split('=')[1], 10);
  }
});

// Run
filterTopTraders().catch(console.error);
