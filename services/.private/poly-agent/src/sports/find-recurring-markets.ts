/**
 * Discover & Analyze Recurring High-Frequency Markets on Polymarket
 *
 * Finds markets that repeat (weekly/biweekly/monthly), fetches price
 * histories, analyzes edge per series, simulates monthly PnL.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/find-recurring-markets.ts
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

// ── Search keywords → series classification ─────────────────
const SEARCH_CONFIGS = [
  { keywords: ['Musk tweet', 'Musk post', 'tweets between', 'Musk X post'], series: 'musk-tweets', freq: 'weekly' },
  { keywords: ['Trump say', 'Trump mention', 'Trump tweet', 'Trump post', 'Trump Truth'], series: 'trump-mentions', freq: 'weekly' },
  { keywords: ['Fed rate', 'FOMC', 'Fed cut', 'Fed hold', 'Fed hike', 'federal funds rate'], series: 'fed-rates', freq: 'monthly' },
  { keywords: ['inflation', 'CPI above', 'CPI below', 'CPI print', 'PCE'], series: 'inflation-data', freq: 'monthly' },
  { keywords: ['jobs report', 'unemployment rate', 'nonfarm payroll', 'jobless claims'], series: 'jobs-data', freq: 'monthly' },
  { keywords: ['Bitcoin above', 'Bitcoin below', 'BTC above', 'BTC below', 'Bitcoin end of', 'BTC price'], series: 'btc-price', freq: 'weekly-monthly' },
  { keywords: ['Ethereum above', 'Ethereum below', 'ETH above', 'ETH below', 'ETH price'], series: 'eth-price', freq: 'weekly-monthly' },
  { keywords: ['Solana above', 'Solana below', 'SOL above', 'SOL price'], series: 'sol-price', freq: 'weekly-monthly' },
  { keywords: ['gas price', 'oil price', 'gasoline', 'crude oil'], series: 'energy-prices', freq: 'monthly' },
  { keywords: ['followers', 'subscribers', 'views milestone'], series: 'social-metrics', freq: 'monthly' },
  { keywords: ['GPT-5', 'GPT-4', 'OpenAI launch', 'Claude', 'Gemini launch'], series: 'ai-milestones', freq: 'quarterly' },
  { keywords: ['MrBeast', 'YouTube views', 'streams'], series: 'youtube-metrics', freq: 'monthly' },
  { keywords: ['temperature record', 'hurricane', 'snowfall', 'heat wave'], series: 'weather', freq: 'seasonal' },
  { keywords: ['end of week', 'by Friday', 'this week'], series: 'weekly-deadlines', freq: 'weekly' },
  { keywords: ['end of month', 'by end of March', 'by end of April', 'by end of May', 'by end of June'], series: 'monthly-deadlines', freq: 'monthly' },
  { keywords: ['GDP', 'trade deficit', 'retail sales', 'housing starts', 'consumer confidence'], series: 'econ-data', freq: 'monthly' },
  { keywords: ['S&P 500', 'Nasdaq', 'Dow Jones', 'stock market', 'market crash'], series: 'stock-market', freq: 'monthly' },
];

interface FoundMarket {
  conditionId: string;
  question: string;
  slug: string;
  series: string;
  freq: string;
  endDate: string;
  volume: number;
  outcomes: string[];
  tokenIds: string[];
  outcomePrices: number[];
  winner: string;
  winnerIndex: number;
  closed: boolean;
}

async function searchMarkets(keyword: string): Promise<any[]> {
  // Search both closed and active markets
  const results: any[] = [];
  for (const closed of [true, false]) {
    try {
      const encoded = encodeURIComponent(keyword);
      const url = `${GAMMA_API}/markets?closed=${closed}&limit=100&volume_num_min=50&end_date_min=2025-10-01T00:00:00Z`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json() as any[];
      if (!Array.isArray(data)) continue;

      // Filter by keyword in question
      const matches = data.filter((m: any) =>
        (m.question || '').toLowerCase().includes(keyword.toLowerCase())
      );
      results.push(...matches.map(m => ({ ...m, _closed: closed })));
    } catch {}
    await sleep(RATE_LIMIT_MS);
  }
  return results;
}

async function fetchPriceHistory(tokenId: string, endTs: number): Promise<{ t: number; p: number }[]> {
  try {
    const start = endTs - 21600;
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${start}&endTs=${endTs}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: { t: number; p: number }[] };
    return data.history || [];
  } catch { return []; }
}

function getPriceAtMins(series: { t: number; p: number; mbc: number }[], targetMins: number): number | null {
  let best: any = null;
  let bestDist = Infinity;
  for (const p of series) {
    const dist = Math.abs(p.mbc - targetMins);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best && bestDist < 10 ? best.p : null;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Discover Recurring High-Frequency Markets            ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  const col = db.collection('recurringMarkets');

  // ── Step 1: Search for recurring market series ────────────────
  console.log('  Step 1: Searching for recurring market series...\n');

  const allFound = new Map<string, FoundMarket>();
  const seriesSummary: { series: string; freq: string; resolved: number; active: number; samples: string[] }[] = [];

  for (const config of SEARCH_CONFIGS) {
    let resolved = 0;
    let active = 0;
    const samples: string[] = [];

    for (const kw of config.keywords) {
      const results = await searchMarkets(kw);

      for (const m of results) {
        if (allFound.has(m.conditionId)) continue;

        let outcomes: string[], tokenIds: string[], outcomePrices: number[];
        try {
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;
          tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
          if (tokenIds.length < 2) continue;
          outcomePrices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : [0, 0];
        } catch { continue; }

        const isClosed = m._closed || m.closed;
        if (isClosed) resolved++;
        else active++;

        const winnerIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;

        allFound.set(m.conditionId, {
          conditionId: m.conditionId, question: m.question || '',
          slug: m.slug || '', series: config.series, freq: config.freq,
          endDate: m.endDate || m.endDateIso || '',
          volume: m.volumeNum || parseFloat(m.volume) || 0,
          outcomes, tokenIds, outcomePrices,
          winner: isClosed ? (outcomes[winnerIndex] || '?') : '?',
          winnerIndex, closed: !!isClosed,
        });

        if (samples.length < 3) samples.push((m.question || '').slice(0, 60));
      }
    }

    seriesSummary.push({ series: config.series, freq: config.freq, resolved, active, samples });
    const total = resolved + active;
    if (total > 0) {
      console.log(`  ${config.series.padEnd(20)} | ${String(resolved).padEnd(4)} resolved | ${String(active).padEnd(4)} active | freq: ${config.freq}`);
      for (const s of samples) console.log(`    → ${s}`);
    }
  }

  const totalResolved = [...allFound.values()].filter(m => m.closed).length;
  const totalActive = [...allFound.values()].filter(m => !m.closed).length;
  console.log(`\n  Total unique markets found: ${allFound.size} (${totalResolved} resolved, ${totalActive} active)\n`);

  // ── Step 2: Fetch price histories for resolved markets ────────
  const resolvedMarkets = [...allFound.values()].filter(m => m.closed && m.outcomePrices && Math.max(...m.outcomePrices) >= 0.9);

  console.log(`  Step 2: Fetching price histories for ${resolvedMarkets.length} resolved markets...\n`);

  interface AnalyzedMarket extends FoundMarket {
    leadingPrice: number;
    leadingSideWon: boolean;
    price5m: number | null;
    price30m: number | null;
    price60m: number | null;
    dataPoints: number;
  }

  const analyzed: AnalyzedMarket[] = [];
  let fetched = 0;
  let errors = 0;
  let qualityFail = 0;

  for (const market of resolvedMarkets) {
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
    const ts = history.map(p => ({ t: p.t, p: p.p, mbc: Math.round((endTs - p.t) / 60) }));

    const pts2hr = ts.filter(p => p.mbc <= 120).length;
    const pts30m = ts.filter(p => p.mbc <= 30).length;
    if (pts2hr < 20 || pts30m < 10) { qualityFail++; continue; }

    const p5 = getPriceAtMins(ts, 5);
    const p30 = getPriceAtMins(ts, 30);
    const p60 = getPriceAtMins(ts, 60);

    const refPrice = p5 ?? ts[ts.length - 1]?.p ?? 0.5;
    const leadingSideIsYes = refPrice > 0.5;
    const leadingPrice = leadingSideIsYes ? refPrice : (1 - refPrice);
    const leadingSideWon = leadingSideIsYes
      ? (market.winnerIndex === 0)
      : (market.winnerIndex === 1);

    const lp5 = p5 !== null ? (leadingSideIsYes ? p5 : 1 - p5) : null;
    const lp30 = p30 !== null ? (leadingSideIsYes ? p30 : 1 - p30) : null;
    const lp60 = p60 !== null ? (leadingSideIsYes ? p60 : 1 - p60) : null;

    analyzed.push({
      ...market, leadingPrice, leadingSideWon,
      price5m: lp5, price30m: lp30, price60m: lp60,
      dataPoints: ts.length,
    });
    fetched++;

    if (fetched % 10 === 0) {
      console.log(`  [${fetched}] ${errors} errors | ${qualityFail} quality-fail | ${market.question?.slice(0, 50)}`);
    }
  }

  console.log(`\n  Fetched: ${fetched} | Errors: ${errors} | Quality-fail: ${qualityFail}\n`);

  // Store to MongoDB (minimal)
  for (const m of analyzed) {
    await col.updateOne(
      { conditionId: m.conditionId },
      { $set: { conditionId: m.conditionId, question: m.question, series: m.series, freq: m.freq, endDate: m.endDate, leadingPrice: m.leadingPrice, leadingSideWon: m.leadingSideWon, volume: m.volume, fetchedAt: new Date() } },
      { upsert: true }
    );
  }
  console.log(`  Stored ${analyzed.length} markets to recurringMarkets collection\n`);

  // ── Step 3: Analyze edge per series ───────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Step 3: EDGE BY SERIES (unique markets)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const seriesMap = new Map<string, AnalyzedMarket[]>();
  for (const m of analyzed) {
    const list = seriesMap.get(m.series) || [];
    list.push(m);
    seriesMap.set(m.series, list);
  }

  console.log(`  ${'Series'.padEnd(22)} | ${'N'.padEnd(4)} | ${'≥75c'.padEnd(5)} | ${'Wins'.padEnd(5)} | ${'WR%'.padEnd(7)} | ${'AvgP'.padEnd(6)} | Edge    | Freq`);
  console.log(`  ${'-'.repeat(80)}`);

  interface SeriesEdge {
    series: string; total: number; q75: number; wins: number;
    wr: number; avgP: number; edge: number; freq: string; pnl: number;
  }
  const seriesEdges: SeriesEdge[] = [];

  for (const [series, markets] of [...seriesMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const q75 = markets.filter(m => m.leadingPrice >= 0.75);
    const wins = q75.filter(m => m.leadingSideWon).length;
    const wr = q75.length > 0 ? wins / q75.length : 0;
    const avgP = q75.length > 0 ? q75.reduce((s, m) => s + m.leadingPrice, 0) / q75.length : 0;
    const edge = wr - avgP;
    let pnl = 0;
    for (const m of q75) { pnl += m.leadingSideWon ? (100 / m.leadingPrice - 100) : -100; }
    const freq = markets[0]?.freq || '?';
    const flag = q75.length < 10 ? ' ⚠' : '';

    seriesEdges.push({ series, total: markets.length, q75: q75.length, wins, wr, avgP, edge, freq, pnl });

    console.log(`  ${series.padEnd(22)} | ${String(markets.length).padEnd(4)} | ${String(q75.length).padEnd(5)} | ${String(wins).padEnd(5)} | ${q75.length > 0 ? (wr*100).toFixed(1).padEnd(6) + '%' : 'N/A'.padEnd(7)} | ${q75.length > 0 ? (avgP*100).toFixed(1).padEnd(5) + 'c' : 'N/A'.padEnd(6)} | ${q75.length > 0 ? (edge >= 0 ? '+' : '') + (edge*100).toFixed(1) + '%' : 'N/A'}${flag} | ${freq}`);
  }

  // ── Step 3b: Price bucket breakdown per top series ────────────
  console.log('\n  PRICE BUCKET BREAKDOWN (top series):\n');

  const priceBuckets = [
    { label: '60-70c', min: 0.60, max: 0.70 },
    { label: '70-75c', min: 0.70, max: 0.75 },
    { label: '75-80c', min: 0.75, max: 0.80 },
    { label: '80-85c', min: 0.80, max: 0.85 },
    { label: '85-90c', min: 0.85, max: 0.90 },
    { label: '90-95c', min: 0.90, max: 0.95 },
    { label: '95c+', min: 0.95, max: 1.01 },
  ];

  for (const [series, markets] of [...seriesMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    if (markets.length < 3) continue;
    console.log(`  ${series.toUpperCase()} (${markets.length} markets):`);
    for (const b of priceBuckets) {
      const bucket = markets.filter(m => m.leadingPrice >= b.min && m.leadingPrice < b.max);
      if (bucket.length === 0) continue;
      const w = bucket.filter(m => m.leadingSideWon).length;
      const avgP = bucket.reduce((s, m) => s + m.leadingPrice, 0) / bucket.length;
      const edge = w / bucket.length - avgP;
      const flag = bucket.length < 5 ? ' ⚠' : '';
      console.log(`    ${b.label.padEnd(8)} | ${String(bucket.length).padEnd(3)} | ${String(w).padEnd(3)}W | WR ${(w/bucket.length*100).toFixed(0)}% | Edge ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1)}%${flag}`);
    }
    console.log('');
  }

  // ── Step 3c: Market-level detail for top series ───────────────
  console.log('  MARKET DETAILS (top series):\n');

  for (const [series, markets] of [...seriesMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
    if (markets.length < 2) continue;
    console.log(`  ${series.toUpperCase()}:`);
    const sorted = markets.sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
    for (const m of sorted) {
      const icon = m.leadingSideWon ? '✅' : '❌';
      const p5 = m.price5m !== null ? `${(m.price5m * 100).toFixed(0)}c` : '?';
      const date = m.endDate ? new Date(m.endDate).toISOString().slice(0, 10) : '?';
      console.log(`    ${icon} ${date} | ${p5.padEnd(5)} | ${(m.question || '?').slice(0, 55)}`);
    }
    console.log('');
  }

  // ── Step 4: Monthly PnL simulation ────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Step 4: MONTHLY PnL SIMULATION ($100 per bet at ≥75c)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Estimate bets per month from data
  const dates = analyzed.filter(m => m.leadingPrice >= 0.75).map(m => new Date(m.endDate).getTime()).filter(d => !isNaN(d));
  const months = dates.length > 1 ? (Math.max(...dates) - Math.min(...dates)) / (30.44 * 86400000) : 1;

  console.log(`  ${'Series'.padEnd(22)} | ${'Bets/Mo'.padEnd(8)} | ${'WR%'.padEnd(7)} | ${'Mo PnL $100'.padEnd(12)} | ${'Mo PnL $500'.padEnd(12)} | Capital`);
  console.log(`  ${'-'.repeat(80)}`);

  let totalBetsPerMonth = 0;
  let totalPnl100 = 0;
  let totalPnl500 = 0;

  for (const se of seriesEdges.sort((a, b) => b.pnl - a.pnl)) {
    if (se.q75 === 0) continue;
    const betsPerMonth = se.q75 / Math.max(months, 1);
    const pnlPerMonth100 = se.pnl / Math.max(months, 1);
    const pnlPerMonth500 = pnlPerMonth100 * 5;
    const capitalNeeded = betsPerMonth * 100;

    totalBetsPerMonth += betsPerMonth;
    totalPnl100 += pnlPerMonth100;
    totalPnl500 += pnlPerMonth500;

    const flag = se.q75 < 5 ? ' ⚠' : '';
    console.log(`  ${se.series.padEnd(22)} | ${betsPerMonth.toFixed(1).padEnd(8)} | ${(se.wr*100).toFixed(0).padEnd(6)}% | $${pnlPerMonth100.toFixed(0).padStart(8)}    | $${pnlPerMonth500.toFixed(0).padStart(8)}    | $${capitalNeeded.toFixed(0)}${flag}`);
  }

  console.log(`  ${'-'.repeat(80)}`);
  console.log(`  ${'TOTAL'.padEnd(22)} | ${totalBetsPerMonth.toFixed(1).padEnd(8)} |       | $${totalPnl100.toFixed(0).padStart(8)}    | $${totalPnl500.toFixed(0).padStart(8)}    | $${(totalBetsPerMonth * 100).toFixed(0)}`);

  // ── Step 5: Combined playbook ─────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Step 5: COMBINED PLAYBOOK');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const allQ75 = analyzed.filter(m => m.leadingPrice >= 0.75);
  const allWins = allQ75.filter(m => m.leadingSideWon).length;
  let totalPnlAll = 0;
  for (const m of allQ75) { totalPnlAll += m.leadingSideWon ? (100 / m.leadingPrice - 100) : -100; }

  console.log(`  Total qualifying bets (≥75c): ${allQ75.length} across ${months.toFixed(1)} months`);
  console.log(`  Overall WR: ${(allWins/allQ75.length*100).toFixed(1)}% (${allWins}W / ${allQ75.length - allWins}L)`);
  console.log(`  Avg entry price: ${(allQ75.reduce((s,m) => s+m.leadingPrice, 0)/allQ75.length*100).toFixed(1)}c`);
  console.log(`\n  Monthly projection:`);
  console.log(`    Bets/month: ${totalBetsPerMonth.toFixed(1)}`);
  console.log(`    At $100/bet: $${totalPnl100.toFixed(0)}/month (${(totalPnl100 / (totalBetsPerMonth * 100) * 100).toFixed(1)}% ROI)`);
  console.log(`    At $500/bet: $${totalPnl500.toFixed(0)}/month`);
  console.log(`    Capital deployed/month: ~$${(totalBetsPerMonth * 100).toFixed(0)} at $100/bet`);
  console.log(`    Idle capital between bets: varies by series frequency`);

  // Active markets right now
  const activeMarkets = [...allFound.values()].filter(m => !m.closed);
  if (activeMarkets.length > 0) {
    console.log(`\n  ACTIVE MARKETS RIGHT NOW (${activeMarkets.length}):`);
    for (const m of activeMarkets.slice(0, 15)) {
      console.log(`    [${m.series}] ${(m.question || '?').slice(0, 60)}`);
    }
  }

  console.log('\n');
  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
