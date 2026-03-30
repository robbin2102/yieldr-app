/**
 * Pass 1B: Fetch Price Histories for Sports Markets
 *
 * For each market in `sportMarkets`, pulls 1-minute price history
 * from CLOB API (last 6 hours before resolution). Stores in
 * `sportPriceHistory` collection.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/fetch-price-histories.ts
 *   npx tsx services/.private/poly-agent/src/sports/fetch-price-histories.ts --limit=200
 *   npx tsx services/.private/poly-agent/src/sports/fetch-price-histories.ts --force
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
const FETCH_LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : 500;
const FORCE = args.includes('--force');

// Data quality thresholds
const MIN_POINTS_2HR = 20;   // minimum data points in last 2 hours
const MIN_POINTS_30MIN = 10; // minimum data points in last 30 minutes

interface ErrorCategory {
  noTokens: number;
  noEndDate: number;
  emptyHistory: number;
  apiError: number;
  belowQuality: number;
}

async function fetchPriceHistory(tokenId: string, endTs: number): Promise<{ t: number; p: number }[]> {
  try {
    const start = endTs - 21600; // 6 hours before close
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${start}&endTs=${endTs}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: { t: number; p: number }[] };
    return data.history || [];
  } catch { return []; }
}

function checkQuality(
  history: { t: number; p: number; minsBeforeClose: number }[],
): { passes: boolean; pts2hr: number; pts30min: number } {
  const pts2hr = history.filter(p => p.minsBeforeClose <= 120).length;
  const pts30min = history.filter(p => p.minsBeforeClose <= 30).length;
  return {
    passes: pts2hr >= MIN_POINTS_2HR && pts30min >= MIN_POINTS_30MIN,
    pts2hr,
    pts30min,
  };
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Price Histories — 1min Resolution              ║');
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
  console.log(`  DB: ${dbName}`);
  console.log(`  Markets in DB: ${totalMarkets}`);
  console.log(`  Histories already fetched: ${existingHistories}`);
  console.log(`  Fetch limit: ${FETCH_LIMIT} | Force: ${FORCE}`);
  console.log(`  Quality gate: ≥${MIN_POINTS_2HR} pts in 2hr, ≥${MIN_POINTS_30MIN} pts in 30min\n`);

  const existingIds = FORCE ? new Set<string>() : new Set(
    (await historyCol.find({}, { projection: { conditionId: 1 } }).toArray()).map(h => h.conditionId)
  );

  // Sort by most recent, prioritize high volume
  const sportFilter = args.includes('--nba') ? { sport: 'nba' } : {};
  const markets = await marketsCol.find(sportFilter).sort({ endDate: -1, volume: -1 }).toArray();
  const toFetch = markets.filter(m => !existingIds.has(m.conditionId)).slice(0, FETCH_LIMIT);

  console.log(`  Sport filter: ${args.includes('--nba') ? 'NBA only' : 'all'}`);
  console.log(`  Markets to fetch: ${toFetch.length}\n`);

  let fetched = 0;
  let passedQuality = 0;
  const errors: ErrorCategory = { noTokens: 0, noEndDate: 0, emptyHistory: 0, apiError: 0, belowQuality: 0 };

  for (const market of toFetch) {
    const tokenIds = market.tokenIds || [];
    if (tokenIds.length < 2 || !tokenIds[0]) {
      errors.noTokens++;
      continue;
    }

    const endDate = market.endDate;
    if (!endDate) { errors.noEndDate++; continue; }
    const endTs = Math.floor(new Date(endDate).getTime() / 1000);
    if (isNaN(endTs) || endTs <= 0) { errors.noEndDate++; continue; }

    // Try YES token first, then NO token
    let history = await fetchPriceHistory(tokenIds[0], endTs);
    await sleep(RATE_LIMIT_MS);

    if (history.length === 0 && tokenIds[1]) {
      history = await fetchPriceHistory(tokenIds[1], endTs);
      await sleep(RATE_LIMIT_MS);

      if (history.length > 0) {
        // Invert NO prices to get YES prices
        history = history.map(p => ({ t: p.t, p: Math.round((1 - p.p) * 1000) / 1000 }));
      }
    }

    if (history.length === 0) {
      errors.emptyHistory++;
      continue;
    }

    // Sort and add minsBeforeClose
    history.sort((a, b) => a.t - b.t);
    const timeSeries = history.map(p => ({
      t: p.t,
      p: p.p,
      minsBeforeClose: Math.round((endTs - p.t) / 60),
    }));

    // Quality gate
    const quality = checkQuality(timeSeries);
    if (!quality.passes) {
      errors.belowQuality++;
      continue;
    }

    // Store
    const durationMins = timeSeries.length > 1
      ? Math.round((timeSeries[timeSeries.length - 1].t - timeSeries[0].t) / 60)
      : 0;

    await historyCol.updateOne(
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
          sport: market.sport,
          dataPoints: timeSeries.length,
          durationMins,
          pts2hr: quality.pts2hr,
          pts30min: quality.pts30min,
          timeSeries,
          fetchedAt: new Date(),
        },
      },
      { upsert: true }
    );

    fetched++;
    passedQuality++;

    if (fetched % 5 === 0) {
      const errTotal = errors.noTokens + errors.noEndDate + errors.emptyHistory + errors.belowQuality;
      console.log(`  [${fetched}/${toFetch.length}] ✅ ${passedQuality} passed | ${errTotal} skipped | ${market.question?.slice(0, 50)}`);
    }
  }

  const errTotal = errors.noTokens + errors.noEndDate + errors.emptyHistory + errors.belowQuality;
  console.log(`\n  Done!`);
  console.log(`  Fetched & passed quality: ${passedQuality}`);
  console.log(`  Skipped: ${errTotal} total`);
  console.log(`    No tokens:        ${errors.noTokens}`);
  console.log(`    No end date:      ${errors.noEndDate}`);
  console.log(`    Empty history:    ${errors.emptyHistory}`);
  console.log(`    Below quality:    ${errors.belowQuality} (<${MIN_POINTS_2HR} pts in 2hr or <${MIN_POINTS_30MIN} pts in 30min)`);

  const finalCount = await historyCol.countDocuments();
  console.log(`\n  Total histories in DB: ${finalCount}`);

  // Quality summary
  if (finalCount > 0) {
    const allHist = await historyCol.find({}, { projection: { sport: 1, pts30min: 1, dataPoints: 1 } }).toArray();
    const bySport = new Map<string, number>();
    for (const h of allHist) {
      bySport.set(h.sport || '?', (bySport.get(h.sport || '?') || 0) + 1);
    }
    console.log('\n  By sport (quality-passed):');
    for (const [sport, count] of [...bySport.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${sport.padEnd(12)} ${count}`);
    }
    const avgPts = allHist.reduce((s, h) => s + (h.dataPoints || 0), 0) / allHist.length;
    const avg30 = allHist.reduce((s, h) => s + (h.pts30min || 0), 0) / allHist.length;
    console.log(`\n  Avg data points/market: ${avgPts.toFixed(0)} | Avg pts in last 30min: ${avg30.toFixed(0)}`);
  }

  console.log('');
  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
