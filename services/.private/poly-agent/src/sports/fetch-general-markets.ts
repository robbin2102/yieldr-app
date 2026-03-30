/**
 * Fetch Non-Sports, Non-Crypto Resolved Markets + Price Histories
 *
 * Fetches 1500 resolved binary markets, excludes sports/crypto,
 * classifies by category, fetches 5-min price histories.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/fetch-general-markets.ts
 *   npx tsx services/.private/poly-agent/src/sports/fetch-general-markets.ts --target=500
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
const CLOB_API = 'https://clob.polymarket.com';
const RATE_LIMIT_MS = 300;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const args = process.argv.slice(2);
const targetArg = args.find(a => a.startsWith('--target='));
const TARGET = targetArg ? parseInt(targetArg.split('=')[1]) : 1500;

// Exclude sports and crypto markets
function isSportsOrCrypto(question: string): boolean {
  const q = question.toLowerCase();

  // Sports keywords
  if (/\b(nba|nfl|ufc|mma|mlb|nhl|nascar|pga|atp|wta|fifa|epl)\b/.test(q)) return true;
  if (/\b(super bowl|world series|stanley cup|champions league|premier league|march madness|wimbledon)\b/.test(q)) return true;
  if (/\b(touchdown|quarterback|knockout|submission|halftime|overtime|playoff|championship game)\b/.test(q)) return true;
  // NBA teams
  if (/\b(lakers|celtics|warriors|bucks|nuggets|76ers|sixers|suns|heat|knicks|nets|clippers|mavericks|cavaliers|thunder|timberwolves|grizzlies|kings|pelicans|rockets|spurs|hawks|hornets|pacers|magic|raptors|pistons|wizards|bulls|blazers|jazz)\b/.test(q)) return true;
  // NFL teams
  if (/\b(chiefs|eagles|49ers|ravens|cowboys|bills|dolphins|bengals|lions|packers|steelers|chargers|broncos|jets|raiders|texans|jaguars|titans|colts|browns|seahawks|rams|vikings|saints|falcons|buccaneers|cardinals|commanders|panthers|bears|giants|patriots)\b/.test(q)) return true;
  // Soccer
  if (/\b(liverpool|manchester city|manchester united|arsenal|chelsea|tottenham|barcelona|real madrid|bayern|juventus|psg|dortmund|napoli|atletico)\b/.test(q)) return true;
  // UFC fighters
  if (/\b(ufc \d|fight night|weigh-in)\b/.test(q)) return true;
  // Tennis
  if (/\b(djokovic|alcaraz|sinner|medvedev|nadal|federer|swiatek|sabalenka|gauff)\b/.test(q)) return true;

  // Crypto keywords
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|defi|nft|airdrop|memecoin|token|blockchain|web3)\b/.test(q)) return true;
  if (/\b(coinbase|binance|uniswap|opensea|metamask|ledger|trezor)\b/.test(q)) return true;
  if (/\b(\$btc|\$eth|\$sol|\$doge|\$shib|\$pepe|\$wif|\$bonk)\b/.test(q)) return true;
  if (/\b(halving|staking|mining|layer 2|rollup|zk-proof)\b/.test(q)) return true;

  return false;
}

function classifyCategory(question: string): string {
  const q = question.toLowerCase();

  if (/\b(election|president|vote|ballot|candidate|primary|caucus|democrat|republican|gop|senate|congress|governor|mayor|poll)\b/.test(q)) return 'politics';
  if (/\b(trump|biden|harris|desantis|haley|vivek|rfk|newsom|gavin|nikki)\b/.test(q)) return 'politics';

  if (/\b(fed|interest rate|inflation|cpi|gdp|unemployment|jobs report|payroll|recession|treasury|bond|stock market|s&p|nasdaq|dow jones|ipo)\b/.test(q)) return 'economics';

  if (/\b(ai |artificial intelligence|openai|chatgpt|gpt-5|gpt-4|claude|gemini|llm|agi|machine learning)\b/.test(q)) return 'ai-tech';
  if (/\b(apple|google|meta|microsoft|tesla|nvidia|amazon|spacex|starship|launch)\b/.test(q)) return 'tech';

  if (/\b(oscar|grammy|emmy|golden globe|box office|movie|film|album|song|billboard|spotify|netflix|disney)\b/.test(q)) return 'entertainment';
  if (/\b(taylor swift|drake|beyonce|kanye|travis scott|rihanna|kardashian|jenner)\b/.test(q)) return 'entertainment';

  if (/\b(ukraine|russia|china|taiwan|nato|war|invasion|sanctions|missile|nuclear|iran|israel|gaza|hamas|hezbollah)\b/.test(q)) return 'geopolitics';

  if (/\b(weather|hurricane|earthquake|tornado|climate|temperature|wildfire|flood)\b/.test(q)) return 'weather';

  if (/\b(covid|vaccine|fda|cdc|pandemic|virus|drug approval|trial|health)\b/.test(q)) return 'health';

  if (/\b(tiktok|ban|regulation|lawsuit|court|supreme court|ruling|legal|indictment|trial|convicted|guilty|acquitted)\b/.test(q)) return 'legal';

  return 'other';
}

async function fetchPriceHistory(tokenId: string, endTs: number): Promise<{ t: number; p: number }[]> {
  try {
    const start = endTs - 21600; // 6 hours
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${start}&endTs=${endTs}&fidelity=5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: { t: number; p: number }[] };
    return data.history || [];
  } catch { return []; }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Fetch Non-Sports/Crypto Markets + Price Histories    ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  const marketsCol = db.collection('generalMarkets');
  const historyCol = db.collection('generalPriceHistory');

  await historyCol.createIndex({ conditionId: 1 }, { unique: true });

  const existing = await marketsCol.countDocuments();
  const existingHist = await historyCol.countDocuments();
  console.log(`  DB: ${dbName}`);
  console.log(`  Existing markets: ${existing} | Histories: ${existingHist}`);
  console.log(`  Target: ${TARGET}\n`);

  // ── Phase 1: Fetch markets ────────────────────────────────────
  const markets = new Map<string, any>();
  let offset = 0;
  let scanned = 0;
  let excluded = { sports: 0, crypto: 0, nonBinary: 0 };

  console.log('  Phase 1: Fetching markets from Gamma API...\n');

  while (markets.size < TARGET && offset < 15000) {
    const url = `${GAMMA_API}/markets?closed=true&limit=100&offset=${offset}&volume_num_min=100&end_date_min=2024-01-01T00:00:00Z`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  API ${res.status} at offset ${offset}`); break; }
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      scanned += data.length;

      for (const m of data) {
        if (markets.size >= TARGET) break;

        // Binary validation
        let outcomes: string[], tokenIds: string[], outcomePrices: number[];
        try {
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!Array.isArray(outcomes) || outcomes.length !== 2) { excluded.nonBinary++; continue; }
          tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
          if (tokenIds.length < 2) { excluded.nonBinary++; continue; }
          outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          if (!outcomePrices || outcomePrices.length !== 2 || Math.max(...outcomePrices) < 0.9) { excluded.nonBinary++; continue; }
        } catch { excluded.nonBinary++; continue; }

        // Exclude sports/crypto
        if (isSportsOrCrypto(m.question || '')) { excluded.sports++; continue; }

        const category = classifyCategory(m.question || '');
        const winnerIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;

        markets.set(m.conditionId, {
          conditionId: m.conditionId, slug: m.slug || '',
          question: m.question || '', outcomes, tokenIds, outcomePrices,
          endDate: m.endDate || m.endDateIso || '',
          volume: m.volumeNum || parseFloat(m.volume) || 0,
          winner: outcomes[winnerIndex], winnerIndex, category,
        });
      }

      if (data.length < 100) break;
      offset += 100;
      if (offset % 1000 === 0) {
        console.log(`  Scanned ${scanned} | Found ${markets.size}/${TARGET} | Excluded: ${excluded.sports} sports/crypto, ${excluded.nonBinary} non-binary`);
      }
    } catch (err: any) {
      console.log(`  Error: ${err.message}`);
      break;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n  Phase 1 done: ${markets.size} markets from ${scanned} scanned`);

  // Category breakdown
  const cats = new Map<string, number>();
  for (const m of markets.values()) cats.set(m.category, (cats.get(m.category) || 0) + 1);
  console.log('  Categories:');
  for (const [cat, count] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(15)} ${count}`);
  }

  // Store markets
  let insertedMarkets = 0;
  for (const m of markets.values()) {
    const r = await marketsCol.updateOne({ conditionId: m.conditionId }, { $set: { ...m, fetchedAt: new Date() } }, { upsert: true });
    if (r.upsertedCount > 0) insertedMarkets++;
  }
  console.log(`\n  Stored: ${insertedMarkets} new markets`);

  // ── Phase 2: Fetch price histories ────────────────────────────
  const existingHistIds = new Set(
    (await historyCol.find({}, { projection: { conditionId: 1 } }).toArray()).map(h => h.conditionId)
  );
  const toFetch = [...markets.values()].filter(m => !existingHistIds.has(m.conditionId));

  console.log(`\n  Phase 2: Fetching price histories (${toFetch.length} markets)...\n`);

  let fetched = 0;
  let errors = 0;
  let qualityFail = 0;

  for (const market of toFetch) {
    const endTs = market.endDate ? Math.floor(new Date(market.endDate).getTime() / 1000) : 0;
    if (!endTs || isNaN(endTs)) { errors++; continue; }

    let history = await fetchPriceHistory(market.tokenIds[0], endTs);
    await sleep(RATE_LIMIT_MS);

    if (history.length === 0 && market.tokenIds[1]) {
      history = await fetchPriceHistory(market.tokenIds[1], endTs);
      await sleep(RATE_LIMIT_MS);
      if (history.length > 0) {
        history = history.map(p => ({ t: p.t, p: Math.round((1 - p.p) * 1000) / 1000 }));
      }
    }

    if (history.length === 0) { errors++; continue; }

    history.sort((a, b) => a.t - b.t);
    const timeSeries = history.map(p => ({
      t: p.t, p: p.p,
      minsBeforeClose: Math.round((endTs - p.t) / 60),
    }));

    // Quality gate
    const pts2hr = timeSeries.filter(p => p.minsBeforeClose <= 120).length;
    const pts30min = timeSeries.filter(p => p.minsBeforeClose <= 30).length;
    if (pts2hr < 10 || pts30min < 3) { qualityFail++; continue; }

    await historyCol.updateOne(
      { conditionId: market.conditionId },
      {
        $set: {
          conditionId: market.conditionId, question: market.question,
          outcomes: market.outcomes, winner: market.winner, winnerIndex: market.winnerIndex,
          endDate: market.endDate, volume: market.volume, category: market.category,
          dataPoints: timeSeries.length, pts2hr, pts30min,
          timeSeries, fetchedAt: new Date(),
        },
      },
      { upsert: true }
    );
    fetched++;

    if (fetched % 20 === 0) {
      console.log(`  [${fetched}] ✅ ${fetched} fetched | ${errors} errors | ${qualityFail} quality-fail | ${market.question?.slice(0, 45)}`);
    }
  }

  const totalHist = await historyCol.countDocuments();
  console.log(`\n  Phase 2 done: ${fetched} fetched | ${errors} errors | ${qualityFail} below quality`);
  console.log(`  Total histories in DB: ${totalHist}\n`);

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
