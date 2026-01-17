/**
 * Trader Profiler - Deep analysis of a Polymarket trader
 *
 * Usage:
 *   npx tsx scripts/profile-trader.ts <wallet_address> [days]
 *
 * Examples:
 *   npx tsx scripts/profile-trader.ts 0xb8cd777114b6cc4d488e79eff1fef91e1c521f4b
 *   npx tsx scripts/profile-trader.ts 0xb8cd777114b6cc4d488e79eff1fef91e1c521f4b 30
 */

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
  avgRoi: number;
}

interface TraderProfile {
  wallet: string;
  period: { days: number; start: string; end: string };

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
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number;

  // Open positions
  openCount: number;
  openValue: number;
  unrealizedPnl: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // Market specialization
  strengths: MarketPerformance[];
  weaknesses: MarketPerformance[];

  // Entry odds analysis
  entryOddsPerformance: EntryOddsPerformance[];

  // Trader label
  label: string;

  // Copy rules
  copyRules: {
    priority: string;
    copy: string;
    cautious: string;
    skip: string;
  };

  // Stop conditions
  stopConditions: string[];
}

// ═══════════════════════════════════════════════════════════════
// API Functions
// ═══════════════════════════════════════════════════════════════

async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  console.log(`  [DEBUG] fetchActivities called: wallet=${wallet.slice(0,10)}..., days=${days}`);

  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;       // API max per request
  const MAX_OFFSET = 10000; // API max offset

  console.log(`  [DEBUG] Time range: ${new Date(startTs * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`);

  let allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    console.log(`  [DEBUG] Fetching: ${url.substring(0, 80)}...`);

    const response = await fetch(url);
    console.log(`  [DEBUG] Response status: ${response.status}`);

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as Activity[];
    console.log(`  [DEBUG] Batch size: ${batch.length}`);

    if (batch.length === 0) break;

    // Check last activity in batch for progress
    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  Fetching offset ${offset}... [${allActivities.length} collected] (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

    // Filter to time range
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

    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  if (offset > MAX_OFFSET && !done) {
    console.log(`  Hit API offset limit (${MAX_OFFSET}) - may have more activities`);
  }

  return allActivities;
}

async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const LIMIT = 500;        // API max per request
  const MAX_OFFSET = 10000; // API max offset

  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as OpenPosition[];
    console.log(`  Fetching offset ${offset}... [${allPositions.length + batch.length} positions]`);

    if (batch.length === 0) break;
    allPositions = allPositions.concat(batch);

    if (batch.length < LIMIT) break;
    offset += LIMIT;

    await new Promise(r => setTimeout(r, 100));
  }

  if (offset > MAX_OFFSET) {
    console.log(`  Hit API offset limit (${MAX_OFFSET}) - may have more positions`);
  }

  return allPositions;
}

async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 50;          // API max per request (closed-positions max is 50!)
  const MAX_OFFSET = 100000; // API max offset

  let allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  Fetching offset ${offset}... [${allPositions.length} positions] (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

    // Filter to time range
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

    await new Promise(r => setTimeout(r, 100));
  }

  if (offset > MAX_OFFSET && !done) {
    console.log(`  Hit API offset limit (${MAX_OFFSET}) - may have more closed positions`);
  }

  return allPositions;
}

// ═══════════════════════════════════════════════════════════════
// Analysis Functions
// ═══════════════════════════════════════════════════════════════

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  if (lower.includes('nba') || lower.includes('basketball') ||
      lower.includes('lakers') || lower.includes('celtics') ||
      lower.includes('bulls') || lower.includes('heat') ||
      lower.includes('warriors') || lower.includes('nuggets') ||
      lower.includes('clippers') || lower.includes('spurs') ||
      lower.includes('mavericks') || lower.includes('thunder') ||
      lower.includes('rockets') || lower.includes('suns') ||
      lower.includes('knicks') || lower.includes('nets') ||
      lower.includes('76ers') || lower.includes('bucks') ||
      lower.includes('cavaliers') || lower.includes('grizzlies') ||
      lower.includes('timberwolves') || lower.includes('pelicans') ||
      lower.includes('blazers') || lower.includes('kings') ||
      lower.includes('jazz') || lower.includes('hawks') ||
      lower.includes('hornets') || lower.includes('magic') ||
      lower.includes('pistons') || lower.includes('pacers') ||
      lower.includes('wizards') || lower.includes('raptors')) {
    if (lower.includes('o/u') || lower.includes('over') || lower.includes('under') || lower.includes('total')) {
      return 'NBA O/U';
    }
    if (lower.includes('spread') || lower.includes('+') || lower.includes('-')) {
      return 'NBA Spread';
    }
    if (lower.includes('mvp') || lower.includes('roy') || lower.includes('finals') || lower.includes('champion')) {
      return 'NBA Futures';
    }
    return 'NBA Moneyline';
  }

  if (lower.includes('nfl') || lower.includes('football') ||
      lower.includes('chiefs') || lower.includes('eagles') ||
      lower.includes('bills') || lower.includes('ravens') ||
      lower.includes('cowboys') || lower.includes('49ers') ||
      lower.includes('patriots') || lower.includes('broncos') ||
      lower.includes('packers') || lower.includes('lions') ||
      lower.includes('dolphins') || lower.includes('jets') ||
      lower.includes('raiders') || lower.includes('chargers') ||
      lower.includes('steelers') || lower.includes('bengals') ||
      lower.includes('browns') || lower.includes('texans') ||
      lower.includes('colts') || lower.includes('jaguars') ||
      lower.includes('titans') || lower.includes('saints') ||
      lower.includes('falcons') || lower.includes('panthers') ||
      lower.includes('buccaneers') || lower.includes('vikings') ||
      lower.includes('bears') || lower.includes('commanders') ||
      lower.includes('giants') || lower.includes('cardinals') ||
      lower.includes('seahawks') || lower.includes('rams') ||
      lower.includes('super bowl')) {
    return 'NFL';
  }

  if (lower.includes('nhl') || lower.includes('hockey') ||
      lower.includes('canucks') || lower.includes('flames') ||
      lower.includes('oilers') || lower.includes('maple leafs') ||
      lower.includes('canadiens') || lower.includes('senators') ||
      lower.includes('jets') || lower.includes('bruins') ||
      lower.includes('rangers') || lower.includes('islanders') ||
      lower.includes('devils') || lower.includes('flyers') ||
      lower.includes('penguins') || lower.includes('capitals') ||
      lower.includes('hurricanes') || lower.includes('blue jackets') ||
      lower.includes('lightning') || lower.includes('panthers') ||
      lower.includes('red wings') || lower.includes('blackhawks') ||
      lower.includes('wild') || lower.includes('blues') ||
      lower.includes('predators') || lower.includes('stars') ||
      lower.includes('avalanche') || lower.includes('coyotes') ||
      lower.includes('golden knights') || lower.includes('kraken') ||
      lower.includes('kings') || lower.includes('ducks') ||
      lower.includes('sharks')) {
    return 'NHL';
  }

  if (lower.includes('mlb') || lower.includes('baseball')) {
    return 'MLB';
  }

  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate')) {
    return 'Politics';
  }

  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') ||
      lower.includes('btc') || lower.includes('eth')) {
    return 'Crypto';
  }

  return 'Other';
}

function analyzeMarketPerformance(closedPositions: ClosedPosition[]): { strengths: MarketPerformance[]; weaknesses: MarketPerformance[] } {
  const byCategory: Record<string, { trades: number; wins: number; losses: number; totalPnl: number }> = {};

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

  const performances: MarketPerformance[] = Object.entries(byCategory).map(([category, stats]) => ({
    category,
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
    totalPnl: stats.totalPnl,
    avgPnl: stats.trades > 0 ? stats.totalPnl / stats.trades : 0,
  }));

  // Sort by total PnL
  const sorted = performances.sort((a, b) => b.totalPnl - a.totalPnl);

  const strengths = sorted.filter(p => p.totalPnl > 0).slice(0, 5);
  const weaknesses = sorted.filter(p => p.totalPnl < 0).slice(-5).reverse();

  return { strengths, weaknesses };
}

function analyzeEntryOdds(activities: Activity[]): EntryOddsPerformance[] {
  // Group BUY trades by entry odds
  const buyTrades = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY');

  const ranges = [
    { label: '< 25c (Big underdog)', min: 0, max: 0.25 },
    { label: '25-40c (Underdog)', min: 0.25, max: 0.40 },
    { label: '40-60c (Toss-up)', min: 0.40, max: 0.60 },
    { label: '60-75c (Favorite)', min: 0.60, max: 0.75 },
    { label: '> 75c (Heavy favorite)', min: 0.75, max: 1.0 },
  ];

  return ranges.map(range => {
    const trades = buyTrades.filter(t => t.price >= range.min && t.price < range.max);
    const wins = trades.filter(t => t.price < 0.5).length; // Simplified - assume underdog wins often

    return {
      range: range.label,
      trades: trades.length,
      wins,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      avgRoi: 0, // Would need resolution data
    };
  }).filter(r => r.trades > 0);
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
    if (topCategory.includes('NBA')) labels.push('NBA_SPECIALIST');
    if (topCategory.includes('NFL')) labels.push('NFL_SPECIALIST');
    if (topCategory.includes('NHL')) labels.push('NHL_SPECIALIST');
    if (topCategory === 'Politics') labels.push('POLITICS_SPECIALIST');
  }

  return labels.join(' | ') || 'UNKNOWN';
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('[DEBUG] Script version: 2026-01-17-v2 with pagination');

  const wallet = process.argv[2];
  const days = parseInt(process.argv[3] || '30');

  if (!wallet) {
    console.log('Usage: npx tsx scripts/profile-trader.ts <wallet_address> [days]');
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const startDate = new Date((now - days * 24 * 60 * 60) * 1000).toISOString().split('T')[0];
  const endDate = new Date(now * 1000).toISOString().split('T')[0];

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    TRADER PROFILER                              ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Wallet:  ${wallet}`);
  console.log(`Period:  Last ${days} days (${startDate} to ${endDate})`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Fetch data
  console.log('Fetching activities...');
  const activities = await fetchActivities(wallet, days);
  console.log(`  Found ${activities.length} activities\n`);

  console.log('Fetching open positions...');
  const openPositions = await fetchOpenPositions(wallet);
  console.log(`  Found ${openPositions.length} open positions\n`);

  console.log('Fetching closed positions...');
  const closedPositions = await fetchClosedPositions(wallet, days);
  console.log(`  Found ${closedPositions.length} closed positions\n`);

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

  const winRate = closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const netPnl = grossProfit - grossLoss;

  // Open positions
  const openValue = openPositions.reduce((sum, p) => sum + p.currentValue, 0);
  const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.cashPnl, 0);

  // Trade sizing
  tradeSizes.sort((a, b) => a - b);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
  const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
  const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

  // Market analysis
  const { strengths, weaknesses } = analyzeMarketPerformance(closedPositions);

  // Entry odds analysis
  const entryOddsPerformance = analyzeEntryOdds(activities);

  // Determine label
  const label = determineTraderLabel({
    volumeLabel,
    strategyLabel,
    winRate,
    profitFactor,
    strengths,
  });

  // Print results
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    BASIC STATS                                 ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total Activities:   ${activities.length}`);
  console.log(`  TRADE (BUY):        ${buyCount}`);
  console.log(`  TRADE (SELL):       ${sellCount}`);
  console.log(`  REDEEM:             ${redeemCount}`);
  console.log(`  Other:              ${otherCount}`);
  console.log('');
  console.log(`  Activity Level:     ${volumeLabel} VOLUME (${tradesPerDay.toFixed(1)} trades/day)`);
  const volumeEmoji = volumeLabel === 'LOW' ? '  Manual-copyable' : volumeLabel === 'HIGH' ? '  Bot-like (hard to copy)' : '';
  if (volumeEmoji) console.log(`                     ${volumeEmoji}`);
  console.log(`  Primary Strategy:   ${strategyLabel} (${buyRatio.toFixed(1)}% buys)`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    PERFORMANCE (Closed Positions)              ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Closed Positions:   ${closedPositions.length}`);
  console.log(`  Wins / Losses:      ${wins} / ${losses}`);
  console.log(`  Win Rate:           ${winRate.toFixed(1)}%`);
  console.log(`  Gross Profit:       $${grossProfit.toFixed(2)}`);
  console.log(`  Gross Loss:         $${grossLoss.toFixed(2)}`);
  console.log(`  Net P&L:            $${netPnl.toFixed(2)}`);
  console.log(`  Profit Factor:      ${profitFactor === Infinity ? 'Inf (no losses)' : profitFactor.toFixed(2)}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    OPEN POSITIONS                              ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Open Positions:     ${openPositions.length}`);
  console.log(`  Current Value:      $${openValue.toFixed(2)}`);
  console.log(`  Unrealized P&L:     $${unrealizedPnl.toFixed(2)}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    TRADE SIZING                                ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Avg Trade Size:     $${avgTradeSize.toFixed(2)}`);
  console.log(`  Median Trade Size:  $${medianTradeSize.toFixed(2)}`);
  console.log(`  Max Trade Size:     $${maxTradeSize.toFixed(2)}`);

  if (strengths.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    STRENGTHS (Profitable Markets)             ');
    console.log('═══════════════════════════════════════════════════════════════');
    strengths.forEach(s => {
      console.log(`  ${s.category.padEnd(20)} +$${s.totalPnl.toFixed(2).padStart(10)} (${s.trades} trades, ${s.winRate.toFixed(0)}% WR)`);
    });
  }

  if (weaknesses.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    WEAKNESSES (Losing Markets)                ');
    console.log('═══════════════════════════════════════════════════════════════');
    weaknesses.forEach(w => {
      console.log(`  ${w.category.padEnd(20)} -$${Math.abs(w.totalPnl).toFixed(2).padStart(10)} (${w.trades} trades, ${w.winRate.toFixed(0)}% WR)`);
    });
  }

  if (entryOddsPerformance.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    ENTRY ODDS ANALYSIS                        ');
    console.log('═══════════════════════════════════════════════════════════════');
    entryOddsPerformance.forEach(e => {
      console.log(`  ${e.range.padEnd(25)} ${e.trades} trades`);
    });
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    TRADER LABEL                                ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ${label}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    COPY RULES                                  ');
  console.log('═══════════════════════════════════════════════════════════════');

  if (volumeLabel === 'LOW' && strategyLabel === 'BUY_AND_HOLD' && winRate >= 60) {
    console.log('  PRIORITY: Entry odds < 40c in their specialty -> Copy at 1.0x');
    console.log('  COPY:     Entry odds 40-60c in their specialty -> Copy at 0.5x');
    console.log('  CAUTIOUS: Entry odds > 60c -> Copy at 0.3x');
    console.log('  SKIP:     Small bets (< 20% of avg) = lottery tickets');
  } else if (volumeLabel === 'HIGH') {
    console.log('  WARNING: High volume trader - difficult to copy manually');
    console.log('  Consider automated copy trading instead');
  } else {
    console.log('  COPY:     Standard bets in their specialty');
    console.log('  CAUTIOUS: Bets outside their specialty');
    console.log('  SKIP:     Very small bets');
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('                    STOP CONDITIONS                             ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  - Win rate drops below ${Math.max(50, winRate - 20).toFixed(0)}% over next 20 trades`);
  if (strengths.length > 0) {
    console.log(`  - Starts betting heavily outside ${strengths[0].category}`);
  }
  console.log('  - Bet sizing becomes erratic (2x+ normal on any trade)');
  console.log('  - Starts selling positions early (strategy change)');

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  // Top open positions
  if (openPositions.length > 0) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    TOP OPEN POSITIONS                         ');
    console.log('═══════════════════════════════════════════════════════════════');

    const sorted = openPositions.sort((a, b) => b.currentValue - a.currentValue).slice(0, 10);
    sorted.forEach((p, i) => {
      const pnlSign = p.cashPnl >= 0 ? '+' : '';
      const pnlPct = p.percentPnl.toFixed(1);
      console.log(`  ${i + 1}. ${p.title.substring(0, 45)}...`);
      console.log(`     ${p.outcome} | $${p.currentValue.toFixed(2)} | ${pnlSign}$${p.cashPnl.toFixed(2)} (${pnlSign}${pnlPct}%)`);
      console.log(`     Entry: ${(p.avgPrice * 100).toFixed(0)}c | Current: ${(p.curPrice * 100).toFixed(0)}c`);
      console.log('');
    });
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
