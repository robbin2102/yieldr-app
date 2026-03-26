/**
 * Live BTC 5m Market Data Collector
 *
 * Fetches a live/recent BTC 5m market's top holders (10 per side),
 * then fetches their activities (up to 10k per wallet) for strategy
 * analysis and backtesting.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/fetch-live-btc5m-data.ts <market_slug>
 *   npx tsx scripts/ai-hedge-fund/fetch-live-btc5m-data.ts btc-updown-5m-1774505100
 *
 * Options:
 *   --holders-per-side N   Top N holders per outcome (default: 10)
 *   --activities-per-wallet N  Max activities per wallet (default: 7000)
 *   --days N               Activity lookback days (default: 7)
 *
 * Saves to: polyMarket5mLiveData collection
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (result.parsed && result.parsed.MONGODB_URI) break;
}

const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── CLI Args ──────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const slug = ARGS.find(a => !a.startsWith('--')) || '';
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};

const HOLDERS_PER_SIDE = parseInt(OPT('holders-per-side', '10'));
const ACTIVITIES_PER_WALLET = parseInt(OPT('activities-per-wallet', '7000'));
const LOOKBACK_DAYS = parseInt(OPT('days', '7'));

// Direct wallet list — skip holders API entirely for BTC 5m markets
// Pass via --wallets "0x...,0x...,0x..." or leave empty to try holders API
const DIRECT_WALLETS = OPT('wallets', '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);

// ── Fetch Market from Gamma ───────────────────────────────────
async function fetchMarketFromGamma(slug: string) {
  const url = `${GAMMA_API}/events?slug=${slug}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma API ${res.status} for ${slug}`);
  const events = await res.json() as any[];
  if (!events?.[0]?.markets?.[0]) throw new Error(`No market found for slug ${slug}`);

  const event = events[0];
  const market = event.markets[0];

  let clobTokenIds: string[] = [];
  try {
    clobTokenIds = JSON.parse(market.clobTokenIds);
  } catch {
    clobTokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  let outcomes: string[] = [];
  try {
    outcomes = JSON.parse(market.outcomes);
  } catch {
    outcomes = (market.outcomes || 'Up,Down').split(',').map((s: string) => s.trim());
  }

  return {
    conditionId: market.conditionId,
    slug: market.slug || slug,
    question: market.question,
    priceToBeat: event.eventMetadata?.priceToBeat || 0,
    eventStartTime: event.eventStartTime || market.startDate,
    endDate: market.endDate || event.endDate,
    clobTokenIds,
    outcomes,
    volume: parseFloat(market.volume || '0'),
    bestBid: parseFloat(market.bestBid || '0'),
    bestAsk: parseFloat(market.bestAsk || '0'),
  };
}

// ── Fetch Holders ─────────────────────────────────────────────
async function fetchHolders(conditionId: string): Promise<{ token: string; holders: any[] }[]> {
  const url = `${DATA_API}/holders?conditionId=${conditionId}&limit=20`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Holders API ${res.status} for ${conditionId}`);
    return [];
  }
  return await res.json() as any[];
}

// ── Fetch Activities with Cursor Pagination ───────────────────
async function fetchActivities(wallet: string, days: number, maxActivities: number): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 3000;

  let all: any[] = [];
  let currentEndTs = now;
  let cursorRound = 0;

  while (currentEndTs > startTs && cursorRound < 20 && all.length < maxActivities) {
    let offset = 0;
    let done = false;

    while (!done && offset <= MAX_OFFSET && all.length < maxActivities) {
      const url = `${DATA_API}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&startTs=${startTs}&endTs=${currentEndTs}&sortBy=TIMESTAMP&sortDirection=DESC`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 400 && all.length > 0) { done = true; break; }
        if (res.status === 400) return all;
        throw new Error(`API ${res.status}`);
      }
      const batch = await res.json() as any[];
      if (batch.length === 0) { done = true; break; }

      for (const a of batch) {
        if (a.timestamp >= startTs && all.length < maxActivities) all.push(a);
        else { done = true; break; }
      }
      if (batch.length < LIMIT) { done = true; break; }
      offset += LIMIT;
      await sleep(100);
    }

    if (!done && all.length > 0 && all.length < maxActivities) {
      const oldestTs = all[all.length - 1].timestamp;
      if (oldestTs >= currentEndTs) break;
      currentEndTs = oldestTs - 1;
      cursorRound++;
    } else break;
  }

  return all;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  if (!slug && DIRECT_WALLETS.length === 0) {
    console.log('Usage: npx tsx scripts/ai-hedge-fund/fetch-live-btc5m-data.ts <market_slug> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --wallets "0x...,0x..."   Direct wallet list (skip holders API)');
    console.log('  --holders-per-side N      Top N holders per outcome (default: 10)');
    console.log('  --activities-per-wallet N Max activities per wallet (default: 7000)');
    console.log('  --days N                 Lookback days (default: 7)');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx fetch-live-btc5m-data.ts btc-updown-5m-1774505100 --wallets "0x2d8b...,0xabc..."');
    console.log('  npx tsx fetch-live-btc5m-data.ts --wallets "0x2d8b..." --days 3');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   BTC 5m Live Market Data Collector                   ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Slug:                ${slug}`);
  console.log(`  Holders per side:    ${HOLDERS_PER_SIDE}`);
  console.log(`  Activities/wallet:   ${ACTIVITIES_PER_WALLET}`);
  console.log(`  Lookback days:       ${LOOKBACK_DAYS}`);

  // 1. Fetch market data (optional — skip if only fetching wallet activities)
  let market = { conditionId: '', slug: slug || 'direct-wallets', question: 'Direct wallet fetch', priceToBeat: 0, eventStartTime: '', endDate: '', clobTokenIds: [] as string[], outcomes: ['Up', 'Down'], volume: 0, bestBid: 0, bestAsk: 0 };
  if (slug) {
    console.log('\n[1] Fetching market from Gamma API...');
    market = await fetchMarketFromGamma(slug);
    console.log(`  Question: ${market.question}`);
    console.log(`  Price to beat: $${market.priceToBeat}`);
    console.log(`  Volume: $${market.volume.toFixed(0)}`);
    console.log(`  Outcomes: ${market.outcomes.join(', ')}`);
  } else {
    console.log('\n[1] No slug provided — fetching wallet activities only');
  }

  // 2. Get wallets — direct list or from holders API
  let wallets: string[];
  const holdersByOutcome: Record<string, { wallet: string; amount: number; outcome: string }[]> = {};

  if (DIRECT_WALLETS.length > 0) {
    console.log(`\n[2] Using ${DIRECT_WALLETS.length} direct wallets (skipping holders API)`);
    wallets = DIRECT_WALLETS;
    wallets.forEach(w => console.log(`  ${w}`));
  } else {
    console.log('\n[2] Fetching top holders...');
    const holderData = await fetchHolders(market.conditionId);

    const walletSet = new Set<string>();

    for (let i = 0; i < holderData.length; i++) {
      const th = holderData[i];
      const tokenIdx = market.clobTokenIds.indexOf(th.token);
      const outcome = tokenIdx >= 0 && tokenIdx < market.outcomes.length ? market.outcomes[tokenIdx] : `Token${i}`;

      const holders = (th.holders || [])
        .sort((a: any, b: any) => (b.amount || 0) - (a.amount || 0))
        .slice(0, HOLDERS_PER_SIDE);

      holdersByOutcome[outcome] = holders.map((h: any) => ({
        wallet: h.proxyWallet?.toLowerCase(),
        amount: h.amount || 0,
        outcome,
      }));

      for (const h of holders) {
        if (h.proxyWallet) walletSet.add(h.proxyWallet.toLowerCase());
      }

      console.log(`  ${outcome}: ${holders.length} holders (top: $${holders[0]?.amount?.toFixed(0) || 0})`);
    }

    wallets = [...walletSet];
    if (wallets.length === 0) {
      console.log('  No holders found — pass --wallets "0x...,0x..." to provide wallets directly');
    }
  }
  console.log(`  Total wallets: ${wallets.length}`);

  // 3. Connect to MongoDB
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  const collection = db.collection('polyMarket5mLiveData');
  await collection.createIndex({ slug: 1 });
  await collection.createIndex({ 'walletActivities.wallet': 1 });

  // 4. Fetch activities for each wallet
  console.log(`\n[3] Fetching activities for ${wallets.length} wallets (${LOOKBACK_DAYS}d, max ${ACTIVITIES_PER_WALLET} each)...`);

  const walletActivities: { wallet: string; activities: any[]; activityCount: number; periodStart: Date | null; periodEnd: Date | null }[] = [];
  let totalActivities = 0;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    process.stdout.write(`  [${i + 1}/${wallets.length}] ${w.slice(0, 10)}... `);

    try {
      const acts = await fetchActivities(w, LOOKBACK_DAYS, ACTIVITIES_PER_WALLET);
      totalActivities += acts.length;

      const timestamps = acts.map((a: any) => a.timestamp).filter(Boolean);
      const periodStart = timestamps.length > 0 ? new Date(Math.min(...timestamps) * 1000) : null;
      const periodEnd = timestamps.length > 0 ? new Date(Math.max(...timestamps) * 1000) : null;

      walletActivities.push({ wallet: w, activities: acts, activityCount: acts.length, periodStart, periodEnd });
      console.log(`${acts.length} activities (${periodStart?.toISOString().split('T')[0] || '?'} to ${periodEnd?.toISOString().split('T')[0] || '?'})`);
    } catch (err: any) {
      console.log(`ERROR: ${err.message}`);
      walletActivities.push({ wallet: w, activities: [], activityCount: 0, periodStart: null, periodEnd: null });
    }

    await sleep(200);
  }

  console.log(`\n  Total activities collected: ${totalActivities}`);

  // 5. Save to MongoDB
  console.log('\n[4] Saving to MongoDB (polyMarket5mLiveData)...');

  const document = {
    slug: market.slug,
    conditionId: market.conditionId,
    question: market.question,
    priceToBeat: market.priceToBeat,
    eventStartTime: market.eventStartTime,
    endDate: market.endDate,
    volume: market.volume,
    outcomes: market.outcomes,
    clobTokenIds: market.clobTokenIds,
    holdersByOutcome,
    walletActivities: walletActivities.map(wa => ({
      wallet: wa.wallet,
      activityCount: wa.activityCount,
      periodStart: wa.periodStart,
      periodEnd: wa.periodEnd,
      activities: wa.activities,
    })),
    totalActivities,
    fetchedAt: new Date(),
    lookbackDays: LOOKBACK_DAYS,
  };

  await collection.updateOne(
    { slug: market.slug },
    { $set: document },
    { upsert: true }
  );

  console.log(`  Saved: ${market.slug} (${totalActivities} activities across ${wallets.length} wallets)`);

  // 6. Quick summary of BTC 5m activity distribution
  console.log('\n[5] Quick BTC 5m Activity Summary:');
  const btc5mPattern = /bitcoin up or down/i;
  for (const wa of walletActivities) {
    const btcActs = wa.activities.filter((a: any) => btc5mPattern.test(a.title || ''));
    const buys = btcActs.filter((a: any) => a.type === 'TRADE' && a.side === 'BUY');
    const totalUsdc = buys.reduce((s: number, a: any) => s + (a.usdcSize || 0), 0);
    if (btcActs.length > 0) {
      console.log(`  ${wa.wallet.slice(0, 10)}... | ${btcActs.length} BTC 5m acts | ${buys.length} buys | $${totalUsdc.toFixed(0)} USDC`);
    }
  }

  await client.close();
  console.log('\nDone.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
