/**
 * Profile Trader v3 — adapted for vault-tracker service
 * Source: scripts/ai-hedge-fund/profile-trader-v3.ts (branch: claude/ai-hedge-fund-MvyeM, commit 92552c0)
 *
 * Changes from original:
 *  - Removed dotenv/path/fileURLToPath imports (service handles env loading)
 *  - Removed MongoClient import and main() CLI entry point
 *  - Exported profileTrader() only — returns { core, positions }
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

interface PublicProfile {
  createdAt?: string;
  pseudonym?: string;
  name?: string;
  xUsername?: string;
}

// ═══════════════════════════════════════════════════════════════
// Fetch Functions
// ═══════════════════════════════════════════════════════════════

// fetchActivities — time-windowed pagination to bypass Polymarket's 3500-record offset cap.
// Uses start/end params with ASC sort. When the cap is hit, slides the window forward
// using the newest collected timestamp and continues until the full period is covered.
async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const periodStart = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const API_OFFSET_CAP = 3500; // Polymarket's hard server-side offset cap
  const MAX_ACTIVITIES = 30000; // Bot guard — anything beyond this is not copy-tradeable

  const seen = new Set<string>();
  const allActivities: Activity[] = [];
  let windowStart = periodStart;

  outer: while (true) {
    let offset = 0;
    let lastTsInWindow = windowStart;
    let hitCap = false;

    while (offset < API_OFFSET_CAP) {
      const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}` +
        `&start=${windowStart}&end=${now}&sortBy=TIMESTAMP&sortDirection=ASC`;

      const response = await fetch(url);
      if (!response.ok) {
        if (Number(response.status) === 400) {
          console.log(`  API returned 400 at offset=${offset} — sliding window`);
          hitCap = true;
          break;
        }
        throw new Error(`API error: ${response.status}`);
      }

      const batch = await response.json() as Activity[];
      if (batch.length === 0) break outer;

      const lastTs = batch[batch.length - 1]?.timestamp;
      console.log(`  Fetching activities offset=${offset}... [${allActivities.length} collected] (${lastTs ? new Date(lastTs * 1000).toISOString().split('T')[0] : 'N/A'})`);

      for (const activity of batch) {
        const key = activity.transactionHash || `${activity.timestamp}-${activity.conditionId}-${activity.outcome}`;
        if (!seen.has(key)) {
          seen.add(key);
          allActivities.push(activity);
          lastTsInWindow = activity.timestamp;
        }
      }

      // Bot guard — skip profiling if activity count exceeds threshold
      if (allActivities.length >= MAX_ACTIVITIES) {
        console.log(`  ⚠️  Activity cap hit (${MAX_ACTIVITIES}) — bot wallet, skipping`);
        return [];
      }

      if (batch.length < LIMIT) break outer; // Last page — all data collected
      offset += LIMIT;
      await new Promise(r => setTimeout(r, 100));
    }

    // Hit offset cap (3500) — slide window forward past what we've collected
    if (!hitCap && offset >= API_OFFSET_CAP) hitCap = true;

    if (hitCap) {
      if (lastTsInWindow <= windowStart) {
        console.log(`  ⚠️  Cannot advance window (all activities at same timestamp) — stopping`);
        break;
      }
      console.log(`  Sliding window past ${new Date(lastTsInWindow * 1000).toISOString().split('T')[0]} (${allActivities.length} collected so far)...`);
      windowStart = lastTsInWindow; // Dedup via `seen` handles any boundary overlap
    }
  }

  // Sort newest first to match expected behavior
  allActivities.sort((a, b) => b.timestamp - a.timestamp);
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
    if (!response.ok) {
      if (Number(response.status) === 400) {
        console.log(`  API returned 400 at offset=${offset} (pagination limit reached) — stopping`);
        break;
      }
      throw new Error(`API error: ${response.status}`);
    }

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
    if (!response.ok) {
      if (Number(response.status) === 400) {
        console.log(`  API returned 400 at offset=${offset} (pagination limit reached) — stopping`);
        break;
      }
      throw new Error(`API error: ${response.status}`);
    }

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
    'ac milan', 'as roma', 'napoli', 'atletico', 'sevilla', 'ajax', 'benfica', 'porto',
    'borussia', 'olympique', 'hamburger sv', ' az '];
  if (soccerTeams.some(team => lower.includes(team))) return 'Soccer';

  // NCAA Basketball — check before MLB to catch college team names first
  const ncaaKeywords = ['ncaa', 'ncaam', 'march madness', 'college basketball', 'college football',
    'cornhuskers', 'hawkeyes', 'tar heels', 'fighting illini', 'gonzaga', 'bulldogs',
    'hoosiers', 'wildcats', 'jayhawks', 'wolverines', 'spartans', 'buckeyes', 'longhorns',
    'cougars', 'aggies', 'hurricanes', 'gators', 'seminoles', 'huskies', 'terrapins',
    'orangemen', 'scarlet knights', 'mountaineers', 'cardinal', 'blue devils', 'boilermakers',
    'volunteers', 'razorbacks', 'gamecocks', 'sooners', 'ducks', 'beavers', 'utes',
    'lobos', 'aztecs', 'rainbow warriors', 'tiger', 'bears',
    'zags', 'friars', 'fighting irish', 'notre dame', 'creighton', 'marquette',
    'villanova', 'providence', 'seton hall', 'depaul', 'georgetown', 'st. john'];
  // Only classify NCAA if not an NHL/NBA team (ducks/kings/cougars/wildcats overlap)
  const isNhlOverlap = nhlTeams.some(t => lower.includes(t));
  const isNbaOverlap = nbaTeams.some(t => lower.includes(t));
  if (!isNhlOverlap && !isNbaOverlap && ncaaKeywords.some(k => lower.includes(k))) return 'NCAA';

  // MLB — team names + generic keywords
  const mlbTeams = ['mlb', 'baseball', 'world series',
    'yankees', 'red sox', 'blue jays', 'orioles', 'rays',
    'white sox', 'guardians', 'tigers', 'royals', 'twins',
    'astros', 'athletics', 'mariners', 'rangers', 'angels',
    'mets', 'phillies', 'braves', 'marlins', 'nationals',
    'cubs', 'brewers', 'cardinals', 'reds', 'pirates',
    'dodgers', 'giants', 'padres', 'rockies', 'diamondbacks'];
  if (mlbTeams.some(k => lower.includes(k))) return 'MLB';

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
    ['BUNDESLIGA', ['fc bayern', 'borussia dortmund', 'borussia', 'rb leipzig', 'wolfsburg',
      'eintracht frankfurt', 'borussia monchengladbach', 'freiburg', 'bayer leverkusen',
      'hertha', 'schalke', 'augsburg', 'bundesliga', 'hoffenheim', 'werder bremen', 'hamburger sv']],
    ['SERIE_A', ['juventus', 'inter milan', 'fc internazionale', 'ac milan', 'as roma',
      'ss lazio', 'napoli', 'atalanta', 'fiorentina', 'torino', 'bologna',
      'udinese', 'serie a', 'coppa italia', 'sampdoria', 'sassuolo']],
    ['LIGUE_1', ['paris saint-germain', 'psg', 'olympique lyonnais', 'olympique de marseille', 'olympique',
      'as monaco', 'lille', 'rennes', 'nice', 'lens', 'ligue 1', 'strasbourg']],
    ['EREDIVISIE', ['ajax', 'psv eindhoven', 'feyenoord', 'az alkmaar', ' az ', 'vitesse', 'eredivisie']],
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

  // Add current value for open positions that had activity in this period (exclude resolved-to-zero)
  const activePositions = openPositions.filter(p => p.curPrice > 0.001);
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

// computeTimeframePnL — METHOD A (v3)
//
// PnL = sum(closedPosition.realizedPnl where close_timestamp in window)
//       + sum(openPosition.cashPnl)   [all-time unrealized; captures unredeemed losers at ~0]
//
// Capital deployed = totalBought of closed positions in window
//                  + initialValue of all open positions (capital still at work)
//
// Replaces cash-flow Method B which inflated ROCE by counting redeems from
// pre-window positions without their corresponding buy costs.
function computeTimeframePnL(
  closedPositions: ClosedPosition[],
  openPositions: OpenPosition[],
  days: number,
) {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  const closedInWindow = closedPositions.filter(p => p.timestamp >= startTs);

  if (closedInWindow.length === 0 && openPositions.length === 0) {
    return { timeframe: `${days}d`, days, pnl: 0, capitalDeployed: 0, totalCapitalDeployed: 0, roce: 0, tradeCount: 0, tradesPerDay: 0, positionCount: 0, tradingDays: 0, wins: 0, losses: 0, winRate: 0, hasData: false, hitApiLimit: false, maxDrawdownAmt: null, maxDrawdownPct: null, realizedPnl: 0, unrealizedPnl: 0, dailyPnLSeries: [] as number[] };
  }

  // Realized: closed positions whose close_timestamp falls in window
  const realizedPnl    = closedInWindow.reduce((s, p) => s + p.realizedPnl, 0);
  const capitalClosed  = closedInWindow.reduce((s, p) => s + p.totalBought, 0);
  const tradeCount     = closedInWindow.length;
  const tradingDays    = new Set(closedInWindow.map(p => new Date(p.timestamp * 1000).toISOString().split('T')[0])).size;

  // Wins/losses from closed positions in window
  let wins   = closedInWindow.filter(p => p.realizedPnl >= 0).length;
  let losses = closedInWindow.filter(p => p.realizedPnl < 0).length;

  // Unrealized: all open positions — cashPnl captures losers sitting at ~0 correctly
  const unrealizedPnl = openPositions.reduce((s, p) => s + p.cashPnl, 0);
  const capitalOpen   = openPositions.reduce((s, p) => s + p.initialValue, 0);

  // Resolved-but-unredeemed open positions also count toward wins/losses
  wins   += openPositions.filter(p => p.curPrice >= 0.99).length;
  losses += openPositions.filter(p => p.curPrice <= 0.001).length;

  const pnl                  = realizedPnl + unrealizedPnl;
  const totalCapitalDeployed = capitalClosed + capitalOpen;
  // Avg capital per active trading day — correct ROCE base for sports/prediction
  // traders who recycle capital across sequential same-day bets. Total capital
  // is misleading because it accumulates across sequential positions using the
  // same dollars.
  const capitalDeployed = tradingDays > 0
    ? totalCapitalDeployed / tradingDays
    : (totalCapitalDeployed > 0 ? totalCapitalDeployed : 0);
  const roce    = capitalDeployed > 0 ? (pnl / capitalDeployed) * 100 : 0;
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;

  // Daily realized PnL series (chronological) — used for drawdown + consistency
  const ddDayMap = new Map<string, number>();
  for (const p of closedInWindow) {
    const day = new Date(p.timestamp * 1000).toISOString().split('T')[0];
    ddDayMap.set(day, (ddDayMap.get(day) ?? 0) + p.realizedPnl);
  }
  const dailyPnLSeries = Array.from(ddDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);

  // Drawdown: worst cumulative realized PnL trough in the window.
  // Expressed as the trough value itself (e.g. -$119k) and as % of avg daily
  // capital — tells you how much the trader was potentially down at worst.
  let maxDrawdownAmt: number | null = null;
  let maxDrawdownPct: number | null = null;

  if (tradingDays >= 2) {
    let cumPnl = 0, troughCumPnl = 0;
    for (const daily of dailyPnLSeries) {
      cumPnl += daily;
      if (cumPnl < troughCumPnl) troughCumPnl = cumPnl;
    }
    maxDrawdownAmt = troughCumPnl; // 0 if realized PnL never went negative
    maxDrawdownPct = capitalDeployed > 0 ? (troughCumPnl / capitalDeployed) * 100 : null;
  }

  return { timeframe: `${days}d`, days, pnl, realizedPnl, unrealizedPnl, capitalDeployed, totalCapitalDeployed, roce, tradeCount, tradesPerDay: tradeCount / days, positionCount: closedInWindow.length, tradingDays, wins, losses, winRate, hasData: closedInWindow.length > 0 || openPositions.length > 0, hitApiLimit: false, maxDrawdownAmt, maxDrawdownPct, dailyPnLSeries };
}


// computeTradingConsistency — replaces the old avgROCE/variance score.
// Uses the 30d daily realized PnL series from closed positions.
//
// daysWon / daysWonRate: how often the trader had a net-positive realized day
// sortinoRatio: avgDailyReturn% / downsideDeviation% — only negative days
//   contribute to the denominator, so it rewards consistent earners who
//   rarely blow up. Dimensionless % ratio for cross-trader comparison.
//   > 1.0 = excellent, > 0.5 = good, < 0.2 = inconsistent / high downside risk
function computeTradingConsistency(dailyPnLSeries: number[], avgDailyCapital: number) {
  if (dailyPnLSeries.length === 0) {
    return { daysWon: 0, daysLost: 0, daysWonRate: 0, avgDailyPnl: 0, sortinoRatio: null, tradingDays: 0 };
  }

  const tradingDays = dailyPnLSeries.length;
  const daysWon  = dailyPnLSeries.filter(d => d > 0).length;
  const daysLost = tradingDays - daysWon;
  const daysWonRate = (daysWon / tradingDays) * 100;

  const totalPnl   = dailyPnLSeries.reduce((a, b) => a + b, 0);
  const avgDailyPnl = totalPnl / tradingDays;

  // Sortino uses daily return % (relative to avg daily capital) so it is
  // comparable across traders of different sizes.
  let sortinoRatio: number | null = null;
  if (avgDailyCapital > 0) {
    const dailyRetPct = dailyPnLSeries.map(d => (d / avgDailyCapital) * 100);
    const avgRetPct   = dailyRetPct.reduce((a, b) => a + b, 0) / tradingDays;
    // Downside deviation: sqrt(mean of squared negative returns)
    const negSquares  = dailyRetPct.map(r => Math.pow(Math.min(r, 0), 2));
    const downsideDev = Math.sqrt(negSquares.reduce((a, b) => a + b, 0) / tradingDays);
    sortinoRatio = downsideDev > 0 ? avgRetPct / downsideDev : null;
  }

  return { daysWon, daysLost, daysWonRate, avgDailyPnl, sortinoRatio, tradingDays };
}

// computeMaxDrawdown30d — from daily cash-flow series
// null if fewer than 5 trading days or cumPnl never goes positive.
// Baseline = first day cumPnl turns positive, preventing inflated drawdowns
// caused by net-negative opening periods (e.g. whale buying before any redemption).
// Result is clamped to 100% — drawdown cannot exceed starting capital.
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
  let troughAtMaxDrawdown = 0;
  let maxDrawdown = 0;
  let firstPositiveSeen = false;

  for (const [, dailyFlow] of sortedDays) {
    cumPnl += dailyFlow;

    // Start tracking only after cumPnl first goes positive.
    // Skips opening period when trader is net-negative (buys before sells/redeems),
    // which would create a false high fragmentation_ratio.
    if (!firstPositiveSeen) {
      if (cumPnl > 0) {
        firstPositiveSeen = true;
        peak = cumPnl;
      }
      continue;
    }

    if (cumPnl > peak) peak = cumPnl;
    const drawdown = peak - cumPnl;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      troughAtMaxDrawdown = cumPnl;
    }
  }

  if (!firstPositiveSeen || peak <= 0) {
    return { maxDrawdown30dPct: null, maxDrawdown: 0, maxDrawdownPercent: 0 };
  }

  const rawPct = (maxDrawdown / peak) * 100;
  // Clamp: drawdown cannot exceed 100% of peak capital
  const pct = Math.min(rawPct, 100);

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
    capital_deployed: number;   // sum of totalBought per position in this category
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
      capital_deployed: 0,
      avg_prices: [],
    };

    entry.titles.add(pos.title.toLowerCase());
    entry.closed_positions++;
    entry.total_pnl += pos.realizedPnl;
    entry.capital_deployed += pos.totalBought;
    if (pos.realizedPnl >= 0) entry.wins++;
    else entry.losses++;
    entry.avg_prices.push(pos.avgPrice);

    groupMap.set(key, entry);
    totalAbsPnl += Math.abs(pos.realizedPnl);
  }

  return Array.from(groupMap.values())
    .map(g => {
      const roce = g.capital_deployed > 0
        ? (g.total_pnl / g.capital_deployed) * 100
        : null;
      return {
        category: g.category,
        sub_league: g.sub_league,
        unique_events: g.titles.size,
        closed_positions: g.closed_positions,
        wins: g.wins,
        losses: g.losses,
        win_rate: (g.wins + g.losses) > 0 ? (g.wins / (g.wins + g.losses)) * 100 : 0,
        total_pnl: g.total_pnl,
        capital_deployed: g.capital_deployed,
        roce,
        pnl_share: totalAbsPnl > 0 ? (g.total_pnl / totalAbsPnl) * 100 : 0,
        avg_entry_price: g.avg_prices.length > 0
          ? g.avg_prices.reduce((a, b) => a + b, 0) / g.avg_prices.length
          : 0,
      };
    })
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
//
// Five behavioral signals modelled on how insiders actually operate:
//   S1 — Acts Late             (max +3): buys within 72h of resolution, wins
//   S2 — Bets Against Crowd   (max +2): wins on sub-0.20 price entries
//   S3 — Conviction Spike     (+2):     10x spike buy within 72h of resolution, won
//   S4 — Thin History          (+1):     new account, immediate large bet, winning
//   S5 — Domain Concentration  (+1):     40%+ winning volume in one category, WR ≥65%
//
// Thresholds: 0–2 none | 3–4 low | 5 medium | 6+ high  (max possible = 9)

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
    closedPositions1000,
    win_rate_sample_size,
    win_rate,
    medianTradeSize,
    activities,
  } = params;

  let score = 0;
  const signals: string[] = [];

  // ── Shared pre-computation ─────────────────────────────────────────────────

  // Index closed positions by conditionId for O(1) lookup
  const wonByCondition  = new Map<string, ClosedPosition>();
  const allByCondition  = new Map<string, ClosedPosition>();
  for (const pos of closedPositions1000) {
    allByCondition.set(pos.conditionId, pos);
    if (pos.realizedPnl > 0) wonByCondition.set(pos.conditionId, pos);
  }

  // Sort activities ascending by timestamp; isolate BUY trades
  const sortedActs  = [...activities].sort((a, b) => a.timestamp - b.timestamp);
  const buyActs     = sortedActs.filter(a => a.type === 'TRADE' && a.side === 'BUY');

  // First BUY per conditionId (earliest entry into each market)
  const firstBuyByCondition = new Map<string, Activity>();
  for (const act of buyActs) {
    if (!firstBuyByCondition.has(act.conditionId)) {
      firstBuyByCondition.set(act.conditionId, act);
    }
  }

  // ── Signal 1 — Acts Late (max +3) ─────────────────────────────────────────
  // Entry within 72h of market resolution + won. Size-weighted win rate gates score.
  //
  // Reactivation variant: account older than 45d but first activity in the 30d
  // window is within the last 7 days → inferred dormancy of 23+ days. If that
  // first-window activity is itself a late entry win, it counts as +2 alone.

  const lateEntries: { won: boolean; usdc: number }[] = [];
  let lateWinCount = 0;

  for (const [conditionId, firstBuy] of firstBuyByCondition) {
    const closedPos = allByCondition.get(conditionId);
    if (!closedPos) continue;
    const gapHours = (closedPos.timestamp - firstBuy.timestamp) / 3600;
    if (gapHours >= 0 && gapHours < 72) {
      const won = closedPos.realizedPnl > 0;
      lateEntries.push({ won, usdc: firstBuy.usdcSize });
      if (won) lateWinCount++;
    }
  }

  // Size-weighted win rate across all late entries (wins + losses)
  const lateTotalUsdc = lateEntries.reduce((s, e) => s + e.usdc, 0);
  const lateWonUsdc   = lateEntries.filter(e => e.won).reduce((s, e) => s + e.usdc, 0);
  const lateSwWr      = lateTotalUsdc > 0 ? lateWonUsdc / lateTotalUsdc : 0;

  // Reactivation check: established account + inactive most of the 30d window + late win
  const nowSec         = Date.now() / 1000;
  const sevenDaysAgoSec = nowSec - 7 * 86400;
  const isReactivation  =
    account_age_days !== null &&
    account_age_days > 45 &&
    sortedActs.length > 0 &&
    sortedActs[0].timestamp > sevenDaysAgoSec; // first activity in window is very recent

  let hasReactivationLateWin = false;
  if (isReactivation && sortedActs.length > 0) {
    const firstAct = sortedActs[0];
    if (firstAct.type === 'TRADE' && firstAct.side === 'BUY') {
      const wonPos = wonByCondition.get(firstAct.conditionId);
      if (wonPos) {
        const gapHours = (wonPos.timestamp - firstAct.timestamp) / 3600;
        if (gapHours >= 0 && gapHours < 72) hasReactivationLateWin = true;
      }
    }
  }

  if (lateWinCount >= 2 && lateSwWr >= 0.70) {
    score += 3;
    signals.push(`s1_late_entry:wins=${lateWinCount},swwr=${Math.round(lateSwWr * 100)}%`);
  } else if (lateWinCount >= 2 && lateSwWr >= 0.50) {
    score += 2;
    signals.push(`s1_late_entry:wins=${lateWinCount},swwr=${Math.round(lateSwWr * 100)}%`);
  } else if (hasReactivationLateWin) {
    // Dormant account resurfacing with a late entry win — strong even as a single instance
    score += 2;
    signals.push('s1_reactivation_late_win');
  } else if (lateWinCount === 1) {
    score += 1;
    signals.push('s1_single_late_win');
  }

  // ── Signal 2 — Bets Against the Crowd (max +2) ────────────────────────────
  // Wins on entries where avgPrice < 0.20. Size-weighted win rate gates score.

  const contrarian     = closedPositions1000.filter(p => p.avgPrice < 0.20);
  const contrarianWins = contrarian.filter(p => p.realizedPnl > 0);

  const contrTotalUsdc = contrarian.reduce((s, p) => s + p.totalBought, 0);
  const contrWonUsdc   = contrarianWins.reduce((s, p) => s + p.totalBought, 0);
  const contrSwWr      = contrTotalUsdc > 0 ? contrWonUsdc / contrTotalUsdc : 0;

  if (contrarianWins.length >= 2 && contrSwWr >= 0.75) {
    score += 2;
    signals.push(`s2_contrarian:wins=${contrarianWins.length},swwr=${Math.round(contrSwWr * 100)}%`);
  } else if (contrarianWins.length >= 2 && contrSwWr >= 0.55) {
    score += 1;
    signals.push(`s2_contrarian:wins=${contrarianWins.length},swwr=${Math.round(contrSwWr * 100)}%`);
  }

  // ── Signal 3 — Conviction Spike Near Resolution (+2) ──────────────────────
  // A single BUY > 10x median bet size, placed within 72h of resolution, that won.

  if (medianTradeSize > 0) {
    const hasSpike = buyActs.some(act => {
      if (act.usdcSize <= medianTradeSize * 10) return false;
      const wonPos = wonByCondition.get(act.conditionId);
      if (!wonPos) return false;
      const gapHours = (wonPos.timestamp - act.timestamp) / 3600;
      return gapHours >= 0 && gapHours < 72;
    });
    if (hasSpike) {
      score += 2;
      signals.push('s3_conviction_spike_near_resolution');
    }
  }

  // ── Signal 4 — Thin History, Immediate Concentration (+1) ─────────────────
  // New account (< 14d), first bets are large (> $300), already winning (WR > 55%, ≥3 trades).

  const hasLargeEarlyBet = closedPositions1000.some(p => p.totalBought > 300);
  if (
    account_age_days !== null &&
    account_age_days < 14 &&
    hasLargeEarlyBet &&
    win_rate_sample_size >= 3 &&
    win_rate > 55
  ) {
    score += 1;
    signals.push('s4_thin_history_concentrated');
  }

  // ── Signal 5 — Domain Concentration (+1) ──────────────────────────────────
  // 40%+ of winning USDC volume concentrated in one category, with WR ≥ 65% in that category.

  const wonPositions = closedPositions1000.filter(p => p.realizedPnl > 0);
  if (wonPositions.length > 0) {
    const totalWonUsdc = wonPositions.reduce((s, p) => s + p.totalBought, 0);

    // Per-category: won usdc + win rate
    const catWonUsdc = new Map<string, number>();
    const catStats   = new Map<string, { wins: number; total: number }>();
    for (const pos of closedPositions1000) {
      const cat = categorizeMarket(pos.title);
      catWonUsdc.set(cat, (catWonUsdc.get(cat) ?? 0) + (pos.realizedPnl > 0 ? pos.totalBought : 0));
      const st = catStats.get(cat) ?? { wins: 0, total: 0 };
      st.total++;
      if (pos.realizedPnl > 0) st.wins++;
      catStats.set(cat, st);
    }

    for (const [cat, wonUsdc] of catWonUsdc) {
      const share      = totalWonUsdc > 0 ? wonUsdc / totalWonUsdc : 0;
      const st         = catStats.get(cat)!;
      const catWinRate = st.total > 0 ? st.wins / st.total : 0;
      if (share >= 0.40 && catWinRate >= 0.65) {
        score += 1;
        signals.push(`s5_domain:${cat}(vol=${Math.round(share * 100)}%,wr=${Math.round(catWinRate * 100)}%)`);
        break; // only award once
      }
    }
  }

  // ── Threshold mapping ──────────────────────────────────────────────────────
  // 0–2 → none | 3–4 → low | 5 → medium | 6+ → high
  let insider_probability: 'high' | 'medium' | 'low' | 'none';
  if      (score >= 6) insider_probability = 'high';
  else if (score >= 5) insider_probability = 'medium';
  else if (score >= 3) insider_probability = 'low';
  else                 insider_probability = 'none';

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
  isWhaleConcentrator: boolean;
}): string {
  const labels: string[] = [];

  if (params.isWhaleConcentrator) labels.push('WHALE_CONCENTRATOR');
  else if (params.volumeLabel === 'LOW') labels.push('LOW_VOLUME');
  else if (params.volumeLabel === 'HIGH') labels.push('HIGH_VOLUME');
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
): Promise<{ core: Record<string, unknown>; positions: Record<string, unknown> }> {
  const { convictionMultiplier = 10, verbose = true } = options;
  const cleanWallet = wallet.toLowerCase();
  const profiledAt = new Date();

  // ── Fetch all data ─────────────────────────────────────────
  if (verbose) {
    console.log('\nFetching activities (30d)...');
  }
  const activities = await fetchActivities(cleanWallet, 30);
  if (activities.length === 0 && verbose) console.log('  ⚠️  0 activities — bot cap hit or inactive wallet');
  // Bot guard: fetchActivities returns [] when cap exceeded — skip this wallet
  if (activities.length === 0) {
    throw new Error('BOT_SKIP: activity cap exceeded or no activity in window');
  }
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

  // ── Activity data coverage diagnostic ─────────────────────
  if (verbose) {
    const fmt = (a: Activity) =>
      `${new Date(a.timestamp * 1000).toISOString()} | ${a.type}${a.side ? '/' + a.side : ''} | $${a.usdcSize.toFixed(2)} USDC | ${a.size.toFixed(4)} shares @ ${a.price.toFixed(4)} | ${a.title?.slice(0, 60) ?? 'N/A'}`;

    console.log('\n─── ACTIVITY DATA COVERAGE ───────────────────────────────');
    if (firstActivityInPeriod) {
      console.log(`  OLDEST in period : ${fmt(firstActivityInPeriod)}`);
    } else {
      console.log('  OLDEST in period : (no activities)');
    }
    if (lastActivity) {
      console.log(`  NEWEST in period : ${fmt(lastActivity)}`);
    } else {
      console.log('  NEWEST in period : (no activities)');
    }
    const coverageDays = (lastActivity && firstActivityInPeriod)
      ? ((lastActivity.timestamp - firstActivityInPeriod.timestamp) / 86400).toFixed(1)
      : '0';
    console.log(`  Coverage         : ${coverageDays} days across ${activities.length} activities`);
    if (activities.length >= 10000) {
      console.log('  ⚠ Hit 10k API limit — older activities may be missing');
    }
    console.log('──────────────────────────────────────────────────────────\n');
  }

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
  let buyCount = 0, sellCount = 0, redeemCount = 0, mergeCount = 0, splitCount = 0, otherCount = 0;
  const tradeSizes: number[] = [];

  for (const a of activities) {
    if (a.type === 'TRADE') {
      tradeSizes.push(a.usdcSize);
      if (a.side === 'BUY') buyCount++;
      else if (a.side === 'SELL') sellCount++;
    } else if (a.type === 'REDEEM') {
      redeemCount++;
    } else if (a.type === 'MERGE') {
      mergeCount++;
    } else if (a.type === 'SPLIT') {
      splitCount++;
    } else {
      otherCount++; // REWARD, CONVERSION
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
  const maxTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => (b > a ? b : a), 0) : 0;

  // ── P&L (Method A — closedPositions-based) ────────────────
  const timeframePnL: Record<string, ReturnType<typeof computeTimeframePnL>> = {
    '1d':  computeTimeframePnL(closedPositions1000, allOpenPositions, 1),
    '7d':  computeTimeframePnL(closedPositions1000, allOpenPositions, 7),
    '15d': computeTimeframePnL(closedPositions1000, allOpenPositions, 15),
    '30d': computeTimeframePnL(closedPositions1000, allOpenPositions, 30),
  };

  const tradingConsistency = computeTradingConsistency(
    timeframePnL['30d'].dailyPnLSeries,
    timeframePnL['30d'].capitalDeployed,
  );

  // ── Capital trend ──────────────────────────────────────────
  const capital_trend: 'scaling_up' | 'scaling_down' | 'stable' | 'inactive' | null =
    (!timeframePnL['15d'].hasData || !timeframePnL['30d'].hasData) ? null :
    timeframePnL['15d'].capitalDeployed === 0 ? 'inactive' :
    timeframePnL['15d'].capitalDeployed > timeframePnL['30d'].capitalDeployed * 0.6 ? 'scaling_up' :
    timeframePnL['15d'].capitalDeployed < timeframePnL['30d'].capitalDeployed * 0.3 ? 'scaling_down' :
    'stable';

  // drawdown_trend: compare absolute trough depths (more negative = worse)
  const _dd15abs = timeframePnL['15d'].maxDrawdownPct !== null ? Math.abs(timeframePnL['15d'].maxDrawdownPct) : null;
  const _dd30abs = timeframePnL['30d'].maxDrawdownPct !== null ? Math.abs(timeframePnL['30d'].maxDrawdownPct) : null;
  const drawdown_trend: 'improving' | 'worsening' | 'stable' | 'insufficient_data' =
    (_dd15abs === null || _dd30abs === null) ? 'insufficient_data' :
    _dd15abs < _dd30abs * 0.7 ? 'improving' :
    _dd15abs > _dd30abs * 1.3 ? 'worsening' :
    'stable';

  // ── ROCE trend ──────────────────────────────────────────────
  const _r7  = timeframePnL['7d'].hasData  ? timeframePnL['7d'].roce  : null;
  const _r15 = timeframePnL['15d'].hasData ? timeframePnL['15d'].roce : null;
  const _r30 = timeframePnL['30d'].hasData ? timeframePnL['30d'].roce : null;

  let _roceDirection: string;
  let _roceTrendBasis: '7d_vs_30d' | '15d_vs_30d' | 'unknown';
  if (_r7 !== null && _r30 !== null) {
    _roceDirection = _r7 > _r30 ? 'improving' : _r7 < _r30 * 0.7 ? 'degrading' : 'stable';
    _roceTrendBasis = '7d_vs_30d';
  } else if (_r15 !== null && _r30 !== null) {
    // 7d has no data (trader inactive <7d) — fall back to 15d vs 30d
    _roceDirection = _r15 > _r30 ? 'improving' : _r15 < _r30 * 0.7 ? 'degrading' : 'stable';
    _roceTrendBasis = '15d_vs_30d';
  } else {
    _roceDirection = 'unknown';
    _roceTrendBasis = 'unknown';
  }
  const roce_trend = { d7: _r7, d15: _r15, d30: _r30, direction: _roceDirection, basis: _roceTrendBasis };

  // profitFactor — Method A (closedPositions-based)
  // > 1 = profitable overall, < 1 = losing overall
  const totalCapitalClosed = closedPositions1000.reduce((s, p) => s + p.totalBought, 0);
  const totalRealizedPnl   = closedPositions1000.reduce((s, p) => s + p.realizedPnl, 0);
  const totalUnrealizedPnl = allOpenPositions.reduce((s, p) => s + p.cashPnl, 0);
  const totalCapitalOpen   = allOpenPositions.reduce((s, p) => s + p.initialValue, 0);
  const totalCapitalDeployed = totalCapitalClosed + totalCapitalOpen;
  const totalPnlAllTime    = totalRealizedPnl + totalUnrealizedPnl;
  const profitFactor = totalCapitalDeployed > 0 ? (totalCapitalDeployed + totalPnlAllTime) / totalCapitalDeployed : 0;

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
  const openResolvedLossPositions = allOpenPositions.filter(p => p.curPrice <= 0.001 && p.size > 0);
  const losses_open_resolved = openResolvedLossPositions.length;

  const totalWins = wins_closed + wins_open_resolved;
  const totalLosses = losses_closed + losses_open_resolved;
  const totalSample = totalWins + totalLosses;
  const win_rate = totalSample > 0 ? (totalWins / totalSample) * 100 : 0;
  const win_rate_sample_size = totalSample;

  // ── Closed positions analysis (from 1000 sample) ──────────
  const avg_entry_price_wins = wins_closed > 0
    ? closedPositions1000.filter(p => p.realizedPnl >= 0).reduce((sum, p) => sum + p.avgPrice, 0) / wins_closed
    : null;
  const totalLossesForAvg = losses_closed + losses_open_resolved;
  const avg_entry_price_losses = totalLossesForAvg > 0
    ? (closedPositions1000.filter(p => p.realizedPnl < 0).reduce((sum, p) => sum + p.avgPrice, 0)
       + openResolvedLossPositions.reduce((sum, p) => sum + p.avgPrice, 0)) / totalLossesForAvg
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

  // Note: activities_per_day = totalActivities / periodDays (computed at read-time)
  // totalActivities is already stored — no need for a separate pre-computed field

  // ── Max drawdown 30d ───────────────────────────────────────
  const { maxDrawdown30dPct, maxDrawdown, maxDrawdownPercent } = computeMaxDrawdown30d(activities);

  // ── Open/closed position categorization ───────────────────
  const LOSS_THRESHOLD = 0.001;
  const openPositions = allOpenPositions.filter(p => p.curPrice >= LOSS_THRESHOLD);

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

  // ── avg_bet_size_usdc ─────────────────────────────────────
  // Method A: avg capital deployed per resolved position (closed + resolved open)
  const avg_bet_size_usdc = win_rate_sample_size > 0 ? totalCapitalDeployed / win_rate_sample_size : 0;

  // ── Activity display classification ───────────────────────
  // WHALE_CONCENTRATOR overrides HIGH_VOLUME when a trader makes many trades
  // into very few markets with large average bets — they are scaling into
  // concentrated positions, not bot-trading across hundreds of markets.
  const isWhaleConcentrator = total_unique_markets_30d <= 15 && avg_bet_size_usdc > 50000;

  // ── Trader label ───────────────────────────────────────────
  const traderLabel = `Trader-${cleanWallet.slice(0, 6)}`;
  const label = determineTraderLabel({ volumeLabel, strategyLabel, win_rate, profitFactor, strengths, isWhaleConcentrator });

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
    days_won_rate: tradingConsistency.daysWonRate,
    sortino_ratio: tradingConsistency.sortinoRatio,
    avg_unique_markets_per_day_7d,
    max_drawdown_15d_amt: timeframePnL['15d'].maxDrawdownAmt,
    max_drawdown_15d_pct: timeframePnL['15d'].maxDrawdownPct,
    max_drawdown_30d_amt: timeframePnL['30d'].maxDrawdownAmt,
    max_drawdown_30d_pct: timeframePnL['30d'].maxDrawdownPct,
    capital_trend,
    drawdown_trend,
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
    console.log('                    TRADER PROFILER v3                          ');
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
    console.log(`  MERGE:              ${mergeCount}`);
    console.log(`  SPLIT:              ${splitCount}`);
    console.log(`  Other (Reward/etc): ${otherCount}`);
    console.log('');
    const activityLevelDisplay = isWhaleConcentrator
      ? `WHALE_CONCENTRATOR (${total_unique_markets_30d} markets, avg bet $${avg_bet_size_usdc.toFixed(0)}, ${tradesPerDay.toFixed(1)} trades/day — scaling entries not fragmentation)`
      : `${volumeLabel} VOLUME (${tradesPerDay.toFixed(1)} trades/day)`;
    console.log(`  Activity Level:     ${activityLevelDisplay}`);
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
    console.log('                    PERFORMANCE (Method A — ClosedPositions)    ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  All-time PnL:       $${totalPnlAllTime.toFixed(2)}  (realized=$${totalRealizedPnl.toFixed(2)}, unrealized=$${totalUnrealizedPnl.toFixed(2)})`);
    console.log(`  Capital Deployed:   $${totalCapitalDeployed.toFixed(2)}  (closed=$${totalCapitalClosed.toFixed(2)}, open=$${totalCapitalOpen.toFixed(2)})`);
    console.log(`  Profit Factor:      ${profitFactor.toFixed(3)}`);
    console.log(`  Closed Positions:   ${closedPositions1000.length} (sample)`);

    console.log('\n  Timeframe P&L:');
    for (const [frame, data] of Object.entries(timeframePnL)) {
      if (data.hasData) {
        const troughStr = data.maxDrawdownAmt !== null && data.maxDrawdownPct !== null && data.maxDrawdownAmt < 0
          ? ` | Trough=$${data.maxDrawdownAmt.toFixed(0)} (${data.maxDrawdownPct.toFixed(1)}% of avgDailyCap)`
          : ' | Trough=none';
        console.log(`    ${frame.padEnd(4)}: PnL=$${data.pnl.toFixed(0).padStart(10)} | ROCE=${data.roce.toFixed(1)}% | AvgDailyCap=$${data.capitalDeployed.toFixed(0)} | TotalCap=$${data.totalCapitalDeployed.toFixed(0)}${troughStr} | TradingDays=${data.tradingDays}`);
      } else {
        console.log(`    ${frame.padEnd(4)}: no data`);
      }
    }

    const roceDirNote = roce_trend.basis === '15d_vs_30d'
      ? ` (15d vs 30d — 7d inactive${last_active_days_ago !== null ? `, last active ${last_active_days_ago.toFixed(0)}d ago` : ''})`
      : '';
    console.log(`\n  ROCE Trend:    7d=${roce_trend.d7 !== null ? roce_trend.d7.toFixed(1) + '%' : 'n/a'}  15d=${roce_trend.d15 !== null ? roce_trend.d15.toFixed(1) + '%' : 'n/a'}  30d=${roce_trend.d30 !== null ? roce_trend.d30.toFixed(1) + '%' : 'n/a'}  → ${roce_trend.direction.toUpperCase()}${roceDirNote}`);
    console.log(`  Capital Trend: ${capital_trend ?? 'n/a'}`);
    console.log(`  Drawdown Trend: ${drawdown_trend}`);

    const lowSampleWarn = tradingConsistency.tradingDays < 15
      ? `  ⚠️ LOW SAMPLE (${tradingConsistency.tradingDays} trading days — need 15+ for reliable signal)`
      : '';
    console.log(`\n  Trading Consistency (30d realized):${lowSampleWarn}`);
    console.log(`    Days Won:       ${tradingConsistency.daysWon}/${tradingConsistency.tradingDays} (${tradingConsistency.daysWonRate.toFixed(1)}%)`);
    console.log(`    Avg Daily PnL:  $${tradingConsistency.avgDailyPnl.toFixed(0)}`);
    console.log(`    Sortino Ratio:  ${tradingConsistency.sortinoRatio !== null ? tradingConsistency.sortinoRatio.toFixed(3) : 'n/a'}  (>0.5 good, >1.0 excellent)`);
    console.log(`    Trading days:   7d=${timeframePnL['7d'].tradingDays}  15d=${timeframePnL['15d'].tradingDays}  30d=${timeframePnL['30d'].tradingDays}`);

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
    const fragLabel = fragmentation_ratio === null
      ? 'n/a'
      : (total_unique_markets_30d <= 10 && fragmentation_ratio > 50)
        ? `CONCENTRATED (${total_unique_markets_30d} markets, scaling entries — not fragmented)`
        : fragmentation_ratio.toFixed(2);
    console.log(`  Fragmentation Ratio:        ${fragLabel}`);
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

      // Log top "Other" market titles so uncategorized bets are visible
      const otherMarkets = market_titles_summary.filter(m => m.category === 'Other');
      if (otherMarkets.length > 0) {
        console.log('\n  ⚠ Top "Other" markets (uncategorized — consider adding keywords):');
        otherMarkets.slice(0, 5).forEach(m => {
          const pnlSign = m.total_pnl >= 0 ? '+' : '';
          console.log(`    ${pnlSign}$${m.total_pnl.toFixed(0).padStart(9)} | ${m.title.slice(0, 72)}`);
        });
      }
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
    if (isWhaleConcentrator) {
      console.log('  PRIORITY: Copy high-conviction bets (>5x avg) at 1.0x when insider signals fired');
      console.log('  COPY:     Same market, same direction — scale in as they scale in');
      console.log('  SKIP:     Do not copy partial scaling trades < 50% of their avg bet');
    } else if (volumeLabel === 'LOW' && strategyLabel === 'BUY_AND_HOLD' && win_rate >= 60) {
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

  // ── Strip dailyPnLSeries from timeframePnL for core doc ───────────────────
  const timeframePnLCore: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(timeframePnL)) {
    const { dailyPnLSeries: _omit, ...rest } = val as Record<string, unknown> & { dailyPnLSeries: unknown };
    timeframePnLCore[key] = rest;
  }

  // ── Core profile document (lean — stored in polymarket-traderProfiles) ────
  const core = {
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
    mergeCount,
    splitCount,
    otherCount, // REWARD, CONVERSION

    // Classification
    tradesPerDay,
    volumeLabel,
    buyRatio,
    strategyLabel,

    // Win rate
    win_rate,
    win_rate_sample_size,
    wins_closed,
    losses_closed,
    wins_open_resolved,
    losses_open_resolved,

    // P&L (Method A — closedPositions-based)
    totalPnlAllTime,
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalCapitalDeployed,
    timeframePnL: timeframePnLCore,  // no dailyPnLSeries
    capital_trend,
    drawdown_trend,
    tradingConsistency,
    profitFactor,

    // Trade sizing
    avgTradeSize,
    medianTradeSize,
    maxTradeSize,
    avg_bet_size_usdc,

    // High conviction summary (counts only — full list in positions doc)
    asymmetricThreshold,
    asymmetricTradesCount: asymmetricTrades.length,
    asymmetricVolume,
    asymmetricVolumePercent,

    // Market specialization summary
    specialty,
    category_breakdown,

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
    isWhaleConcentrator,
    avg_entry_price_wins,
    avg_entry_price_losses,

    // Insider detection
    insider_score,
    insider_probability,
    insider_signals_fired,
    insider_rank_multiplier: insider_probability === 'high' ? 1.5 : 1.0,

    // Baseline snapshot
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

    label,
  };

  // ── Positions document (heavy arrays — stored in polymarket-traderPositions) ─
  // dailyPnLSeries per timeframe stored here for charting/analytics
  const dailyPnLByFrame: Record<string, number[]> = {};
  for (const [key, val] of Object.entries(timeframePnL)) {
    const v = val as Record<string, unknown>;
    if (Array.isArray(v.dailyPnLSeries)) dailyPnLByFrame[key] = v.dailyPnLSeries as number[];
  }

  const positions = {
    wallet: cleanWallet,
    profiledAt,
    topOpenPositions,
    recentClosedPositions,
    recentHighConvictionTrades,
    market_titles_summary,
    entryOddsBreakdown,
    strengths,
    weaknesses,
    dailyPnLByFrame,
  };

  return { core, positions };

}
