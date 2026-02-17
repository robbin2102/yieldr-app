/**
 * Test script to calculate P&L using Cash Flow approach from activities
 *
 * Formula: P&L = (Sells + Redeems + Ending Value) - Buys
 *
 * Where:
 * - Buys = Σ BUY.usdcSize (cash spent)
 * - Sells = Σ SELL.usdcSize (cash received from selling)
 * - Redeems = Σ REDEEM.usdcSize (cash received from redemptions)
 * - Ending Value = net_shares × current_price (for positions still held)
 * - net_shares = Σ BUY.size - Σ SELL.size - Σ REDEEM.size
 */

const API_BASE = 'https://data-api.polymarket.com';

interface Activity {
  conditionId: string;
  title: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  usdcSize: number;
  timestamp: number;
}

interface Position {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  curPrice: number;
  currentValue: number;
  cashPnl: number;
  realizedPnl: number;
}

interface PositionActivity {
  conditionId: string;
  title: string;
  outcome: string;
  buys: number;       // USDC spent
  sells: number;      // USDC received from sells
  redeems: number;    // USDC received from redeems
  netShares: number;  // Shares still held
  buyCount: number;
  sellCount: number;
  redeemCount: number;
}

async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 10000; // API allows up to 10000 per docs

  let allActivities: Activity[] = [];
  let offset = 0;
  let reachedTimeLimit = false;

  console.log(`  Fetching activities for last ${days} days...`);

  while (offset <= MAX_OFFSET) {
    // Don't use 'start' param - it causes 400 errors for some users
    // Instead, fetch all and filter client-side (sorted DESC so newest first)
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err: any) {
      console.log(`  Network error at offset ${offset}, stopping`);
      break;
    }

    if (!response.ok) {
      if (response.status === 400) {
        // Hit API limit, stop gracefully
        console.log(`  API limit reached at offset ${offset}`);
        break;
      }
      throw new Error(`API error: ${response.status}`);
    }

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    // Filter by time and check if we've gone past our time window
    for (const activity of batch) {
      if (activity.timestamp >= cutoffTs) {
        allActivities.push(activity);
      } else {
        // Since sorted DESC, once we hit an old activity, all remaining are older
        reachedTimeLimit = true;
        break;
      }
    }

    if (reachedTimeLimit) {
      console.log(`  Reached time cutoff at offset ${offset}`);
      break;
    }

    if (batch.length < LIMIT) break; // Last page
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`  Found ${allActivities.length} activities in ${days}d window (offset reached: ${offset})`);
  return allActivities;
}

async function fetchPositions(wallet: string): Promise<Position[]> {
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allPositions: Position[] = [];
  let offset = 0;

  console.log(`  Fetching current positions...`);

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const batch = await response.json() as Position[];
    if (batch.length === 0) break;

    allPositions = allPositions.concat(batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`  Found ${allPositions.length} positions`);
  return allPositions;
}

interface ClosedPosition {
  conditionId: string;
  title: string;
  outcome: string;
  realizedPnl: number;
  boughtShares: number;
  soldShares: number;
  redeemedShares: number;
  avgPrice: number;
  settlePrice: number;
  timestamp: number;
}

async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allClosed: ClosedPosition[] = [];
  let offset = 0;

  console.log(`  Fetching closed positions for last ${days} days...`);

  while (offset <= MAX_OFFSET) {
    // Use start parameter for time filtering on closed positions endpoint
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&startTime=${startTs}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err: any) {
      console.log(`  Network error at offset ${offset}, stopping`);
      break;
    }

    if (!response.ok) {
      if (response.status === 400) {
        console.log(`  API limit reached at offset ${offset}`);
        break;
      }
      throw new Error(`Closed positions API error: ${response.status}`);
    }

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    allClosed = allClosed.concat(batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`  Found ${allClosed.length} closed positions in ${days}d window`);
  return allClosed;
}

function calculateCashFlowPnL(
  activities: Activity[],
  positions: Position[]
): {
  totalPnL: number;
  totalBuys: number;
  totalSells: number;
  totalRedeems: number;
  totalEndingValue: number;
  positionCount: number;
  wins: number;
  losses: number;
  activityBreakdown: { trades: number; redeems: number; splits: number; merges: number; other: number };
} {
  // Build position lookup by conditionId + outcome
  const positionMap = new Map<string, Position>();
  for (const pos of positions) {
    const key = `${pos.conditionId}-${pos.outcome}`;
    positionMap.set(key, pos);
  }

  // Group activities by conditionId + outcome
  const activityByPosition = new Map<string, PositionActivity>();

  let activityBreakdown = { trades: 0, redeems: 0, splits: 0, merges: 0, other: 0 };

  for (const activity of activities) {
    const key = `${activity.conditionId}-${activity.outcome}`;

    if (!activityByPosition.has(key)) {
      activityByPosition.set(key, {
        conditionId: activity.conditionId,
        title: activity.title,
        outcome: activity.outcome,
        buys: 0,
        sells: 0,
        redeems: 0,
        netShares: 0,
        buyCount: 0,
        sellCount: 0,
        redeemCount: 0,
      });
    }

    const pa = activityByPosition.get(key)!;

    if (activity.type === 'TRADE') {
      activityBreakdown.trades++;
      if (activity.side === 'BUY') {
        pa.buys += activity.usdcSize;
        pa.netShares += activity.size;
        pa.buyCount++;
      } else if (activity.side === 'SELL') {
        pa.sells += activity.usdcSize;
        pa.netShares -= activity.size;
        pa.sellCount++;
      }
    } else if (activity.type === 'REDEEM') {
      activityBreakdown.redeems++;
      pa.redeems += activity.usdcSize;
      pa.netShares -= activity.size;
      pa.redeemCount++;
    } else if (activity.type === 'SPLIT') {
      activityBreakdown.splits++;
      // SPLIT: $1 USDC -> 1 YES + 1 NO (neutral, no P&L impact)
      // But it adds shares, so track it
      pa.netShares += activity.size;
    } else if (activity.type === 'MERGE') {
      activityBreakdown.merges++;
      // MERGE: 1 YES + 1 NO -> $1 USDC (neutral, no P&L impact)
      pa.netShares -= activity.size;
    } else {
      activityBreakdown.other++;
    }
  }

  // Calculate P&L for each position
  let totalBuys = 0;
  let totalSells = 0;
  let totalRedeems = 0;
  let totalEndingValue = 0;
  let wins = 0;
  let losses = 0;

  for (const [key, pa] of activityByPosition) {
    totalBuys += pa.buys;
    totalSells += pa.sells;
    totalRedeems += pa.redeems;

    // Get current price for ending value
    const position = positionMap.get(key);
    let endingValue = 0;

    if (pa.netShares > 0) {
      if (position) {
        // Use actual current price
        endingValue = pa.netShares * position.curPrice;
      } else {
        // Position not found - might have been fully sold/redeemed
        // If we have net shares but no position, assume 0 value (resolved loss or sold)
        endingValue = 0;
      }
    }

    totalEndingValue += endingValue;

    // Calculate P&L for this position
    const positionPnL = pa.sells + pa.redeems + endingValue - pa.buys;
    if (positionPnL >= 0) wins++;
    else losses++;
  }

  const totalPnL = totalSells + totalRedeems + totalEndingValue - totalBuys;

  return {
    totalPnL,
    totalBuys,
    totalSells,
    totalRedeems,
    totalEndingValue,
    positionCount: activityByPosition.size,
    wins,
    losses,
    activityBreakdown,
  };
}

function formatUSD(value: number): string {
  if (Math.abs(value) >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  } else if (Math.abs(value) >= 1000) {
    return `$${(value / 1000).toFixed(2)}K`;
  }
  return `$${value.toFixed(2)}`;
}

async function analyzeWallet(wallet: string, label: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Analyzing: ${label}`);
  console.log(`Wallet: ${wallet}`);
  console.log(`${'='.repeat(60)}`);

  // Fetch positions once
  const positions = await fetchPositions(wallet);

  // Analyze for different time periods
  const periods = [1, 7, 30];

  for (const days of periods) {
    console.log(`\n--- ${days}D P&L Analysis ---`);

    try {
      // Method 1: Cash flow from activities (limited to ~3500 most recent)
      const activities = await fetchActivities(wallet, days);

      // Method 2: Closed positions with timestamp filtering (more reliable for redeems)
      const closedPositions = await fetchClosedPositions(wallet, days);

      // Calculate closed positions P&L
      const closedPnL = closedPositions.reduce((sum, cp) => sum + cp.realizedPnl, 0);
      const closedWins = closedPositions.filter(cp => cp.realizedPnl >= 0).length;
      const closedLosses = closedPositions.filter(cp => cp.realizedPnl < 0).length;

      console.log(`\n  Closed Positions (from /v1/closed-positions):`);
      console.log(`    Count: ${closedPositions.length}`);
      console.log(`    Realized P&L: ${formatUSD(closedPnL)}`);
      console.log(`    Wins: ${closedWins}, Losses: ${closedLosses}`);

      if (activities.length === 0) {
        console.log(`\n  No activities in ${days}d window`);
        console.log(`\n    *** ${days}D P&L (closed only): ${formatUSD(closedPnL)} ***`);
        continue;
      }

      const result = calculateCashFlowPnL(activities, positions);

      console.log(`\n  Activities (from /activity, max ~3500):`);
      console.log(`    Trades: ${result.activityBreakdown.trades}`);
      console.log(`    Redeems: ${result.activityBreakdown.redeems}`);
      console.log(`    Splits: ${result.activityBreakdown.splits}`);
      console.log(`    Merges: ${result.activityBreakdown.merges}`);

      console.log(`\n  Cash Flow (activities-based):`);
      console.log(`    Total Buys (cash out):     ${formatUSD(result.totalBuys)}`);
      console.log(`    Total Sells (cash in):     ${formatUSD(result.totalSells)}`);
      console.log(`    Total Redeems (cash in):   ${formatUSD(result.totalRedeems)}`);
      console.log(`    Ending Value (still held): ${formatUSD(result.totalEndingValue)}`);
      console.log(`    Activities P&L:            ${formatUSD(result.totalPnL)}`);

      // For open positions that had activity, calculate unrealized P&L
      // Get conditionIds from activities
      const activityConditionIds = new Set(activities.map(a => `${a.conditionId}-${a.outcome}`));
      const openWithActivity = positions.filter(p => {
        const key = `${p.conditionId}-${p.outcome}`;
        return activityConditionIds.has(key) && p.curPrice >= 0.001 && p.curPrice <= 0.99;
      });
      const unrealizedPnL = openWithActivity.reduce((sum, p) => sum + p.cashPnl, 0);

      console.log(`\n  Open Positions with ${days}d Activity:`);
      console.log(`    Count: ${openWithActivity.length}`);
      console.log(`    Unrealized P&L: ${formatUSD(unrealizedPnL)}`);

      // Combined P&L = Closed positions realized + Open positions unrealized
      const combinedPnL = closedPnL + unrealizedPnL;

      console.log(`\n  Results:`);
      console.log(`    Closed positions: ${closedPositions.length}`);
      console.log(`    Open with activity: ${openWithActivity.length}`);
      console.log(`    Total: ${closedPositions.length + openWithActivity.length}`);
      console.log(`    Win Rate (closed): ${closedPositions.length > 0 ? ((closedWins / closedPositions.length) * 100).toFixed(1) : 0}%`);

      console.log(`\n    *** ${days}D P&L: ${formatUSD(combinedPnL)} ***`);
      console.log(`        (Closed: ${formatUSD(closedPnL)} + Open Unrealized: ${formatUSD(unrealizedPnL)})`);

    } catch (error: any) {
      console.error(`  Error: ${error.message}`);
    }
  }

  // Also show position stats
  console.log(`\n--- Position Summary ---`);
  const activePositions = positions.filter(p => p.curPrice >= 0.001 && p.curPrice <= 0.99);
  const resolvedLosses = positions.filter(p => p.curPrice < 0.001);
  const resolvedWins = positions.filter(p => p.curPrice > 0.99);

  console.log(`  Active positions: ${activePositions.length}`);
  console.log(`  Resolved losses (0¢): ${resolvedLosses.length}`);
  console.log(`  Resolved wins (100¢): ${resolvedWins.length}`);
  console.log(`  Total positions: ${positions.length}`);

  const totalCashPnl = positions.reduce((sum, p) => sum + p.cashPnl, 0);
  const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
  console.log(`\n  Total cashPnl (all positions): ${formatUSD(totalCashPnl)}`);
  console.log(`  Total realizedPnl (partial sells): ${formatUSD(totalRealizedPnl)}`);
}

async function main() {
  console.log('Testing Cash Flow P&L Calculation');
  console.log('Compare results with Polymarket UI to validate');

  // Wallet 1: DrPufferfish (many trades)
  await analyzeWallet(
    '0xdb27bf2ac5d428a9c63dbc914611036855a6c56e',
    'DrPufferfish (Sports, 1046 predictions)'
  );

  // Wallet 2: Crypto bot (fewer trades)
  await analyzeWallet(
    '0xcbb1a3174d9ac5a0f57f5b86808204b9382e7afb',
    'Crypto Bot (39 predictions)'
  );
}

main().catch(console.error);
