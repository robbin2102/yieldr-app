/**
 * AI Hedge Fund — Fetch BTC 5-Minute Markets
 *
 * Fetches BTC 5-minute markets from the Polymarket Gamma API,
 * saves market data, holder snapshots, and aggregated top traders
 * to MongoDB.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/fetch-btc-5m-markets.ts
 *   npx tsx scripts/ai-hedge-fund/fetch-btc-5m-markets.ts --days=7
 *   npx tsx scripts/ai-hedge-fund/fetch-btc-5m-markets.ts --skip-holders --skip-traders
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Db } from 'mongodb';

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

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CANDLE_INTERVAL = 300; // 5 minutes in seconds
const CANDLES_PER_DAY = 288; // 24 * 60 / 5
const GAMMA_RATE_LIMIT_MS = 300;
const DATA_RATE_LIMIT_MS = 100;
const CONCURRENCY = 5;
const TOP_TRADERS_LIMIT = 100;
const HOLDERS_LIMIT = 20;

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface GammaMarket {
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string | string[];
  clobTokenIds: string | string[];
  endDate: string;
  volume: string;
  volumeNum: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  active: boolean;
  closed: boolean;
  resolved: boolean;
}

interface GammaEvent {
  id: string;
  slug: string;
  markets: GammaMarket[];
  eventMetadata?: {
    priceToBeat?: number;
  };
  eventStartTime?: string;
  endDate?: string;
}

interface HolderEntry {
  proxyWallet: string;
  name: string;
  amount: number;
  profileImage: string;
}

interface TokenHolders {
  token: string;
  holders: HolderEntry[];
}

interface CLIArgs {
  days: number;
  skipHolders: boolean;
  skipTraders: boolean;
}

// ═══════════════════════════════════════════════════════════════
// CLI Argument Parsing
// ═══════════════════════════════════════════════════════════════

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  let days = 14;
  let skipHolders = false;
  let skipTraders = false;

  for (const arg of args) {
    if (arg.startsWith('--days=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (!isNaN(val) && val > 0) days = val;
    } else if (arg === '--skip-holders') {
      skipHolders = true;
    } else if (arg === '--skip-traders') {
      skipTraders = true;
    }
  }

  return { days, skipHolders, skipTraders };
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}m`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(0)}k`;
  return `$${vol.toFixed(0)}`;
}

/**
 * Parse clobTokenIds which may be a JSON string array, a comma-separated
 * string, or an actual array.
 */
function parseClobTokenIds(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];

  // Try JSON parse first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Not JSON — fall through to comma-split
  }

  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse outcomes which may be a JSON string array or actual array.
 */
function parseOutcomes(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Not JSON
  }

  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Generate all deterministic slugs for the last N days.
 * Each slug is `btc-updown-5m-{unix_ts}` in 300-second increments.
 */
function generateSlugs(days: number): string[] {
  const now = Math.floor(Date.now() / 1000);
  // Align to the most recent 5-minute boundary
  const currentBoundary = now - (now % CANDLE_INTERVAL);
  const startTs = currentBoundary - days * 24 * 60 * 60;
  const slugs: string[] = [];

  for (let ts = startTs; ts <= currentBoundary; ts += CANDLE_INTERVAL) {
    slugs.push(`btc-updown-5m-${ts}`);
  }

  return slugs;
}

// ═══════════════════════════════════════════════════════════════
// API Fetchers
// ═══════════════════════════════════════════════════════════════

async function fetchGammaEvent(slug: string): Promise<GammaEvent | null> {
  const url = `${GAMMA_API}/events?slug=${slug}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`  [WARN] Gamma API ${res.status} for ${slug}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data[0] as GammaEvent;
  } catch (err: any) {
    console.warn(`  [WARN] Gamma API error for ${slug}: ${err.message}`);
    return null;
  }
}

async function fetchHolders(conditionId: string): Promise<TokenHolders[]> {
  const url = `${DATA_API}/holders?conditionId=${conditionId}&limit=${HOLDERS_LIMIT}`;
  try {
    const res = await fetch(url);
    if (res.status === 404) return [];
    if (!res.ok) {
      console.warn(`  [WARN] Data API ${res.status} for holders conditionId=${conditionId}`);
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data as TokenHolders[];
  } catch (err: any) {
    console.warn(`  [WARN] Data API error for holders conditionId=${conditionId}: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// MongoDB Operations
// ═══════════════════════════════════════════════════════════════

async function ensureIndexes(db: Db): Promise<void> {
  const markets = db.collection('polyMarket5m');
  const holders = db.collection('polyMarket5mHolders');
  const traders = db.collection('polyMarket5mTopTraders');

  await Promise.all([
    markets.createIndex({ slug: 1 }, { unique: true }),
    markets.createIndex({ conditionId: 1 }),
    holders.createIndex({ conditionId: 1 }),
    holders.createIndex({ conditionId: 1, tokenId: 1 }, { unique: true }),
    holders.createIndex({ 'holders.proxyWallet': 1 }),
    traders.createIndex({ wallet: 1 }, { unique: true }),
    traders.createIndex({ totalUsdcVolume: -1 }),
  ]);

  console.log('[DB] Indexes ensured on polyMarket5m, polyMarket5mHolders, polyMarket5mTopTraders');
}

async function upsertMarket(db: Db, doc: Record<string, any>): Promise<void> {
  await db.collection('polyMarket5m').updateOne(
    { slug: doc.slug },
    { $set: doc },
    { upsert: true },
  );
}

async function upsertHolderDoc(db: Db, doc: Record<string, any>): Promise<void> {
  await db.collection('polyMarket5mHolders').updateOne(
    { conditionId: doc.conditionId, tokenId: doc.tokenId },
    { $set: doc },
    { upsert: true },
  );
}

async function markHoldersIndexed(db: Db, slug: string): Promise<void> {
  await db.collection('polyMarket5m').updateOne(
    { slug },
    { $set: { holdersIndexed: true } },
  );
}

// ═══════════════════════════════════════════════════════════════
// Core Processing
// ═══════════════════════════════════════════════════════════════

async function processMarket(
  db: Db,
  slug: string,
  index: number,
  total: number,
  skipHolders: boolean,
): Promise<void> {
  const event = await fetchGammaEvent(slug);
  if (!event || !event.markets || event.markets.length === 0) {
    console.log(`  [${index + 1}/${total}] ${slug} | not found — skipped`);
    return;
  }

  const market = event.markets[0];
  const outcomes = parseOutcomes(market.outcomes);
  const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
  const priceToBeat = event.eventMetadata?.priceToBeat ?? 0;
  const volumeNum = typeof market.volumeNum === 'number' ? market.volumeNum : parseFloat(String(market.volumeNum)) || 0;

  const marketDoc = {
    slug: market.slug || slug,
    conditionId: market.conditionId,
    eventId: event.id,
    question: market.question,
    priceToBeat,
    eventStartTime: event.eventStartTime ? new Date(event.eventStartTime) : null,
    endDate: market.endDate ? new Date(market.endDate) : null,
    outcomes,
    clobTokenIds,
    volume: parseFloat(String(market.volume)) || 0,
    volumeNum,
    bestBid: typeof market.bestBid === 'number' ? market.bestBid : parseFloat(String(market.bestBid)) || 0,
    bestAsk: typeof market.bestAsk === 'number' ? market.bestAsk : parseFloat(String(market.bestAsk)) || 0,
    lastTradePrice: typeof market.lastTradePrice === 'number' ? market.lastTradePrice : parseFloat(String(market.lastTradePrice)) || 0,
    active: Boolean(market.active),
    closed: Boolean(market.closed),
    resolved: Boolean(market.resolved),
    holdersIndexed: false,
    fetchedAt: new Date(),
  };

  await upsertMarket(db, marketDoc);

  let holderCount = 0;

  if (!skipHolders && market.conditionId) {
    await sleep(DATA_RATE_LIMIT_MS);
    const tokenHolders = await fetchHolders(market.conditionId);

    for (const th of tokenHolders) {
      const tokenIndex = clobTokenIds.indexOf(th.token);
      const outcome = tokenIndex >= 0 && tokenIndex < outcomes.length
        ? outcomes[tokenIndex]
        : 'Unknown';

      const holders: HolderEntry[] = (th.holders || []).map((h: any) => ({
        proxyWallet: h.proxyWallet || h.wallet || '',
        name: h.name || '',
        amount: typeof h.amount === 'number' ? h.amount : parseFloat(String(h.amount)) || 0,
        profileImage: h.profileImage || '',
      }));

      holderCount += holders.length;

      const totalAmount = holders.reduce((sum, h) => sum + h.amount, 0);
      const topHolder = holders.length > 0
        ? holders.reduce((max, h) => (h.amount > max.amount ? h : max), holders[0])
        : null;

      const holderDoc = {
        conditionId: market.conditionId,
        tokenId: th.token,
        outcome,
        outcomeIndex: tokenIndex,
        marketSlug: marketDoc.slug,
        marketQuestion: market.question,
        marketEndDate: marketDoc.endDate,
        priceToBeat,
        holders,
        totalHolders: holders.length,
        totalAmount,
        topHolderAmount: topHolder?.amount ?? 0,
        topHolderWallet: topHolder?.proxyWallet ?? '',
        fetchedAt: new Date(),
      };

      await upsertHolderDoc(db, holderDoc);
    }

    await markHoldersIndexed(db, marketDoc.slug);
  }

  console.log(
    `  [${index + 1}/${total}] ${slug} | vol: ${formatVolume(volumeNum)}` +
    (skipHolders ? '' : ` | holders: ${holderCount}`),
  );
}

/**
 * Process slugs in batches with concurrency control and rate limiting.
 */
async function processAllMarkets(
  db: Db,
  slugs: string[],
  skipHolders: boolean,
): Promise<void> {
  const total = slugs.length;
  let processed = 0;

  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch = slugs.slice(i, i + CONCURRENCY);
    const promises = batch.map((slug, batchIdx) =>
      processMarket(db, slug, i + batchIdx, total, skipHolders),
    );

    await Promise.all(promises);
    processed += batch.length;

    // Rate limit: wait between batches
    if (i + CONCURRENCY < total) {
      await sleep(GAMMA_RATE_LIMIT_MS);
    }
  }

  console.log(`\n[DONE] Processed ${processed} slugs.`);
}

/**
 * Aggregate unique wallets across all polyMarket5mHolders, rank by total
 * USDC volume, save top 100 to polyMarket5mTopTraders.
 */
async function aggregateTopTraders(db: Db): Promise<void> {
  console.log('\n[TRADERS] Aggregating top traders across all 5m markets...');

  const pipeline = [
    { $unwind: '$holders' },
    {
      $group: {
        _id: '$holders.proxyWallet',
        totalUsdcVolume: { $sum: '$holders.amount' },
        marketCount: { $addToSet: '$conditionId' },
        avgHolding: { $avg: '$holders.amount' },
        maxHolding: { $max: '$holders.amount' },
        firstSeen: { $min: '$marketEndDate' },
        lastSeen: { $max: '$marketEndDate' },
      },
    },
    {
      $project: {
        _id: 0,
        wallet: '$_id',
        totalUsdcVolume: 1,
        marketCount: { $size: '$marketCount' },
        avgHolding: { $round: ['$avgHolding', 2] },
        maxHolding: { $round: ['$maxHolding', 2] },
        firstSeen: 1,
        lastSeen: 1,
      },
    },
    { $sort: { totalUsdcVolume: -1 as const } },
    { $limit: TOP_TRADERS_LIMIT },
  ];

  const results = await db.collection('polyMarket5mHolders').aggregate(pipeline).toArray();

  if (results.length === 0) {
    console.log('[TRADERS] No holder data found — skipping top trader aggregation.');
    return;
  }

  const now = new Date();
  const tradersCollection = db.collection('polyMarket5mTopTraders');

  // Clear existing top traders and replace with fresh aggregation
  await tradersCollection.deleteMany({});

  const docs = results.map((r) => ({
    wallet: r.wallet,
    totalUsdcVolume: r.totalUsdcVolume,
    marketCount: r.marketCount,
    avgHolding: r.avgHolding,
    maxHolding: r.maxHolding,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    fetchedAt: now,
  }));

  await tradersCollection.insertMany(docs);
  console.log(`[TRADERS] Saved ${docs.length} top traders to polyMarket5mTopTraders.`);

  // Print top 10 for visibility
  console.log('\n  Top 10 traders by USDC volume:');
  for (let i = 0; i < Math.min(10, docs.length); i++) {
    const t = docs[i];
    console.log(
      `    ${i + 1}. ${t.wallet.slice(0, 10)}... | ${formatVolume(t.totalUsdcVolume)} | ${t.marketCount} markets`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║   BTC 5-Minute Markets Fetcher                       ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Days:          ${args.days}`);
  console.log(`  Skip holders:  ${args.skipHolders}`);
  console.log(`  Skip traders:  ${args.skipTraders}`);

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('[FATAL] MONGODB_URI not found in environment. Check .env.local or .env');
    process.exit(1);
  }

  const slugs = generateSlugs(args.days);
  console.log(`  Total slugs:   ${slugs.length} (${args.days} days x ${CANDLES_PER_DAY}/day)\n`);

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    console.log('[DB] Connected to MongoDB.\n');

    const db = client.db();
    await ensureIndexes(db);

    // Phase 1: Fetch markets (and optionally holders)
    console.log('\n[PHASE 1] Fetching markets from Gamma API...\n');
    await processAllMarkets(db, slugs, args.skipHolders);

    // Phase 2: Aggregate top traders
    if (!args.skipTraders && !args.skipHolders) {
      console.log('\n[PHASE 2] Aggregating top traders...');
      await aggregateTopTraders(db);
    } else if (args.skipTraders) {
      console.log('\n[PHASE 2] Skipped top trader aggregation (--skip-traders).');
    } else if (args.skipHolders) {
      console.log('\n[PHASE 2] Skipped top trader aggregation (no holder data fetched).');
    }

    // Summary
    const marketCount = await db.collection('polyMarket5m').countDocuments();
    const holderDocCount = await db.collection('polyMarket5mHolders').countDocuments();
    const traderCount = await db.collection('polyMarket5mTopTraders').countDocuments();

    console.log('\n══════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('══════════════════════════════════════════════════');
    console.log(`  polyMarket5m:           ${marketCount} documents`);
    console.log(`  polyMarket5mHolders:    ${holderDocCount} documents`);
    console.log(`  polyMarket5mTopTraders: ${traderCount} documents`);
    console.log('══════════════════════════════════════════════════\n');
  } catch (err: any) {
    console.error(`[FATAL] ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await client.close();
    console.log('[DB] Disconnected from MongoDB.');
  }
}

main();
