/**
 * AI Hedge Fund — Profile Trader v2
 *
 * Single wallet profiler with corrected win rate, insider detection,
 * category breakdown with sub-leagues, and LLM placeholder fields.
 * Core profileTrader() is exported for use by bulk-profile-ahf.ts.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/profile-trader-v2.ts <wallet> [conviction_multiplier]
 *
 * Examples:
 *   npx tsx scripts/ai-hedge-fund/profile-trader-v2.ts 0x23796015f5159c76921dc869b7f95a7c57e2bf16
 *   npx tsx scripts/ai-hedge-fund/profile-trader-v2.ts 0x23796015f5159c76921dc869b7f95a7c57e2bf16 20
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

// Load environment — .env.local first so AI hedge fund scripts use the same
// MONGODB_URI as Next.js API routes (which always resolve to the yieldr db).
// The polyagent env points to a different cluster and is only a fallback.
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

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

interface PublicProfile {
  createdAt?: string;
  pseudonym?: string;
  name?: string;
  xUsername?: string;
}

// ═══════════════════════════════════════════════════════════════
// Fetch Functions
// ═══════════════════════════════════════════════════════════════

// fetchActivities — unchanged from profile-trader.ts (time-based, 30 days)
async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  Fetching activities offset=${offset}... [${allActivities.length} collected] (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

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
    await new Promise(r => setTimeout(r, 100));
  }

  if (offset > MAX_OFFSET && !done) {
    console.log(`  Hit API offset limit (${MAX_OFFSET}) — may have more activities`);
  }

  return allActivities;
}

// fetchOpenPositions — unchanged from profile-trader.ts (fetches ALL including resolved)
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as OpenPosition[];
    console.log(`  Fetching open positions offset=${offset}... [${allPositions.length + batch.length} positions]`);

    if (batch.length === 0) break;
    allPositions = allPositions.concat(batch);

    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  if (offset > MAX_OFFSET) {
    console.log(`  Hit API offset limit (${MAX_OFFSET}) — may have more positions`);
  }

  return allPositions;
}

// fetchClosedPositions — NEW signature: accepts options object
// If limit is passed: fetch until limit reached, ignore timestamp
// If days is passed: use existing time filter logic
// Default: limit=1000 (for win rate accuracy)
async function fetchClosedPositions(
  wallet: string,
  options: { days?: number; limit?: number } = { limit: 1000 }
): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = options.days ? now - (options.days * 24 * 60 * 60) : null;
  const targetLimit = options.limit ?? null;
  const LIMIT = 50; // API max per request for closed-positions
  const MAX_OFFSET = 100000;

  let allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    const lastTs = batch[batch.length - 1]?.timestamp;
    console.log(`  Fetching closed positions offset=${offset}... [${allPositions.length} positions] (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

    for (const pos of batch) {
      // Days filter: stop when we go past the time window
      if (startTs !== null && pos.timestamp < startTs) {
        done = true;
        break;
      }

      allPositions.push(pos);

      // Limit filter: stop when we reach the target
      if (targetLimit !== null && allPositions.length >= targetLimit) {
        done = true;
        break;
      }
    }

    if (batch.length < LIMIT) break;
    offset += LIMIT;
    await new Promise(r => setTimeout(r, 100));
  }

  return allPositions;
}

// fetchPublicProfile — NEW: Polymarket public profile API
// 200ms delay before call. All errors caught silently (store nulls on failure).
async function fetchPublicProfile(wallet: string): Promise<PublicProfile | null> {
  await new Promise(r => setTimeout(r, 200));
  try {
    const url = `${API_BASE}/public-profile?address=${wallet}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json() as PublicProfile;
  } catch {
    return null;
  }
}

// fetchFirstActivity — NEW: earliest ever activity for dormancy detection
// 100ms delay. Errors caught silently.
async function fetchFirstActivity(wallet: string): Promise<Activity | null> {
  await new Promise(r => setTimeout(r, 100));
  try {
    const url = `${API_BASE}/activity?user=${wallet}&limit=1&offset=0&sortBy=TIMESTAMP&sortDirection=ASC`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const batch = await response.json() as Activity[];
    return batch.length > 0 ? batch[0] : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Market Categorization
// ═══════════════════════════════════════════════════════════════

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  // NBA — all team names and variations (existing, unchanged)
  const nbaTeams = ['nba', 'basketball', 'lakers', 'celtics', 'bulls', 'heat', 'warriors', 'nuggets',
    'clippers', 'spurs', 'mavericks', 'mavs', 'thunder', 'rockets', 'suns', 'knicks', 'nets', '76ers',
    'sixers', 'bucks', 'cavaliers', 'cavs', 'grizzlies', 'timberwolves', 'wolves', 'pelicans',
    'blazers', 'trail blazers', 'kings', 'jazz', 'hawks', 'hornets', 'magic', 'pistons', 'pacers',
    'wizards', 'raptors'];
  if (nbaTeams.some(team => lower.includes(team))) return 'NBA';

  // NFL — all team names and variations (existing, unchanged)
  const nflTeams = ['nfl', 'football', 'super bowl', 'chiefs', 'eagles', 'bills', 'ravens', 'cowboys',
    '49ers', 'niners', 'patriots', 'pats', 'broncos', 'packers', 'lions', 'dolphins', 'jets',
    'raiders', 'chargers', 'steelers', 'bengals', 'browns', 'texans', 'colts', 'jaguars', 'jags',
    'titans', 'saints', 'falcons', 'panthers', 'buccaneers', 'bucs', 'vikings', 'bears',
    'commanders', 'giants', 'cardinals', 'seahawks', 'rams'];
  if (nflTeams.some(team => lower.includes(team))) return 'NFL';

  // NHL — all team names and variations (existing, unchanged)
  const nhlTeams = ['nhl', 'hockey', 'canucks', 'flames', 'oilers', 'maple leafs', 'leafs',
    'canadiens', 'habs', 'senators', 'sens', 'jets', 'bruins', 'rangers', 'islanders', 'devils',
    'flyers', 'penguins', 'pens', 'capitals', 'caps', 'hurricanes', 'canes', 'blue jackets',
    'lightning', 'bolts', 'red wings', 'blackhawks', 'wild', 'blues',
    'predators', 'preds', 'stars', 'avalanche', 'avs', 'coyotes', 'golden knights', 'knights',
    'kraken', 'kings', 'ducks', 'sharks'];
  if (nhlTeams.some(team => lower.includes(team))) return 'NHL';

  // Soccer — checked before MLB to prevent 'giants', 'city' conflicts with other sports
  const soccerTeams = ['premier league', 'la liga', 'bundesliga', 'serie a', 'ligue 1', 'champions league',
    'europa league', 'conference league', 'manchester', 'liverpool', 'chelsea', 'arsenal', 'tottenham',
    'barcelona', 'real madrid', 'bayern', 'juventus', 'psg', 'fc ', ' fc', 'united', 'inter milan',
    'ac milan', 'as roma', 'napoli', 'atletico', 'sevilla', 'ajax', 'benfica', 'porto'];
  if (soccerTeams.some(team => lower.includes(team))) return 'Soccer';

  // MLB
  if (lower.includes('mlb') || lower.includes('baseball')) return 'MLB';

  // Tennis — NEW
  const tennisKeywords = ['tennis', 'atp', 'wta', 'wimbledon', 'us open', 'french open', 'australian open', 'grand slam'];
  if (tennisKeywords.some(k => lower.includes(k))) return 'Tennis';

  // Golf — NEW
  const golfKeywords = ['golf', 'pga', 'masters', 'open championship', 'ryder cup'];
  if (golfKeywords.some(k => lower.includes(k))) return 'Golf';

  // MMA — NEW
  const mmaKeywords = ['ufc', 'mma', 'bellator', 'fighting championship'];
  if (mmaKeywords.some(k => lower.includes(k))) return 'MMA';

  // Politics (existing, unchanged)
  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate') ||
      lower.includes('democrat') || lower.includes('republican') || lower.includes('governor') ||
      lower.includes('vote') || lower.includes('poll')) return 'Politics';

  // Finance — NEW
  const financeKeywords = ['fed', 'interest rate', 'cpi', 'inflation', 's&p', 'nasdaq', 'gdp', 'recession', 'fomc'];
  if (financeKeywords.some(k => lower.includes(k))) return 'Finance';

  // Crypto (existing, unchanged)
  if (lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('crypto') ||
      lower.includes('btc') || lower.includes('eth') || lower.includes('solana') ||
      lower.includes('doge') || lower.includes('token')) return 'Crypto';

  // Entertainment — NEW
  const entertainmentKeywords = ['oscar', 'grammy', 'emmy', 'golden globe', 'box office', 'award'];
  if (entertainmentKeywords.some(k => lower.includes(k))) return 'Entertainment';

  return 'Other';
}

// detectSubLeague — NEW: only runs when category === 'Soccer'
// Returns FIRST matching league or null.
function detectSubLeague(title: string, category: string): string | null {
  if (category !== 'Soccer') return null;

  const lower = title.toLowerCase();

  const leagues: [string, string[]][] = [
    ['PREMIER_LEAGUE', ['manchester united', 'manchester city', 'liverpool', 'chelsea',
      'arsenal', 'tottenham', 'newcastle', 'west ham', 'aston villa', 'brighton',
      'everton', 'crystal palace', 'brentford', 'fulham', 'wolves', 'nottingham',
      'premier league', 'epl']],
    ['CHAMPIONS_LEAGUE', ['champions league', 'europa league', 'conference league',
      'ucl', 'ajax', 'celtic', 'rangers', 'benfica', 'porto', 'galatasaray',
      'besiktas', 'anderlecht', 'psv', 'fc bruges']],
    ['LA_LIGA', ['real madrid', 'fc barcelona', 'atletico madrid', 'sevilla', 'real betis',
      'valencia', 'villarreal', 'athletic club', 'rc celta', 'getafe', 'girona',
      'espanyol', 'cadiz', 'deportivo', 'la liga', 'osasuna', 'mallorca', 'rayo vallecano']],
    ['BUNDESLIGA', ['fc bayern', 'borussia dortmund', 'rb leipzig', 'wolfsburg',
      'eintracht frankfurt', 'borussia monchengladbach', 'freiburg', 'bayer leverkusen',
      'hertha', 'schalke', 'augsburg', 'bundesliga', 'hoffenheim', 'werder bremen']],
    ['SERIE_A', ['juventus', 'inter milan', 'fc internazionale', 'ac milan', 'as roma',
      'ss lazio', 'napoli', 'atalanta', 'fiorentina', 'torino', 'bologna',
      'udinese', 'serie a', 'coppa italia', 'sampdoria', 'sassuolo']],
    ['LIGUE_1', ['paris saint-germain', 'psg', 'olympique lyonnais', 'as monaco',
      'olympique de marseille', 'lille', 'rennes', 'nice', 'lens', 'ligue 1', 'strasbourg']],
  ];

  for (const [league, keywords] of leagues) {
    if (keywords.some(k => lower.includes(k))) return league;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// P&L Computation
// ═══════════════════════════════════════════════════════════════

function computeCashFlowPnL(activities: Activity[], openPositions: OpenPosition[]) {
  let totalBuys = 0, totalSells = 0, totalRedeems = 0;
  const conditionIds = new Set<string>();
  const positionCashFlow = new Map<string, number>();

  for (const a of activities) {
    conditionIds.add(a.conditionId);
    const flow = positionCashFlow.get(a.conditionId) ?? 0;

    if (a.type === 'TRADE' && a.side === 'BUY') {
      totalBuys += a.usdcSize;
      positionCashFlow.set(a.conditionId, flow - a.usdcSize);
    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      totalSells += a.usdcSize;
      positionCashFlow.set(a.conditionId, flow + a.usdcSize);
    } else if (a.type === 'REDEEM') {
      totalRedeems += a.usdcSize;
      positionCashFlow.set(a.conditionId, flow + a.usdcSize);
    }
  }

  // Add current value for active open positions that had activity in this period
  const activePositions = openPositions.filter(p => p.curPrice > 0.001 && p.curPrice < 0.99);
  let totalEndingValue = 0;
  for (const p of activePositions) {
    if (conditionIds.has(p.conditionId)) {
      totalEndingValue += p.currentValue;
      const flow = positionCashFlow.get(p.conditionId) ?? 0;
      positionCashFlow.set(p.conditionId, flow + p.currentValue);
    }
  }

  let wins = 0, losses = 0;
  for (const cashFlow of positionCashFlow.values()) {
    if (cashFlow >= 0) wins++;
    else losses++;
  }

  const totalPnl = totalSells + totalRedeems + totalEndingValue - totalBuys;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

  return { totalPnl, totalBuys, totalSells, totalRedeems, totalEndingValue, positionsWithActivity: conditionIds.size, wins, losses, winRate };
}

function computeTimeframePnL(activities: Activity[], openPositions: OpenPosition[], days: number) {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  const windowActivities = activities.filter(a => a.timestamp >= startTs);

  if (windowActivities.length === 0) {
    return { timeframe: `${days}d`, days, pnl: 0, buys: 0, sells: 0, redeems: 0, endingValue: 0, capitalDeployed: 0, roce: 0, tradeCount: 0, tradesPerDay: 0, positionCount: 0, tradingDays: 0, wins: 0, losses: 0, winRate: 0, hasData: false, hitApiLimit: false };
  }

  let buys = 0, sells = 0, redeems = 0, tradeCount = 0;
  const conditionIds = new Set<string>();
  const positionCashFlow = new Map<string, number>();

  for (const a of windowActivities) {
    conditionIds.add(a.conditionId);
    const flow = positionCashFlow.get(a.conditionId) ?? 0;

    if (a.type === 'TRADE' && a.side === 'BUY') {
      buys += a.usdcSize;
      tradeCount++;
      positionCashFlow.set(a.conditionId, flow - a.usdcSize);
    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      sells += a.usdcSize;
      tradeCount++;
      positionCashFlow.set(a.conditionId, flow + a.usdcSize);
    } else if (a.type === 'REDEEM') {
      redeems += a.usdcSize;
      positionCashFlow.set(a.conditionId, flow + a.usdcSize);
    }
  }

  const activePositions = openPositions.filter(p => p.curPrice > 0.001 && p.curPrice < 0.99);
  let endingValue = 0;
  for (const p of activePositions) {
    if (conditionIds.has(p.conditionId)) {
      endingValue += p.currentValue;
      const flow = positionCashFlow.get(p.conditionId) ?? 0;
      positionCashFlow.set(p.conditionId, flow + p.currentValue);
    }
  }

  let wins = 0, losses = 0;
  for (const cashFlow of positionCashFlow.values()) {
    if (cashFlow >= 0) wins++;
    else losses++;
  }

  const pnl = sells + redeems + endingValue - buys;
  const capitalDeployed = buys;
  const roce = capitalDeployed > 0 ? (pnl / capitalDeployed) * 100 : 0;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
  const tradingDays = new Set(windowActivities.map(a => new Date(a.timestamp * 1000).toISOString().split('T')[0])).size;

  return { timeframe: `${days}d`, days, pnl, buys, sells, redeems, endingValue, capitalDeployed, roce, tradeCount, tradesPerDay: tradeCount / days, positionCount: conditionIds.size, tradingDays, wins, losses, winRate, hasData: true, hitApiLimit: false };
}

function computePnlConsistency(timeframePnL: Record<string, ReturnType<typeof computeTimeframePnL>>) {
  const frames = ['1d', '7d', '15d', '30d'];
  const available = frames.filter(f => timeframePnL[f].hasData);

  if (available.length === 0) {
    return { timeframesAvailable: 0, allPositive: false, positiveCount: 0, avgRoce: 0, roceVariance: 0, score: 0 };
  }

  const roces = available.map(f => timeframePnL[f].roce);
  const positiveCount = available.filter(f => timeframePnL[f].pnl > 0).length;
  const allPositive = positiveCount === available.length;
  const avgRoce = roces.reduce((a, b) => a + b, 0) / roces.length;

  const variance = roces.length > 1
    ? Math.sqrt(roces.reduce((sum, r) => sum + Math.pow(r - avgRoce, 2), 0) / roces.length)
    : 0;

  const score = avgRoce / (1 + variance / 100);

  // Daily PnL components — avgDailyPnl from 30d frame; stdDev across timeframe daily rates
  const frame30 = timeframePnL['30d'];
  const avgDailyPnl = frame30.hasData ? frame30.pnl / 30 : 0;
  const dailyRates = available.map(f => timeframePnL[f].pnl / timeframePnL[f].days);
  const avgDailyRate = dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length;
  const stdDev = dailyRates.length > 1
    ? Math.sqrt(dailyRates.reduce((sum, r) => sum + Math.pow(r - avgDailyRate, 2), 0) / dailyRates.length)
    : 0;

  const tradingDays7d = timeframePnL['7d'].tradingDays;
  const tradingDays15d = timeframePnL['15d'].tradingDays;
  const tradingDays30d = timeframePnL['30d'].tradingDays;

  return { timeframesAvailable: available.length, allPositive, positiveCount, avgRoce, roceVariance: variance, score, avgDailyPnl, stdDev, tradingDays7d, tradingDays15d, tradingDays30d };
}

// computeMaxDrawdown30d — NEW: from daily cash-flow series
// null if fewer than 5 trading days or peak <= 0
function computeMaxDrawdown30d(activities: Activity[]): { maxDrawdown30dPct: number | null; maxDrawdown: number; maxDrawdownPercent: number } {
  const dayMap = new Map<string, number>(); // day → net daily cash flow (inflows - outflows)

  for (const a of activities) {
    const day = new Date(a.timestamp * 1000).toISOString().split('T')[0];
    const cur = dayMap.get(day) ?? 0;

    if (a.type === 'TRADE' && a.side === 'BUY') {
      dayMap.set(day, cur - a.usdcSize);
    } else if (a.type === 'TRADE' && a.side === 'SELL') {
      dayMap.set(day, cur + a.usdcSize);
    } else if (a.type === 'REDEEM') {
      dayMap.set(day, cur + a.usdcSize);
    }
  }

  if (dayMap.size < 5) return { maxDrawdown30dPct: null, maxDrawdown: 0, maxDrawdownPercent: 0 };

  const sortedDays = Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  let cumPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const [, dailyFlow] of sortedDays) {
    cumPnl += dailyFlow;
    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  if (peak <= 0) return { maxDrawdown30dPct: null, maxDrawdown: 0, maxDrawdownPercent: 0 };

  const pct = (maxDrawdown / peak) * 100;
  return { maxDrawdown30dPct: pct, maxDrawdown, maxDrawdownPercent: pct };
}

// ═══════════════════════════════════════════════════════════════
// Market Analysis
// ═══════════════════════════════════════════════════════════════

function analyzeMarketPerformance(closedPositions: ClosedPosition[]): { strengths: MarketPerformance[]; weaknesses: MarketPerformance[] } {
  const byCategory = new Map<string, { trades: number; wins: number; losses: number; totalPnl: number }>();

  for (const pos of closedPositions) {
    const category = categorizeMarket(pos.title);
    const entry = byCategory.get(category) ?? { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
    entry.trades++;
    entry.totalPnl += pos.realizedPnl;
    if (pos.realizedPnl >= 0) entry.wins++;
    else entry.losses++;
    byCategory.set(category, entry);
  }

  const performances: MarketPerformance[] = Array.from(byCategory.entries()).map(([category, stats]) => ({
    category,
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
    totalPnl: stats.totalPnl,
    avgPnl: stats.trades > 0 ? stats.totalPnl / stats.trades : 0,
  }));

  const sorted = performances.sort((a, b) => b.totalPnl - a.totalPnl);
  return {
    strengths: sorted.filter(p => p.totalPnl > 0).slice(0, 5),
    weaknesses: sorted.filter(p => p.totalPnl < 0).slice(-5).reverse(),
  };
}

function analyzeEntryOdds(activities: Activity[]): EntryOddsPerformance[] {
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
    const wins = trades.filter(t => t.price < 0.5).length; // simplified heuristic
    return {
      range: range.label,
      trades: trades.length,
      wins,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      avgRoi: 0,
    };
  }).filter(r => r.trades > 0);
}

// buildCategoryBreakdown — NEW: grouped by (category, sub_league) from 1000 closed positions
function buildCategoryBreakdown(closedPositions: ClosedPosition[]) {
  const groupMap = new Map<string, {
    category: string;
    sub_league: string | null;
    titles: Set<string>;
    closed_positions: number;
    wins: number;
    losses: number;
    total_pnl: number;
    avg_prices: number[];
  }>();

  let totalAbsPnl = 0;

  for (const pos of closedPositions) {
    const category = categorizeMarket(pos.title);
    const sub_league = detectSubLeague(pos.title, category);
    const key = `${category}||${sub_league ?? '__none__'}`;

    const entry = groupMap.get(key) ?? {
      category,
      sub_league,
      titles: new Set(),
      closed_positions: 0,
      wins: 0,
      losses: 0,
      total_pnl: 0,
      avg_prices: [],
    };

    entry.titles.add(pos.title.toLowerCase());
    entry.closed_positions++;
    entry.total_pnl += pos.realizedPnl;
    if (pos.realizedPnl >= 0) entry.wins++;
    else entry.losses++;
    entry.avg_prices.push(pos.avgPrice);

    groupMap.set(key, entry);
    totalAbsPnl += Math.abs(pos.realizedPnl);
  }

  return Array.from(groupMap.values())
    .map(g => ({
      category: g.category,
      sub_league: g.sub_league,
      unique_events: g.titles.size,
      closed_positions: g.closed_positions,
      wins: g.wins,
      losses: g.losses,
      win_rate: (g.wins + g.losses) > 0 ? (g.wins / (g.wins + g.losses)) * 100 : 0,
      total_pnl: g.total_pnl,
      pnl_share: totalAbsPnl > 0 ? (g.total_pnl / totalAbsPnl) * 100 : 0,
      avg_entry_price: g.avg_prices.length > 0 ? g.avg_prices.reduce((a, b) => a + b, 0) / g.avg_prices.length : 0,
    }))
    .sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl));
}

// buildMarketTitlesSummary — NEW: top 50 markets by |PnL| from 1000 closed positions
function buildMarketTitlesSummary(closedPositions: ClosedPosition[]) {
  // closedPositions are DESC by timestamp, so [0] is most recent
  const titleMap = new Map<string, {
    title: string;
    category: string;
    sub_league: string | null;
    times_entered: number;
    mostRecentPnl: number;
    total_pnl: number;
    avg_prices: number[];
  }>();

  for (const pos of closedPositions) {
    const key = pos.title.toLowerCase();
    const category = categorizeMarket(pos.title);
    const sub_league = detectSubLeague(pos.title, category);

    const entry = titleMap.get(key);
    if (!entry) {
      // First occurrence (most recent due to DESC sort)
      titleMap.set(key, {
        title: pos.title,
        category,
        sub_league,
        times_entered: 1,
        mostRecentPnl: pos.realizedPnl,
        total_pnl: pos.realizedPnl,
        avg_prices: [pos.avgPrice],
      });
    } else {
      entry.times_entered++;
      entry.total_pnl += pos.realizedPnl;
      entry.avg_prices.push(pos.avgPrice);
    }
  }

  return Array.from(titleMap.values())
    .map(m => ({
      title: m.title,
      category: m.category,
      sub_league: m.sub_league,
      times_entered: m.times_entered,
      won: m.mostRecentPnl >= 0, // most recent entry result
      total_pnl: m.total_pnl,
      avg_entry_price: m.avg_prices.reduce((a, b) => a + b, 0) / m.avg_prices.length,
    }))
    .sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl))
    .slice(0, 50);
}

// ═══════════════════════════════════════════════════════════════
// Insider Detection
// ═══════════════════════════════════════════════════════════════

function computeInsiderScore(params: {
  account_age_days: number | null;
  first_ever_activity_at: Date | null;
  closedPositions1000: ClosedPosition[];
  win_rate_sample_size: number;
  win_rate: number;
  avg_bet_size_usdc: number;
  medianTradeSize: number;
  activities: Activity[];
}): { insider_score: number; insider_probability: 'high' | 'medium' | 'low' | 'none'; insider_signals_fired: string[] } {
  const {
    account_age_days,
    first_ever_activity_at,
    closedPositions1000,
    win_rate_sample_size,
    win_rate,
    avg_bet_size_usdc,
    medianTradeSize,
    activities,
  } = params;

  let score = 0;
  const signals: string[] = [];

  const accountAgeThreshold = Number(process.env.INSIDER_ACCOUNT_AGE_THRESHOLD ?? 30);
  const dormancyThreshold = Number(process.env.INSIDER_DORMANCY_THRESHOLD ?? 30);

  // Signal a — account age: +2
  if (account_age_days !== null && account_age_days < accountAgeThreshold) {
    score += 2;
    signals.push('a_young_account');
  }

  // Signal b — dormancy: +2
  // dormancy = days between first_ever_activity_at and start of 30d profiling window
  if (first_ever_activity_at !== null) {
    const profileWindowStart = Date.now() - 30 * 86400000;
    const dormancy = (profileWindowStart - first_ever_activity_at.getTime()) / 86400000;
    if (dormancy > dormancyThreshold) {
      score += 2;
      signals.push('b_dormant_account');
    }
  }

  // Signal c — category virgin large bet: +1
  // A category appearing exactly once AND totalBought > 500 AND minimal history
  if (win_rate_sample_size < 5 && closedPositions1000.length > 0) {
    const categoryCounts = new Map<string, number>();
    for (const pos of closedPositions1000) {
      const cat = categorizeMarket(pos.title);
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    const hasVirginalLargeBet = closedPositions1000.some(pos => {
      const cat = categorizeMarket(pos.title);
      return categoryCounts.get(cat) === 1 && pos.totalBought > 500;
    });
    if (hasVirginalLargeBet) {
      score += 1;
      signals.push('c_category_virgin_large_bet');
    }
  }

  // Signal d — large bet minimal history: +2
  if (win_rate_sample_size < 15) {
    const hasLargeWithMinimalHistory = closedPositions1000.some(pos => pos.totalBought > 100000);
    if (hasLargeWithMinimalHistory) {
      score += 2;
      signals.push('d_large_bet_minimal_history');
    }
  }

  // Signal e — conviction spike established account: +1
  if (win_rate_sample_size >= 10 && medianTradeSize > 0) {
    const hasSpikedTrade = activities.some(a => a.type === 'TRADE' && a.usdcSize > medianTradeSize * 10);
    if (hasSpikedTrade) {
      score += 1;
      signals.push('e_conviction_spike');
    }
  }

  // Signal f — whale concentration: +2
  // Large avg bet + limited history + solid win rate → probable informed trader
  if (avg_bet_size_usdc > 50000 && win_rate_sample_size >= 5 && win_rate_sample_size <= 20 && win_rate > 60) {
    score += 2;
    signals.push('f_whale_concentration');
  }

  // Cap at 7
  score = Math.min(score, 7);

  let insider_probability: 'high' | 'medium' | 'low' | 'none';
  if (score >= 3) insider_probability = 'high';
  else if (score === 2) insider_probability = 'medium';
  else if (score === 1) insider_probability = 'low';
  else insider_probability = 'none';

  return { insider_score: score, insider_probability, insider_signals_fired: signals };
}

// ═══════════════════════════════════════════════════════════════
// Classification Helpers
// ═══════════════════════════════════════════════════════════════

function determineTraderLabel(params: {
  volumeLabel: string;
  strategyLabel: string;
  win_rate: number;
  profitFactor: number;
  strengths: MarketPerformance[];
}): string {
  const labels: string[] = [];

  if (params.volumeLabel === 'LOW') labels.push('LOW_VOLUME');
  if (params.volumeLabel === 'HIGH') labels.push('HIGH_VOLUME');
  if (params.strategyLabel === 'BUY_AND_HOLD') labels.push('HOLDER');
  if (params.win_rate >= 70) labels.push('HIGH_WIN_RATE');
  if (params.profitFactor >= 2) labels.push('PROFITABLE');

  if (params.strengths.length > 0) {
    const topCategory = params.strengths[0].category;
    if (topCategory === 'NBA') labels.push('NBA_SPECIALIST');
    if (topCategory === 'NFL') labels.push('NFL_SPECIALIST');
    if (topCategory === 'NHL') labels.push('NHL_SPECIALIST');
    if (topCategory === 'Soccer') labels.push('SOCCER_SPECIALIST');
    if (topCategory === 'Politics') labels.push('POLITICS_SPECIALIST');
    if (topCategory === 'Crypto') labels.push('CRYPTO_SPECIALIST');
    if (topCategory === 'Tennis') labels.push('TENNIS_SPECIALIST');
    if (topCategory === 'MMA') labels.push('MMA_SPECIALIST');
  }

  return labels.join(' | ') || 'UNKNOWN';
}

function computeCurrentStreak(closedPositions: ClosedPosition[]): { currentStreak: number; currentStreakType: 'WIN' | 'LOSS' | 'NONE' } {
  if (closedPositions.length === 0) return { currentStreak: 0, currentStreakType: 'NONE' };

  // Sort DESC by timestamp (most recent first)
  const sorted = [...closedPositions].sort((a, b) => b.timestamp - a.timestamp);
  const firstIsWin = sorted[0].realizedPnl >= 0;
  let streak = 1;

  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i].realizedPnl >= 0) === firstIsWin) streak++;
    else break;
  }

  return { currentStreak: streak, currentStreakType: firstIsWin ? 'WIN' : 'LOSS' };
}

// ═══════════════════════════════════════════════════════════════
// Core profileTrader() — exported for Part 2 (bulk-profile-ahf)
// ═══════════════════════════════════════════════════════════════

export async function profileTrader(
  wallet: string,
  options: { convictionMultiplier?: number; verbose?: boolean } = {}
): Promise<Record<string, unknown>> {
  const { convictionMultiplier = 10, verbose = true } = options;
  const cleanWallet = wallet.toLowerCase();
  const profiledAt = new Date();

  // ── Fetch all data ─────────────────────────────────────────
  if (verbose) {
    console.log('\nFetching activities (30d)...');
  }
  const activities = await fetchActivities(cleanWallet, 30);
  if (verbose) console.log(`  Found ${activities.length} activities\n`);

  if (verbose) console.log('Fetching open positions...');
  const allOpenPositions = await fetchOpenPositions(cleanWallet);
  if (verbose) console.log(`  Found ${allOpenPositions.length} positions total\n`);

  // Fetch closed positions with limit=1000 for accurate win rate
  if (verbose) console.log('Fetching last 1000 closed positions (for win rate)...');
  const closedPositions1000 = await fetchClosedPositions(cleanWallet, { limit: 1000 });
  if (verbose) console.log(`  Found ${closedPositions1000.length} closed positions\n`);

  // Fetch public profile (200ms delay baked into fetchPublicProfile)
  if (verbose) console.log('Fetching public profile...');
  const publicProfile = await fetchPublicProfile(cleanWallet);

  // Fetch first ever activity (100ms delay baked in)
  if (verbose) console.log('Fetching first ever activity...');
  const firstEverActivity = await fetchFirstActivity(cleanWallet);

  // ── Period info ────────────────────────────────────────────
  const lastActivity = activities.length > 0
    ? activities.reduce((latest, a) => a.timestamp > latest.timestamp ? a : latest)
    : null;
  const firstActivityInPeriod = activities.length > 0
    ? activities.reduce((earliest, a) => a.timestamp < earliest.timestamp ? a : earliest)
    : null;

  const lastActiveAt = lastActivity ? new Date(lastActivity.timestamp * 1000) : null;
  const periodInfo = {
    requestedDays: 30,
    actualDays: (lastActivity && firstActivityInPeriod)
      ? Math.ceil((lastActivity.timestamp - firstActivityInPeriod.timestamp) / 86400)
      : 0,
    hitApiLimit: activities.length >= 10000,
    startDate: firstActivityInPeriod ? new Date(firstActivityInPeriod.timestamp * 1000) : null,
    endDate: lastActiveAt,
    activitiesCount: activities.length,
    lastActiveAt,
  };

  const last_active_days_ago: number | null = lastActiveAt
    ? (Date.now() - lastActiveAt.getTime()) / 86400000
    : null;

  // ── Identity from public profile ───────────────────────────
  let account_created_at: Date | null = null;
  let account_age_days: number | null = null;
  let pseudonym: string | null = null;
  let display_name: string | null = null;
  let x_username: string | null = null;

  if (publicProfile) {
    if (publicProfile.createdAt) {
      try {
        account_created_at = new Date(publicProfile.createdAt);
        account_age_days = (profiledAt.getTime() - account_created_at.getTime()) / 86400000;
      } catch { /* silently ignore */ }
    }
    pseudonym = publicProfile.pseudonym ?? null;
    display_name = publicProfile.name ?? null;
    x_username = publicProfile.xUsername ?? null;
  }

  const first_ever_activity_at: Date | null = firstEverActivity
    ? new Date(firstEverActivity.timestamp * 1000)
    : null;

  // ── Activity counts ────────────────────────────────────────
  let buyCount = 0, sellCount = 0, redeemCount = 0, otherCount = 0;
  const tradeSizes: number[] = [];

  for (const a of activities) {
    if (a.type === 'TRADE') {
      tradeSizes.push(a.usdcSize);
      if (a.side === 'BUY') buyCount++;
      else if (a.side === 'SELL') sellCount++;
    } else if (a.type === 'REDEEM') {
      redeemCount++;
    } else {
      otherCount++;
    }
  }

  const totalTrades = buyCount + sellCount;
  const tradesPerDay = totalTrades / 30;

  // Volume classification
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

  // Trade sizing
  tradeSizes.sort((a, b) => a - b);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
  const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
  const maxTradeSize = tradeSizes.length > 0 ? Math.max(...tradeSizes) : 0;

  // ── P&L (cashFlow-based — source of truth) ────────────────
  const cashFlowPnL = computeCashFlowPnL(activities, allOpenPositions);

  const timeframePnL: Record<string, ReturnType<typeof computeTimeframePnL>> = {
    '1d': computeTimeframePnL(activities, allOpenPositions, 1),
    '7d': computeTimeframePnL(activities, allOpenPositions, 7),
    '15d': computeTimeframePnL(activities, allOpenPositions, 15),
    '30d': computeTimeframePnL(activities, allOpenPositions, 30),
  };

  const pnlConsistency = computePnlConsistency(timeframePnL);

  // ── ROCE trend ──────────────────────────────────────────────
  const _r7  = timeframePnL['7d'].hasData  ? timeframePnL['7d'].roce  : null;
  const _r15 = timeframePnL['15d'].hasData ? timeframePnL['15d'].roce : null;
  const _r30 = timeframePnL['30d'].hasData ? timeframePnL['30d'].roce : null;
  const _roceDirection = (_r7 !== null && _r30 !== null)
    ? (_r7 > _r30 ? 'improving' : _r7 < _r30 * 0.7 ? 'degrading' : 'stable')
    : 'unknown';
  const roce_trend = { d7: _r7, d15: _r15, d30: _r30, direction: _roceDirection };

  // profitFactor — cashFlow-based (replaces closedPositions-based)
  // > 1 = profitable overall, < 1 = losing overall
  const totalInflows = cashFlowPnL.totalSells + cashFlowPnL.totalRedeems + cashFlowPnL.totalEndingValue;
  const profitFactor = cashFlowPnL.totalBuys > 0 ? totalInflows / cashFlowPnL.totalBuys : 0;

  // ── Win Rate (CORRECTED — CRITICAL) ───────────────────────
  // win_rate uses last 1000 closed positions + resolved open positions
  // curPrice >= 0.99 = won but unredeemed, curPrice <= 0.001 = lost but unredeemed
  // This is more accurate than closedPositions API alone (misses unredeemed losses)
  // and more accurate than cashFlowPnL (which includes unresolved open positions)

  let wins_closed = 0, losses_closed = 0;
  for (const pos of closedPositions1000) {
    if (pos.realizedPnl >= 0) wins_closed++;
    else losses_closed++;
  }

  const wins_open_resolved = allOpenPositions.filter(p => p.curPrice >= 0.99 && p.size > 0).length;
  const losses_open_resolved = allOpenPositions.filter(p => p.curPrice <= 0.001 && p.size > 0).length;

  const totalWins = wins_closed + wins_open_resolved;
  const totalLosses = losses_closed + losses_open_resolved;
  const totalSample = totalWins + totalLosses;
  const win_rate = totalSample > 0 ? (totalWins / totalSample) * 100 : 0;
  const win_rate_sample_size = totalSample;

  // ── Closed positions analysis (from 1000 sample) ──────────
  const avg_entry_price_wins = wins_closed > 0
    ? closedPositions1000.filter(p => p.realizedPnl >= 0).reduce((sum, p) => sum + p.avgPrice, 0) / wins_closed
    : null;
  const avg_entry_price_losses = losses_closed > 0
    ? closedPositions1000.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.avgPrice, 0) / losses_closed
    : null;

  // Current streak from 1000 sample
  const { currentStreak, currentStreakType } = computeCurrentStreak(closedPositions1000);

  // ── Market activity metrics ────────────────────────────────
  // avg_unique_markets_per_day_7d: mean distinct markets per active day in last 7d
  const now7d = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const last7dActivities = activities.filter(a => a.timestamp >= now7d);
  const dayMarkets = new Map<string, Set<string>>();
  for (const a of last7dActivities) {
    const day = new Date(a.timestamp * 1000).toISOString().split('T')[0];
    if (!dayMarkets.has(day)) dayMarkets.set(day, new Set());
    dayMarkets.get(day)!.add(a.title.toLowerCase());
  }
  const activeDays7d = Array.from(dayMarkets.values()).filter(s => s.size >= 1);
  const _avg7dRaw = activeDays7d.length > 0
    ? activeDays7d.reduce((sum, s) => sum + s.size, 0) / activeDays7d.length
    : null;
  const avg_unique_markets_per_day_7d = {
    value: _avg7dRaw,
    sample_days: activeDays7d.length,
    is_low_sample: activeDays7d.length < 3,
  };

  // fragmentation_ratio: total activities / unique markets across all 30d activities
  const uniqueMarkets30d = new Set(activities.map(a => a.title.toLowerCase()));
  const total_unique_markets_30d = uniqueMarkets30d.size;
  const fragmentation_ratio: number | null = total_unique_markets_30d > 0
    ? activities.length / total_unique_markets_30d
    : null;

  // ── Max drawdown 30d ───────────────────────────────────────
  const { maxDrawdown30dPct, maxDrawdown, maxDrawdownPercent } = computeMaxDrawdown30d(activities);

  // ── Open/closed position categorization ───────────────────
  const LOSS_THRESHOLD = 0.001;
  const WIN_THRESHOLD = 0.99;
  const openPositions = allOpenPositions.filter(p => p.curPrice >= LOSS_THRESHOLD && p.curPrice <= WIN_THRESHOLD);

  // ── Category breakdown and market titles ──────────────────
  const category_breakdown = buildCategoryBreakdown(closedPositions1000);
  const market_titles_summary = buildMarketTitlesSummary(closedPositions1000);

  // ── Market specialization ──────────────────────────────────
  const { strengths, weaknesses } = analyzeMarketPerformance(closedPositions1000);
  const specialty = strengths.length > 0 ? strengths[0].category : null;

  // ── Entry odds ─────────────────────────────────────────────
  const entryOddsBreakdown = analyzeEntryOdds(activities);

  // ── High conviction trades ────────────────────────────────
  const asymmetricThreshold = avgTradeSize * convictionMultiplier;
  const asymmetricTrades = activities
    .filter(a => a.type === 'TRADE' && a.usdcSize >= asymmetricThreshold)
    .sort((a, b) => b.timestamp - a.timestamp);
  const asymmetricVolume = asymmetricTrades.reduce((sum, t) => sum + t.usdcSize, 0);
  const totalTradingVolume = tradeSizes.reduce((a, b) => a + b, 0);
  const asymmetricVolumePercent = totalTradingVolume > 0 ? (asymmetricVolume / totalTradingVolume) * 100 : 0;

  // ── Trader label ───────────────────────────────────────────
  const traderLabel = `Trader-${cleanWallet.slice(0, 6)}`;
  const label = determineTraderLabel({ volumeLabel, strategyLabel, win_rate, profitFactor, strengths });

  // ── avg_bet_size_usdc ─────────────────────────────────────
  const avg_bet_size_usdc = win_rate_sample_size > 0 ? cashFlowPnL.totalBuys / win_rate_sample_size : 0;

  // ── Insider score ──────────────────────────────────────────
  const { insider_score, insider_probability, insider_signals_fired } = computeInsiderScore({
    account_age_days,
    first_ever_activity_at,
    closedPositions1000,
    win_rate_sample_size,
    win_rate,
    avg_bet_size_usdc,
    medianTradeSize,
    activities,
  });

  // ── Baseline snapshot ──────────────────────────────────────
  const baseline_snapshot = {
    win_rate,
    win_rate_sample_size,
    avg_bet_size_usdc,
    profit_factor: profitFactor,
    roce_30d: timeframePnL['30d'].roce,
    roce_trend,
    pnl_consistency_score: pnlConsistency.score,
    avg_unique_markets_per_day_7d,
    max_drawdown_30d_pct: maxDrawdown30dPct,
    last_active_days_ago,
    profiled_at: profiledAt,
  };

  // ── Recent high-conviction trades (top 20, buy-biased for signal generation) ──
  const recentHighConvictionTrades = asymmetricTrades
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

  // ── Top open positions (active only) ──────────────────────
  const topOpenPositions = openPositions
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
    }));

  // ── Recent closed positions (for display) ─────────────────
  const recentClosedPositions = closedPositions1000
    .slice(0, 30)
    .map(p => ({
      title: p.title,
      outcome: p.outcome,
      size: p.totalBought,
      avgPrice: p.avgPrice,
      realizedPnl: p.realizedPnl,
      timestamp: new Date(p.timestamp * 1000),
      status: 'REDEEMED' as const,
    }));

  // ── Console output ─────────────────────────────────────────
  if (verbose) {
    const now = Math.floor(Date.now() / 1000);
    const startDate = new Date((now - 30 * 24 * 60 * 60) * 1000).toISOString().split('T')[0];
    const endDate = new Date(now * 1000).toISOString().split('T')[0];

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    TRADER PROFILER v2                          ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Wallet:  ${cleanWallet}`);
    console.log(`Period:  Last 30 days (${startDate} to ${endDate})`);
    console.log('═══════════════════════════════════════════════════════════════\n');

    // ── NEW: Identity ──
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    IDENTITY                                    ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Display Name:   ${display_name || '(not set)'}`);
    console.log(`  Pseudonym:      ${pseudonym || '(not set)'}`);
    console.log(`  X Username:     ${x_username ? '@' + x_username : '(not set)'}`);
    console.log(`  Account Age:    ${account_age_days !== null ? account_age_days.toFixed(1) + ' days' : 'unknown'}`);
    console.log(`  First Activity: ${first_ever_activity_at ? first_ever_activity_at.toISOString() : 'unknown'}`);
    console.log(`  Last Active:    ${last_active_days_ago !== null ? last_active_days_ago.toFixed(1) + 'd ago' : 'unknown'}`);

    // ── BASIC STATS ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    BASIC STATS                                 ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Total Activities:   ${activities.length}`);
    console.log(`  TRADE (BUY):        ${buyCount}`);
    console.log(`  TRADE (SELL):       ${sellCount}`);
    console.log(`  REDEEM:             ${redeemCount}`);
    console.log(`  Other:              ${otherCount}`);
    console.log('');
    console.log(`  Activity Level:     ${volumeLabel} VOLUME (${tradesPerDay.toFixed(1)} trades/day)`);
    console.log(`  Primary Strategy:   ${strategyLabel} (${buyRatio.toFixed(1)}% buys)`);

    // ── NEW: WIN RATE (CORRECTED) ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    WIN RATE (CORRECTED)                        ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Win Rate:           ${win_rate.toFixed(1)}%`);
    console.log(`  Sample Size:        ${win_rate_sample_size} total`);
    console.log(`  Closed Wins:        ${wins_closed}`);
    console.log(`  Closed Losses:      ${losses_closed}`);
    console.log(`  Resolved Open Wins: ${wins_open_resolved}  (curPrice >= 0.99, unredeemed)`);
    console.log(`  Resolved Open Loss: ${losses_open_resolved}  (curPrice <= 0.001, unredeemed)`);
    console.log(`  Current Streak:     ${currentStreak} ${currentStreakType}`);

    // ── PERFORMANCE ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    PERFORMANCE (30-Day, Cash-Flow Based)       ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Total PnL:          $${cashFlowPnL.totalPnl.toFixed(2)}`);
    console.log(`  Total Buys:         $${cashFlowPnL.totalBuys.toFixed(2)}`);
    console.log(`  Total Sells:        $${cashFlowPnL.totalSells.toFixed(2)}`);
    console.log(`  Total Redeems:      $${cashFlowPnL.totalRedeems.toFixed(2)}`);
    console.log(`  Ending Value:       $${cashFlowPnL.totalEndingValue.toFixed(2)}`);
    console.log(`  Profit Factor:      ${profitFactor.toFixed(3)}`);
    console.log(`  Positions (30d):    ${cashFlowPnL.positionsWithActivity} (${cashFlowPnL.wins}W / ${cashFlowPnL.losses}L)`);

    console.log('\n  Timeframe P&L:');
    for (const [frame, data] of Object.entries(timeframePnL)) {
      if (data.hasData) {
        console.log(`    ${frame.padEnd(4)}: PnL=$${data.pnl.toFixed(0).padStart(10)} | ROCE=${data.roce.toFixed(1)}% | Capital=$${data.capitalDeployed.toFixed(0)} | TradingDays=${data.tradingDays}`);
      } else {
        console.log(`    ${frame.padEnd(4)}: no data`);
      }
    }

    console.log(`\n  ROCE Trend:    7d=${roce_trend.d7 !== null ? roce_trend.d7.toFixed(1) + '%' : 'n/a'}  15d=${roce_trend.d15 !== null ? roce_trend.d15.toFixed(1) + '%' : 'n/a'}  30d=${roce_trend.d30 !== null ? roce_trend.d30.toFixed(1) + '%' : 'n/a'}  → ${roce_trend.direction.toUpperCase()}`);

    console.log(`\n  PnL Consistency:`);
    console.log(`    Score:          ${pnlConsistency.score.toFixed(1)}`);
    console.log(`    Avg daily PnL:  $${(pnlConsistency.avgDailyPnl ?? 0).toFixed(0)}`);
    console.log(`    Std deviation:  $${(pnlConsistency.stdDev ?? 0).toFixed(0)}`);
    console.log(`    Trading days:   7d=${pnlConsistency.tradingDays7d}  15d=${pnlConsistency.tradingDays15d}  30d=${pnlConsistency.tradingDays30d}`);
    console.log(`    (avgROCE=${pnlConsistency.avgRoce.toFixed(1)}%  variance=${pnlConsistency.roceVariance.toFixed(1)})`);

    // ── OPEN POSITIONS ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    OPEN POSITIONS                              ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Active Positions:   ${openPositions.length}`);
    console.log(`  Current Value:      $${openPositions.reduce((s, p) => s + p.currentValue, 0).toFixed(2)}`);
    console.log(`  All-time Unred. Losses: ${losses_open_resolved}  (curPrice ~0)`);
    console.log(`  All-time Unred. Wins:   ${wins_open_resolved}  (curPrice ~1)`);

    // ── TRADE SIZING ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    TRADE SIZING                                ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Avg Trade Size:     $${avgTradeSize.toFixed(2)}`);
    console.log(`  Median Trade Size:  $${medianTradeSize.toFixed(2)}`);
    console.log(`  Max Trade Size:     $${maxTradeSize.toFixed(2)}`);
    console.log(`  Avg Bet Size:       $${avg_bet_size_usdc.toFixed(0)}  (totalBuys / positions)`);

    // ── MARKET ACTIVITY METRICS ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    MARKET ACTIVITY                             ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Unique Markets (30d):       ${total_unique_markets_30d}`);
    console.log(`  Fragmentation Ratio:        ${fragmentation_ratio !== null ? fragmentation_ratio.toFixed(2) : 'n/a'}`);
    console.log(`  Avg Unique Mkts/Day (7d):   ${avg_unique_markets_per_day_7d.value !== null ? avg_unique_markets_per_day_7d.value.toFixed(1) + (avg_unique_markets_per_day_7d.is_low_sample ? ` (low sample: ${avg_unique_markets_per_day_7d.sample_days}d)` : '') : `n/a (0 active days)`}`);
    console.log(`  Max Drawdown (30d):         ${maxDrawdown30dPct !== null ? maxDrawdown30dPct.toFixed(1) + '%' : 'n/a'}`);
    console.log(`  Avg Entry Price (wins):     ${avg_entry_price_wins !== null ? avg_entry_price_wins.toFixed(3) : 'n/a'}`);
    console.log(`  Avg Entry Price (losses):   ${avg_entry_price_losses !== null ? avg_entry_price_losses.toFixed(3) : 'n/a'}`);

    // ── HIGH CONVICTION TRADES ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`                    HIGH CONVICTION (>${convictionMultiplier}x avg)                `);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Threshold:          $${asymmetricThreshold.toFixed(2)} (${convictionMultiplier}x avg)`);
    console.log(`  Count:              ${asymmetricTrades.length} trades`);
    console.log(`  Volume:             $${asymmetricVolume.toFixed(2)} (${asymmetricVolumePercent.toFixed(1)}% of total)`);

    if (asymmetricTrades.length > 0) {
      console.log('\n  Recent high-conviction trades:');
      asymmetricTrades.slice(0, 5).forEach(t => {
        const date = new Date(t.timestamp * 1000).toISOString().split('T')[0];
        const mult = (t.usdcSize / avgTradeSize).toFixed(1);
        console.log(`    ${date} | ${t.side} $${t.usdcSize.toFixed(0)} (${mult}x) | ${t.title.slice(0, 45)}... @ ${(t.price * 100).toFixed(0)}c`);
      });
    }

    // ── STRENGTHS & WEAKNESSES ──
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

    // ── NEW: CATEGORY BREAKDOWN ──
    if (category_breakdown.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    CATEGORY BREAKDOWN (1000 closed)           ');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('  Category            Sub-League      Pos  WR%   PnL        Share');
      console.log('  ─────────────────────────────────────────────────────────────────');
      category_breakdown.slice(0, 10).forEach(c => {
        const cat = c.category.padEnd(18);
        const sub = (c.sub_league || '-').padEnd(14);
        const pos = String(c.closed_positions).padStart(4);
        const wr = c.win_rate.toFixed(0).padStart(4);
        const pnl = `$${c.total_pnl.toFixed(0)}`.padStart(10);
        const share = `${c.pnl_share.toFixed(1)}%`.padStart(7);
        console.log(`  ${cat} ${sub} ${pos} ${wr}% ${pnl} ${share}`);
      });
    }

    // ── ENTRY ODDS ──
    if (entryOddsBreakdown.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    ENTRY ODDS ANALYSIS                        ');
      console.log('═══════════════════════════════════════════════════════════════');
      entryOddsBreakdown.forEach(e => {
        console.log(`  ${e.range.padEnd(28)} ${e.trades} trades`);
      });
    }

    // ── TRADER LABEL ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    TRADER LABEL                                ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  ${label}`);
    console.log(`  Specialty: ${specialty || 'none'}`);

    // ── COPY RULES (from profile-trader.ts) ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    COPY RULES                                  ');
    console.log('═══════════════════════════════════════════════════════════════');
    if (volumeLabel === 'LOW' && strategyLabel === 'BUY_AND_HOLD' && win_rate >= 60) {
      console.log('  PRIORITY: Entry odds < 40c in their specialty -> Copy at 1.0x');
      console.log('  COPY:     Entry odds 40-60c in their specialty -> Copy at 0.5x');
      console.log('  CAUTIOUS: Entry odds > 60c -> Copy at 0.3x');
      console.log('  SKIP:     Small bets (< 20% of avg) = lottery tickets');
    } else if (volumeLabel === 'HIGH') {
      console.log('  WARNING: High volume trader — difficult to copy manually');
      console.log('  Consider automated copy trading instead');
    } else {
      console.log('  COPY:     Standard bets in their specialty');
      console.log('  CAUTIOUS: Bets outside their specialty');
      console.log('  SKIP:     Very small bets');
    }

    // ── STOP CONDITIONS ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    STOP CONDITIONS                             ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  - Win rate drops below ${Math.max(50, win_rate - 20).toFixed(0)}% over next 20 trades`);
    if (strengths.length > 0) console.log(`  - Starts betting heavily outside ${strengths[0].category}`);
    console.log('  - Bet sizing becomes erratic (2x+ normal on any trade)');
    console.log('  - Starts selling positions early (strategy change)');

    // ── NEW: INSIDER PROBABILITY ──
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                    INSIDER DETECTION                           ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Probability:    ${insider_probability.toUpperCase()}`);
    console.log(`  Score:          ${insider_score}/7`);
    console.log(`  Signals Fired:  ${insider_signals_fired.length > 0 ? insider_signals_fired.join(', ') : 'none'}`);

    // ── TOP OPEN POSITIONS ──
    if (topOpenPositions.length > 0) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('                    TOP OPEN POSITIONS (active)                ');
      console.log('═══════════════════════════════════════════════════════════════');
      topOpenPositions.slice(0, 5).forEach((p, i) => {
        const pnlSign = p.cashPnl >= 0 ? '+' : '';
        console.log(`  ${i + 1}. ${p.title.slice(0, 50)}...`);
        console.log(`     ${p.outcome} | $${p.currentValue.toFixed(2)} | ${pnlSign}$${p.cashPnl.toFixed(2)} (${pnlSign}${p.percentPnl.toFixed(1)}%)`);
        console.log(`     Entry: ${(p.avgPrice * 100).toFixed(0)}c | Current: ${(p.curPrice * 100).toFixed(0)}c`);
        console.log('');
      });
    }

    console.log('═══════════════════════════════════════════════════════════════\n');
  }

  // ── Build and return profile document ─────────────────────
  return {
    wallet: cleanWallet,
    traderLabel,
    profiledAt,
    periodDays: 30,
    periodInfo,

    // Activity counts
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

    // Win rate (CORRECTED — primary metric)
    win_rate,
    win_rate_sample_size,
    wins_closed,
    losses_closed,
    wins_open_resolved,
    losses_open_resolved,

    // P&L (cashFlow-based — source of truth)
    cashFlowPnL,
    timeframePnL,
    pnlConsistency,
    profitFactor,

    // Trade sizing
    avgTradeSize,
    medianTradeSize,
    maxTradeSize,
    avg_bet_size_usdc,

    // High conviction trades
    asymmetricThreshold,
    asymmetricTradesCount: asymmetricTrades.length,
    asymmetricVolume,
    asymmetricVolumePercent,
    recentHighConvictionTrades,

    // Market specialization (from 1000 closed positions)
    strengths,
    weaknesses,
    specialty,
    entryOddsBreakdown,

    // Streak
    currentStreak,
    currentStreakType,

    // Drawdown
    maxDrawdown,
    maxDrawdownPercent,
    max_drawdown_30d_pct: maxDrawdown30dPct,

    // Identity
    account_created_at,
    account_age_days,
    pseudonym,
    display_name,
    x_username,
    first_ever_activity_at,
    last_active_days_ago,

    // ROCE trend
    roce_trend,

    // Market activity metrics
    avg_unique_markets_per_day_7d,
    fragmentation_ratio,
    avg_entry_price_wins,
    avg_entry_price_losses,

    // Category & market breakdown
    category_breakdown,
    market_titles_summary,

    // Insider detection
    insider_score,
    insider_probability,
    insider_signals_fired,

    // Baseline snapshot (for monitoring drift)
    baseline_snapshot,

    // LLM placeholder fields — populated by edge-discovery-batch.ts
    edge_type: null,
    edge_hypothesis: null,
    strength_markets: null,
    weakness_markets: null,
    price_range_min: null,
    price_range_max: null,
    sustainability: null,
    follow_rules: null,
    llm_analyzed_at: null,

    // Display data
    label,
    topOpenPositions,
    recentClosedPositions,
  };
}

// ═══════════════════════════════════════════════════════════════
// Main — standalone CLI entry point
// ═══════════════════════════════════════════════════════════════

async function main() {
  const wallet = process.argv[2];
  const convictionMultiplier = parseInt(process.argv[3] || '10');

  if (!wallet) {
    console.log('Usage: npx tsx scripts/ai-hedge-fund/profile-trader-v2.ts <wallet_address> [conviction_multiplier]');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set in environment');
    process.exit(1);
  }

  // Extract db name from URI — same logic as lib/mongodb.ts
  function extractDbName(uri: string): string {
    try {
      const url = new URL(uri);
      const name = url.pathname.replace('/', '');
      return name || 'polymarket-test';
    } catch {
      const match = uri.match(/\/([^/?]+)(\?|$)/);
      return match?.[1] || 'polymarket-test';
    }
  }
  const dbName = extractDbName(mongoUri);

  console.log('Connecting to MongoDB...');
  const client = new MongoClient(mongoUri);
  await client.connect();
  console.log(`Connected → db: ${dbName}\n`);

  // Run the profiler
  const profileData = await profileTrader(wallet, { convictionMultiplier, verbose: true });

  // Save to polymarket-traderProfiles (production collection)
  const db = client.db(dbName);
  const collection = db.collection('polymarket-traderProfiles');

  console.log('Saving to MongoDB (polymarket-traderProfiles)...');
  await collection.updateOne(
    { wallet: (wallet as string).toLowerCase() },
    { $set: profileData },
    { upsert: true }
  );
  console.log('  ✅ Saved successfully');
  console.log(`  Wallet: ${wallet}`);

  await client.close();
  console.log('\nDone.');
}

// Only run when invoked directly (not when imported by bulk-profile-ahf.ts)
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
