/**
 * Pass 1A: Fetch Resolved NBA Markets from Polymarket
 *
 * Fetches closed binary markets, filters for NBA by question text.
 * Targets 100 resolved NBA markets.
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
const TARGET_COUNT = 100;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const NBA_TEAMS = [
  'lakers', 'celtics', 'warriors', 'bucks', 'nuggets', '76ers', 'sixers', 'suns',
  'heat', 'knicks', 'nets', 'clippers', 'mavericks', 'cavaliers', 'thunder',
  'timberwolves', 'grizzlies', 'kings', 'pelicans', 'rockets', 'spurs', 'hawks',
  'hornets', 'pacers', 'magic', 'raptors', 'pistons', 'wizards', 'bulls',
  'blazers', 'trail blazers', 'jazz', 'pistons',
];

function isNbaMarket(question: string): boolean {
  const q = question.toLowerCase();
  if (q.includes('nba')) return true;
  if (q.includes('basketball') && !q.includes('college')) return true;
  return NBA_TEAMS.some(team => q.includes(team));
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Resolved NBA Markets — Polymarket              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  const collection = db.collection('sportMarkets');

  console.log(`  DB: ${dbName}`);
  const existing = await collection.countDocuments({ sport: 'nba' });
  console.log(`  Existing NBA markets: ${existing}`);
  console.log(`  Target: ${TARGET_COUNT}\n`);

  const nbaMarkets = new Map<string, any>();
  let offset = 0;
  let scanned = 0;

  while (nbaMarkets.size < TARGET_COUNT && offset < 5000) {
    const url = `${GAMMA_API}/markets?closed=true&limit=100&offset=${offset}&volume_num_min=100`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  API ${res.status} at offset ${offset}`); break; }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      scanned += data.length;

      for (const m of data) {
        if (nbaMarkets.size >= TARGET_COUNT) break;
        try {
          const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!Array.isArray(outcomes) || outcomes.length !== 2 || !m.outcomePrices) continue;
          if (!isNbaMarket(m.question || '')) continue;

          nbaMarkets.set(m.conditionId, m);
        } catch {}
      }

      if (data.length < 100) break;
      offset += 100;

      if (offset % 500 === 0) {
        console.log(`  Scanned ${scanned} markets | NBA found: ${nbaMarkets.size}/${TARGET_COUNT}`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
      break;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  Scanned: ${scanned} | NBA found: ${nbaMarkets.size}`);

  // Store
  let inserted = 0;
  for (const [conditionId, m] of nbaMarkets) {
    try {
      const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      let tokenIds: string[] = [];
      try { tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || []; }
      catch { tokenIds = (m.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

      let outcomePrices: number[] = [];
      try { outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; }
      catch { continue; }
      if (outcomePrices.length !== 2) continue;
      const winnerIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;

      const result = await collection.updateOne(
        { conditionId },
        {
          $set: {
            conditionId, slug: m.slug || '',
            question: m.question || '', outcomes, tokenIds,
            endDate: m.endDate || m.endDateIso || '',
            volume: m.volumeNum || parseFloat(m.volume) || 0,
            resolved: true, outcomePrices: JSON.stringify(outcomePrices),
            winner: outcomes[winnerIndex] || '?', winnerIndex,
            sport: 'nba', fetchedAt: new Date(),
          },
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0) inserted++;
    } catch {}
  }

  console.log(`  Stored: ${inserted} new | ${nbaMarkets.size - inserted} updated`);
  const total = await collection.countDocuments({ sport: 'nba' });
  console.log(`  Total NBA in DB: ${total}\n`);

  // Show samples
  console.log('  Sample markets:');
  for (const m of [...nbaMarkets.values()].slice(0, 10)) {
    console.log(`    ${(m.question || '?').slice(0, 75)}`);
  }
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
