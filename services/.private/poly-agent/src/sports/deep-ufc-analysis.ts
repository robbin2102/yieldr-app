/**
 * Deep UFC Edge Analysis
 *
 * Fetches ALL resolved UFC markets from Gamma API (not limited to
 * existing DB), gets price histories, analyzes first-touch edge
 * with reversal tracking per fight type.
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/sports/deep-ufc-analysis.ts
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
const THRESHOLDS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

interface PricePoint { t: number; p: number; }

function isUfcMarket(question: string): boolean {
  const q = question.toLowerCase();
  if (/\bufc\b/.test(q)) return true;
  if (/\bmma\b/.test(q) && /\bwin\b|vs\.?\b|fight\b/.test(q)) return true;
  if (/\bfight night\b/.test(q)) return true;
  if (/\bbellator\b/.test(q)) return true;
  if (/\bpfl\b/.test(q) && /fight|win|vs/.test(q)) return true;
  return false;
}

function classifyUfcType(question: string): string {
  const q = question.toLowerCase();
  if (/who will win|vs\.?\s|beat/.test(q) && !/method|finish|decision|round|ko|tko|submission/.test(q)) return 'winner';
  if (/finish|ko|tko|knockout|submission/.test(q)) return 'method-finish';
  if (/decision|judges|scorecard/.test(q)) return 'method-decision';
  if (/round \d|which round|go the distance|last the/.test(q)) return 'rounds';
  if (/fight of the night|performance|bonus/.test(q)) return 'bonus';
  return 'other';
}

async function fetchPriceHistory(tokenId: string, endTs: number, lookbackSecs: number): Promise<PricePoint[]> {
  try {
    const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${endTs - lookbackSecs}&endTs=${endTs}&fidelity=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json() as { history: PricePoint[] };
    return data.history || [];
  } catch { return []; }
}

interface TouchResult {
  conditionId: string;
  question: string;
  ufcType: string;
  threshold: number;
  side: 'Yes' | 'No';
  sideWon: boolean;
  entryPrice: number;
  minsBeforeClose: number;
  reversed: boolean;
  maxDrawdown: number;
  minPriceAfter: number;
  recoveredAfterReversal: boolean;
}

function findFirstTouch(history: PricePoint[], threshold: number, endTs: number, winnerIndex: number): TouchResult | null {
  if (history.length < 2) return null;
  for (let i = 1; i < history.length; i++) {
    const yesPrice = history[i].p;
    const noPrice = 1 - history[i].p;
    const prevYes = history[i - 1].p;
    const prevNo = 1 - history[i - 1].p;

    let side: 'Yes' | 'No' | null = null;
    let sidePrice = 0;

    if (yesPrice >= threshold && prevYes < threshold) { side = 'Yes'; sidePrice = yesPrice; }
    if (!side && noPrice >= threshold && prevNo < threshold) { side = 'No'; sidePrice = noPrice; }
    if (!side) continue;

    const sideWon = side === 'Yes' ? (winnerIndex === 0) : (winnerIndex === 1);
    const minsBeforeClose = (endTs - history[i].t) / 60;

    let minAfter = sidePrice;
    let reversed = false;
    let recovered = false;
    for (let j = i + 1; j < history.length; j++) {
      const lp = side === 'Yes' ? history[j].p : (1 - history[j].p);
      if (lp < minAfter) minAfter = lp;
      if (lp < threshold) reversed = true;
      if (reversed && lp >= threshold) recovered = true;
    }

    return {
      conditionId: '', question: '', ufcType: '',
      threshold, side, sideWon, entryPrice: sidePrice,
      minsBeforeClose, reversed, maxDrawdown: sidePrice - minAfter,
      minPriceAfter: minAfter, recoveredAfterReversal: recovered,
    };
  }
  return null;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Deep UFC Edge Analysis                               ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  // ── Phase 1: Fetch ALL UFC markets from Gamma API ─────────────
  console.log('  Phase 1: Searching Gamma API for UFC markets...\n');

  const ufcMarkets = new Map<string, any>();
  let offset = 0;
  let scanned = 0;

  while (offset < 10000) {
    const url = `${GAMMA_API}/markets?closed=true&limit=100&offset=${offset}&volume_num_min=50&end_date_min=2024-01-01T00:00:00Z`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json() as any[];
      if (!Array.isArray(data) || data.length === 0) break;
      scanned += data.length;

      for (const m of data) {
        if (!isUfcMarket(m.question || '')) continue;
        let outcomes: string[], tokenIds: string[], outcomePrices: number[];
        try {
          outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
          if (!Array.isArray(outcomes) || outcomes.length !== 2) continue;
          tokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [];
          if (tokenIds.length < 2) continue;
          outcomePrices = m.outcomePrices ? (typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices) : null;
          if (!outcomePrices || outcomePrices.length !== 2 || Math.max(...outcomePrices) < 0.9) continue;
        } catch { continue; }

        const winnerIndex = outcomePrices[0] > outcomePrices[1] ? 0 : 1;
        ufcMarkets.set(m.conditionId, {
          conditionId: m.conditionId, question: m.question || '',
          outcomes, tokenIds, outcomePrices,
          endDate: m.endDate || m.endDateIso || '',
          volume: m.volumeNum || parseFloat(m.volume) || 0,
          winner: outcomes[winnerIndex], winnerIndex,
          ufcType: classifyUfcType(m.question || ''),
        });
      }

      if (data.length < 100) break;
      offset += 100;
      if (offset % 500 === 0) console.log(`  Scanned ${scanned} | UFC found: ${ufcMarkets.size}`);
    } catch { break; }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`  Scanned: ${scanned} | UFC markets: ${ufcMarkets.size}\n`);

  // Type breakdown
  const typeCounts = new Map<string, number>();
  for (const m of ufcMarkets.values()) typeCounts.set(m.ufcType, (typeCounts.get(m.ufcType) || 0) + 1);
  console.log('  By type:');
  for (const [t, n] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${t.padEnd(18)} ${n}`);

  // ── Phase 2: Fetch price histories (7-day, 1-min) ─────────────
  console.log(`\n  Phase 2: Fetching 7-day price histories (1-min)...`);
  console.log(`  Est. time: ${Math.ceil(ufcMarkets.size * 0.7 / 60)} min\n`);

  const allTouches: TouchResult[] = [];
  let fetched = 0;
  let noData = 0;

  interface MarketWithHistory {
    market: any;
    history: PricePoint[];
  }
  const marketsWithData: MarketWithHistory[] = [];

  for (const market of ufcMarkets.values()) {
    const endTs = market.endDate ? Math.floor(new Date(market.endDate).getTime() / 1000) : 0;
    if (!endTs) { noData++; continue; }

    let history = await fetchPriceHistory(market.tokenIds[0], endTs, 604800);
    await sleep(RATE_LIMIT_MS);

    if (history.length < 5 && market.tokenIds[1]) {
      const noHist = await fetchPriceHistory(market.tokenIds[1], endTs, 604800);
      await sleep(RATE_LIMIT_MS);
      if (noHist.length >= 5) history = noHist.map(p => ({ t: p.t, p: Math.round((1 - p.p) * 1000) / 1000 }));
    }

    if (history.length < 5) { noData++; continue; }
    history.sort((a, b) => a.t - b.t);
    fetched++;
    marketsWithData.push({ market, history });

    for (const thresh of THRESHOLDS) {
      const touch = findFirstTouch(history, thresh, endTs, market.winnerIndex);
      if (touch) {
        touch.conditionId = market.conditionId;
        touch.question = market.question;
        touch.ufcType = market.ufcType;
        allTouches.push(touch);
      }
    }

    if (fetched % 10 === 0) {
      console.log(`  [${fetched + noData}/${ufcMarkets.size}] ✅${fetched} | ⚠${noData} nodata | Touches: ${allTouches.length} | ${market.question?.slice(0, 45)}`);
    }
  }

  console.log(`\n  Fetched: ${fetched} | No data: ${noData} | Touches: ${allTouches.length}\n`);

  // ── Phase 3: Analysis ─────────────────────────────────────────

  // 1. Market-level detail (deduplicated — one row per market at 75c)
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  1. ALL UFC MARKETS (one row per market, price at 5min before close)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${'W/L'} | ${'Type'.padEnd(16)} | ${'@5m'.padEnd(5)} | ${'@30m'.padEnd(5)} | ${'@60m'.padEnd(5)} | Market`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const { market, history } of marketsWithData) {
    const endTs = Math.floor(new Date(market.endDate).getTime() / 1000);
    const getP = (mins: number): number | null => {
      let best: PricePoint | null = null;
      let bestD = Infinity;
      for (const p of history) {
        const d = Math.abs((endTs - p.t) / 60 - mins);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best && bestD < 10 ? best.p : null;
    };

    const p5 = getP(5);
    const p30 = getP(30);
    const p60 = getP(60);
    const ref = p5 ?? p30 ?? history[history.length - 1]?.p ?? 0.5;
    const leadYes = ref > 0.5;
    const lp5 = p5 !== null ? (leadYes ? p5 : 1 - p5) : null;
    const lp30 = p30 !== null ? (leadYes ? p30 : 1 - p30) : null;
    const lp60 = p60 !== null ? (leadYes ? p60 : 1 - p60) : null;
    const won = leadYes ? (market.winnerIndex === 0) : (market.winnerIndex === 1);

    const icon = won ? '✅' : '❌';
    const f5 = lp5 !== null ? `${(lp5 * 100).toFixed(0)}c` : '?';
    const f30 = lp30 !== null ? `${(lp30 * 100).toFixed(0)}c` : '?';
    const f60 = lp60 !== null ? `${(lp60 * 100).toFixed(0)}c` : '?';
    console.log(`  ${icon} | ${market.ufcType.padEnd(16)} | ${f5.padEnd(5)} | ${f30.padEnd(5)} | ${f60.padEnd(5)} | ${(market.question || '?').slice(0, 50)}`);
  }

  // 2. FIRST-TOUCH WR BY THRESHOLD
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  2. FIRST-TOUCH WIN RATE (true crossing only)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  ${'Thresh'.padEnd(7)} | ${'N'.padEnd(4)} | ${'W'.padEnd(4)} | ${'WR%'.padEnd(7)} | ${'AvgEntry'.padEnd(9)} | ${'Mins→Res'.padEnd(9)} | ${'Rev%'.padEnd(6)} | ${'AvgDD'.padEnd(6)} | Edge    | EV/$100`);
  console.log(`  ${'-'.repeat(90)}`);

  for (const thresh of THRESHOLDS) {
    const t = allTouches.filter(x => x.threshold === thresh);
    if (t.length === 0) continue;
    const w = t.filter(x => x.sideWon).length;
    const wr = w / t.length;
    const avgE = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
    const avgMins = t.reduce((s, x) => s + x.minsBeforeClose, 0) / t.length;
    const rev = t.filter(x => x.reversed).length;
    const avgDD = t.reduce((s, x) => s + x.maxDrawdown, 0) / t.length;
    const edge = wr - avgE;
    const ev = wr * (100 / avgE - 100) - (1 - wr) * 100;
    const flag = t.length < 10 ? ' ⚠' : '';

    console.log(`  ${(thresh*100).toFixed(0)}c`.padEnd(8) + `| ${String(t.length).padEnd(4)} | ${String(w).padEnd(4)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgE*100).toFixed(1).padEnd(8)}c | ${avgMins.toFixed(0).padEnd(8)}m | ${(rev/t.length*100).toFixed(0).padEnd(5)}% | ${(avgDD*100).toFixed(1).padEnd(5)}c | ${edge >= 0 ? '+' : ''}${(edge*100).toFixed(1).padEnd(6)}% | $${ev.toFixed(2)}${flag}`);
  }

  // 3. BY UFC TYPE × THRESHOLD
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  3. BY UFC TYPE × THRESHOLD');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const ufcTypes = [...new Set(allTouches.map(t => t.ufcType))].sort();
  for (const thresh of [0.65, 0.75, 0.85, 0.95]) {
    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`  ${'Type'.padEnd(18)} | ${'N'.padEnd(4)} | ${'WR%'.padEnd(7)} | ${'AvgE'.padEnd(6)} | ${'Rev%'.padEnd(6)} | EV/$100`);
    console.log(`  ${'-'.repeat(55)}`);
    for (const ut of ufcTypes) {
      const t = allTouches.filter(x => x.threshold === thresh && x.ufcType === ut);
      if (t.length < 2) continue;
      const w = t.filter(x => x.sideWon).length;
      const wr = w / t.length;
      const avgE = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
      const rev = t.filter(x => x.reversed).length;
      const ev = wr * (100 / avgE - 100) - (1 - wr) * 100;
      const flag = t.length < 10 ? ' ⚠' : '';
      console.log(`  ${ut.padEnd(18)} | ${String(t.length).padEnd(4)} | ${(wr*100).toFixed(1).padEnd(6)}% | ${(avgE*100).toFixed(1).padEnd(5)}c | ${(rev/t.length*100).toFixed(0).padEnd(5)}% | $${ev.toFixed(2)}${flag}`);
    }
    console.log('');
  }

  // 4. REVERSAL DETAIL
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  4. REVERSAL DETAIL');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of [0.70, 0.80, 0.90]) {
    const t = allTouches.filter(x => x.threshold === thresh);
    if (t.length === 0) continue;
    const noRev = t.filter(x => !x.reversed);
    const rev = t.filter(x => x.reversed);
    const noRevW = noRev.filter(x => x.sideWon).length;
    const revW = rev.filter(x => x.sideWon).length;

    console.log(`  Entry at ${(thresh*100).toFixed(0)}c:`);
    console.log(`    No reversal: ${noRev.length} markets | WR ${noRev.length > 0 ? (noRevW/noRev.length*100).toFixed(1) : 0}%`);
    console.log(`    Reversed:    ${rev.length} markets | WR ${rev.length > 0 ? (revW/rev.length*100).toFixed(1) : 0}% | Recovered: ${rev.filter(x => x.recoveredAfterReversal).length}/${rev.length}`);
    if (rev.length > 0) {
      const avgDD = rev.reduce((s, x) => s + x.maxDrawdown, 0) / rev.length;
      console.log(`    Avg DD in reversals: ${(avgDD*100).toFixed(1)}c`);
    }
    console.log('');
  }

  // 5. ALL LOSSES
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  5. ALL LOSSES (at any threshold)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const losses = allTouches.filter(t => !t.sideWon);
  const lossMarkets = [...new Set(losses.map(l => l.conditionId))];

  console.log(`  ${lossMarkets.length} unique markets with losses:\n`);
  for (const cid of lossMarkets) {
    const marketLosses = losses.filter(l => l.conditionId === cid);
    const m = marketLosses[0];
    const thresholds = marketLosses.map(l => `${(l.threshold*100).toFixed(0)}c`).join(', ');
    console.log(`  ❌ [${m.ufcType}] ${m.question.slice(0, 55)}`);
    console.log(`     Lost at: ${thresholds} | Entry: ${(m.entryPrice*100).toFixed(0)}c | DD: ${(m.maxDrawdown*100).toFixed(0)}c | Rev: ${m.reversed ? 'Y' : 'N'}`);
  }

  // 6. PnL SIMULATION
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  6. PnL SIMULATION — $100 per first-touch');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const thresh of THRESHOLDS) {
    const t = allTouches.filter(x => x.threshold === thresh);
    if (t.length === 0) continue;
    const w = t.filter(x => x.sideWon).length;
    const avgE = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
    let pnl = 0;
    for (const x of t) pnl += x.sideWon ? (100 / x.entryPrice - 100) : -100;
    console.log(`  ${(thresh*100).toFixed(0)}c: ${t.length} markets | ${w}W/${t.length-w}L | WR ${(w/t.length*100).toFixed(1)}% | AvgEntry ${(avgE*100).toFixed(1)}c | PnL $${pnl.toFixed(0)} (${(pnl/(t.length*100)*100).toFixed(1)}% ROI)`);
  }

  // SUMMARY
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  UFC markets found: ${ufcMarkets.size} | With data: ${fetched}`);
  console.log(`  Unique markets with touches: ${new Set(allTouches.map(t => t.conditionId)).size}`);
  console.log(`  Total first-touch entries: ${allTouches.length}\n`);
  for (const thresh of THRESHOLDS) {
    const t = allTouches.filter(x => x.threshold === thresh);
    if (t.length === 0) continue;
    const w = t.filter(x => x.sideWon).length;
    const avgE = t.reduce((s, x) => s + x.entryPrice, 0) / t.length;
    const ev = (w/t.length) * (100/avgE - 100) - (1 - w/t.length) * 100;
    console.log(`  ${(thresh*100).toFixed(0)}c: ${t.length} mkts | WR ${(w/t.length*100).toFixed(1)}% | AvgEntry ${(avgE*100).toFixed(1)}c | EV $${ev.toFixed(2)}/bet`);
  }
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
