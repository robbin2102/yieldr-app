/**
 * AI Hedge Fund — Generate Signals (Part 5)
 *
 * Reads ahf-alphaTraders (llm_analyzed, not 'unclear', active <=7d).
 * For each trader, reads recentHighConvictionTrades from polymarket-traderProfiles.
 * Groups by market, filters by strength_markets + price range + recency.
 * Validates open markets via Gamma API.
 * Saves signals to ahf-signals, updates signal counts on ahf-alphaTraders.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/generate-signals.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Db } from 'mongodb';

// ── Env loading ───────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface HighConvictionTrade {
  timestamp: Date;
  side: string;
  market: string;   // market title
  outcome: string;
  price: number;
  usdcSize: number;
  sizeMultiplier: number;
  txHash?: string;
}

interface AlphaTrader {
  wallet: string;
  display_name?: string | null;
  pseudonym?: string | null;
  edge_type: string;
  edge_confidence: string;
  rank_score: number;
  insider_probability: string;
  specialty?: string;
  strength_markets?: string[];
  weakness_markets?: string[];
  price_range_min?: number | null;
  price_range_max?: number | null;
  follow_rules?: string | null;
  last_active_days_ago?: number | null;
}

interface TraderProfile {
  wallet: string;
  recentHighConvictionTrades?: HighConvictionTrade[];
}

interface PositionGroup {
  market_title: string;
  outcome: string;
  category: string;
  sub_league: string | null;
  total_size_deployed: number;
  entry_count: number;
  avg_entry_price: number;
  first_entry_at: Date;
  last_entry_at: Date;
}

export interface SignalsResult {
  generated: number;
  traders: number;
}

// ── Market categorization (inlined from profile-trader-v2 patterns) ───────────

const CATEGORY_PATTERNS: Array<{ category: string; keywords: string[] }> = [
  { category: 'NBA',      keywords: ['nba', 'lakers', 'celtics', 'warriors', 'bulls', 'bucks', 'nets', 'knicks', 'heat', 'suns', 'nuggets', 'clippers', 'mavericks', 'hawks', 'raptors', 'pacers', 'sixers', 'cavaliers', 'pistons', 'magic', 'hornets', 'pelicans', 'grizzlies', 'rockets', 'spurs', 'thunder', 'trail blazers', 'jazz', 'kings', 'timberwolves'] },
  { category: 'NFL',      keywords: ['nfl', 'chiefs', 'patriots', 'cowboys', 'eagles', 'bills', 'bengals', 'ravens', '49ers', 'rams', 'chargers', 'broncos', 'raiders', 'dolphins', 'jets', 'giants', 'commanders', 'bears', 'lions', 'packers', 'vikings', 'saints', 'falcons', 'panthers', 'buccaneers', 'cardinals', 'seahawks', 'super bowl'] },
  { category: 'NHL',      keywords: ['nhl', 'bruins', 'maple leafs', 'canadiens', 'rangers', 'penguins', 'blackhawks', 'red wings', 'flyers', 'capitals', 'lightning', 'panthers', 'hurricanes', 'islanders', 'senators', 'sabres', 'jets', 'coyotes', 'sharks', 'ducks', 'kings', 'canucks', 'flames', 'oilers', 'avalanche', 'blues', 'predators', 'wild', 'stars', 'blue jackets'] },
  { category: 'MLB',      keywords: ['mlb', 'yankees', 'red sox', 'dodgers', 'cubs', 'mets', 'giants', 'cardinals', 'braves', 'astros', 'world series'] },
  { category: 'Tennis',   keywords: ['tennis', 'atp', 'wta', 'wimbledon', 'french open', 'us open', 'australian open', 'grand slam', 'djokovic', 'federer', 'nadal', 'serena', 'alcaraz'] },
  { category: 'Golf',     keywords: ['golf', 'pga', 'masters', 'open championship', 'us open golf', 'ryder cup', 'tiger woods', 'mcilroy'] },
  { category: 'MMA',      keywords: ['ufc', 'mma', 'bellator', 'conor mcgregor', 'khabib'] },
  { category: 'Politics', keywords: ['election', 'president', 'senate', 'congress', 'vote', 'poll', 'biden', 'trump', 'democrat', 'republican', 'governor', 'primary', 'minister', 'parliament'] },
  { category: 'Crypto',   keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'defi', 'nft', 'solana', 'sol', 'doge', 'xrp', 'bnb'] },
  { category: 'Finance',  keywords: ['stock', 'nasdaq', 'sp500', 's&p', 'dow', 'fed', 'interest rate', 'gdp', 'inflation', 'ipo', 'earnings'] },
  { category: 'Entertainment', keywords: ['oscar', 'grammy', 'emmy', 'golden globe', 'box office', 'movie', 'award', 'celebrity', 'reality tv'] },
];

const SOCCER_LEAGUES: Array<{ name: string; keywords: string[] }> = [
  { name: 'PREMIER_LEAGUE',   keywords: ['premier league', 'epl', 'arsenal', 'chelsea', 'liverpool', 'manchester', 'man city', 'man utd', 'tottenham', 'newcastle', 'west ham', 'aston villa', 'brighton'] },
  { name: 'CHAMPIONS_LEAGUE', keywords: ['champions league', 'ucl'] },
  { name: 'LA_LIGA',          keywords: ['la liga', 'real madrid', 'barcelona', 'atletico', 'sevilla', 'valencia', 'villarreal', 'real sociedad'] },
  { name: 'BUNDESLIGA',       keywords: ['bundesliga', 'bayern', 'dortmund', 'rb leipzig', 'leverkusen', 'frankfurt', 'wolfsburg'] },
  { name: 'SERIE_A',          keywords: ['serie a', 'juventus', 'inter milan', 'ac milan', 'napoli', 'roma', 'lazio', 'atalanta', 'fiorentina'] },
  { name: 'LIGUE_1',          keywords: ['ligue 1', 'psg', 'paris saint-germain', 'marseille', 'lyon', 'monaco', 'lille', 'rennes', 'nice'] },
  { name: 'EREDIVISIE',       keywords: ['eredivisie', 'ajax', 'psv', 'feyenoord'] },
];

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();

  // Check soccer first
  const soccerKw = ['soccer', 'football', 'fc', 'united', 'city', 'athletic', 'real ', 'atletico', 'sporting', 'ol ', 'ac milan', 'inter', 'juventus', 'liverpool', 'arsenal', 'chelsea', 'barcelona', 'manchester', 'tottenham', 'psg', 'paris saint-germain'];
  if (soccerKw.some(k => lower.includes(k))) return 'Soccer';

  for (const { category, keywords } of CATEGORY_PATTERNS) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return 'Other';
}

function detectSubLeague(title: string, category: string): string | null {
  if (category !== 'Soccer') return null;
  const lower = title.toLowerCase();
  for (const { name, keywords } of SOCCER_LEAGUES) {
    if (keywords.some(k => lower.includes(k))) return name;
  }
  return null;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── Gamma API market check ────────────────────────────────────────────────────

async function isMarketOpen(marketTitle: string): Promise<{ open: boolean; verified: boolean }> {
  const slug = slugify(marketTitle);
  try {
    const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&closed=false`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { open: true, verified: false };

    const data = await resp.json() as unknown[];
    if (!Array.isArray(data) || data.length === 0) return { open: false, verified: true };

    const market = data[0] as Record<string, unknown>;
    if (market.closed === true) return { open: false, verified: true };

    return { open: true, verified: true };
  } catch {
    return { open: true, verified: false }; // include signal anyway on API failure
  }
}

// ── Signal matching helpers ───────────────────────────────────────────────────

/**
 * Check if any of the trader's strength_markets match this position's
 * category/sub_league via case-insensitive substring.
 * e.g. 'La Liga' in strength_markets matches 'Soccer/La Liga/underdog win markets'
 */
function matchesStrengthMarkets(
  strengthMarkets: string[],
  category: string,
  subLeague: string | null
): boolean {
  if (strengthMarkets.length === 0) return true; // no restrictions = accept all

  const target = `${category}${subLeague ? '/' + subLeague : ''}`.toLowerCase();
  return strengthMarkets.some(s => {
    const sl = s.toLowerCase();
    return target.includes(sl) || sl.includes(target) || sl.includes(category.toLowerCase());
  });
}

// ── Core logic (exported for pipeline use) ────────────────────────────────────

export async function generateSignals(db: Db): Promise<SignalsResult> {
  // Load qualifying alpha traders
  const traders = await db
    .collection<AlphaTrader>('ahf-alphaTraders')
    .find({
      llm_analyzed_at: { $ne: null },
      edge_type: { $ne: 'unclear' },
      last_active_days_ago: { $lte: 7 },
    })
    .sort({ rank_score: -1 })
    .toArray();

  console.log(`  Found ${traders.length} qualifying traders (LLM analyzed, active <=7d)`);

  const signalsCol  = db.collection('ahf-signals');
  const profilesCol = db.collection<TraderProfile>('polymarket-traderProfiles');
  const alphaCol    = db.collection('ahf-alphaTraders');

  // Create indexes
  await signalsCol.createIndex(
    { trader_wallet: 1, market_title: 1, outcome: 1 },
    { unique: true, background: true }
  );
  await signalsCol.createIndex({ status: 1, created_at: -1 }, { background: true });
  await signalsCol.createIndex({ trader_rank_score: -1 }, { background: true });

  let totalSignals = 0;
  let processedTraders = 0;
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  for (const trader of traders) {
    // Load recentHighConvictionTrades from polymarket-traderProfiles
    const profile = await profilesCol.findOne(
      { wallet: { $regex: new RegExp('^' + trader.wallet.replace('0x', '0x'), 'i') } },
      { projection: { recentHighConvictionTrades: 1 } }
    );

    const trades: HighConvictionTrade[] = profile?.recentHighConvictionTrades ?? [];
    if (trades.length === 0) continue;

    // Group by market title (case-insensitive key)
    const grouped = new Map<string, HighConvictionTrade[]>();
    for (const trade of trades) {
      // Only buy-side trades for signal generation
      if (trade.side && trade.side !== 'BUY' && trade.side !== 'UNKNOWN') continue;
      const key = trade.market.toLowerCase();
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(trade);
    }

    const traderSignals: string[] = [];
    const priceMin = trader.price_range_min ?? 0;
    const priceMax = trader.price_range_max ?? 1;
    const strengthMarkets = trader.strength_markets ?? [];

    for (const [, entries] of grouped) {
      if (entries.length === 0) continue;

      // Group by outcome as well
      const outcomeMap = new Map<string, HighConvictionTrade[]>();
      for (const e of entries) {
        const ok = e.outcome.toLowerCase();
        if (!outcomeMap.has(ok)) outcomeMap.set(ok, []);
        outcomeMap.get(ok)!.push(e);
      }

      for (const [, outcomeEntries] of outcomeMap) {
        const marketTitle = outcomeEntries[0].market;
        const outcome     = outcomeEntries[0].outcome;

        // Weighted avg entry price
        const totalSize  = outcomeEntries.reduce((s, t) => s + t.usdcSize, 0);
        const weightedPrice = outcomeEntries.reduce((s, t) => s + t.price * t.usdcSize, 0) / totalSize;
        const timestamps  = outcomeEntries.map(t => new Date(t.timestamp));
        const firstEntry  = new Date(Math.min(...timestamps.map(d => d.getTime())));
        const lastEntry   = new Date(Math.max(...timestamps.map(d => d.getTime())));

        // ── SIGNAL FILTERS ───────────────────────────────────────────────────

        // 1. Category must match strength_markets
        const category  = categorizeMarket(marketTitle);
        const subLeague = detectSubLeague(marketTitle, category);
        if (!matchesStrengthMarkets(strengthMarkets, category, subLeague)) continue;

        // 2. Avg entry price within trader's price range
        if (weightedPrice < priceMin || weightedPrice > priceMax) continue;

        // 3. Must have entry within last 14 days
        if (lastEntry < fourteenDaysAgo) continue;

        // ── MARKET VALIDITY CHECK ────────────────────────────────────────────
        const { open, verified } = await isMarketOpen(marketTitle);
        if (!open) continue;

        await sleep(100); // 100ms between Gamma API calls

        // ── BUILD SIGNAL ─────────────────────────────────────────────────────
        const marketSlug = slugify(marketTitle);
        const signalId   = `${trader.wallet.slice(2, 10)}-${marketSlug.slice(0, 20)}-${Date.now()}`;
        const traderName = trader.display_name || trader.pseudonym || 'Unknown';

        const signalDoc = {
          signal_id: signalId,
          trader_wallet: trader.wallet,
          trader_name: traderName,
          trader_edge_type: trader.edge_type,
          trader_edge_confidence: trader.edge_confidence,
          trader_rank_score: trader.rank_score,
          trader_insider_probability: trader.insider_probability,
          market_title:   marketTitle,
          market_slug:    marketSlug,
          outcome,
          category,
          sub_league: subLeague,

          // Position aggregate
          total_size_deployed: totalSize,
          entry_count:         outcomeEntries.length,
          avg_entry_price:     weightedPrice,
          first_entry_at:      firstEntry,
          last_entry_at:       lastEntry,

          // From LLM profile
          price_range_min: priceMin,
          price_range_max: priceMax,
          follow_rules:    trader.follow_rules ?? null,
          strength_match:  true,
          market_verified: verified,

          // Status
          status:     'active',
          created_at: new Date(),

          // Trader agent fills these
          executed:           false,
          executed_at:        null,
          execution_price:    null,
          execution_size_usdc: null,
          execution_outcome:  null,
        };

        // Upsert on { trader_wallet, market_title, outcome }
        await signalsCol.updateOne(
          { trader_wallet: trader.wallet, market_title: marketTitle, outcome },
          { $set: signalDoc },
          { upsert: true }
        );

        traderSignals.push(signalId);
        totalSignals++;

        console.log(
          `  SIGNAL [${trader.edge_type}] ${traderName} → ` +
          `${marketTitle.slice(0, 50)} | ${outcome} @ ${weightedPrice.toFixed(2)} | ` +
          `${outcomeEntries.length} entries | $${totalSize.toFixed(0)}`
        );
      }
    }

    // Update signal count on ahf-alphaTraders
    if (traderSignals.length > 0) {
      const sigCount = await signalsCol.countDocuments({ trader_wallet: trader.wallet });
      const latestSig = await signalsCol
        .find({ trader_wallet: trader.wallet })
        .sort({ created_at: -1 })
        .limit(1)
        .toArray();

      await alphaCol.updateOne(
        { wallet: trader.wallet },
        {
          $set: {
            signal_count:   sigCount,
            last_signal_at: latestSig[0]?.created_at ?? new Date(),
          },
        }
      );
      processedTraders++;
    }
  }

  console.log(`\n  Generated ${totalSignals} signals from ${processedTraders} traders`);
  return { generated: totalSignals, traders: processedTraders };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));
  console.log(`Connected → db: ${extractDbName(mongoUri)}\n`);

  try {
    await generateSignals(db);
  } finally {
    await client.close();
  }
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
