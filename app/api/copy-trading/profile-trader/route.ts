import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for profiling

const API_BASE = 'https://data-api.polymarket.com';
const FETCH_TIMEOUT = 30000; // 30 second timeout
const MAX_RETRIES = 3;

// Fetch with timeout and retry (only retries network errors and 5xx, not 4xx)
async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      // Don't retry 4xx client errors - they won't resolve with retries
      if (response.status >= 400 && response.status < 500) {
        const errorBody = await response.text().catch(() => '');
        console.error(`Polymarket API ${response.status}: ${errorBody.substring(0, 200)}`);
        throw new Error(`API client error: ${response.status} - ${errorBody.substring(0, 100)}`);
      }

      // Retry 5xx server errors
      if (response.status >= 500) {
        throw new Error(`API server error: ${response.status}`);
      }

      return response;
    } catch (error: any) {
      lastError = error;

      // Don't retry client errors (4xx)
      if (error.message?.includes('client error')) {
        throw error;
      }

      if (attempt === retries) throw error;
      console.log(`Retry ${attempt}/${retries} for ${url.substring(0, 80)}...`);
      await new Promise(r => setTimeout(r, 1000 * attempt)); // Backoff
    }
  }
  throw lastError || new Error('Max retries exceeded');
}

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

// Fetch activities with pagination
async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;  // API max per request
  const MAX_OFFSET = 2500;  // Polymarket API limit is 3000, stay under

  let allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetchWithRetry(url);

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
    await new Promise(r => setTimeout(r, 50));
  }

  return allActivities;
}

// Fetch open positions WITH PAGINATION
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetchWithRetry(url);

    const batch = await response.json() as OpenPosition[];
    if (batch.length === 0) break;

    allPositions = allPositions.concat(batch);

    if (batch.length < LIMIT) break; // Last page
    offset += LIMIT;

    await new Promise(r => setTimeout(r, 50)); // Rate limiting
  }

  return allPositions;
}

// Fetch closed positions
async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;  // Increased for efficiency
  const MAX_OFFSET = 2500;  // Polymarket API limit is 3000, stay under

  let allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetchWithRetry(url);

    const batch = await response.json() as ClosedPosition[];
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
    await new Promise(r => setTimeout(r, 50));
  }

  return allPositions;
}

// Categorize market
function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  // NBA - All team names and variations
  const nbaTeams = ['nba', 'basketball', 'lakers', 'celtics', 'bulls', 'heat', 'warriors', 'nuggets',
    'clippers', 'spurs', 'mavericks', 'mavs', 'thunder', 'rockets', 'suns', 'knicks', 'nets', '76ers',
    'sixers', 'bucks', 'cavaliers', 'cavs', 'grizzlies', 'timberwolves', 'wolves', 'pelicans',
    'blazers', 'trail blazers', 'kings', 'jazz', 'hawks', 'hornets', 'magic', 'pistons', 'pacers',
    'wizards', 'raptors'];
  if (nbaTeams.some(team => lower.includes(team))) {
    return 'NBA';
  }

  // NFL - All team names and variations
  const nflTeams = ['nfl', 'football', 'super bowl', 'chiefs', 'eagles', 'bills', 'ravens', 'cowboys',
    '49ers', 'niners', 'patriots', 'pats', 'broncos', 'packers', 'lions', 'dolphins', 'jets',
    'raiders', 'chargers', 'steelers', 'bengals', 'browns', 'texans', 'colts', 'jaguars', 'jags',
    'titans', 'saints', 'falcons', 'panthers', 'buccaneers', 'bucs', 'vikings', 'bears',
    'commanders', 'giants', 'cardinals', 'seahawks', 'rams'];
  if (nflTeams.some(team => lower.includes(team))) {
    return 'NFL';
  }

  // NHL - All team names and variations
  const nhlTeams = ['nhl', 'hockey', 'canucks', 'flames', 'oilers', 'maple leafs', 'leafs',
    'canadiens', 'habs', 'senators', 'sens', 'jets', 'bruins', 'rangers', 'islanders', 'devils',
    'flyers', 'penguins', 'pens', 'capitals', 'caps', 'hurricanes', 'canes', 'blue jackets',
    'lightning', 'bolts', 'panthers', 'red wings', 'blackhawks', 'hawks', 'wild', 'blues',
    'predators', 'preds', 'stars', 'avalanche', 'avs', 'coyotes', 'golden knights', 'knights',
    'kraken', 'kings', 'ducks', 'sharks'];
  if (nhlTeams.some(team => lower.includes(team))) {
    return 'NHL';
  }

  // Soccer/Football - Major leagues and teams
  const soccerTeams = ['premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league',
    'manchester', 'liverpool', 'chelsea', 'arsenal', 'tottenham', 'barcelona', 'real madrid',
    'bayern', 'juventus', 'psg', 'fc ', ' fc', 'united', 'city'];
  if (soccerTeams.some(team => lower.includes(team))) {
    return 'Soccer';
  }

  // MLB
  if (lower.includes('mlb') || lower.includes('baseball')) {
    return 'MLB';
  }

  // Politics
  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate') ||
      lower.includes('democrat') || lower.includes('republican') || lower.includes('governor') ||
      lower.includes('vote') || lower.includes('poll')) {
    return 'Politics';
  }

  // Crypto
  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') ||
      lower.includes('btc') || lower.includes('eth') || lower.includes('solana') ||
      lower.includes('doge') || lower.includes('token')) {
    return 'Crypto';
  }

  return 'Other';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, label, days = 30 } = body;

    if (!wallet) {
      return NextResponse.json({ success: false, error: 'Wallet address required' }, { status: 400 });
    }

    const cleanWallet = wallet.toLowerCase();
    const traderLabel = label || `Trader-${cleanWallet.slice(0, 6)}`;

    // Fetch all data in parallel
    const [activities, allOpenPositions, closedPositions] = await Promise.all([
      fetchActivities(cleanWallet, days),
      fetchOpenPositions(cleanWallet),
      fetchClosedPositions(cleanWallet, days),
    ]);

    // Separate active positions from resolved ones
    // 0¢ = lost (market resolved against them, unredeemed)
    // 100¢ = won (market resolved in their favor, unredeemed)
    const LOSS_THRESHOLD = 0.001;  // <0.1¢ = resolved loss
    const WIN_THRESHOLD = 0.99;   // >99¢ = resolved win

    const openPositions = allOpenPositions.filter(p =>
      p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
    );

    // Unredeemed resolved positions - these MUST be included in P&L!
    // Traders often redeem wins (to get USDC) but not losses (0¢ = nothing to claim)
    // So /v1/closed-positions misses all unredeemed losses, causing inflated P&L
    const resolvedLosses = allOpenPositions.filter(p =>
      p.curPrice < LOSS_THRESHOLD && p.size > 0
    );
    const resolvedWins = allOpenPositions.filter(p =>
      p.curPrice > WIN_THRESHOLD && p.size > 0
    );

    // Build set of conditionIds for unredeemed wins (to add expected redemption value)
    const unredeemedWinConditionIds = new Set<string>();
    for (const pos of resolvedWins) {
      unredeemedWinConditionIds.add(pos.conditionId);
    }

    // Build set of conditionIds with activity in time window for filtering
    const activityConditionIds = new Set<string>();
    for (const activity of activities) {
      activityConditionIds.add(activity.conditionId);
    }

    // Filter unredeemed positions to only those with activity in the time period
    const timeFilteredLosses = resolvedLosses.filter(p =>
      activityConditionIds.has(p.conditionId)
    );
    const timeFilteredWins = resolvedWins.filter(p =>
      activityConditionIds.has(p.conditionId)
    );

    // Count activities by type and calculate P&L from cash flows
    // P&L = (Cash received from SELLs + REDEEMs + Unredeemed Wins) - (Cash spent on BUYs)
    // SPLIT/MERGE are neutral operations (no P&L impact)
    let buyCount = 0, sellCount = 0, redeemCount = 0, splitCount = 0, mergeCount = 0, otherCount = 0;
    let cashOut = 0;  // USDC spent (BUYs)
    let cashIn = 0;   // USDC received (SELLs + REDEEMs)
    let unredeemedWinValue = 0;  // Expected redemption value from unredeemed wins
    const tradeSizes: number[] = [];

    activities.forEach(a => {
      if (a.type === 'TRADE') {
        tradeSizes.push(a.usdcSize);
        if (a.side === 'BUY') {
          buyCount++;
          cashOut += a.usdcSize;
          // If this BUY is for a position that won but hasn't been redeemed yet,
          // add the expected redemption value (shares × $1.00)
          if (unredeemedWinConditionIds.has(a.conditionId)) {
            unredeemedWinValue += a.size;  // Each share redeems for $1.00
          }
        } else if (a.side === 'SELL') {
          sellCount++;
          cashIn += a.usdcSize;
        }
      } else if (a.type === 'REDEEM') {
        redeemCount++;
        cashIn += a.usdcSize;
      } else if (a.type === 'SPLIT') {
        splitCount++;
        // SPLIT: USDC → Yes/No shares (neutral, no P&L)
      } else if (a.type === 'MERGE') {
        mergeCount++;
        // MERGE: Yes/No shares → USDC (neutral, no P&L)
      } else {
        otherCount++;
      }
    });

    // P&L calculation - Keep it simple and accurate
    // 1. Realized P&L: From closed (redeemed) positions - time filtered, accurate
    // 2. Unrealized P&L: From truly open positions (not resolved yet)
    // This avoids the complexity of trying to time-filter unredeemed resolved positions

    // Realized P&L from redeemed positions (time-filtered by fetchClosedPositions)
    const realizedPnl = closedPositions.reduce((sum, p) => sum + p.realizedPnl, 0);

    // Unrealized P&L from truly open positions (markets not yet resolved)
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);

    // Total P&L = Realized + Unrealized
    const totalPnl = realizedPnl + unrealizedPnl;

    // Gross profit/loss from closed positions only (for profit factor)
    const grossProfit = closedPositions.filter(p => p.realizedPnl > 0).reduce((sum, p) => sum + p.realizedPnl, 0);
    const grossLoss = Math.abs(closedPositions.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.realizedPnl, 0));

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

    // Win/loss counts from closed (redeemed) positions only - time filtered
    let wins = 0, losses = 0;
    closedPositions.forEach(p => {
      if (p.realizedPnl >= 0) wins++;
      else losses++;
    });

    // Win rate and profit factor from closed positions
    const totalClosedCount = closedPositions.length;
    const winRate = totalClosedCount > 0 ? (wins / totalClosedCount) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Open positions stats
    const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);

    // Trade sizing
    tradeSizes.sort((a, b) => a - b);
    const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
    const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
    const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

    // Market specialization analysis - From closed (redeemed) positions only (time-filtered)
    const byCategory: Record<string, { trades: number; wins: number; losses: number; totalPnl: number }> = {};

    for (const pos of closedPositions) {
      const category = categorizeMarket(pos.title);
      if (!byCategory[category]) {
        byCategory[category] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
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

    // Determine specialty
    const specialty = strengths.length > 0 ? strengths[0].category : null;

    // High conviction trades (no limit - show all)
    const asymmetricThreshold = avgTradeSize * 10;
    const asymmetricTrades = activities
      .filter(a => a.type === 'TRADE' && a.usdcSize >= asymmetricThreshold)
      .sort((a, b) => b.timestamp - a.timestamp);

    // Build recent closed positions (redeemed only, time-filtered)
    const recentClosedPositions = closedPositions
      .map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.totalBought,
        avgPrice: p.avgPrice,
        realizedPnl: p.realizedPnl,
        timestamp: new Date(p.timestamp * 1000),
        status: p.realizedPnl >= 0 ? 'WON' as const : 'LOST' as const,
      }))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 30); // Show most recent 30

    // ============================================================
    // CONSISTENCY METRICS - Daily P&L, rolling periods, streaks
    // ============================================================
    const now = Math.floor(Date.now() / 1000);
    const day7Ago = now - (7 * 24 * 60 * 60);
    const day15Ago = now - (15 * 24 * 60 * 60);

    // Group closed positions by day (UTC)
    const pnlByDay: Record<string, number> = {};
    const capitalByDay: Record<string, number> = {};

    closedPositions.forEach(p => {
      const day = new Date(p.timestamp * 1000).toISOString().split('T')[0];
      pnlByDay[day] = (pnlByDay[day] || 0) + p.realizedPnl;
    });

    // Group BUY activities by day for capital deployed
    activities.filter(a => a.type === 'TRADE' && a.side === 'BUY').forEach(a => {
      const day = new Date(a.timestamp * 1000).toISOString().split('T')[0];
      capitalByDay[day] = (capitalByDay[day] || 0) + a.usdcSize;
    });

    // Sort days chronologically
    const allDays = Object.keys(pnlByDay).sort();
    const dailyPnls = allDays.map(d => pnlByDay[d]);

    // Rolling P&L calculations
    const pnl7d = closedPositions
      .filter(p => p.timestamp >= day7Ago)
      .reduce((sum, p) => sum + p.realizedPnl, 0);

    const pnl15d = closedPositions
      .filter(p => p.timestamp >= day15Ago)
      .reduce((sum, p) => sum + p.realizedPnl, 0);

    // Profitable days
    const profitableDays = dailyPnls.filter(p => p > 0).length;
    const losingDays = dailyPnls.filter(p => p < 0).length;
    const profitableDayRate = dailyPnls.length > 0 ? (profitableDays / dailyPnls.length) * 100 : 0;

    // Consistency score (Sharpe-like: avgDailyPnl / stdDev)
    const avgDailyPnl = dailyPnls.length > 0 ? dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length : 0;
    const variance = dailyPnls.length > 0
      ? dailyPnls.reduce((sum, p) => sum + Math.pow(p - avgDailyPnl, 2), 0) / dailyPnls.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const consistencyScore = stdDev > 0 ? avgDailyPnl / stdDev : (avgDailyPnl > 0 ? 999 : 0);

    // Win/loss streaks (based on daily P&L)
    let currentStreak = 0;
    let currentStreakType: 'win' | 'loss' | null = null;
    let longestWinStreak = 0;
    let longestLossStreak = 0;

    for (const pnl of dailyPnls) {
      if (pnl > 0) {
        if (currentStreakType === 'win') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentStreakType = 'win';
        }
        longestWinStreak = Math.max(longestWinStreak, currentStreak);
      } else if (pnl < 0) {
        if (currentStreakType === 'loss') {
          currentStreak++;
        } else {
          currentStreak = 1;
          currentStreakType = 'loss';
        }
        longestLossStreak = Math.max(longestLossStreak, currentStreak);
      }
    }

    // Current streak (from most recent days)
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
    // RISK METRICS - Drawdown, capital deployed
    // ============================================================

    // Max drawdown calculation (from cumulative P&L)
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let runningPnl = 0;
    let peak = 0;

    for (const day of allDays) {
      runningPnl += pnlByDay[day];
      if (runningPnl > peak) peak = runningPnl;
      const drawdown = peak - runningPnl;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
      }
    }

    // Capital deployed metrics
    const capitalDays = Object.keys(capitalByDay).sort();
    const dailyCapitals = capitalDays.map(d => capitalByDay[d]);
    const avgDailyCapital = dailyCapitals.length > 0
      ? dailyCapitals.reduce((a, b) => a + b, 0) / dailyCapitals.length
      : 0;

    const capital7d = activities
      .filter(a => a.type === 'TRADE' && a.side === 'BUY' && a.timestamp >= day7Ago)
      .reduce((sum, a) => sum + a.usdcSize, 0);

    const capital15d = activities
      .filter(a => a.type === 'TRADE' && a.side === 'BUY' && a.timestamp >= day15Ago)
      .reduce((sum, a) => sum + a.usdcSize, 0);

    // Return on capital
    const returnOnCapital7d = capital7d > 0 ? (pnl7d / capital7d) * 100 : 0;
    const returnOnCapital15d = capital15d > 0 ? (pnl15d / capital15d) * 100 : 0;

    // Largest single loss and average loss
    const losingPositions = closedPositions.filter(p => p.realizedPnl < 0);
    const largestSingleLoss = losingPositions.length > 0
      ? Math.min(...losingPositions.map(p => p.realizedPnl))
      : 0;
    const avgLossSize = losingPositions.length > 0
      ? losingPositions.reduce((sum, p) => sum + p.realizedPnl, 0) / losingPositions.length
      : 0;

    // ============================================================
    // EDGE LOSS DETECTION - Signals for declining performance
    // ============================================================

    // Split positions into baseline (days 1-23) and recent (days 24-30)
    const day23Ago = now - (23 * 24 * 60 * 60);
    const baselinePositions = closedPositions.filter(p => p.timestamp < day7Ago);
    const recentPositions = closedPositions.filter(p => p.timestamp >= day7Ago);

    // Baseline win rate (days 1-23)
    const baselineWins = baselinePositions.filter(p => p.realizedPnl >= 0).length;
    const baselineWinRate = baselinePositions.length > 0
      ? (baselineWins / baselinePositions.length) * 100
      : 0;

    // Recent win rate (last 7 days)
    const recentWins = recentPositions.filter(p => p.realizedPnl >= 0).length;
    const recentWinRate = recentPositions.length > 0
      ? (recentWins / recentPositions.length) * 100
      : 0;

    // Win rate decline
    const winRateDecline = baselineWinRate - recentWinRate;

    // P&L trend (is recent P&L worse than baseline daily average?)
    const baselinePnl = baselinePositions.reduce((sum, p) => sum + p.realizedPnl, 0);
    const baselineDays = Math.max(1, days - 7);
    const baselineAvgDailyPnl = baselinePnl / baselineDays;
    const recentAvgDailyPnl = pnl7d / 7;
    const pnlTrendDecline = baselineAvgDailyPnl - recentAvgDailyPnl;

    // Recent average trade size vs historical
    const recentTrades = activities.filter(a =>
      a.type === 'TRADE' && a.timestamp >= day7Ago
    );
    const baselineTrades = activities.filter(a =>
      a.type === 'TRADE' && a.timestamp < day7Ago
    );
    const recentAvgTradeSize = recentTrades.length > 0
      ? recentTrades.reduce((sum, a) => sum + a.usdcSize, 0) / recentTrades.length
      : 0;
    const baselineAvgTradeSize = baselineTrades.length > 0
      ? baselineTrades.reduce((sum, a) => sum + a.usdcSize, 0) / baselineTrades.length
      : avgTradeSize;

    // Volume spike detection (recent 7d capital vs average * 7)
    const expectedCapital7d = avgDailyCapital * 7;
    const volumeSpikeRatio = expectedCapital7d > 0 ? capital7d / expectedCapital7d : 1;

    // Trade size increase (potential tilt indicator)
    const tradeSizeIncreaseRatio = baselineAvgTradeSize > 0
      ? recentAvgTradeSize / baselineAvgTradeSize
      : 1;

    // Category-specific edge loss (for significant categories >10% volume)
    const totalVolume = closedPositions.length;
    const categoryEdgeLoss: Array<{
      category: string;
      baselineWinRate: number;
      recentWinRate: number;
      decline: number;
    }> = [];

    // Build category stats for baseline and recent
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

    // Check significant categories for edge loss
    const significantCategories = marketPerformance
      .filter(mp => totalVolume > 0 && (mp.trades / totalVolume) >= 0.10)
      .slice(0, 3);

    for (const cat of significantCategories) {
      const baseline = categoryBaseline[cat.category];
      const recent = categoryRecent[cat.category];

      if (baseline && baseline.total >= 5 && recent && recent.total >= 2) {
        const baseWR = (baseline.wins / baseline.total) * 100;
        const recentWR = (recent.wins / recent.total) * 100;
        const decline = baseWR - recentWR;

        if (decline > 12) {  // >12% decline threshold
          categoryEdgeLoss.push({
            category: cat.category,
            baselineWinRate: baseWR,
            recentWinRate: recentWR,
            decline,
          });
        }
      }
    }

    // Compile edge loss signals with thresholds
    const edgeLossSignals = {
      // Win rate dropped >12%
      winRateDecline: winRateDecline > 12,
      winRateDeclineValue: winRateDecline,

      // Recent P&L is negative
      pnl7dNegative: pnl7d < 0,
      pnl7dValue: pnl7d,

      // Loss streak ≥4 consecutive days
      lossStreakAlert: recentStreakType === 'loss' && recentStreak >= 4,
      currentLossStreak: recentStreakType === 'loss' ? recentStreak : 0,

      // Volume spike >1.75x normal
      volumeSpike: volumeSpikeRatio > 1.75,
      volumeSpikeRatio,

      // Trade size increase >1.5x (potential tilt)
      tradeSizeIncrease: tradeSizeIncreaseRatio > 1.5,
      tradeSizeIncreaseRatio,

      // Category-specific edge loss
      categoryEdgeLoss,
      hasCategoryEdgeLoss: categoryEdgeLoss.length > 0,

      // Overall edge loss flag (any significant signal)
      hasEdgeLossWarning: winRateDecline > 12 ||
        (pnl7d < 0 && pnl15d < pnl7d) ||
        (recentStreakType === 'loss' && recentStreak >= 4) ||
        categoryEdgeLoss.length > 0,
    };

    // Build profile data
    const profileData = {
      wallet: cleanWallet,
      label: traderLabel,
      profiledAt: new Date(),
      periodDays: days,

      // Basic stats
      totalActivities: activities.length,
      buyCount,
      sellCount,
      redeemCount,
      splitCount,
      mergeCount,
      otherCount,

      // Classification
      tradesPerDay,
      volumeLabel,
      buyRatio,
      strategyLabel,

      // Performance - Simple P&L calculation
      // Realized P&L: From closed (redeemed) positions - time filtered
      // Unrealized P&L: From open positions (markets not resolved)
      realizedPnl,          // P&L from redeemed positions (time-filtered)
      unrealizedPnl,        // P&L from open positions (paper gains/losses)
      totalPnl,             // realizedPnl + unrealizedPnl
      grossProfit,          // Sum of winning closed positions
      grossLoss,            // Sum of losing closed positions (absolute)
      profitFactor,

      // Win/loss stats from closed positions (time-filtered)
      closedPositionsCount: closedPositions.length,
      wins,
      losses,
      winRate,

      // Recent closed positions (for display)
      recentClosedPositions,

      // Open positions
      openPositionsCount: openPositions.length,
      openValue,
      unrealizedPnl,

      // Trade sizing
      avgTradeSize,
      medianTradeSize,
      maxTradeSize,

      // Specialty
      specialty,
      strengths,
      weaknesses,

      // High conviction
      asymmetricThreshold,
      asymmetricTradesCount: asymmetricTrades.length,
      recentHighConvictionTrades: asymmetricTrades.map(t => ({
        timestamp: new Date(t.timestamp * 1000),
        side: t.side || 'UNKNOWN',
        market: t.title,
        outcome: t.outcome,
        price: t.price,
        usdcSize: t.usdcSize,
        sizeMultiplier: avgTradeSize > 0 ? t.usdcSize / avgTradeSize : 0,
        txHash: t.transactionHash,
      })),

      // Top open positions (no limit - save all for accurate display)
      topOpenPositions: openPositions
        .sort((a, b) => b.currentValue - a.currentValue)
        .map(p => ({
          title: p.title,
          outcome: p.outcome,
          size: p.size,
          avgPrice: p.avgPrice,
          curPrice: p.curPrice,
          currentValue: p.currentValue,
          cashPnl: p.cashPnl,
          percentPnl: p.percentPnl,
        })),

      // ============================================================
      // CONSISTENCY METRICS
      // ============================================================
      consistency: {
        // Rolling P&L
        pnl7d,
        pnl15d,
        avgDailyPnl,

        // Daily performance
        tradingDays: allDays.length,
        profitableDays,
        losingDays,
        profitableDayRate,

        // Consistency score (Sharpe-like: avgDailyPnl / stdDev)
        consistencyScore,
        stdDev,

        // Streaks (based on daily P&L)
        longestWinStreak,
        longestLossStreak,
        currentStreak: recentStreak,
        currentStreakType: recentStreakType,
      },

      // ============================================================
      // RISK METRICS
      // ============================================================
      risk: {
        // Drawdown
        maxDrawdown,
        maxDrawdownPercent,

        // Capital deployed
        avgDailyCapital,
        capital7d,
        capital15d,

        // Return on capital
        returnOnCapital7d,
        returnOnCapital15d,

        // Loss analysis
        largestSingleLoss,
        avgLossSize,
      },

      // ============================================================
      // EDGE LOSS SIGNALS
      // ============================================================
      edgeLoss: {
        // Baseline vs recent comparison
        baselineWinRate,
        recentWinRate,
        winRateDecline,

        // P&L trend
        baselineAvgDailyPnl,
        recentAvgDailyPnl,
        pnlTrendDecline,

        // Volume and sizing changes
        volumeSpikeRatio,
        tradeSizeIncreaseRatio,
        recentAvgTradeSize,

        // Category-specific edge loss
        categoryEdgeLoss,

        // Alert signals
        signals: edgeLossSignals,
      },
    };

    // Save to MongoDB
    const client = await clientPromise;
    const db = client.db(dbName);

    // Upsert into traderProfiles collection
    await db.collection('polymarket-traderProfiles').updateOne(
      { wallet: cleanWallet },
      { $set: profileData },
      { upsert: true }
    );

    // Also upsert into trackedTraders (but with isTracking = false initially)
    await db.collection('polymarket-trackedTraders').updateOne(
      { wallet: cleanWallet },
      {
        $set: {
          wallet: cleanWallet,
          label: traderLabel,
          isActive: true,
          isTracking: false, // Not tracking until user clicks "Start Tracking"
          volumeLabel,
          strategyLabel,
          specialty,
          winRate,
          profitFactor,
          realizedPnl,
          unrealizedPnl,
          avgTradeSize,
          lastUpdatedAt: new Date(),
        },
        $setOnInsert: {
          addedAt: new Date(),
          lastSeenTimestamp: Math.floor(Date.now() / 1000),
          totalAlerts: 0,
          totalCopied: 0,
          totalPnl: 0,
        },
      },
      { upsert: true }
    );

    return NextResponse.json({
      success: true,
      profile: profileData,
    });

  } catch (error: any) {
    console.error('Error profiling trader:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
