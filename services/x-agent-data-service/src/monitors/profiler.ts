/**
 * Trader Profiler Monitor
 *
 * Re-profiles top 100 edge-ranked traders using v2 profiling logic.
 * Updates ahf-edgeRankedTraders collection with fresh metrics.
 *
 * Runs every 1 hour (heavy operation due to API calls per trader).
 */

import { getDB, COLLECTIONS } from '../lib/db';
import {
  fetchActivities,
  fetchOpenPositions,
  fetchClosedPositions,
  Activity,
  OpenPosition,
  ClosedPosition,
} from '../lib/polymarket-api';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';

const log = createLogger('Profiler');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

const LOSS_THRESHOLD = 0.001;
const WIN_THRESHOLD = 0.99;

// ═══════════════════════════════════════════════════════════════
// Market categorization (from profile-trader-v2.ts)
// ═══════════════════════════════════════════════════════════════

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  const nba = ['nba', 'basketball', 'lakers', 'celtics', 'bulls', 'heat', 'warriors', 'nuggets', 'clippers', 'spurs', 'mavericks', 'thunder', 'rockets', 'suns', 'knicks', 'nets', '76ers', 'bucks', 'cavaliers', 'grizzlies', 'timberwolves', 'pelicans'];
  if (nba.some(t => lower.includes(t))) return 'NBA';

  const nfl = ['nfl', 'super bowl', 'chiefs', 'eagles', 'bills', 'ravens', 'cowboys', '49ers', 'patriots', 'broncos', 'packers', 'lions', 'dolphins', 'jets', 'raiders', 'steelers'];
  if (nfl.some(t => lower.includes(t))) return 'NFL';

  const soccer = ['premier league', 'la liga', 'bundesliga', 'serie a', 'champions league', 'manchester', 'liverpool', 'chelsea', 'arsenal', 'barcelona', 'real madrid', 'bayern', 'world cup', 'soccer', 'football'];
  if (soccer.some(t => lower.includes(t))) return 'Soccer';

  const politics = ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'democrat', 'republican', 'vote', 'political', 'governor'];
  if (politics.some(t => lower.includes(t))) return 'Politics';

  const crypto = ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'blockchain', 'defi', 'solana', 'sol'];
  if (crypto.some(t => lower.includes(t))) return 'Crypto';

  const geopolitics = ['war', 'nato', 'russia', 'ukraine', 'china', 'taiwan', 'iran', 'israel', 'ceasefire', 'sanction', 'tariff', 'treaty'];
  if (geopolitics.some(t => lower.includes(t))) return 'Geopolitics';

  return 'Other';
}

// ═══════════════════════════════════════════════════════════════
// Profile computation (adapted from profile-trader-v2.ts)
// ═══════════════════════════════════════════════════════════════

interface MarketPerformance {
  category: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
}

function computeProfile(
  wallet: string,
  activities: Activity[],
  openPositions: OpenPosition[],
  closedPositions: ClosedPosition[],
  label?: string
) {
  const now = new Date();
  const convictionMultiplier = CONFIG.PROFILER.CONVICTION_MULTIPLIER;

  // Activity breakdown
  const trades = activities.filter(a => a.type === 'TRADE');
  const buys = trades.filter(t => t.side === 'BUY');
  const sells = trades.filter(t => t.side === 'SELL');
  const redeems = activities.filter(a => a.type === 'REDEEM');

  // Volume classification
  const periodDays = CONFIG.PROFILER.ACTIVITY_DAYS;
  const tradesPerDay = trades.length / periodDays;
  const volumeLabel = tradesPerDay < 1 ? 'LOW' : tradesPerDay < 5 ? 'MEDIUM' : 'HIGH';

  // Strategy classification
  const totalTrades = buys.length + sells.length;
  const buyRatio = totalTrades > 0 ? buys.length / totalTrades : 0;
  const strategyLabel = buyRatio > 0.8 ? 'BUY_AND_HOLD' : buyRatio < 0.4 ? 'SWING_TRADER' : 'ACTIVE_TRADER';

  // Closed position analysis
  const tradeSizes: number[] = trades.map(t => t.usdcSize).filter(s => s > 0);

  // Separate resolved positions
  const resolvedWins = openPositions.filter(p => p.curPrice > WIN_THRESHOLD && p.size > 0);
  const resolvedLosses = openPositions.filter(p => p.curPrice < LOSS_THRESHOLD && p.size > 0);
  const activePositions = openPositions.filter(
    p => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
  );

  // PnL from closed positions
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;

  for (const pos of closedPositions) {
    if (pos.realizedPnl > 0) {
      grossProfit += pos.realizedPnl;
      wins++;
    } else if (pos.realizedPnl < 0) {
      grossLoss += Math.abs(pos.realizedPnl);
      losses++;
    }
  }

  // Add resolved positions PnL
  for (const p of resolvedWins) {
    grossProfit += p.currentValue - p.initialValue;
    wins++;
  }
  for (const p of resolvedLosses) {
    grossLoss += p.initialValue;
    losses++;
  }

  const totalClosed = closedPositions.length + resolvedWins.length + resolvedLosses.length;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999999 : 0;
  const netPnl = grossProfit - grossLoss;

  // Trade sizing
  tradeSizes.sort((a, b) => a - b);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
  const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
  const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

  // Open positions
  const openValue = activePositions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = activePositions.reduce((sum, p) => sum + p.cashPnl, 0);

  // High conviction (asymmetric) trade detection
  const asymmetricThreshold = avgTradeSize * convictionMultiplier;
  const asymmetricTrades = trades
    .filter(t => t.usdcSize >= asymmetricThreshold)
    .sort((a, b) => b.usdcSize - a.usdcSize);

  const asymmetricVolume = asymmetricTrades.reduce((sum, t) => sum + t.usdcSize, 0);
  const totalVolume = tradeSizes.reduce((a, b) => a + b, 0);

  const recentHighConvictionTrades = asymmetricTrades
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20)
    .map(t => ({
      timestamp: new Date(t.timestamp * 1000),
      side: t.side || 'UNKNOWN',
      market: t.title,
      outcome: t.outcome,
      price: t.price,
      usdcSize: t.usdcSize,
      sizeMultiplier: avgTradeSize > 0 ? t.usdcSize / avgTradeSize : 0,
      txHash: t.transactionHash,
    }));

  // Market specialization
  const categoryMap = new Map<string, { wins: number; losses: number; pnl: number; trades: number }>();
  for (const pos of closedPositions) {
    const cat = categorizeMarket(pos.title);
    const existing = categoryMap.get(cat) || { wins: 0, losses: 0, pnl: 0, trades: 0 };
    existing.trades++;
    if (pos.realizedPnl > 0) {
      existing.wins++;
      existing.pnl += pos.realizedPnl;
    } else {
      existing.losses++;
      existing.pnl += pos.realizedPnl;
    }
    categoryMap.set(cat, existing);
  }

  const categories: MarketPerformance[] = Array.from(categoryMap.entries())
    .filter(([, v]) => v.trades >= 3)
    .map(([category, v]) => ({
      category,
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      winRate: v.trades > 0 ? (v.wins / v.trades) * 100 : 0,
      totalPnl: v.pnl,
    }));

  const strengths = categories
    .filter(c => c.winRate >= 55 && c.totalPnl > 0)
    .sort((a, b) => b.totalPnl - a.totalPnl)
    .slice(0, 3);

  const weaknesses = categories
    .filter(c => c.winRate < 50 || c.totalPnl < 0)
    .sort((a, b) => a.totalPnl - b.totalPnl)
    .slice(0, 3);

  // Top open positions
  const topOpenPositions = activePositions
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 10)
    .map(p => ({
      conditionId: p.conditionId,
      title: p.title,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      initialValue: p.initialValue,
      currentValue: p.currentValue,
      cashPnl: p.cashPnl,
      percentPnl: p.percentPnl,
    }));

  return {
    wallet: wallet.toLowerCase(),
    label: label || undefined,
    profiledAt: now,
    periodDays,

    // Activity
    totalActivities: activities.length,
    buyCount: buys.length,
    sellCount: sells.length,
    redeemCount: redeems.length,

    // Volume / strategy
    tradesPerDay,
    volumeLabel,
    buyRatio,
    strategyLabel,

    // Performance
    closedPositionsCount: totalClosed,
    wins,
    losses,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor,

    // Positions
    openPositionsCount: activePositions.length,
    openValue,
    unrealizedPnl,

    // Trade sizing
    avgTradeSize,
    medianTradeSize,
    maxTradeSize,

    // High conviction
    asymmetricThreshold,
    asymmetricTradesCount: asymmetricTrades.length,
    asymmetricVolume,
    asymmetricVolumePercent: totalVolume > 0 ? (asymmetricVolume / totalVolume) * 100 : 0,
    recentHighConvictionTrades,

    // Market specialization
    strengths,
    weaknesses,
    specialty: strengths[0]?.category,

    // Positions snapshot
    topOpenPositions,

    // Metadata
    lastUpdatedAt: now,
  };
}

// ═══════════════════════════════════════════════════════════════
// Profile runner
// ═══════════════════════════════════════════════════════════════

async function profileTrader(wallet: string, label?: string): Promise<boolean> {
  try {
    const [activities, openPositions, closedPositions] = await Promise.all([
      fetchActivities(wallet, CONFIG.PROFILER.ACTIVITY_DAYS),
      fetchOpenPositions(wallet),
      fetchClosedPositions(wallet, CONFIG.PROFILER.ACTIVITY_DAYS),
    ]);

    if (activities.length === 0) {
      log.warn(`No activities for ${label || wallet}, skipping`);
      return false;
    }

    const profile = computeProfile(wallet, activities, openPositions, closedPositions, label);

    // Save to ahf-edgeRankedTraders
    const db = await getDB();
    const collection = db.collection(COLLECTIONS.EDGE_RANKED_TRADERS);

    await collection.updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: profile },
      { upsert: true }
    );

    return true;
  } catch (error: any) {
    log.error(`Error profiling ${label || wallet}: ${error.message}`);
    return false;
  }
}

async function runProfileRefresh(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    const db = await getDB();

    // Get current edge-ranked traders
    const edgeCollection = db.collection(COLLECTIONS.EDGE_RANKED_TRADERS);
    let traders = await edgeCollection
      .find({})
      .sort({ profitFactor: -1, netPnl: -1 })
      .limit(CONFIG.TOP_TRADERS_LIMIT)
      .project({ wallet: 1, label: 1 })
      .toArray();

    // If no edge-ranked traders, bootstrap from traderProfiles
    if (traders.length === 0) {
      log.warn('No edge-ranked traders found, bootstrapping from traderProfiles...');
      const profilesCollection = db.collection(COLLECTIONS.TRADER_PROFILES);
      traders = await profilesCollection
        .find({ winRate: { $gte: 55 }, profitFactor: { $gte: 1.5 } })
        .sort({ profitFactor: -1, netPnl: -1 })
        .limit(CONFIG.TOP_TRADERS_LIMIT)
        .project({ wallet: 1, label: 1 })
        .toArray();
    }

    if (traders.length === 0) {
      log.warn('No traders found to profile');
      return;
    }

    log.info(`Re-profiling ${traders.length} traders...`);

    let profiled = 0;
    let failed = 0;

    for (const trader of traders) {
      const success = await profileTrader(trader.wallet, trader.label);
      if (success) profiled++;
      else failed++;

      // Rate limiting: 2s between traders (heavy API calls)
      await new Promise(r => setTimeout(r, 2000));
    }

    log.success(`Profiling complete: ${profiled} profiled, ${failed} failed`);
  } catch (error: any) {
    log.error(`Profile refresh failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startProfiler(): void {
  log.info(`Starting profiler (every ${CONFIG.INTERVALS.PROFILE_REFRESH / 3600000}h)`);

  // Delay 2 minutes to let other monitors run first
  setTimeout(() => {
    runProfileRefresh();
    intervalId = setInterval(runProfileRefresh, CONFIG.INTERVALS.PROFILE_REFRESH);
  }, 120_000);
}

export function stopProfiler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Profiler stopped');
  }
}

export function getProfilerStatus() {
  return { isRunning };
}
