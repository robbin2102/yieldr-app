/**
 * Pass 1A: Fetch Resolved Sports Markets from Polymarket
 *
 * Pulls 500+ resolved binary sports markets from Gamma API,
 * stores them in MongoDB `sportMarkets` collection.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/fetch-sports-markets.ts
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

const GAMMA_API = 'https://gamma-api.polymarket.com';
const RATE_LIMIT_MS = 350;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Sport-related tags to search
const SPORT_TAGS = [
  'sports', 'nba', 'nfl', 'ufc', 'mma', 'soccer', 'football',
  'mlb', 'nhl', 'tennis', 'boxing', 'f1', 'cricket', 'golf',
  'premier-league', 'champions-league', 'la-liga', 'serie-a',
  'college-football', 'college-basketball', 'march-madness',
];

interface StoredMarket {
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  endDate: string;
  volume: number;
  resolved: boolean;
  outcomePrices: string;
  winner: string;       // outcome that won
  winnerIndex: number;   // 0 or 1
  tag: string;
  fetchedAt: Date;
}

async function fetchMarketsByTag(tag: string): Promise<any[]> {
  const markets: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_API}/markets?closed=true&limit=${limit}&offset=${offset}&tag=${tag}&volume_num_min=1000`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  [${tag}] API ${res.status} at offset ${offset}`); break; }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;

      // Filter: binary markets only (2 outcomes), resolved
      const binary = data.filter((m: any) => {
        try {
          const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          return Array.isArray(outcomes) && outcomes.length === 2 && m.outcomePrices;
        } catch { return false; }
      });

      markets.push(...binary.map((m: any) => ({ ...m, _tag: tag })));

      if (data.length < limit) break;
      offset += limit;
      if (offset > 2000) break;
    } catch (err: any) {
      console.log(`  [${tag}] Error: ${err.message}`);
      break;
    }
    await sleep(RATE_LIMIT_MS);
  }
  return markets;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Resolved Sports Markets — Polymarket           ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  const collection = db.collection('sportMarkets');

  // Check existing
  const existing = await collection.countDocuments();
  console.log(`  Existing markets in DB: ${existing}\n`);

  const allMarkets = new Map<string, any>(); // dedupe by conditionId

  for (const tag of SPORT_TAGS) {
    process.stdout.write(`  Fetching [${tag}]...`);
    const markets = await fetchMarketsByTag(tag);
    let newCount = 0;
    for (const m of markets) {
      if (!allMarkets.has(m.conditionId)) {
        allMarkets.set(m.conditionId, m);
        newCount++;
      }
    }
    console.log(` ${markets.length} found, ${newCount} new (total: ${allMarkets.size})`);
    await sleep(RATE_LIMIT_MS);
  }

  // Also try fetching without tag filter to catch sports markets not tagged
  console.log('\n  Fetching recent closed markets (no tag filter)...');
  let offset = 0;
  while (allMarkets.size < 800 && offset < 3000) {
    try {
      const res = await fetch(`${GAMMA_API}/markets?closed=true&limit=100&offset=${offset}&volume_num_min=5000`);
      if (!res.ok) break;
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;

      for (const m of data) {
        try {
          const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!Array.isArray(outcomes) || outcomes.length !== 2 || !m.outcomePrices) continue;

          // Check if sport-related by question keywords
          const q = (m.question || '').toLowerCase();
          const sportKeywords = ['win', 'beat', 'score', 'game', 'match', 'fight', 'round', 'set',
            'goal', 'touchdown', 'knockout', 'decision', 'points', 'nba', 'nfl', 'ufc',
            'premier league', 'champions league', 'series', 'playoff', 'championship',
            'vs', 'v.', 'over', 'under', 'spread', 'moneyline', 'total'];
          const isSport = sportKeywords.some(kw => q.includes(kw));
          if (isSport && !allMarkets.has(m.conditionId)) {
            allMarkets.set(m.conditionId, { ...m, _tag: 'auto-detected' });
          }
        } catch {}
      }

      if (data.length < 100) break;
      offset += 100;
    } catch { break; }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  Total unique markets found: ${allMarkets.size}`);

  // Process and store
  const toStore: StoredMarket[] = [];
  for (const [conditionId, m] of allMarkets) {
    try {
      const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      let tokenIds: string[] = [];
      try { tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds; }
      catch { tokenIds = (m.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

      // Determine winner from outcomePrices
      let outcomePrices: number[] = [];
      try { outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; }
      catch { continue; }

      if (outcomePrices.length !== 2) continue;
      const winnerIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;
      const winner = outcomes[winnerIndex] || '?';

      toStore.push({
        conditionId,
        slug: m.slug || m.market_slug || '',
        question: m.question || '',
        outcomes,
        tokenIds,
        endDate: m.endDate || m.endDateIso || '',
        volume: m.volumeNum || parseFloat(m.volume) || 0,
        resolved: true,
        outcomePrices: JSON.stringify(outcomePrices),
        winner,
        winnerIndex,
        tag: m._tag || '',
        fetchedAt: new Date(),
      });
    } catch {}
  }

  console.log(`  Markets ready to store: ${toStore.length}`);

  if (toStore.length > 0) {
    // Upsert to avoid duplicates
    let inserted = 0;
    for (const m of toStore) {
      const result = await collection.updateOne(
        { conditionId: m.conditionId },
        { $set: m },
        { upsert: true }
      );
      if (result.upsertedCount > 0) inserted++;
    }
    console.log(`  Inserted: ${inserted} new | Updated: ${toStore.length - inserted}`);
  }

  // Summary by tag
  const tagCounts = new Map<string, number>();
  for (const m of toStore) {
    tagCounts.set(m.tag, (tagCounts.get(m.tag) || 0) + 1);
  }
  console.log('\n  By tag:');
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${tag.padEnd(20)} ${count}`);
  }

  const totalInDb = await collection.countDocuments();
  console.log(`\n  Total in sportMarkets collection: ${totalInDb}\n`);

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
