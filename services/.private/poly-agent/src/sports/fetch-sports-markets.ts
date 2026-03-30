/**
 * Pass 1A: Fetch Resolved Sports Markets from Polymarket
 *
 * Fetches 500+ resolved binary sports markets across all categories.
 * Classifies by sport using question text, stores in MongoDB.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/fetch-sports-markets.ts
 *   npx tsx services/.private/poly-agent/src/sports/fetch-sports-markets.ts --target=200
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

const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--target='));
const TARGET = targetArg ? parseInt(targetArg.split('=')[1]) : 500;

function classifySport(question: string): string | null {
  const q = question.toLowerCase();

  // NBA
  if (q.includes('nba')) return 'nba';
  if (/\b(lakers|celtics|warriors|bucks|nuggets|76ers|sixers|suns|heat|knicks|nets|clippers|mavericks|cavaliers|thunder|timberwolves|grizzlies|kings|pelicans|rockets|spurs|hawks|hornets|pacers|magic|raptors|pistons|wizards|bulls|blazers|trail blazers|jazz)\b/.test(q)) {
    // Exclude if NFL context
    if (/\b(nfl|touchdown|quarterback|super bowl|seahawks|patriots|chiefs|eagles|cowboys|steelers|broncos|dolphins|bengals|lions|packers|chargers|raiders|texans|jaguars|titans|colts|browns|rams|vikings|saints|falcons|buccaneers|cardinals|commanders|panthers|bears|giants|jets|bills|ravens)\b/.test(q)) return null;
    return 'nba';
  }

  // NFL
  if (q.includes('nfl') || q.includes('super bowl')) return 'nfl';
  if (/\b(chiefs|eagles|49ers|ravens|cowboys|bills|dolphins|bengals|lions|packers|steelers|chargers|broncos|jets|raiders|texans|jaguars|titans|colts|browns|seahawks|rams|vikings|saints|falcons|buccaneers|cardinals|commanders|panthers|bears|giants|patriots)\b/.test(q)) return 'nfl';

  // UFC/MMA
  if (q.includes('ufc') || q.includes(' mma ')) return 'ufc';
  if (/\b(fight night|knockout|ko\/tko|submission|split decision|unanimous decision)\b/.test(q)) return 'ufc';

  // Soccer
  if (/\b(premier league|champions league|la liga|serie a|bundesliga|europa league|world cup|mls cup)\b/.test(q)) return 'soccer';
  if (/\b(liverpool|manchester united|manchester city|arsenal|chelsea|tottenham|barcelona|real madrid|bayern munich|juventus|psg|inter milan|ac milan|napoli|dortmund|atletico madrid)\b/.test(q)) return 'soccer';

  // MLB
  if (q.includes('mlb') || q.includes('world series')) return 'mlb';
  if (/\b(yankees|dodgers|astros|braves|phillies|mets|padres|guardians|orioles|rangers|mariners|twins|rays|brewers|cubs|reds|diamondbacks|blue jays|red sox)\b/.test(q)) return 'mlb';

  // NHL
  if (q.includes('nhl') || q.includes('stanley cup')) return 'nhl';
  if (/\b(bruins|avalanche|hurricanes|panthers|oilers|stars|maple leafs|lightning|penguins|canadiens|blackhawks|kraken|wild|flames|predators|blues|sharks|islanders|capitals|flyers|devils|red wings)\b/.test(q)) return 'nhl';

  // Tennis
  if (/\b(tennis|wimbledon|us open tennis|french open|australian open|roland garros|atp|wta)\b/.test(q)) return 'tennis';
  if (/\b(djokovic|alcaraz|sinner|medvedev|rublev|tsitsipas|zverev|nadal|swiatek|sabalenka|gauff)\b/.test(q)) return 'tennis';

  // F1
  if (/\b(formula 1|f1 |grand prix)\b/.test(q)) return 'f1';
  if (/\b(verstappen|hamilton|leclerc|norris|sainz|perez|red bull racing|ferrari f1|mclaren f1)\b/.test(q)) return 'f1';

  // Boxing
  if (/\b(boxing|heavyweight bout|welterweight|middleweight)\b/.test(q)) return 'boxing';
  if (/\b(fury|usyk|crawford|canelo|spence|tyson)\b/.test(q)) return 'boxing';

  // Cricket
  if (/\b(cricket|ipl|test match|odi|t20|ashes)\b/.test(q)) return 'cricket';

  // Golf
  if (/\b(golf|pga|masters tournament|us open golf|ryder cup)\b/.test(q)) return 'golf';

  return null;
}

function isValidBinary(m: any): { valid: boolean; outcomes: string[]; tokenIds: string[]; outcomePrices: number[] } {
  try {
    const outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    if (!Array.isArray(outcomes) || outcomes.length !== 2) return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] };

    let tokenIds: string[] = [];
    try { tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || []; }
    catch { tokenIds = (m.clobTokenIds || '').split(',').map((s: string) => s.trim()); }
    if (tokenIds.length < 2 || !tokenIds[0] || !tokenIds[1]) return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] };

    let outcomePrices: number[] = [];
    try { outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices; }
    catch { return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] }; }
    if (outcomePrices.length !== 2) return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] };

    // Must be resolved (one price near 1, other near 0)
    const max = Math.max(outcomePrices[0], outcomePrices[1]);
    if (max < 0.9) return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] };

    return { valid: true, outcomes, tokenIds, outcomePrices };
  } catch {
    return { valid: false, outcomes: [], tokenIds: [], outcomePrices: [] };
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Resolved Sports Markets — All Categories       ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  const collection = db.collection('sportMarkets');

  console.log(`  DB: ${dbName}`);
  const existing = await collection.countDocuments();
  console.log(`  Existing markets: ${existing}`);
  console.log(`  Target: ${TARGET}\n`);

  const sportMarkets = new Map<string, any>();
  let offset = 0;
  let scanned = 0;
  let nonBinary = 0;
  let nonSport = 0;

  while (sportMarkets.size < TARGET && offset < 10000) {
    const url = `${GAMMA_API}/markets?closed=true&limit=100&offset=${offset}&volume_num_min=500&end_date_min=2024-01-01T00:00:00Z`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  API ${res.status} at offset ${offset}`); break; }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      scanned += data.length;

      for (const m of data) {
        if (sportMarkets.size >= TARGET) break;

        const { valid, outcomes, tokenIds, outcomePrices } = isValidBinary(m);
        if (!valid) { nonBinary++; continue; }

        const sport = classifySport(m.question || '');
        if (!sport) { nonSport++; continue; }

        if (!sportMarkets.has(m.conditionId)) {
          sportMarkets.set(m.conditionId, { ...m, _sport: sport, _outcomes: outcomes, _tokenIds: tokenIds, _outcomePrices: outcomePrices });
        }
      }

      if (data.length < 100) break;
      offset += 100;

      if (offset % 500 === 0) {
        console.log(`  Scanned ${scanned} | Sports: ${sportMarkets.size}/${TARGET} | Skipped: ${nonBinary} non-binary, ${nonSport} non-sport`);
      }
    } catch (err: any) {
      console.log(`  Error at offset ${offset}: ${err.message}`);
      break;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  Scanned: ${scanned} | Sports found: ${sportMarkets.size}`);
  console.log(`  Skipped: ${nonBinary} non-binary, ${nonSport} non-sport`);

  // Sport breakdown
  const sportCounts = new Map<string, number>();
  for (const [_, m] of sportMarkets) {
    sportCounts.set(m._sport, (sportCounts.get(m._sport) || 0) + 1);
  }
  console.log('\n  By sport:');
  for (const [sport, count] of [...sportCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${sport.padEnd(12)} ${count}`);
  }

  // Store
  let inserted = 0;
  for (const [conditionId, m] of sportMarkets) {
    const winnerIndex = m._outcomePrices[0] > m._outcomePrices[1] ? 0 : 1;
    const result = await collection.updateOne(
      { conditionId },
      {
        $set: {
          conditionId, slug: m.slug || '',
          question: m.question || '', outcomes: m._outcomes, tokenIds: m._tokenIds,
          endDate: m.endDate || m.endDateIso || '',
          volume: m.volumeNum || parseFloat(m.volume) || 0,
          resolved: true, outcomePrices: JSON.stringify(m._outcomePrices),
          winner: m._outcomes[winnerIndex] || '?', winnerIndex,
          sport: m._sport, fetchedAt: new Date(),
        },
      },
      { upsert: true }
    );
    if (result.upsertedCount > 0) inserted++;
  }

  console.log(`\n  Stored: ${inserted} new | ${sportMarkets.size - inserted} updated`);
  const total = await collection.countDocuments();
  console.log(`  Total in DB: ${total}\n`);

  // Samples per sport
  for (const sport of [...sportCounts.keys()].slice(0, 5)) {
    const sample = [...sportMarkets.values()].find(m => m._sport === sport);
    if (sample) console.log(`  [${sport}] ${(sample.question || '?').slice(0, 70)}`);
  }
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
