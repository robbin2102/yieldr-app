/**
 * analyze-allocations.ts  —  Trader Allocation & PnL Analysis
 *
 * Data sources:
 *   - MongoDB: ahf-copyTrades + ahf-copyTraders (bot activity)
 *   - MongoDB: ahf-edgeRankedTraders (pipeline edge scores)
 *
 * Retains full PnL analysis from analyze-pnl.ts and adds:
 *   - Edge score from pipeline (ahf-edgeRankedTraders)
 *   - Allocation scaling rules (30% per-position cap, % based)
 *   - Hard stop criteria (dormant >4d, edge <0.1, realized loss >$50)
 *   - Execution failure vs trader failure labeling
 *
 * Allocation Rules:
 *   Per-position cap: 30% of allocationUsdc (scales dynamically)
 *   SCALE_UP:   bot realized > +$20 AND edge > 0.15   → double allocation
 *   SCALE_DOWN: bot realized < -$25                    → halve allocation
 *   HARD_STOP:  bot realized < -$50 OR dormant >4d OR edge <0.1
 *
 * Usage:
 *   npx tsx analyze-allocations.ts                      # all traders
 *   npx tsx analyze-allocations.ts --trader T3-Active    # single trader
 *   npx tsx analyze-allocations.ts --min-usdc 10         # hide tiny markets in detail
 */

import mongoose from 'mongoose';
import { config }    from './src/config';
import { connectDB } from './src/db/connection';
import { CopyTrade }  from './src/db/models/CopyTrade';
import { CopyTrader } from './src/db/models/CopyTrader';

// ── CLI args ──────────────────────────────────────────────────────────────────
function argVal(n: string) { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i+1] : undefined; }
const FILTER_TRADER = argVal('trader');
const MIN_USDC      = parseFloat(argVal('min-usdc') ?? '5');

// ── formatting ────────────────────────────────────────────────────────────────
const pad  = (s: any, n: number) => String(s).slice(0, n).padEnd(n);
const rpad = (s: any, n: number) => String(s).slice(0, n).padStart(n);
const $    = (n: number) => !isFinite(n) || n === 0 ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const p3   = (n: number) => n > 0 ? n.toFixed(3) : '—';

// ── price cache (CLOB midpoint, overridden by portfolio prices where available) ─
const priceCache = new Map<string, number>();
async function fetchMidprice(id: string): Promise<number> {
  if (!id || priceCache.has(id)) return priceCache.get(id) ?? 0;
  try {
    const r: any = await (await fetch(`${config.clobApiBase}/midpoint?token_id=${id}`)).json();
    const p = parseFloat(r.mid ?? '0');
    priceCache.set(id, p);
    return p;
  } catch { return 0; }
}
async function batchPrices(ids: string[]) {
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i+10).map(fetchMidprice));
    if (i + 10 < ids.length) await new Promise(r => setTimeout(r, 150));
  }
}

// BTC short-duration markets predate copy-trade bot — exclude from portfolio totals.
// These are naturally excluded from bot cashflow PnL (no CopyTrade docs for them),
// but they'd inflate the portfolio total shown in NOTES if not filtered here.
const BTC_SHORT_MKT = /btc.*(5m|5min|15m|15min|up.?down)/i;

// ── fetch bot portfolio positions (data API) — more accurate than CLOB for ────
// resolved markets. Returns Map<tokenId, {curPrice, size}>.
// Overrides priceCache entries where portfolio shows a higher-confidence price.
// Excludes BTC 5m/15m short-duration markets (pre-copy-trade positions).
async function fetchBotPortfolioPrices(): Promise<Map<string, { curPrice: number; size: number }>> {
  const m = new Map<string, { curPrice: number; size: number }>();
  let btcExcluded = 0;
  try {
    const url = `${config.dataApiBase}/positions?user=${config.botWalletAddress}&sizeThreshold=0.01&limit=500`;
    const res = await fetch(url);
    if (!res.ok) { process.stdout.write(`HTTP ${res.status} `); return m; }
    const raw: any = await res.json();
    const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
    for (const p of items) {
      const tid   = p.asset ?? p.tokenId ?? '';
      const title = (p.title ?? p.outcome ?? '').toString();
      if (!tid) continue;
      if (BTC_SHORT_MKT.test(title)) { btcExcluded++; continue; }
      const cur  = parseFloat(p.curPrice ?? p.currentPrice ?? '0');
      const size = parseFloat(p.size ?? '0');
      m.set(tid, { curPrice: cur, size });
      // Seed priceCache — portfolio price is authoritative (handles resolved markets)
      if (cur > 0) priceCache.set(tid, cur);
    }
  } catch (e: any) {
    process.stdout.write(`WARN(${(e as any).message}) `);
  }
  if (btcExcluded > 0) process.stdout.write(`(${btcExcluded} BTC short-mkt excluded) `);
  return m;
}

// ── fetch all bot REDEEM events from Polymarket data API ─────────────────────
// Returns Map<assetKey → totalUsdcRedeemed>.
// assetKey is typically the outcome tokenId (returned in `asset` field by
// the data API). Falls back to `conditionId` if `asset` is absent.
async function fetchBotRedemptions(): Promise<Map<string, number>> {
  const byAsset = new Map<string, number>();
  let offset = 0;
  const limit = 500;
  process.stdout.write('Fetching bot redemption history from data API... ');
  try {
    while (true) {
      const url =
        `${config.dataApiBase}/activity?user=${config.botWalletAddress}` +
        `&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
      const res = await fetch(url);
      if (!res.ok) { process.stdout.write(`HTTP ${res.status} `); break; }
      const raw: any = await res.json();
      const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
      if (items.length === 0) break;

      for (const item of items) {
        if ((item.type ?? '').toUpperCase() !== 'REDEEM') continue;
        const key  = item.asset ?? item.tokenId ?? item.conditionId ?? '';
        const usdc = parseFloat(item.usdcSize ?? item.size ?? '0');
        if (key && usdc > 0) byAsset.set(key, (byAsset.get(key) ?? 0) + usdc);
      }

      if (items.length < limit) break;
      offset += limit;
    }
  } catch (e: any) {
    process.stdout.write(`WARN(${e.message}) `);
  }
  const total = [...byAsset.values()].reduce((s, v) => s + v, 0);
  console.log(`done — ${byAsset.size} redeemed positions, $${total.toFixed(2)} USDC total.`);
  return byAsset;
}

// ── derive shares when traderSize is missing ──────────────────────────────────
function shares(t: any): number {
  if ((t.traderSize ?? 0) > 0) return t.traderSize;
  return (t.traderPrice ?? 0) > 0 ? (t.traderBetUsdc ?? 0) / t.traderPrice : 0;
}

// ── fetch edge data from pipeline ────────────────────────────────────────────
interface EdgeData {
  edge: number;
  confidence: string;
  last_active: number | null;   // days since last active (float), from last_active_days_ago
  overall_rank: number;
  specialty: string;
}
async function fetchEdgeData(wallets: string[]): Promise<Map<string, EdgeData>> {
  const m = new Map<string, EdgeData>();
  try {
    const col = mongoose.connection.collection('ahf-edgeRankedTraders');
    const docs = await col.find({ wallet: { $in: wallets } }).toArray();
    for (const d of docs) {
      m.set((d.wallet as string).toLowerCase(), {
        edge: d.edge ?? 0,
        confidence: d.confidence ?? 'n/a',
        last_active: typeof d.last_active === 'number' ? d.last_active : null,
        overall_rank: d.overall_rank ?? 999,
        specialty: d.specialty ?? 'unknown',
      });
    }
    console.log(`Loaded edge data for ${m.size}/${wallets.length} traders from ahf-edgeRankedTraders.`);
  } catch (e: any) {
    console.warn(`WARN: Could not load edge data: ${e.message}`);
  }
  return m;
}

// ── types ─────────────────────────────────────────────────────────────────────
interface Stats {
  label: string; wallet: string;
  avgBet: number; baseBet: number; maxBet: number; alloc: number; spent: number;
  positionCap: number; // 30% of alloc
  // Trader cashflow (from MongoDB detected docs)
  tBought: number; tSold: number; tRedeemed: number; tOpenVal: number;
  tRealized: number; tTotal: number;
  // Bot cashflow (from MongoDB FILLED docs + data API redeems)
  bBought: number; bSold: number; bRedeemed: number; bOpenVal: number;
  bRealized: number; bTotal: number;
  // ROCE — % based, independent of allocation size
  traderROCE: number;  // tTotal / tBought  — trader's return on their own detected capital
  botROCE:    number;  // bTotal / allocationUsdc — our return on our allocated capital
  // Activity counts
  detected: number; filled: number; skips: Record<string, number>;
  // Missed conviction PnL
  missedPnl: number;
  // Pipeline edge data
  edgeScore:      number | null;
  edgeConfidence: string | null;
  edgeRank:       number | null;
  edgeSpecialty:  string | null;
  daysInactive:   number | null;
  // Failure classification
  failureType: 'EXEC_FAIL' | 'TRADER_FAIL' | 'NONE';
  action: string; reason: string;
}

// ── recommendation ────────────────────────────────────────────────────────────
// Hard stops (3, binary — bypass scaling entirely):
//   1. botROCE < -50%  — lost half our allocation, real capital floor
//   2. Dormant > 4d    — trader not active on their own book
//   3. Edge < 0.1      — statistical edge gone
//   (Specialty filter removed — handled at trader selection time, not runtime)
//
// Scaling (ROCE-based — traderROCE = tTotal/tBought, botROCE = bTotal/alloc):
//   SCALE_UP L2: traderROCE > +40% AND edge > 0.20  → double allocation
//   SCALE_UP L1: traderROCE > +20% AND edge > 0.15  → double allocation
//   SOFT_STOP:   traderROCE < -30%                   → $0 new entries, keep open
//   SCALE_DOWN:  traderROCE < -15%                   → halve allocation
//   WATCH:       traderROCE < 0                      → monitor, no change
//   CONTINUE:    traderROCE >= 0                     → hold allocation
//
// Execution gate: exec_skip_rate > 60% (excl. BELOW_AVG) → hold alloc, fix infra
function recommend(s: Stats): { action: string; reason: string; failureType: 'EXEC_FAIL' | 'TRADER_FAIL' | 'NONE' } {
  const allocCount    = s.skips['ALLOCATION_FULL'] ?? 0;
  const belowAvgCount = (s.skips['BELOW_AVG'] ?? 0) + (s.skips['GROUPED_BELOW_AVG'] ?? 0);
  const totalSkips    = Object.values(s.skips).reduce((a, b) => a + b, 0);
  // Exec-only rate: BELOW_AVG/GROUPED_BELOW_AVG are intentional filters, not execution failures.
  // Only real infrastructure failures (SNP, WIDE_SPREAD, PRICEDRIFT, ALLOC_FULL) count here.
  const execSkips    = totalSkips - belowAvgCount;
  const execSkipRate = s.detected > 0 ? execSkips / s.detected : 0;
  const belowAvgRate = s.detected > 0 ? belowAvgCount / s.detected : 0;
  // Top skip overall; top exec skip excludes intentional below-avg filters
  const execTopSkip = Object.entries(s.skips)
    .filter(([k]) => k !== 'BELOW_AVG' && k !== 'GROUPED_BELOW_AVG')
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  // ── HARD STOPS (4 only — binary, bypass everything) ──────────────────────

  // 1. Bot lost > 50% of allocation — real capital floor
  if (s.botROCE < -0.50) {
    return { action: '🔴 HARD_STOP', failureType: 'TRADER_FAIL',
      reason: `botROCE ${pct(s.botROCE)} — lost >50% of allocation ($${s.alloc})` };
  }
  // 2. Trader dormant > 4 days
  if (s.daysInactive !== null && s.daysInactive > 4) {
    return { action: '🔴 HARD_STOP', failureType: 'TRADER_FAIL',
      reason: `trader dormant ${s.daysInactive}d — not trading their own book` };
  }
  // 3. Edge collapsed
  if (s.edgeScore !== null && s.edgeScore < 0.1) {
    return { action: '🔴 HARD_STOP', failureType: 'TRADER_FAIL',
      reason: `edge collapsed to ${s.edgeScore.toFixed(3)} (confidence=${s.edgeConfidence})` };
  }

  // ── EXECUTION GATE — exec_skip_rate > 60% means infrastructure is failing ─
  // Excludes BELOW_AVG/GROUPED_BELOW_AVG (intentional filters, not failures).
  // Hold allocation at current level — do not penalise a good trader for our infra issues.
  if (execSkipRate > 0.60) {
    const topNote = execTopSkip ? ` (top: ${execTopSkip})` : '';
    return { action: '🟡 FIX_ENTRY [EXEC_FAIL]', failureType: 'EXEC_FAIL',
      reason: `exec_skip_rate ${pct(execSkipRate)} >60%${topNote} | below_avg ${pct(belowAvgRate)} (expected)` };
  }

  // ── EXEC_FAIL sub-case: allocation is the binding constraint ─────────────
  if (s.traderROCE > 0.20 && execTopSkip === 'ALLOCATION_FULL') {
    return { action: '🟡 INCREASE_ALLOC [EXEC_FAIL]', failureType: 'EXEC_FAIL',
      reason: `tROCE ${pct(s.traderROCE)} but allocation maxed ($${s.spent.toFixed(0)}/$${s.alloc}) — ${allocCount} trades missed` };
  }

  // ── SCALING (ROCE-based, trader-driven) ───────────────────────────────────

  // Soft stop — trader losing significantly
  if (s.traderROCE < -0.30) {
    return { action: '🔴 SOFT_STOP', failureType: 'TRADER_FAIL',
      reason: `tROCE ${pct(s.traderROCE)} < -30% — $0 new entries, keep open positions` };
  }
  // Scale down — trader losing, not yet soft-stop
  if (s.traderROCE < -0.15) {
    return { action: '🟠 SCALE_DOWN', failureType: 'TRADER_FAIL',
      reason: `tROCE ${pct(s.traderROCE)} < -15% — halve allocation ($${s.alloc} → $${Math.floor(s.alloc / 2)})` };
  }
  // Scale up (level 2) — strong performance + strong edge
  if (s.traderROCE > 0.40 && s.edgeScore !== null && s.edgeScore > 0.20) {
    return { action: '🟢 SCALE_UP_L2', failureType: 'NONE',
      reason: `tROCE ${pct(s.traderROCE)} >40%, edge=${s.edgeScore.toFixed(3)} >0.20 — double again ($${s.alloc} → $${Math.min(s.alloc * 2, s.alloc * 10)})` };
  }
  // Scale up (level 1)
  if (s.traderROCE > 0.20 && s.edgeScore !== null && s.edgeScore > 0.15) {
    return { action: '🟢 SCALE_UP', failureType: 'NONE',
      reason: `tROCE ${pct(s.traderROCE)} >20%, edge=${s.edgeScore.toFixed(3)} >0.15 — double allocation ($${s.alloc} → $${s.alloc * 2})` };
  }
  // Continue — profitable or neutral
  if (s.traderROCE >= 0) {
    const edgeNote = s.edgeScore != null ? ` | edge=${s.edgeScore.toFixed(3)}` : '';
    return { action: '🟢 CONTINUE', failureType: 'NONE',
      reason: `tROCE ${pct(s.traderROCE)}, bROCE ${pct(s.botROCE)}${edgeNote}` };
  }
  return { action: '🟡 WATCH', failureType: 'NONE',
    reason: `tROCE ${pct(s.traderROCE)}, bROCE ${pct(s.botROCE)} — monitor next cycle` };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();

  const traders = await CopyTrader.find(FILTER_TRADER ? { label: FILTER_TRADER } : {}).sort({ label: 1 }).lean();
  if (!traders.length) { console.log('No traders found'); process.exit(0); }

  const wallets = traders.map(t => t.wallet.toLowerCase());
  const allDocs = await CopyTrade.find({ sourceWallet: { $in: wallets } }).lean() as any[];
  console.log(`\nLoaded ${allDocs.length} trade docs from MongoDB across ${traders.length} trader(s).`);

  // Fetch prices for all known markets
  const uniqueIds = [...new Set(allDocs.map((t: any) => t.tokenId).filter(Boolean))];
  process.stdout.write(`Fetching prices for ${uniqueIds.length} markets... `);
  await batchPrices(uniqueIds);
  console.log('done.');

  // Fetch bot portfolio positions — overrides CLOB price for resolved markets
  process.stdout.write('Fetching bot portfolio positions... ');
  const botPortfolio = await fetchBotPortfolioPrices();
  console.log(`done — ${botPortfolio.size} open positions, $${[...botPortfolio.values()].reduce((s,p) => s + p.curPrice * p.size, 0).toFixed(2)} total value.`);

  // Fetch bot redemptions from data API (all time, for all traders)
  const botRedemptionMap = await fetchBotRedemptions();

  // Fetch edge data from pipeline
  const edgeMap = await fetchEdgeData(wallets);
  console.log();

  // ── compute per-trader stats ──────────────────────────────────────────────
  const allStats: Stats[] = [];

  for (const tr of traders) {
    const docs = allDocs.filter((t: any) => t.sourceWallet === tr.wallet.toLowerCase());

    // Categorise docs
    const buyDocs     = docs.filter((t: any) => t.side === 'BUY'  && t.skipReason !== 'NON_TRADE');
    const sellDocs    = docs.filter((t: any) => t.side === 'SELL' && t.skipReason !== 'NON_TRADE');
    const redeemDocs  = docs.filter((t: any) => t.skipReason === 'NON_TRADE' && (t.traderBetUsdc ?? 0) > 0);

    // ── Trader cashflow (what the trader actually did, detected by scanner) ──
    const tBought   = buyDocs   .reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);
    const tSold     = sellDocs  .reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);
    const tRedeemed = redeemDocs.reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);

    // Trader net shares per market → open value at current price
    const tNetByMkt = new Map<string, number>();
    for (const t of buyDocs)  tNetByMkt.set(t.tokenId ?? '', (tNetByMkt.get(t.tokenId ?? '') ?? 0) + shares(t));
    for (const t of sellDocs) tNetByMkt.set(t.tokenId ?? '', (tNetByMkt.get(t.tokenId ?? '') ?? 0) - shares(t));
    let tOpenVal = 0;
    for (const [id, sh] of tNetByMkt) {
      if (sh <= 0) continue;
      const cur = priceCache.get(id) ?? 0;
      if (cur > 0.01) tOpenVal += sh * cur; // include resolved (cur≈1) and open
    }

    const tRealized = -tBought + tSold + tRedeemed;
    const tTotal    = tRealized + tOpenVal;

    // ── Bot cashflow (FILLED docs + data API redemptions) ────────────────────
    const bBuyFills  = docs.filter((t: any) => t.side === 'BUY'  && t.status === 'FILLED');
    const bSellFills = docs.filter((t: any) => t.side === 'SELL' && t.status === 'FILLED');
    const bBought    = bBuyFills .reduce((s: number, t: any) => s + (t.filledUsdc ?? 0), 0);
    const bSold      = bSellFills.reduce((s: number, t: any) => s + (t.filledUsdc ?? 0), 0);

    // Trader tokenIds the bot actually filled on — used to attribute redemptions
    const bTraderTokenIds = new Set(bBuyFills.map((t: any) => t.tokenId).filter(Boolean));

    // Bot redeemed: sum USDC from data API REDEEM events for this trader's tokens
    let bRedeemed = 0;
    for (const tid of bTraderTokenIds) {
      bRedeemed += botRedemptionMap.get(tid) ?? 0;
    }

    const bNetByMkt  = new Map<string, number>();
    for (const t of bBuyFills)  bNetByMkt.set(t.tokenId ?? '', (bNetByMkt.get(t.tokenId ?? '') ?? 0) + (t.filledSize ?? 0));
    for (const t of bSellFills) bNetByMkt.set(t.tokenId ?? '', (bNetByMkt.get(t.tokenId ?? '') ?? 0) - (t.filledSize ?? 0));
    let bOpenVal = 0;
    for (const [id, sh] of bNetByMkt) {
      if (sh <= 0) continue;
      // Skip tokens already redeemed — their value is captured in bRedeemed
      if (botRedemptionMap.has(id)) continue;
      const cur = priceCache.get(id) ?? 0;
      if (cur > 0.01) bOpenVal += sh * cur;
    }
    const bRealized = -bBought + bSold;
    const bTotal    = bRealized + bOpenVal + bRedeemed;

    // ── Skip counts (excluding NON_TRADE from detect count) ───────────────────
    const skips: Record<string, number> = {};
    let detected = 0, filled = 0;
    for (const t of docs) {
      if (t.skipReason === 'NON_TRADE') continue;
      detected++;
      if (t.status === 'FILLED') filled++;
      if (t.status === 'SKIPPED' && t.skipReason) skips[t.skipReason] = (skips[t.skipReason] ?? 0) + 1;
    }

    // ── Missed conviction PnL (30% of alloc as position cap) ──────────────────
    const MISSED = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
    const positionCap = tr.allocationUsdc * 0.30;
    let missedPnl = 0;
    for (const t of buyDocs) {
      if (t.status !== 'SKIPPED' || (t.traderBetUsdc ?? 0) < tr.avgBet || !MISSED.has(t.skipReason)) continue;
      const cur = priceCache.get(t.tokenId ?? '') ?? 0;
      if (!cur || !(t.traderPrice ?? 0)) continue;
      const hyp = Math.min(positionCap, tr.baseBetUsdc * ((t.traderBetUsdc ?? 0) / tr.avgBet));
      missedPnl += (hyp / t.traderPrice) * (cur - t.traderPrice);
    }

    // ── Edge data from pipeline ───────────────────────────────────────────────
    // last_active in ahf-edgeRankedTraders = last_active_days_ago from profile-trader-v3
    // It is already the number of days since the trader was last active (a float).
    // Do NOT treat as a timestamp — just use it directly.
    const edge = edgeMap.get(tr.wallet.toLowerCase());
    const daysInactive: number | null =
      edge?.last_active != null && typeof edge.last_active === 'number'
        ? Math.floor(edge.last_active)
        : null;

    // traderROCE = trader's return on their own detected capital (tTotal / tBought)
    // — measures how well the TRADER is performing in trades we can see, independent of our allocation size
    // botROCE   = our return on our allocated capital (bTotal / allocationUsdc)
    // — measures how much WE made; used only for the hard floor check
    const traderROCE = tBought > 0 ? tTotal / tBought : 0;
    const botROCE    = tr.allocationUsdc > 0 ? bTotal / tr.allocationUsdc : 0;

    const s: Stats = {
      label: tr.label, wallet: tr.wallet,
      avgBet: tr.avgBet, baseBet: tr.baseBetUsdc, maxBet: tr.maxBetUsdc,
      alloc: tr.allocationUsdc, spent: tr.spentUsdc,
      positionCap,
      tBought, tSold, tRedeemed, tOpenVal, tRealized, tTotal,
      bBought, bSold, bRedeemed, bOpenVal, bRealized, bTotal,
      traderROCE, botROCE,
      detected, filled, skips, missedPnl,
      edgeScore:      edge?.edge ?? null,
      edgeConfidence: edge?.confidence ?? null,
      edgeRank:       edge?.overall_rank ?? null,
      edgeSpecialty:  edge?.specialty ?? null,
      daysInactive,
      failureType: 'NONE',
      action: '', reason: '',
    };
    const rec    = recommend(s);
    s.action     = rec.action;
    s.reason     = rec.reason;
    s.failureType = rec.failureType;
    allStats.push(s);
  }

  // ══ 1. GRAND SUMMARY TABLE ═════════════════════════════════════════════════
  const W = 170;
  console.log('═'.repeat(W));
  console.log('  COPY TRADING PERFORMANCE & ALLOCATION ANALYSIS  (since monitoring started — MongoDB + pipeline data)');
  console.log('═'.repeat(W));
  console.log(
    '\n  ' + pad('Trader', 22) +
    rpad('T.Bought', 10) + rpad('T.Sold', 9) + rpad('T.Redeem', 10) +
    rpad('T.OpenVal', 10) + rpad('T.Realized', 12) + rpad('T.Total', 10) +
    rpad('Det/Fill', 9) +
    rpad('B.Cost', 9) + rpad('B.Redeem', 10) + rpad('B.PnL', 9) +
    rpad('Edge', 7) + rpad('Missed', 9) + '  Action'
  );
  console.log('  ' + '─'.repeat(W - 2));

  let gTB=0, gTS=0, gTR=0, gTO=0, gTRlz=0, gTT=0, gBC=0, gBRd=0, gBP=0, gM=0;
  for (const s of allStats) {
    console.log(
      '  ' + pad(s.label, 22) +
      rpad('$'+s.tBought.toFixed(0),   10) + rpad('$'+s.tSold.toFixed(0),     9) +
      rpad('$'+s.tRedeemed.toFixed(0), 10) + rpad('$'+s.tOpenVal.toFixed(0),  10) +
      rpad($(s.tRealized), 12) + rpad($(s.tTotal), 10) +
      rpad(`${s.filled}/${s.detected}`, 9) +
      rpad('$'+s.bBought.toFixed(0), 9) +
      rpad(s.bRedeemed > 0 ? '$'+s.bRedeemed.toFixed(0) : '—', 10) +
      rpad($(s.bTotal), 9) +
      rpad(s.edgeScore != null ? s.edgeScore.toFixed(3) : '—', 7) +
      rpad($(s.missedPnl), 9) + '  ' + s.action
    );
    gTB+=s.tBought; gTS+=s.tSold; gTR+=s.tRedeemed; gTO+=s.tOpenVal;
    gTRlz+=s.tRealized; gTT+=s.tTotal; gBC+=s.bBought; gBRd+=s.bRedeemed; gBP+=s.bTotal; gM+=s.missedPnl;
  }
  console.log('  ' + '─'.repeat(W - 2));
  console.log(
    '  ' + pad('TOTAL', 22) +
    rpad('$'+gTB.toFixed(0), 10) + rpad('$'+gTS.toFixed(0), 9) +
    rpad('$'+gTR.toFixed(0), 10) + rpad('$'+gTO.toFixed(0), 10) +
    rpad($(gTRlz), 12) + rpad($(gTT), 10) +
    '         ' +
    rpad('$'+gBC.toFixed(0), 9) +
    rpad(gBRd > 0 ? '$'+gBRd.toFixed(0) : '—', 10) +
    rpad($(gBP), 9) + rpad($(gM), 9)
  );

  // ══ 2. ALLOCATION MANAGEMENT ════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  ALLOCATION MANAGEMENT');
  console.log('═'.repeat(W));
  console.log('\n  Rules (tROCE = trader\'s return on their own detected capital = tTotal/tBought):');
  console.log('    Per-position cap:  30% of allocationUsdc');
  console.log('    SCALE_UP L1:       tROCE > +20% AND edge > 0.15  → double allocation');
  console.log('    SCALE_UP L2:       tROCE > +40% AND edge > 0.20  → double again (max 10x start)');
  console.log('    SCALE_DOWN:        tROCE < -15%                   → halve allocation');
  console.log('    SOFT_STOP:         tROCE < -30%                   → $0 new entries, keep open positions');
  console.log('    HARD_STOP #1:      bROCE < -50% (bTotal/alloc)   → close all (real capital floor)');
  console.log('    HARD_STOP #2:      dormant > 4d                   → close all');
  console.log('    HARD_STOP #3:      edge    < 0.1                  → close all');
  console.log('    EXEC_GATE:         exec_skip_rate > 60% (excl. BELOW_AVG) → hold alloc, fix execution');
  console.log();
  console.log(
    '  ' + pad('Trader', 22) +
    rpad('Alloc', 8) + rpad('Spent', 8) + rpad('PosCap', 8) +
    rpad('tROCE', 8) + rpad('bROCE', 8) +
    rpad('Edge', 7) + rpad('Specialty', 12) + rpad('Inactive', 9) +
    '  ' + pad('Failure', 12) + 'Next Alloc'
  );
  console.log('  ' + '─'.repeat(W - 2));
  for (const s of allStats) {
    const inactiveLbl = s.daysInactive != null ? `${s.daysInactive}d` : '—';
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const newAlloc =
      s.action.includes('HARD_STOP') || s.action.includes('SOFT_STOP')
        ? '$0 (close/stop)' :
      s.action.includes('SCALE_DOWN')
        ? `$${Math.floor(s.alloc / 2)}` :
      s.action.includes('SCALE_UP')
        ? `$${Math.min(s.alloc * 2, s.alloc * 10)} (×2)` :
      s.action.includes('INCREASE_ALLOC')
        ? `$${s.alloc * 2} (×2)` :
      `$${s.alloc} (hold)`;
    console.log(
      '  ' + pad(s.label, 22) +
      rpad('$'+s.alloc, 8) + rpad('$'+s.spent.toFixed(0), 8) + rpad('$'+s.positionCap.toFixed(0), 8) +
      rpad(pct(s.traderROCE), 8) + rpad(pct(s.botROCE), 8) +
      rpad(s.edgeScore != null ? s.edgeScore.toFixed(3) : '—', 7) +
      rpad(s.edgeSpecialty ?? '—', 12) +
      rpad(inactiveLbl, 9) + '  ' +
      pad(s.failureType, 12) + newAlloc
    );
  }

  // ══ 3. RECOMMENDATIONS ════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  RECOMMENDATIONS');
  console.log('═'.repeat(W));
  for (const s of allStats) {
    const skipSummary = Object.entries(s.skips).sort((a,b)=>b[1]-a[1]).slice(0,5)
      .map(([k,v]) => `${k}:${v}`).join('  ');
    const ba  = (s.skips['BELOW_AVG'] ?? 0) + (s.skips['GROUPED_BELOW_AVG'] ?? 0);
    const tot = Object.values(s.skips).reduce((a,b)=>a+b, 0);
    const execRate = s.detected > 0 ? ((tot - ba) / s.detected * 100).toFixed(0) : '0';
    const baRate   = s.detected > 0 ? (ba / s.detected * 100).toFixed(0) : '0';
    const rateNote = tot > 0 ? `  [exec_skip: ${execRate}%  below_avg: ${baRate}%]` : '';
    console.log(`\n  ${s.action.padEnd(30)}  ${pad(s.label, 22)}  ${s.reason}`);
    if (skipSummary) console.log(`  ${''.padEnd(30)}  ${''.padEnd(22)}  Skips → ${skipSummary}${rateNote}`);
  }

  // ══ 4. PER-TRADER DETAIL ══════════════════════════════════════════════════
  for (const s of allStats) {
    const docs = allDocs.filter((t: any) => t.sourceWallet === s.wallet.toLowerCase());

    // Group by market
    const byMkt = new Map<string, any[]>();
    for (const t of docs) {
      const k = t.tokenId || `nt_${t.title}`;
      if (!byMkt.has(k)) byMkt.set(k, []);
      byMkt.get(k)!.push(t);
    }

    interface Row {
      title: string; out: string; cur: number;
      tBuyUsdc: number; tSellUsdc: number; tVwap: number;
      bBuyUsdc: number; bVwap: number; bPnl: number;
      missedPnl: number; skipStr: string;
    }
    const rows: Row[] = [];

    for (const [tokenId, mts] of byMkt) {
      const cur = priceCache.get(tokenId) ?? 0;
      const buys  = mts.filter((t: any) => t.side === 'BUY'  && t.skipReason !== 'NON_TRADE');
      const sells = mts.filter((t: any) => t.side === 'SELL' && t.skipReason !== 'NON_TRADE');

      const tBuyUsdc   = buys .reduce((a: number, t: any) => a + (t.traderBetUsdc ?? 0), 0);
      const tSellUsdc  = sells.reduce((a: number, t: any) => a + (t.traderBetUsdc ?? 0), 0);
      const tBuyShares = buys .reduce((a: number, t: any) => a + shares(t), 0);
      const tVwap      = tBuyShares > 0 ? tBuyUsdc / tBuyShares : 0;

      const bBuyFills  = mts.filter((t: any) => t.side === 'BUY'  && t.status === 'FILLED');
      const bSellFills = mts.filter((t: any) => t.side === 'SELL' && t.status === 'FILLED');
      const bBuyUsdc   = bBuyFills .reduce((a: number, t: any) => a + (t.filledUsdc ?? 0), 0);
      const bSellUsdc  = bSellFills.reduce((a: number, t: any) => a + (t.filledUsdc ?? 0), 0);
      const bNetSh     = bBuyFills.reduce((a: number, t: any) => a + (t.filledSize ?? 0), 0)
                       - bSellFills.reduce((a: number, t: any) => a + (t.filledSize ?? 0), 0);
      const bVwap      = bBuyFills.length > 0
        ? bBuyUsdc / bBuyFills.reduce((a: number, t: any) => a + (t.filledSize ?? 0), 0)
        : 0;
      // For bPnl: exclude open value for tokens already redeemed (cash in bRedeemed)
      const bAlreadyRedeemed = botRedemptionMap.has(tokenId);
      const bMktRedeemed = botRedemptionMap.get(tokenId) ?? 0;
      const bPnl = -bBuyUsdc + bSellUsdc + bMktRedeemed +
        (!bAlreadyRedeemed && bNetSh > 0 && cur > 0.01 ? bNetSh * cur : 0);

      const MISSED = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
      let mktMissed = 0;
      for (const t of buys) {
        if (t.status !== 'SKIPPED' || (t.traderBetUsdc ?? 0) < s.avgBet || !MISSED.has(t.skipReason)) continue;
        if (!cur || !(t.traderPrice ?? 0)) continue;
        const hyp = Math.min(s.positionCap, s.baseBet * ((t.traderBetUsdc ?? 0) / s.avgBet));
        mktMissed += (hyp / t.traderPrice) * (cur - t.traderPrice);
      }

      const skipAgg: Record<string, number> = {};
      for (const t of mts) if (t.status === 'SKIPPED' && t.skipReason) skipAgg[t.skipReason] = (skipAgg[t.skipReason] ?? 0) + 1;
      const skipStr = Object.entries(skipAgg).sort((a,b)=>b[1]-a[1]).slice(0,3)
        .map(([k,v]) => `${k.replace('ALLOCATION_FULL','ALLOC').replace('SELL_NO_POSITION','SNP').replace('GROUPED_BELOW_AVG','GRP').replace('PRICEDRIFT_FAILED','DRIFT').replace('WIDE_SPREAD','WIDE')}:${v}`)
        .join(' ');

      if (tBuyUsdc + tSellUsdc < MIN_USDC && bBuyUsdc === 0) continue;

      rows.push({
        title: (mts[0].title ?? 'Unknown').slice(0, 44), out: (mts[0].outcome ?? '—').slice(0, 4),
        cur, tBuyUsdc, tSellUsdc, tVwap, bBuyUsdc, bVwap, bPnl, missedPnl: mktMissed, skipStr,
      });
    }

    rows.sort((a,b) => (b.tBuyUsdc + b.tSellUsdc) - (a.tBuyUsdc + a.tSellUsdc));
    if (!rows.length) continue;

    console.log('\n' + '═'.repeat(W));
    console.log(
      `  ${s.label}` +
      `  |  T.Realized: ${$(s.tRealized)}  T.Total: ${$(s.tTotal)}` +
      `  |  Bot: ${$(s.bTotal)}  Missed: ${$(s.missedPnl)}`
    );
    console.log('─'.repeat(W));
    console.log(
      '  ' + pad('Market', 44) + '  ' + pad('Out', 4) + '  ' +
      rpad('Cur', 6) + '  ' + rpad('T.Entry', 7) + '  ' +
      rpad('T.Bought', 9) + '  ' + rpad('T.Sold', 8) + '  ' +
      rpad('B.Entry', 7) + '  ' + rpad('B.PnL', 8) + '  ' +
      rpad('Missed', 8) + '  Skips'
    );
    console.log('  ' + '─'.repeat(W - 2));

    for (const r of rows.slice(0, 15)) {
      console.log(
        '  ' + pad(r.title, 44) + '  ' + pad(r.out, 4) + '  ' +
        rpad(r.cur > 0 ? r.cur.toFixed(3) : '—', 6) + '  ' +
        rpad(p3(r.tVwap), 7) + '  ' +
        rpad('$'+r.tBuyUsdc.toFixed(0), 9) + '  ' +
        rpad(r.tSellUsdc > 0 ? '$'+r.tSellUsdc.toFixed(0) : '—', 8) + '  ' +
        rpad(r.bBuyUsdc > 0 ? p3(r.bVwap) : '—', 7) + '  ' +
        rpad(r.bBuyUsdc > 0 ? $(r.bPnl) : '—', 8) + '  ' +
        rpad(r.missedPnl !== 0 ? $(r.missedPnl) : '—', 8) + '  ' +
        r.skipStr
      );
    }
    if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more markets`);
  }

  // ══ notes ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  NOTES');
  console.log('  · All data from MongoDB — covers activity since bot started monitoring each trader.');
  console.log('  · Edge scores from ahf-edgeRankedTraders (pipeline). Missing = trader not in ranked pool.');
  console.log('  · Per-position cap: 30% of allocationUsdc (not fixed $). Scales dynamically.');
  console.log('  · Failure types: EXEC_FAIL = our side (allocation/spread/entry), TRADER_FAIL = trader issue.');
  console.log('  · HARD_STOP triggers: bot realized < -$50, dormant >4d, edge < 0.1.');
  console.log('  · Missed$: est. PnL on above-avgBet trades blocked by ALLOC_FULL/PRICEDRIFT/WIDE_SPREAD.');
  console.log('  · To reduce SELL_NO_POSITION/WIDE_SPREAD: set DETECTOR_INTERVAL_MS=5000 in Railway.');
  console.log('  · Grouped BELOW_AVG scanner: GROUP_SCAN_INTERVAL_MS (10m) / GROUP_SCAN_WINDOW_MS (30m).');
  console.log('  · B.Redeem: USDC bot received from resolved YES positions, fetched from Polymarket data API.');
  console.log(`  · Portfolio total value: $${[...botPortfolio.values()].reduce((s,p) => s + p.curPrice * p.size, 0).toFixed(2)} across ${botPortfolio.size} open positions.`);
  console.log('═'.repeat(W) + '\n');

  await mongoose.disconnect();
}

main().catch(console.error);
