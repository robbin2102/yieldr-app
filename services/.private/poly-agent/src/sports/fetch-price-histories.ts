/**
 * Pass 1B: Fetch Price Histories for Sports Markets
 *
 * For each market in `sportMarkets`, pulls minute-level price history
 * from CLOB API and stores in `sportPriceHistory` collection.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/fetch-price-histories.ts
 *
 * Options:
 *   --limit=50    Process only first N markets without history
 *   --force       Re-fetch even if history exists
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.local'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

if (!process.env.MONGODB_URI) { console.error('Fatal: MONGODB_URI not set'); process.exit(1); }

const CLOB_API = 'https://clob.polymarket.com';
const RATE_LIMIT_MS = 300;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const FETCH_LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 100;
const FORCE = args.includes('--force');

async function fetchPriceHistory(tokenId: string, endTs?: number): Promise<{ t: number; p: number }[]> {
  try {
    // Fetch last 24 hours of history before market end
    const end = endTs || Math.floor(Date.now() / 1000);
    const start = end - 86400; // 24 hours before close

    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${start}&endTs=${end}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: { t: number; p: number }[] };
    return data.history || [];
  } catch { return []; }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Price Histories — Sports Markets               ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  const marketsCol = db.collection('sportMarkets');
  const historyCol = db.collection('sportPriceHistory');

  await historyCol.createIndex({ conditionId: 1 }, { unique: true });

  const totalMarkets = await marketsCol.countDocuments();
  const existingHistories = await historyCol.countDocuments();
  console.log(`  Markets in DB: ${totalMarkets}`);
  console.log(`  Histories already fetched: ${existingHistories}`);
  console.log(`  Fetch limit: ${FETCH_LIMIT} | Force: ${FORCE}\n`);

  // Find markets without price history
  const existingIds = FORCE ? new Set<string>() : new Set(
    (await historyCol.find({}, { projection: { conditionId: 1 } }).toArray()).map(h => h.conditionId)
  );

  const markets = await marketsCol.find({}).toArray();
  const toFetch = markets.filter(m => !existingIds.has(m.conditionId)).slice(0, FETCH_LIMIT);

  console.log(`  Markets to fetch: ${toFetch.length}\n`);

  let fetched = 0;
  let skipped = 0;
  let errors = 0;

  for (const market of toFetch) {
    const tokenIds = market.tokenIds || [];
    if (tokenIds.length < 2) { skipped++; continue; }

    const endTs = market.endDate ? Math.floor(new Date(market.endDate).getTime() / 1000) : undefined;

    // Fetch price history for the YES/first outcome token
    const yesHistory = await fetchPriceHistory(tokenIds[0], endTs);
    await sleep(RATE_LIMIT_MS);

    if (yesHistory.length === 0) {
      // Try second token
      const noHistory = await fetchPriceHistory(tokenIds[1], endTs);
      await sleep(RATE_LIMIT_MS);

      if (noHistory.length === 0) {
        errors++;
        if (errors % 10 === 0) console.log(`  [${fetched}/${toFetch.length}] ${errors} errors so far`);
        continue;
      }

      // Invert No prices to get Yes prices
      const invertedHistory = noHistory.map(p => ({ t: p.t, p: Math.round((1 - p.p) * 1000) / 1000 }));
      await storeHistory(historyCol, market, invertedHistory, 'inverted');
      fetched++;
    } else {
      await storeHistory(historyCol, market, yesHistory, 'direct');
      fetched++;
    }

    if (fetched % 10 === 0) {
      console.log(`  [${fetched}/${toFetch.length}] Fetched | ${errors} errors | ${market.question?.slice(0, 50)}`);
    }
  }

  const finalCount = await historyCol.countDocuments();
  console.log(`\n  Done! Fetched: ${fetched} | Errors: ${errors} | Skipped: ${skipped}`);
  console.log(`  Total histories in DB: ${finalCount}\n`);

  await client.close();
}

async function storeHistory(
  col: any,
  market: any,
  history: { t: number; p: number }[],
  source: string
) {
  // Sort by timestamp
  history.sort((a, b) => a.t - b.t);

  // Compute basic stats
  const endTs = market.endDate ? Math.floor(new Date(market.endDate).getTime() / 1000) : (history[history.length - 1]?.t || 0);
  const durationMins = history.length > 1
    ? Math.round((history[history.length - 1].t - history[0].t) / 60)
    : 0;

  // Convert to time series with minutesBeforeClose
  const timeSeries = history.map(p => ({
    t: p.t,
    p: p.p,
    minsBeforeClose: Math.round((endTs - p.t) / 60),
  }));

  await col.updateOne(
    { conditionId: market.conditionId },
    {
      $set: {
        conditionId: market.conditionId,
        slug: market.slug,
        question: market.question,
        outcomes: market.outcomes,
        winner: market.winner,
        winnerIndex: market.winnerIndex,
        endDate: market.endDate,
        volume: market.volume,
        tag: market.tag,
        source,
        dataPoints: timeSeries.length,
        durationMins,
        timeSeries,
        fetchedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
