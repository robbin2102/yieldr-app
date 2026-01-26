#!/usr/bin/env ts-node

/**
 * Bulk Trader Profiler
 *
 * Profiles all unique traders from PolyMarketHolder collection in batches.
 * Includes resume capability - skips already profiled wallets.
 *
 * Usage:
 *   npx tsx scripts/bulk-profile-traders.ts
 *   npx tsx scripts/bulk-profile-traders.ts --batch=5        # Start from batch 5
 *   npx tsx scripts/bulk-profile-traders.ts --force          # Re-profile all (ignore existing)
 *   npx tsx scripts/bulk-profile-traders.ts --dry-run        # Just count traders, don't profile
 *
 * Rate Limits (Polymarket Data API):
 *   - No official rate limit documented, but ~100ms delay between calls is safe
 *   - Each profile needs ~3 API calls (activities, positions, closed-positions)
 *   - 1000 traders * 3 calls * 100ms = ~5 minutes per batch
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import PolyMarketHolder from '../models/PolyMarketHolder';

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  BATCH_SIZE: 1000,           // Traders per batch
  API_DELAY_MS: 100,          // Delay between API calls
  PROFILE_DAYS: 30,           // Days of history to analyze
  MAX_RETRIES: 3,             // Retries per trader on failure
  RETRY_DELAY_MS: 2000,       // Delay before retry
  COLLECTION_NAME: 'polymarket-traderProfiles',
};

const API_BASE = 'https://data-api.polymarket.com';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

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
  slug?: string;
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
  slug?: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

interface BatchProgress {
  batchNumber: number;
  totalBatches: number;
  processedInBatch: number;
  totalProcessed: number;
  totalTraders: number;
  startedAt: Date;
  lastWallet?: string;
}

// ═══════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  url: string,
  retries: number = CONFIG.MAX_RETRIES
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sleep(CONFIG.API_DELAY_MS);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      return await response.json() as T;
    } catch (error: any) {
      if (attempt === retries) throw error;
      console.log(`    Retry ${attempt}/${retries} for ${url.substring(0, 80)}...`);
      await sleep(CONFIG.RETRY_DELAY_MS);
    }
  }
  throw new Error('Max retries exceeded');
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
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const batch = await fetchWithRetry<Activity[]>(url);

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
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const batch = await fetchWithRetry<OpenPosition[]>(url);

    if (batch.length === 0) break;
    allPositions = allPositions.concat(batch);

    if (batch.length < LIMIT) break;
    offset += LIMIT;
  }

  return allPositions;
}

async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 5000;

  let allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const batch = await fetchWithRetry<ClosedPosition[]>(url);

    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        done = true;
        break;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
  }

  return allPositions;
}

// ═══════════════════════════════════════════════════════════════
// Profiling Logic (mirrors route.ts)
// ═══════════════════════════════════════════════════════════════

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  const nbaTeams = ['nba', 'basketball', 'lakers', 'celtics', 'bulls', 'heat', 'warriors', 'nuggets',
    'clippers', 'spurs', 'mavericks', 'mavs', 'thunder', 'rockets', 'suns', 'knicks', 'nets', '76ers',
    'sixers', 'bucks', 'cavaliers', 'cavs', 'grizzlies', 'timberwolves', 'wolves', 'pelicans',
    'blazers', 'trail blazers', 'kings', 'jazz', 'hawks', 'hornets', 'magic', 'pistons', 'pacers',
    'wizards', 'raptors'];
  if (nbaTeams.some(team => lower.includes(team))) return 'NBA';

  const nflTeams = ['nfl', 'football', 'super bowl', 'chiefs', 'eagles', 'bills', 'ravens', 'cowboys',
    '49ers', 'niners', 'patriots', 'pats', 'broncos', 'packers', 'lions', 'dolphins', 'jets',
    'raiders', 'chargers', 'steelers', 'bengals', 'browns', 'texans', 'colts', 'jaguars', 'jags',
    'titans', 'saints', 'falcons', 'panthers', 'buccaneers', 'bucs', 'vikings', 'bears',
    'commanders', 'giants', 'cardinals', 'seahawks', 'rams'];
  if (nflTeams.some(team => lower.includes(team))) return 'NFL';

  const nhlTeams = ['nhl', 'hockey', 'canucks', 'flames', 'oilers', 'maple leafs', 'leafs',
    'canadiens', 'habs', 'senators', 'sens', 'jets', 'bruins', 'rangers', 'islanders', 'devils',
    'flyers', 'penguins', 'pens', 'capitals', 'caps', 'hurricanes', 'canes', 'blue jackets',
    'lightning', 'bolts', 'panthers', 'red wings', 'blackhawks', 'hawks', 'wild', 'blues',
    'predators', 'preds', 'stars', 'avalanche', 'avs', 'coyotes', 'golden knights', 'knights',
    'kraken', 'kings', 'ducks', 'sharks'];
  if (nhlTeams.some(team => lower.includes(team))) return 'NHL';

  const soccerTeams = ['premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league',
    'manchester', 'liverpool', 'chelsea', 'arsenal', 'tottenham', 'barcelona', 'real madrid',
    'bayern', 'juventus', 'psg', 'fc ', ' fc', 'united', 'city'];
  if (soccerTeams.some(team => lower.includes(team))) return 'Soccer';

  if (lower.includes('mlb') || lower.includes('baseball')) return 'MLB';

  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate') ||
      lower.includes('democrat') || lower.includes('republican') || lower.includes('governor') ||
      lower.includes('vote') || lower.includes('poll')) return 'Politics';

  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') ||
      lower.includes('btc') || lower.includes('eth') || lower.includes('solana') ||
      lower.includes('doge') || lower.includes('token')) return 'Crypto';

  return 'Other';
}

async function profileTrader(wallet: string, days: number): Promise<any> {
  const cleanWallet = wallet.toLowerCase();
  const traderLabel = `Trader-${cleanWallet.slice(0, 6)}`;

  // Fetch all data
  const [activities, allOpenPositions, closedPositions] = await Promise.all([
    fetchActivities(cleanWallet, days),
    fetchOpenPositions(cleanWallet),
    fetchClosedPositions(cleanWallet, days),
  ]);

  // Skip if no activity
  if (activities.length === 0 && closedPositions.length === 0) {
    return null;
  }

  // Separate positions
  const LOSS_THRESHOLD = 0.001;
  const WIN_THRESHOLD = 0.99;

  const openPositions = allOpenPositions.filter(p =>
    p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
  );

  // Count activities
  let buyCount = 0, sellCount = 0, redeemCount = 0, splitCount = 0, mergeCount = 0, otherCount = 0;
  const tradeSizes: number[] = [];

  activities.forEach(a => {
    if (a.type === 'TRADE') {
      tradeSizes.push(a.usdcSize);
      if (a.side === 'BUY') buyCount++;
      else if (a.side === 'SELL') sellCount++;
    } else if (a.type === 'REDEEM') redeemCount++;
    else if (a.type === 'SPLIT') splitCount++;
    else if (a.type === 'MERGE') mergeCount++;
    else otherCount++;
  });

  // P&L calculation
  const realizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);
  const totalPnl = realizedPnl + unrealizedPnl;

  const grossProfit = closedPositions.filter(p => p.realizedPnl > 0).reduce((sum, p) => sum + p.realizedPnl, 0);
  const grossLoss = Math.abs(closedPositions.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.realizedPnl, 0));

  const totalTrades = buyCount + sellCount;
  const tradesPerDay = totalTrades / days;

  let volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  if (tradesPerDay < 5) volumeLabel = 'LOW';
  else if (tradesPerDay < 20) volumeLabel = 'MEDIUM';
  else volumeLabel = 'HIGH';

  const buyRatio = totalTrades > 0 ? (buyCount / totalTrades) * 100 : 0;
  let strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';
  if (buyRatio >= 90) strategyLabel = 'BUY_AND_HOLD';
  else if (buyRatio >= 60) strategyLabel = 'SWING_TRADER';
  else strategyLabel = 'ACTIVE_TRADER';

  let wins = 0, losses = 0;
  closedPositions.forEach(p => {
    if (p.realizedPnl >= 0) wins++;
    else losses++;
  });

  const totalClosedCount = closedPositions.length;
  const winRate = totalClosedCount > 0 ? (wins / totalClosedCount) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);

  tradeSizes.sort((a, b) => a - b);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
  const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
  const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

  // Market specialization
  const byCategory: Record<string, { trades: number; wins: number; losses: number; totalPnl: number }> = {};
  for (const pos of closedPositions) {
    const category = categorizeMarket(pos.title);
    if (!byCategory[category]) byCategory[category] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
    byCategory[category].trades++;
    byCategory[category].totalPnl += pos.realizedPnl;
    if (pos.realizedPnl >= 0) byCategory[category].wins++;
    else byCategory[category].losses++;
  }

  const marketPerformance = Object.entries(byCategory)
    .map(([category, stats]) => ({
      category,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      totalPnl: stats.totalPnl,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  const strengths = marketPerformance.filter(p => p.totalPnl > 0).slice(0, 3);
  const weaknesses = marketPerformance.filter(p => p.totalPnl < 0).slice(-3).reverse();
  const specialty = strengths.length > 0 ? strengths[0].category : null;

  // ============================================================
  // CONSISTENCY METRICS
  // ============================================================
  const now = Math.floor(Date.now() / 1000);
  const day7Ago = now - (7 * 24 * 60 * 60);
  const day15Ago = now - (15 * 24 * 60 * 60);

  const pnlByDay: Record<string, number> = {};
  const capitalByDay: Record<string, number> = {};

  closedPositions.forEach(p => {
    const day = new Date(p.timestamp * 1000).toISOString().split('T')[0];
    pnlByDay[day] = (pnlByDay[day] || 0) + p.realizedPnl;
  });

  activities.filter(a => a.type === 'TRADE' && a.side === 'BUY').forEach(a => {
    const day = new Date(a.timestamp * 1000).toISOString().split('T')[0];
    capitalByDay[day] = (capitalByDay[day] || 0) + a.usdcSize;
  });

  const allDays = Object.keys(pnlByDay).sort();
  const dailyPnls = allDays.map(d => pnlByDay[d]);

  const pnl7d = closedPositions.filter(p => p.timestamp >= day7Ago).reduce((sum, p) => sum + p.realizedPnl, 0);
  const pnl15d = closedPositions.filter(p => p.timestamp >= day15Ago).reduce((sum, p) => sum + p.realizedPnl, 0);

  const profitableDays = dailyPnls.filter(p => p > 0).length;
  const losingDays = dailyPnls.filter(p => p < 0).length;
  const profitableDayRate = dailyPnls.length > 0 ? (profitableDays / dailyPnls.length) * 100 : 0;

  const avgDailyPnl = dailyPnls.length > 0 ? dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length : 0;
  const variance = dailyPnls.length > 0 ? dailyPnls.reduce((sum, p) => sum + Math.pow(p - avgDailyPnl, 2), 0) / dailyPnls.length : 0;
  const stdDev = Math.sqrt(variance);
  const consistencyScore = stdDev > 0 ? avgDailyPnl / stdDev : (avgDailyPnl > 0 ? 999 : 0);

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

  let recentStreak = 0;
  let recentStreakType: 'win' | 'loss' | null = null;
  for (let i = dailyPnls.length - 1; i >= 0; i--) {
    const pnl = dailyPnls[i];
    if (pnl > 0) {
      if (recentStreakType === null) recentStreakType = 'win';
      if (recentStreakType === 'win') recentStreak++;
      else break;
    } else if (pnl < 0) {
      if (recentStreakType === null) recentStreakType = 'loss';
      if (recentStreakType === 'loss') recentStreak++;
      else break;
    }
  }

  // ============================================================
  // RISK METRICS
  // ============================================================
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

  const capitalDays = Object.keys(capitalByDay).sort();
  const dailyCapitals = capitalDays.map(d => capitalByDay[d]);
  const avgDailyCapital = dailyCapitals.length > 0 ? dailyCapitals.reduce((a, b) => a + b, 0) / dailyCapitals.length : 0;

  const capital7d = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY' && a.timestamp >= day7Ago).reduce((sum, a) => sum + a.usdcSize, 0);
  const capital15d = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY' && a.timestamp >= day15Ago).reduce((sum, a) => sum + a.usdcSize, 0);

  const returnOnCapital7d = capital7d > 0 ? (pnl7d / capital7d) * 100 : 0;
  const returnOnCapital15d = capital15d > 0 ? (pnl15d / capital15d) * 100 : 0;

  const losingPositions = closedPositions.filter(p => p.realizedPnl < 0);
  const largestSingleLoss = losingPositions.length > 0 ? Math.min(...losingPositions.map(p => p.realizedPnl)) : 0;
  const avgLossSize = losingPositions.length > 0 ? losingPositions.reduce((sum, p) => sum + p.realizedPnl, 0) / losingPositions.length : 0;

  // ============================================================
  // EDGE LOSS DETECTION
  // ============================================================
  const baselinePositions = closedPositions.filter(p => p.timestamp < day7Ago);
  const recentPositions = closedPositions.filter(p => p.timestamp >= day7Ago);

  const baselineWins = baselinePositions.filter(p => p.realizedPnl >= 0).length;
  const baselineWinRate = baselinePositions.length > 0 ? (baselineWins / baselinePositions.length) * 100 : 0;

  const recentWins = recentPositions.filter(p => p.realizedPnl >= 0).length;
  const recentWinRate = recentPositions.length > 0 ? (recentWins / recentPositions.length) * 100 : 0;

  const winRateDecline = baselineWinRate - recentWinRate;

  const baselinePnl = baselinePositions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const baselineDays = Math.max(1, days - 7);
  const baselineAvgDailyPnl = baselinePnl / baselineDays;
  const recentAvgDailyPnl = pnl7d / 7;
  const pnlTrendDecline = baselineAvgDailyPnl - recentAvgDailyPnl;

  const recentTrades = activities.filter(a => a.type === 'TRADE' && a.timestamp >= day7Ago);
  const baselineTrades = activities.filter(a => a.type === 'TRADE' && a.timestamp < day7Ago);
  const recentAvgTradeSize = recentTrades.length > 0 ? recentTrades.reduce((sum, a) => sum + a.usdcSize, 0) / recentTrades.length : 0;
  const baselineAvgTradeSize = baselineTrades.length > 0 ? baselineTrades.reduce((sum, a) => sum + a.usdcSize, 0) / baselineTrades.length : avgTradeSize;

  const expectedCapital7d = avgDailyCapital * 7;
  const volumeSpikeRatio = expectedCapital7d > 0 ? capital7d / expectedCapital7d : 1;
  const tradeSizeIncreaseRatio = baselineAvgTradeSize > 0 ? recentAvgTradeSize / baselineAvgTradeSize : 1;

  // Category edge loss
  const totalVolume = closedPositions.length;
  const categoryEdgeLoss: Array<{ category: string; baselineWinRate: number; recentWinRate: number; decline: number }> = [];

  const categoryBaseline: Record<string, { wins: number; total: number }> = {};
  const categoryRecent: Record<string, { wins: number; total: number }> = {};

  baselinePositions.forEach(p => {
    const cat = categorizeMarket(p.title);
    if (!categoryBaseline[cat]) categoryBaseline[cat] = { wins: 0, total: 0 };
    categoryBaseline[cat].total++;
    if (p.realizedPnl >= 0) categoryBaseline[cat].wins++;
  });

  recentPositions.forEach(p => {
    const cat = categorizeMarket(p.title);
    if (!categoryRecent[cat]) categoryRecent[cat] = { wins: 0, total: 0 };
    categoryRecent[cat].total++;
    if (p.realizedPnl >= 0) categoryRecent[cat].wins++;
  });

  const significantCategories = marketPerformance.filter(mp => totalVolume > 0 && (mp.trades / totalVolume) >= 0.10).slice(0, 3);

  for (const cat of significantCategories) {
    const baseline = categoryBaseline[cat.category];
    const recent = categoryRecent[cat.category];
    if (baseline && baseline.total >= 5 && recent && recent.total >= 2) {
      const baseWR = (baseline.wins / baseline.total) * 100;
      const recentWR = (recent.wins / recent.total) * 100;
      const decline = baseWR - recentWR;
      if (decline > 12) {
        categoryEdgeLoss.push({ category: cat.category, baselineWinRate: baseWR, recentWinRate: recentWR, decline });
      }
    }
  }

  const edgeLossSignals = {
    winRateDecline: winRateDecline > 12,
    winRateDeclineValue: winRateDecline,
    pnl7dNegative: pnl7d < 0,
    pnl7dValue: pnl7d,
    lossStreakAlert: recentStreakType === 'loss' && recentStreak >= 4,
    currentLossStreak: recentStreakType === 'loss' ? recentStreak : 0,
    volumeSpike: volumeSpikeRatio > 1.75,
    volumeSpikeRatio,
    tradeSizeIncrease: tradeSizeIncreaseRatio > 1.5,
    tradeSizeIncreaseRatio,
    categoryEdgeLoss,
    hasCategoryEdgeLoss: categoryEdgeLoss.length > 0,
    hasEdgeLossWarning: winRateDecline > 12 || (pnl7d < 0 && pnl15d < pnl7d) || (recentStreakType === 'loss' && recentStreak >= 4) || categoryEdgeLoss.length > 0,
  };

  // Build profile
  return {
    wallet: cleanWallet,
    label: traderLabel,
    profiledAt: new Date(),
    periodDays: days,
    totalActivities: activities.length,
    buyCount, sellCount, redeemCount, splitCount, mergeCount, otherCount,
    tradesPerDay, volumeLabel, buyRatio, strategyLabel,
    realizedPnl, unrealizedPnl, totalPnl, grossProfit, grossLoss, profitFactor,
    closedPositionsCount: closedPositions.length,
    wins, losses, winRate,
    openPositionsCount: openPositions.length, openValue,
    avgTradeSize, medianTradeSize, maxTradeSize,
    specialty, strengths, weaknesses,
    consistency: {
      pnl7d, pnl15d, avgDailyPnl,
      tradingDays: allDays.length, profitableDays, losingDays, profitableDayRate,
      consistencyScore, stdDev,
      longestWinStreak, longestLossStreak,
      currentStreak: recentStreak, currentStreakType: recentStreakType,
    },
    risk: {
      maxDrawdown, maxDrawdownPercent,
      avgDailyCapital, capital7d, capital15d,
      returnOnCapital7d, returnOnCapital15d,
      largestSingleLoss, avgLossSize,
    },
    edgeLoss: {
      baselineWinRate, recentWinRate, winRateDecline,
      baselineAvgDailyPnl, recentAvgDailyPnl, pnlTrendDecline,
      volumeSpikeRatio, tradeSizeIncreaseRatio, recentAvgTradeSize,
      categoryEdgeLoss,
      signals: edgeLossSignals,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Main Script
// ═══════════════════════════════════════════════════════════════

async function getUniqueTraders(): Promise<string[]> {
  console.log('Fetching unique traders from PolyMarketHolder collection...');

  const pipeline = [
    { $unwind: '$holders' },
    { $group: { _id: { $toLower: '$holders.proxyWallet' } } },
    { $sort: { _id: 1 } },
  ];

  const result = await PolyMarketHolder.aggregate(pipeline);
  const wallets = result.map(r => r._id).filter(Boolean);

  console.log(`Found ${wallets.length} unique traders\n`);
  return wallets;
}

async function getAlreadyProfiledWallets(db: mongoose.Connection): Promise<Set<string>> {
  const collection = db.collection(CONFIG.COLLECTION_NAME);
  const profiles = await collection.find({}, { projection: { wallet: 1 } }).toArray();
  return new Set(profiles.map(p => p.wallet.toLowerCase()));
}

async function saveProgress(db: mongoose.Connection, progress: BatchProgress): Promise<void> {
  await db.collection('bulk-profile-progress').updateOne(
    { _id: 'current' },
    { $set: progress },
    { upsert: true }
  );
}

async function loadProgress(db: mongoose.Connection): Promise<BatchProgress | null> {
  const doc = await db.collection('bulk-profile-progress').findOne({ _id: 'current' });
  return doc as BatchProgress | null;
}

function parseArgs(): { startBatch: number; force: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  let startBatch = 1;
  let force = false;
  let dryRun = false;

  args.forEach(arg => {
    if (arg.startsWith('--batch=')) startBatch = parseInt(arg.split('=')[1], 10);
    if (arg === '--force') force = true;
    if (arg === '--dry-run') dryRun = true;
  });

  return { startBatch, force, dryRun };
}

async function main(): Promise<void> {
  const { startBatch, force, dryRun } = parseArgs();

  console.log('\n');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                                                              █');
  console.log('█              BULK TRADER PROFILER                            █');
  console.log('█                                                              █');
  console.log('████████████████████████████████████████████████████████████████');
  console.log('\n');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not found in environment');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  const db = mongoose.connection;
  console.log('Connected to MongoDB\n');

  // Get all unique traders
  const allTraders = await getUniqueTraders();
  const totalBatches = Math.ceil(allTraders.length / CONFIG.BATCH_SIZE);

  console.log(`Total traders: ${allTraders.length}`);
  console.log(`Batch size: ${CONFIG.BATCH_SIZE}`);
  console.log(`Total batches: ${totalBatches}`);
  console.log(`Profile period: ${CONFIG.PROFILE_DAYS} days`);
  console.log(`Force re-profile: ${force}`);
  console.log('\n');

  if (dryRun) {
    console.log('DRY RUN - Not profiling, just counting');
    await mongoose.connection.close();
    return;
  }

  // Get already profiled wallets (for resume)
  let alreadyProfiled = new Set<string>();
  if (!force) {
    alreadyProfiled = await getAlreadyProfiledWallets(db);
    console.log(`Already profiled: ${alreadyProfiled.size} traders`);
  }

  // Filter traders to process
  const tradersToProcess = force
    ? allTraders
    : allTraders.filter(w => !alreadyProfiled.has(w.toLowerCase()));

  console.log(`Traders to process: ${tradersToProcess.length}\n`);

  if (tradersToProcess.length === 0) {
    console.log('All traders already profiled. Use --force to re-profile.');
    await mongoose.connection.close();
    return;
  }

  // Process in batches
  const collection = db.collection(CONFIG.COLLECTION_NAME);
  let totalProcessed = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  const startTime = Date.now();

  for (let batchNum = startBatch; batchNum <= totalBatches; batchNum++) {
    const batchStart = (batchNum - 1) * CONFIG.BATCH_SIZE;
    const batchEnd = Math.min(batchNum * CONFIG.BATCH_SIZE, tradersToProcess.length);
    const batchTraders = tradersToProcess.slice(batchStart, batchEnd);

    if (batchTraders.length === 0) continue;

    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  BATCH ${batchNum}/${totalBatches} (${batchTraders.length} traders)`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    const batchStartTime = Date.now();
    let batchSuccessful = 0;
    let batchFailed = 0;
    let batchSkipped = 0;

    for (let i = 0; i < batchTraders.length; i++) {
      const wallet = batchTraders[i];
      const progress = `[${i + 1}/${batchTraders.length}]`;

      try {
        process.stdout.write(`  ${progress} Profiling ${wallet.substring(0, 10)}... `);

        const profile = await profileTrader(wallet, CONFIG.PROFILE_DAYS);

        if (profile === null) {
          console.log('SKIPPED (no activity)');
          batchSkipped++;
          totalSkipped++;
        } else {
          // Save to MongoDB
          await collection.updateOne(
            { wallet: wallet.toLowerCase() },
            { $set: profile },
            { upsert: true }
          );
          console.log(`OK (${profile.closedPositionsCount} closed, $${profile.realizedPnl.toFixed(0)} P&L)`);
          batchSuccessful++;
          totalSuccessful++;
        }
      } catch (error: any) {
        console.log(`FAILED: ${error.message}`);
        batchFailed++;
        totalFailed++;
      }

      totalProcessed++;

      // Save progress every 100 traders
      if (totalProcessed % 100 === 0) {
        await saveProgress(db, {
          batchNumber: batchNum,
          totalBatches,
          processedInBatch: i + 1,
          totalProcessed,
          totalTraders: tradersToProcess.length,
          startedAt: new Date(startTime),
          lastWallet: wallet,
        });
      }
    }

    const batchDuration = (Date.now() - batchStartTime) / 1000;
    const totalDuration = (Date.now() - startTime) / 1000;
    const avgPerTrader = batchDuration / batchTraders.length;

    console.log('\n');
    console.log(`  Batch ${batchNum} complete:`);
    console.log(`    Successful: ${batchSuccessful}`);
    console.log(`    Failed: ${batchFailed}`);
    console.log(`    Skipped: ${batchSkipped}`);
    console.log(`    Duration: ${batchDuration.toFixed(1)}s (${avgPerTrader.toFixed(2)}s/trader)`);
    console.log('\n');

    // ETA calculation
    const remainingTraders = tradersToProcess.length - totalProcessed;
    const etaSeconds = remainingTraders * avgPerTrader;
    const etaMinutes = Math.ceil(etaSeconds / 60);
    console.log(`  Overall progress: ${totalProcessed}/${tradersToProcess.length} (${((totalProcessed / tradersToProcess.length) * 100).toFixed(1)}%)`);
    console.log(`  ETA: ~${etaMinutes} minutes remaining`);
    console.log('\n');
  }

  // Final summary
  const totalDuration = (Date.now() - startTime) / 1000;

  console.log('████████████████████████████████████████████████████████████████');
  console.log('█                     PROFILING COMPLETE                        █');
  console.log('████████████████████████████████████████████████████████████████');
  console.log(`  Total processed: ${totalProcessed}`);
  console.log(`  Successful: ${totalSuccessful}`);
  console.log(`  Failed: ${totalFailed}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Duration: ${(totalDuration / 60).toFixed(1)} minutes`);
  console.log(`  Collection: ${CONFIG.COLLECTION_NAME}`);
  console.log('\n');

  // Clean up progress
  await db.collection('bulk-profile-progress').deleteOne({ _id: 'current' });

  await mongoose.connection.close();
  console.log('MongoDB connection closed');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
