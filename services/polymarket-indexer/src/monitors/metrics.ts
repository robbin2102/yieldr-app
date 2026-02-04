/**
 * Polymarket Metrics Computation
 * Deep analysis of trader performance - matches profile-trader.ts logic
 */

import { getCollections } from '../lib/db';
import {
  fetchOpenPositions,
  fetchActivities,
  fetchClosedPositions,
  Activity,
  OpenPosition,
  ClosedPosition,
} from '../lib/api';

const LOSS_THRESHOLD = 0.001; // < 0.1¢ = resolved loss
const WIN_THRESHOLD = 0.99; // > 99¢ = resolved win
const DEFAULT_CONVICTION_MULTIPLIER = 10; // Trades > 10x avg = high conviction

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface MarketPerformance {
  category: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

interface EntryOddsPerformance {
  range: string;
  trades: number;
  wins: number;
  winRate: number;
}

interface HighConvictionTrade {
  timestamp: Date;
  side: string;
  market: string;
  outcome: string;
  price: number;
  usdcSize: number;
  sizeMultiplier: number;
  txHash: string;
}

export interface TraderProfile {
  wallet: string;
  profiledAt: Date;
  periodDays: number;

  // Activity stats
  totalActivities: number;
  buyCount: number;
  sellCount: number;
  redeemCount: number;
  otherCount: number;

  // Volume classification
  tradesPerDay: number;
  volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';

  // Strategy classification
  buyRatio: number;
  strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';

  // Performance from closed positions
  closedPositionsCount: number;
  unredeemedLossCount: number;
  unredeemedLossAmount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number;

  // Open positions
  openPositionsCount: number;
  openValue: number;
  unrealizedPnl: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // High conviction (asymmetric) trades
  asymmetricThreshold: number;
  asymmetricTradesCount: number;
  asymmetricVolume: number;
  asymmetricVolumePercent: number;

  // Market specialization
  strengths: MarketPerformance[];
  weaknesses: MarketPerformance[];

  // Entry odds analysis
  entryOddsBreakdown: EntryOddsPerformance[];

  // Trader label
  label: string;

  // Recent high-conviction trades
  recentHighConvictionTrades: HighConvictionTrade[];

  // Top open positions
  topOpenPositions: any[];

  // Timestamps
  lastUpdatedAt: Date;
}

// ═══════════════════════════════════════════════════════════════
// Market Categorization (matches profile-trader.ts)
// ═══════════════════════════════════════════════════════════════

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  // NBA - All team names and variations
  const nbaTeams = [
    'nba',
    'basketball',
    'lakers',
    'celtics',
    'bulls',
    'heat',
    'warriors',
    'nuggets',
    'clippers',
    'spurs',
    'mavericks',
    'mavs',
    'thunder',
    'rockets',
    'suns',
    'knicks',
    'nets',
    '76ers',
    'sixers',
    'bucks',
    'cavaliers',
    'cavs',
    'grizzlies',
    'timberwolves',
    'wolves',
    'pelicans',
    'blazers',
    'trail blazers',
    'kings',
    'jazz',
    'hawks',
    'hornets',
    'magic',
    'pistons',
    'pacers',
    'wizards',
    'raptors',
  ];
  if (nbaTeams.some((team) => lower.includes(team))) {
    return 'NBA';
  }

  // NFL - All team names and variations
  const nflTeams = [
    'nfl',
    'football',
    'super bowl',
    'chiefs',
    'eagles',
    'bills',
    'ravens',
    'cowboys',
    '49ers',
    'niners',
    'patriots',
    'pats',
    'broncos',
    'packers',
    'lions',
    'dolphins',
    'jets',
    'raiders',
    'chargers',
    'steelers',
    'bengals',
    'browns',
    'texans',
    'colts',
    'jaguars',
    'jags',
    'titans',
    'saints',
    'falcons',
    'panthers',
    'buccaneers',
    'bucs',
    'vikings',
    'bears',
    'commanders',
    'giants',
    'cardinals',
    'seahawks',
    'rams',
  ];
  if (nflTeams.some((team) => lower.includes(team))) {
    return 'NFL';
  }

  // NHL - All team names and variations
  const nhlTeams = [
    'nhl',
    'hockey',
    'canucks',
    'flames',
    'oilers',
    'maple leafs',
    'leafs',
    'canadiens',
    'habs',
    'senators',
    'sens',
    'bruins',
    'rangers',
    'islanders',
    'devils',
    'flyers',
    'penguins',
    'pens',
    'capitals',
    'caps',
    'hurricanes',
    'canes',
    'blue jackets',
    'lightning',
    'bolts',
    'red wings',
    'blackhawks',
    'wild',
    'blues',
    'predators',
    'preds',
    'stars',
    'avalanche',
    'avs',
    'coyotes',
    'golden knights',
    'knights',
    'kraken',
    'ducks',
    'sharks',
  ];
  if (nhlTeams.some((team) => lower.includes(team))) {
    return 'NHL';
  }

  // Soccer/Football - Major leagues and teams
  const soccerTeams = [
    'premier league',
    'la liga',
    'bundesliga',
    'serie a',
    'ligue 1',
    'champions league',
    'manchester',
    'liverpool',
    'chelsea',
    'arsenal',
    'tottenham',
    'barcelona',
    'real madrid',
    'bayern',
    'juventus',
    'psg',
    'fc ',
    ' fc',
    'united',
    'city',
  ];
  if (soccerTeams.some((team) => lower.includes(team))) {
    return 'Soccer';
  }

  // MLB
  if (lower.includes('mlb') || lower.includes('baseball')) {
    return 'MLB';
  }

  // Politics
  if (
    lower.includes('trump') ||
    lower.includes('biden') ||
    lower.includes('election') ||
    lower.includes('president') ||
    lower.includes('congress') ||
    lower.includes('senate') ||
    lower.includes('democrat') ||
    lower.includes('republican') ||
    lower.includes('governor') ||
    lower.includes('vote') ||
    lower.includes('poll')
  ) {
    return 'Politics';
  }

  // Crypto
  if (
    lower.includes('bitcoin') ||
    lower.includes('ethereum') ||
    lower.includes('crypto') ||
    lower.includes('btc') ||
    lower.includes('eth') ||
    lower.includes('solana') ||
    lower.includes('doge') ||
    lower.includes('token')
  ) {
    return 'Crypto';
  }

  return 'Other';
}

// ═══════════════════════════════════════════════════════════════
// Analysis Functions
// ═══════════════════════════════════════════════════════════════

function analyzeMarketPerformance(
  closedPositions: ClosedPosition[]
): { strengths: MarketPerformance[]; weaknesses: MarketPerformance[] } {
  const byCategory: Record<
    string,
    { trades: number; wins: number; losses: number; totalPnl: number }
  > = {};

  for (const pos of closedPositions) {
    const category = categorizeMarket(pos.title);
    if (!byCategory[category]) {
      byCategory[category] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
    }

    byCategory[category].trades++;
    byCategory[category].totalPnl += pos.realizedPnl;

    if (pos.realizedPnl >= 0) {
      byCategory[category].wins++;
    } else {
      byCategory[category].losses++;
    }
  }

  const performances: MarketPerformance[] = Object.entries(byCategory).map(
    ([category, stats]) => ({
      category,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
      totalPnl: stats.totalPnl,
      avgPnl: stats.trades > 0 ? stats.totalPnl / stats.trades : 0,
    })
  );

  // Sort by total PnL
  const sorted = performances.sort((a, b) => b.totalPnl - a.totalPnl);

  const strengths = sorted.filter((p) => p.totalPnl > 0).slice(0, 5);
  const weaknesses = sorted.filter((p) => p.totalPnl < 0).slice(-5).reverse();

  return { strengths, weaknesses };
}

function analyzeEntryOdds(activities: Activity[]): EntryOddsPerformance[] {
  const buyTrades = activities.filter((a) => a.type === 'TRADE' && a.side === 'BUY');

  const ranges = [
    { label: '< 25c (Big underdog)', min: 0, max: 0.25 },
    { label: '25-40c (Underdog)', min: 0.25, max: 0.4 },
    { label: '40-60c (Toss-up)', min: 0.4, max: 0.6 },
    { label: '60-75c (Favorite)', min: 0.6, max: 0.75 },
    { label: '> 75c (Heavy favorite)', min: 0.75, max: 1.0 },
  ];

  return ranges
    .map((range) => {
      const trades = buyTrades.filter(
        (t) => t.price >= range.min && t.price < range.max
      );
      // Simplified win estimation
      const wins = trades.filter((t) => t.price < 0.5).length;

      return {
        range: range.label,
        trades: trades.length,
        wins,
        winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      };
    })
    .filter((r) => r.trades > 0);
}

function determineTraderLabel(profile: Partial<TraderProfile>): string {
  const labels: string[] = [];

  // Volume-based
  if (profile.volumeLabel === 'LOW') labels.push('LOW_VOLUME');
  if (profile.volumeLabel === 'HIGH') labels.push('HIGH_VOLUME');

  // Strategy-based
  if (profile.strategyLabel === 'BUY_AND_HOLD') labels.push('HOLDER');

  // Performance-based
  if (profile.winRate && profile.winRate >= 70) labels.push('HIGH_WIN_RATE');
  if (profile.profitFactor && profile.profitFactor >= 2) labels.push('PROFITABLE');

  // Specialization
  if (profile.strengths && profile.strengths.length > 0) {
    const topCategory = profile.strengths[0].category;
    if (topCategory === 'NBA') labels.push('NBA_SPECIALIST');
    if (topCategory === 'NFL') labels.push('NFL_SPECIALIST');
    if (topCategory === 'NHL') labels.push('NHL_SPECIALIST');
    if (topCategory === 'Politics') labels.push('POLITICS_SPECIALIST');
    if (topCategory === 'Crypto') labels.push('CRYPTO_SPECIALIST');
    if (topCategory === 'Soccer') labels.push('SOCCER_SPECIALIST');
  }

  return labels.join(' | ') || 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════
// Main Computation
// ═══════════════════════════════════════════════════════════════

export async function computeTraderMetrics(
  walletAddress: string,
  days: number = 90,
  convictionMultiplier: number = DEFAULT_CONVICTION_MULTIPLIER
): Promise<TraderProfile> {
  console.log(`[Metrics] Computing metrics for ${walletAddress} (${days} days)...`);

  // Fetch all data from API
  const [allOpenPositions, activities, closedPositions] = await Promise.all([
    fetchOpenPositions(walletAddress),
    fetchActivities(walletAddress, days),
    fetchClosedPositions(walletAddress, days),
  ]);

  // Separate truly active positions from resolved positions
  const openPositions = allOpenPositions.filter(
    (p) => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
  );
  const resolvedLosses = allOpenPositions.filter(
    (p) => p.curPrice < LOSS_THRESHOLD && p.size > 0
  );
  const resolvedWins = allOpenPositions.filter(
    (p) => p.curPrice > WIN_THRESHOLD && p.size > 0
  );

  console.log(`[Metrics] Positions: ${allOpenPositions.length} total, ${openPositions.length} active, ${resolvedLosses.length} losses @ 0¢, ${resolvedWins.length} wins @ 100¢`);

  // Count activities by type
  let buyCount = 0;
  let sellCount = 0;
  let redeemCount = 0;
  let otherCount = 0;
  const tradeSizes: number[] = [];

  activities.forEach((a) => {
    if (a.type === 'TRADE') {
      tradeSizes.push(a.usdcSize);
      if (a.side === 'BUY') buyCount++;
      else if (a.side === 'SELL') sellCount++;
    } else if (a.type === 'REDEEM') {
      redeemCount++;
    } else {
      otherCount++;
    }
  });

  const totalTrades = buyCount + sellCount;

  // Volume classification
  const tradesPerDay = totalTrades / days;
  let volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  if (tradesPerDay < 5) volumeLabel = 'LOW';
  else if (tradesPerDay < 20) volumeLabel = 'MEDIUM';
  else volumeLabel = 'HIGH';

  // Strategy classification
  const buyRatio = totalTrades > 0 ? (buyCount / totalTrades) * 100 : 0;
  let strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';
  if (buyRatio >= 90) strategyLabel = 'BUY_AND_HOLD';
  else if (buyRatio >= 60) strategyLabel = 'SWING_TRADER';
  else strategyLabel = 'ACTIVE_TRADER';

  // Closed positions analysis (only time-filtered closed positions)
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;

  closedPositions.forEach((p) => {
    if (p.realizedPnl >= 0) {
      grossProfit += p.realizedPnl;
      wins++;
    } else {
      grossLoss += Math.abs(p.realizedPnl);
      losses++;
    }
  });

  // Track unredeemed losses (ALL-TIME counts from resolved positions)
  const unredeemedLossCount = resolvedLosses.length;
  const unredeemedLossAmount = resolvedLosses.reduce(
    (sum, p) => sum + p.initialValue,
    0
  );

  // Win rate and profit factor based on closed positions only
  const totalClosedCount = closedPositions.length;
  const winRate = totalClosedCount > 0 ? (wins / totalClosedCount) * 100 : 0;
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999999 : 0;
  const netPnl = grossProfit - grossLoss;

  // Open positions
  const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);

  // Trade sizing
  tradeSizes.sort((a, b) => a - b);
  const avgTradeSize =
    tradeSizes.length > 0
      ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length
      : 0;
  const medianTradeSize =
    tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
  const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

  // Market analysis
  const { strengths, weaknesses } = analyzeMarketPerformance(closedPositions);

  // Entry odds analysis
  const entryOddsBreakdown = analyzeEntryOdds(activities);

  // High conviction (asymmetric) trade detection
  const asymmetricThreshold = avgTradeSize * convictionMultiplier;
  const asymmetricTrades = activities
    .filter((a) => a.type === 'TRADE' && a.usdcSize >= asymmetricThreshold)
    .sort((a, b) => b.usdcSize - a.usdcSize);

  const asymmetricVolume = asymmetricTrades.reduce((sum, t) => sum + t.usdcSize, 0);
  const totalVolume = tradeSizes.reduce((a, b) => a + b, 0);
  const asymmetricVolumePercent =
    totalVolume > 0 ? (asymmetricVolume / totalVolume) * 100 : 0;

  // Build recent high-conviction trades for storage
  const recentHighConvictionTrades: HighConvictionTrade[] = asymmetricTrades
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20)
    .map((t) => ({
      timestamp: new Date(t.timestamp * 1000),
      side: t.side || 'UNKNOWN',
      market: t.title,
      outcome: t.outcome,
      price: t.price,
      usdcSize: t.usdcSize,
      sizeMultiplier: avgTradeSize > 0 ? t.usdcSize / avgTradeSize : 0,
      txHash: t.transactionHash,
    }));

  // Top open positions
  const topOpenPositions = openPositions
    .sort((a, b) => b.currentValue - a.currentValue)
    .slice(0, 10)
    .map((p) => ({
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

  // Determine label
  const partialProfile = {
    volumeLabel,
    strategyLabel,
    winRate,
    profitFactor,
    strengths,
  };
  const label = determineTraderLabel(partialProfile);

  const profile: TraderProfile = {
    wallet: walletAddress.toLowerCase(),
    profiledAt: new Date(),
    periodDays: days,

    totalActivities: activities.length,
    buyCount,
    sellCount,
    redeemCount,
    otherCount,

    tradesPerDay,
    volumeLabel,
    buyRatio,
    strategyLabel,

    closedPositionsCount: closedPositions.length,
    unredeemedLossCount,
    unredeemedLossAmount,
    wins,
    losses,
    winRate,
    grossProfit,
    grossLoss,
    netPnl,
    profitFactor,

    openPositionsCount: openPositions.length,
    openValue,
    unrealizedPnl,

    avgTradeSize,
    medianTradeSize,
    maxTradeSize,

    asymmetricThreshold,
    asymmetricTradesCount: asymmetricTrades.length,
    asymmetricVolume,
    asymmetricVolumePercent,

    strengths,
    weaknesses,
    entryOddsBreakdown,

    label,
    recentHighConvictionTrades,
    topOpenPositions,

    lastUpdatedAt: new Date(),
  };

  console.log(
    `[Metrics] ${walletAddress}: ${label} | Win Rate: ${winRate.toFixed(1)}% | Net PnL: $${netPnl.toFixed(2)} | Profit Factor: ${profitFactor.toFixed(2)}`
  );

  return profile;
}

/**
 * Save trader profile to database
 */
export async function saveTraderProfile(profile: TraderProfile): Promise<void> {
  const { traderProfiles } = await getCollections();

  await traderProfiles.updateOne(
    { wallet: profile.wallet },
    { $set: profile },
    { upsert: true }
  );

  console.log(`[Metrics] Saved profile for ${profile.wallet}`);
}
