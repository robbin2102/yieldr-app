import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for profiling

const API_BASE = 'https://data-api.polymarket.com';

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
  const LIMIT = 500;
  const MAX_OFFSET = 5000;

  let allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

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

// Fetch open positions
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// Fetch closed positions
async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 50;
  const MAX_OFFSET = 2000;

  let allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

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
    const LOSS_THRESHOLD = 0.001;  // <0.1¢ = resolved loss (allows 0.1-1¢ positions to show as active)
    const WIN_THRESHOLD = 0.99;   // >99¢ = resolved win

    const openPositions = allOpenPositions.filter(p =>
      p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD
    );
    const resolvedLosses = allOpenPositions.filter(p =>
      p.curPrice < LOSS_THRESHOLD && p.size > 0
    );
    const resolvedWins = allOpenPositions.filter(p =>
      p.curPrice > WIN_THRESHOLD && p.size > 0
    );

    // Count activities by type
    let buyCount = 0, sellCount = 0, redeemCount = 0, otherCount = 0;
    const tradeSizes: number[] = [];

    activities.forEach(a => {
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

    // Closed positions analysis
    let grossProfit = 0, grossLoss = 0, wins = 0, losses = 0;
    closedPositions.forEach(p => {
      if (p.realizedPnl >= 0) {
        grossProfit += p.realizedPnl;
        wins++;
      } else {
        grossLoss += Math.abs(p.realizedPnl);
        losses++;
      }
    });

    // Add resolved losses (unredeemed losing positions at 0¢)
    let unredeemedLossCount = 0;
    let unredeemedLossAmount = 0;
    resolvedLosses.forEach(p => {
      const lossAmount = p.initialValue;
      unredeemedLossAmount += lossAmount;
      unredeemedLossCount++;
      losses++;
      grossLoss += lossAmount;
    });

    // Add resolved wins (unredeemed winning positions at 100¢)
    let unredeemedWinCount = 0;
    let unredeemedWinAmount = 0;
    resolvedWins.forEach(p => {
      const winAmount = p.currentValue - p.initialValue; // Profit
      unredeemedWinAmount += winAmount;
      unredeemedWinCount++;
      wins++;
      grossProfit += winAmount;
    });

    const totalClosedCount = closedPositions.length + unredeemedLossCount + unredeemedWinCount;
    const winRate = totalClosedCount > 0 ? (wins / totalClosedCount) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const netPnl = grossProfit - grossLoss;

    // Open positions stats
    const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);

    // Trade sizing
    tradeSizes.sort((a, b) => a - b);
    const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
    const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
    const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

    // Market specialization analysis - INCLUDE ALL resolved positions (redeemed + unredeemed)
    const byCategory: Record<string, { trades: number; wins: number; losses: number; totalPnl: number }> = {};

    // 1. Add closed (redeemed) positions
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

    // 2. Add resolved losses (unredeemed 0¢ positions)
    for (const pos of resolvedLosses) {
      const category = categorizeMarket(pos.title);
      if (!byCategory[category]) {
        byCategory[category] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
      byCategory[category].trades++;
      byCategory[category].totalPnl -= pos.initialValue; // Loss = negative
      byCategory[category].losses++;
    }

    // 3. Add resolved wins (unredeemed 100¢ positions)
    for (const pos of resolvedWins) {
      const category = categorizeMarket(pos.title);
      if (!byCategory[category]) {
        byCategory[category] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
      byCategory[category].trades++;
      const profit = pos.currentValue - pos.initialValue;
      byCategory[category].totalPnl += profit;
      byCategory[category].wins++;
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

    // Build recent closed positions (combine redeemed + resolved wins/losses)
    const recentClosedPositions = [
      // Official closed positions (redeemed)
      ...closedPositions.map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.totalBought,
        avgPrice: p.avgPrice,
        realizedPnl: p.realizedPnl,
        timestamp: new Date(p.timestamp * 1000),
        status: 'REDEEMED' as const,
      })),
      // Resolved wins (100¢, not yet redeemed)
      ...resolvedWins.map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        realizedPnl: p.currentValue - p.initialValue,
        timestamp: new Date(), // Use now as timestamp since we don't have exact resolution time
        status: 'WON' as const,
      })),
      // Resolved losses (0¢, not yet redeemed)
      ...resolvedLosses.map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        realizedPnl: -p.initialValue, // Loss = negative initial value
        timestamp: new Date(),
        status: 'LOST' as const,
      })),
    ].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 20); // Show most recent 20

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
      otherCount,

      // Classification
      tradesPerDay,
      volumeLabel,
      buyRatio,
      strategyLabel,

      // Performance
      closedPositionsCount: closedPositions.length,
      unredeemedLossCount,
      unredeemedLossAmount,
      unredeemedWinCount,
      unredeemedWinAmount,
      totalResolvedCount: totalClosedCount,
      wins,
      losses,
      winRate,
      grossProfit,
      grossLoss,
      netPnl,
      profitFactor,

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
          netPnl,
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
