/**
 * analyze-pnl.ts  —  Trader vs Bot PnL Analysis  (v2)
 *
 * Trader PnL: activity cashflow from Polymarket API
 *   realizedPnl = − Σ(BUY usdcSize) + Σ(SELL usdcSize) + Σ(REDEEM usdcSize)
 *   totalPnl    = realizedPnl + currentValue(open positions)
 *
 * Bot PnL: same cashflow method, using MongoDB FILLED docs
 *   realizedPnl = − Σ(filledUsdc BUY) + Σ(filledUsdc SELL)
 *   totalPnl    = realizedPnl + Σ(netShares × curPrice)
 *
 * Output:
 *   1. Grand summary table  — one row per trader
 *   2. Recommendations      — CONTINUE / INCREASE_ALLOC / FIX_ENTRY / WATCH / STOP
 *   3. Per-trader detail    — top markets, missed trades, skip breakdown
 *
 * Usage:
 *   npx tsx analyze-pnl.ts                         # all traders, all time
 *   npx tsx analyze-pnl.ts --trader T3-Active       # single trader
 *   npx tsx analyze-pnl.ts --days 30                # limit activity window
 *   npx tsx analyze-pnl.ts --min-usdc 10            # hide tiny markets in details
 */

import mongoose from 'mongoose';
import { config }    from './src/config';
import { connectDB } from './src/db/connection';
import { CopyTrade }  from './src/db/models/CopyTrade';
import { CopyTrader } from './src/db/models/CopyTrader';

const DATA_API = config.dataApiBase || 'https://data-api.polymarket.com';

// ── CLI args ──────────────────────────────────────────────────────────────────
function argVal(n: string) { const i = process.argv.indexOf(`--${n}`); return i !== -1 ? process.argv[i+1] : undefined; }
const FILTER_TRADER = argVal('trader');
const FILTER_DAYS   = parseInt(argVal('days')     ?? '0');
const MIN_USDC      = parseFloat(argVal('min-usdc') ?? '5');

// ── formatting ────────────────────────────────────────────────────────────────
const pad  = (s: any, n: number) => String(s).slice(0,n).padEnd(n);
const rpad = (s: any, n: number) => String(s).slice(0,n).padStart(n);
const $    = (n: number) => !isFinite(n) ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);
const p3   = (n: number) => n > 0 ? n.toFixed(3) : '—';

// ── price cache ───────────────────────────────────────────────────────────────
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
    if (i+10 < ids.length) await new Promise(r => setTimeout(r, 150));
  }
}

// ── Polymarket API helpers ────────────────────────────────────────────────────
async function fetchActivity(wallet: string, sinceMs: number): Promise<any[]> {
  const result: any[] = [];
  let offset = 0;
  while (true) {
    const url = `${DATA_API}/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const raw: any = await (await fetch(url)).json();
    const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
    if (!items.length) break;
    for (const t of items) {
      if (sinceMs > 0 && parseFloat(t.timestamp ?? '0') * 1000 < sinceMs) return result;
      result.push(t);
    }
    if (items.length < 500) break;
    offset += 500;
  }
  return result;
}

async function fetchPositions(wallet: string): Promise<any[]> {
  const raw: any = await (await fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`)).json();
  return Array.isArray(raw) ? raw : (raw.data ?? []);
}

// ── types ─────────────────────────────────────────────────────────────────────
interface Stats {
  label: string; wallet: string;
  avgBet: number; baseBet: number; maxBet: number; alloc: number; spent: number;
  // Trader cashflow
  tBought: number; tSold: number; tRedeemed: number; tOpenVal: number;
  tRealized: number; tTotal: number;
  // Bot cashflow
  bBought: number; bSold: number; bOpenVal: number;
  bRealized: number; bTotal: number;
  // Activity
  detected: number; filled: number; skips: Record<string, number>;
  // Missed conviction
  missedPnl: number;
  // Recommendation
  action: string; reason: string;
}

// ── recommendation engine ─────────────────────────────────────────────────────
function recommend(s: Stats): { action: string; reason: string } {
  const topSkip = Object.entries(s.skips).sort((a,b) => b[1]-a[1])[0]?.[0] ?? '';
  const capRate = s.detected > 0 ? s.filled / s.detected : 0;

  if (s.tTotal < -1000 && s.tRealized < -200) {
    return { action: '🔴 STOP',          reason: `trader consistently losing: realized ${$(s.tRealized)}` };
  }
  if (s.bTotal < -20 && s.tTotal < -200) {
    return { action: '🔴 STOP',          reason: `both trader and bot losing` };
  }
  if (s.tTotal > 100 && topSkip === 'ALLOCATION_FULL') {
    return { action: '🟡 INCREASE_ALLOC',reason: `trader ${$(s.tTotal)} but allocation maxed ($${s.spent.toFixed(0)}/$${s.alloc})` };
  }
  if (s.tTotal > 50 && (s.skips['SELL_NO_POSITION'] ?? 0) > (s.detected * 0.5)) {
    return { action: '🟡 FIX_ENTRY',     reason: `trader ${$(s.tTotal)} but bot missing buy entries (>50% SELL_NO_POSITION)` };
  }
  if (s.tTotal > 50 && topSkip === 'WIDE_SPREAD' && capRate < 0.05) {
    return { action: '🟡 WATCH',         reason: `trader ${$(s.tTotal)} but trades too illiquid to copy` };
  }
  if (s.tTotal > 50 && capRate >= 0.05) {
    return { action: '🟢 CONTINUE',      reason: `trader ${$(s.tTotal)}, bot ${$(s.bTotal)}, capture ${(capRate*100).toFixed(0)}%` };
  }
  if (s.tRealized > 0 && s.tTotal > 0) {
    return { action: '🟢 CONTINUE',      reason: `trader profitable: realized ${$(s.tRealized)}, total ${$(s.tTotal)}` };
  }
  return { action: '🟡 WATCH',           reason: `mixed signals — tTotal ${$(s.tTotal)}, bot ${$(s.bTotal)}` };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();
  const now   = Date.now();
  const since = FILTER_DAYS > 0 ? now - FILTER_DAYS * 86_400_000 : 0;

  const traders = await CopyTrader.find(FILTER_TRADER ? { label: FILTER_TRADER } : {}).sort({ label: 1 }).lean();
  if (!traders.length) { console.log('No traders found'); process.exit(0); }

  const wallets = traders.map(t => t.wallet.toLowerCase());
  const allBotTrades = await CopyTrade.find({ sourceWallet: { $in: wallets } }).lean() as any[];

  // Prices for all known markets
  const uniqueIds = [...new Set(allBotTrades.map((t: any) => t.tokenId).filter(Boolean))];
  process.stdout.write(`\nFetching prices for ${uniqueIds.length} markets... `);
  await batchPrices(uniqueIds);
  console.log('done.');

  // Fetch activity + positions per trader
  console.log(`Fetching activity for ${traders.length} trader(s)...\n`);
  const traderApi: Record<string, { acts: any[]; positions: any[] }> = {};
  for (const t of traders) {
    process.stdout.write(`  ${t.label}... `);
    try {
      const [acts, positions] = await Promise.all([fetchActivity(t.wallet, since), fetchPositions(t.wallet)]);
      traderApi[t.wallet] = { acts, positions };
      console.log(`${acts.length} activities, ${positions.length} positions`);
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
      traderApi[t.wallet] = { acts: [], positions: [] };
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ── compute per-trader stats ──────────────────────────────────────────────
  const allStats: Stats[] = [];

  for (const tr of traders) {
    const { acts, positions } = traderApi[tr.wallet];
    const botTrades = allBotTrades.filter((t: any) => t.sourceWallet === tr.wallet.toLowerCase());

    // Trader cashflow
    const tBought   = acts.filter(a => a.type === 'TRADE' && a.side === 'BUY') .reduce((s, a) => s + parseFloat(a.usdcSize ?? '0'), 0);
    const tSold     = acts.filter(a => a.type === 'TRADE' && a.side === 'SELL').reduce((s, a) => s + parseFloat(a.usdcSize ?? '0'), 0);
    const tRedeemed = acts.filter(a => a.type === 'REDEEM')                    .reduce((s, a) => s + parseFloat(a.usdcSize ?? '0'), 0);
    const tOpenVal  = positions.filter(p => { const c = parseFloat(p.curPrice ?? p.currentPrice ?? '0'); return c > 0.01 && c < 0.99; })
                               .reduce((s, p) => s + parseFloat(p.currentValue ?? '0'), 0);
    const tRealized = -tBought + tSold + tRedeemed;
    const tTotal    = tRealized + tOpenVal;

    // Bot cashflow from MongoDB fills
    const bBuyFills  = botTrades.filter((t: any) => t.side === 'BUY'  && t.status === 'FILLED');
    const bSellFills = botTrades.filter((t: any) => t.side === 'SELL' && t.status === 'FILLED');
    const bBought    = bBuyFills .reduce((s: number, t: any) => s + (t.filledUsdc ?? 0), 0);
    const bSold      = bSellFills.reduce((s: number, t: any) => s + (t.filledUsdc ?? 0), 0);

    // Bot net shares per market → open value
    const netByMarket = new Map<string, number>();
    for (const t of bBuyFills)  netByMarket.set(t.tokenId ?? '', (netByMarket.get(t.tokenId ?? '') ?? 0) + (t.filledSize ?? 0));
    for (const t of bSellFills) netByMarket.set(t.tokenId ?? '', (netByMarket.get(t.tokenId ?? '') ?? 0) - (t.filledSize ?? 0));
    let bOpenVal = 0;
    for (const [id, sh] of netByMarket) if (sh > 0) bOpenVal += sh * (priceCache.get(id) ?? 0);
    const bRealized = -bBought + bSold;
    const bTotal    = bRealized + bOpenVal;

    // Skip counts
    const skips: Record<string, number> = {};
    let detected = 0, filled = 0;
    for (const t of botTrades) {
      if (t.skipReason === 'NON_TRADE') continue;
      detected++;
      if (t.status === 'FILLED') filled++;
      if (t.status === 'SKIPPED' && t.skipReason) skips[t.skipReason] = (skips[t.skipReason] ?? 0) + 1;
    }

    // Missed conviction PnL (above avgBet, blocked by execution filters)
    const MISSED = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
    let missedPnl = 0;
    for (const t of botTrades) {
      if (t.side !== 'BUY' || t.status !== 'SKIPPED') continue;
      if ((t.traderBetUsdc ?? 0) < tr.avgBet || !MISSED.has(t.skipReason)) continue;
      const cur = priceCache.get(t.tokenId ?? '') ?? 0;
      if (!cur || !(t.traderPrice ?? 0)) continue;
      const hyp = Math.min(tr.maxBetUsdc, tr.baseBetUsdc * ((t.traderBetUsdc ?? 0) / tr.avgBet));
      missedPnl += (hyp / t.traderPrice) * (cur - t.traderPrice);
    }

    const s: Stats = {
      label: tr.label, wallet: tr.wallet,
      avgBet: tr.avgBet, baseBet: tr.baseBetUsdc, maxBet: tr.maxBetUsdc,
      alloc: tr.allocationUsdc, spent: tr.spentUsdc,
      tBought, tSold, tRedeemed, tOpenVal, tRealized, tTotal,
      bBought, bSold, bOpenVal, bRealized, bTotal,
      detected, filled, skips, missedPnl,
      action: '', reason: '',
    };
    const rec = recommend(s);
    s.action = rec.action;
    s.reason = rec.reason;
    allStats.push(s);
  }

  // ══ 1. GRAND SUMMARY TABLE ═════════════════════════════════════════════════
  const W = 152;
  console.log('\n' + '═'.repeat(W));
  console.log('  COPY TRADING PERFORMANCE SUMMARY' + (FILTER_DAYS > 0 ? `  (last ${FILTER_DAYS}d)` : '  (all-time activity)'));
  console.log('═'.repeat(W));
  console.log(
    '\n  ' + pad('Trader', 22) +
    rpad('T.Bought', 10) + rpad('T.Sold', 9) + rpad('T.Redeem', 10) + rpad('T.OpenVal', 10) +
    rpad('T.Realized', 12) + rpad('T.Total', 10) +
    rpad('Det/Fill', 9) +
    rpad('B.Cost', 9) + rpad('B.PnL', 9) +
    rpad('Missed', 9) + '  Action'
  );
  console.log('  ' + '─'.repeat(W - 2));

  let gTB = 0, gTS = 0, gTR = 0, gTO = 0, gTRlz = 0, gTT = 0, gBC = 0, gBP = 0, gM = 0;
  for (const s of allStats) {
    console.log(
      '  ' + pad(s.label, 22) +
      rpad('$' + s.tBought.toFixed(0),   10) + rpad('$' + s.tSold.toFixed(0),     9) +
      rpad('$' + s.tRedeemed.toFixed(0), 10) + rpad('$' + s.tOpenVal.toFixed(0),  10) +
      rpad($(s.tRealized), 12) + rpad($(s.tTotal), 10) +
      rpad(`${s.filled}/${s.detected}`, 9) +
      rpad('$' + s.bBought.toFixed(0), 9) + rpad($(s.bTotal), 9) +
      rpad($(s.missedPnl), 9) + '  ' + s.action
    );
    gTB += s.tBought; gTS += s.tSold; gTR += s.tRedeemed; gTO += s.tOpenVal;
    gTRlz += s.tRealized; gTT += s.tTotal; gBC += s.bBought; gBP += s.bTotal; gM += s.missedPnl;
  }
  console.log('  ' + '─'.repeat(W - 2));
  console.log(
    '  ' + pad('TOTAL', 22) +
    rpad('$' + gTB.toFixed(0), 10) + rpad('$' + gTS.toFixed(0), 9) +
    rpad('$' + gTR.toFixed(0), 10) + rpad('$' + gTO.toFixed(0), 10) +
    rpad($(gTRlz), 12) + rpad($(gTT), 10) +
    '         ' +
    rpad('$' + gBC.toFixed(0), 9) + rpad($(gBP), 9) + rpad($(gM), 9)
  );

  // ══ 2. RECOMMENDATIONS ════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  RECOMMENDATIONS');
  console.log('═'.repeat(W));
  for (const s of allStats) {
    const skipSummary = Object.entries(s.skips).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([k,v]) => `${k}:${v}`).join('  ');
    console.log(`\n  ${s.action.padEnd(24)}  ${pad(s.label, 22)}  ${s.reason}`);
    if (skipSummary) console.log(`  ${''.padEnd(24)}  ${''.padEnd(22)}  Skips: ${skipSummary}`);
  }

  // ══ 3. PER-TRADER DETAIL ══════════════════════════════════════════════════
  for (const s of allStats) {
    const botTrades = allBotTrades.filter((t: any) => t.sourceWallet === s.wallet.toLowerCase());

    // Group by market
    const byMkt = new Map<string, any[]>();
    for (const t of botTrades) {
      const k = t.tokenId || `nt_${t.title}`;
      if (!byMkt.has(k)) byMkt.set(k, []);
      byMkt.get(k)!.push(t);
    }

    // Build per-market rows
    interface Row {
      title: string; out: string; cur: number;
      tBuyUsdc: number; tSellUsdc: number; tVwap: number;
      bBuyUsdc: number; bVwap: number; bPnl: number;
      missedPnl: number; skipStr: string;
    }
    const rows: Row[] = [];

    for (const [tokenId, mts] of byMkt) {
      const cur = priceCache.get(tokenId) ?? 0;
      const buys  = mts.filter((t: any) => t.side === 'BUY');
      const sells = mts.filter((t: any) => t.side === 'SELL');

      const tBuyUsdc   = buys.reduce((a: number, t: any) => a + (t.traderBetUsdc ?? 0), 0);
      const tSellUsdc  = sells.reduce((a: number, t: any) => a + (t.traderBetUsdc ?? 0), 0);
      const tBuyShares = buys.reduce((a: number, t: any) => a + (t.traderSize > 0 ? t.traderSize : (t.traderPrice > 0 ? (t.traderBetUsdc ?? 0) / t.traderPrice : 0)), 0);
      const tVwap      = tBuyShares > 0 ? tBuyUsdc / tBuyShares : 0;

      const bFillBuy  = mts.filter((t: any) => t.side === 'BUY'  && t.status === 'FILLED');
      const bFillSell = mts.filter((t: any) => t.side === 'SELL' && t.status === 'FILLED');
      const bBuyUsdc  = bFillBuy .reduce((a: number, t: any) => a + (t.filledUsdc ?? 0), 0);
      const bSellUsdc = bFillSell.reduce((a: number, t: any) => a + (t.filledUsdc ?? 0), 0);
      const bShares   = bFillBuy .reduce((a: number, t: any) => a + (t.filledSize ?? 0), 0)
                      - bFillSell.reduce((a: number, t: any) => a + (t.filledSize ?? 0), 0);
      const bVwap     = bShares > 0 ? bBuyUsdc / bShares : (bFillBuy.length > 0 ? (bFillBuy[0].avgFillPrice ?? 0) : 0);
      const bPnl      = -bBuyUsdc + bSellUsdc + Math.max(0, bShares) * cur;

      const MISSED = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
      let mktMissed = 0;
      for (const t of buys) {
        if (t.status !== 'SKIPPED' || (t.traderBetUsdc ?? 0) < s.avgBet || !MISSED.has(t.skipReason)) continue;
        if (!cur || !(t.traderPrice ?? 0)) continue;
        const hyp = Math.min(s.maxBet, s.baseBet * ((t.traderBetUsdc ?? 0) / s.avgBet));
        mktMissed += (hyp / t.traderPrice) * (cur - t.traderPrice);
      }

      const skipStr = Object.entries(
        mts.filter((t: any) => t.status === 'SKIPPED' && t.skipReason)
           .reduce((acc: any, t: any) => { acc[t.skipReason] = (acc[t.skipReason] ?? 0) + 1; return acc; }, {})
      ).sort((a: any,b: any)=>b[1]-a[1]).slice(0,3)
       .map(([k,v]: any) => `${k.replace('ALLOCATION_FULL','ALLOC_F').replace('SELL_NO_POSITION','SELL_NOP').replace('GROUPED_BELOW_AVG','GROUPED').replace('PRICEDRIFT_FAILED','PRICEDRIFT').replace('WIDE_SPREAD','WIDE')}:${v}`)
       .join(' ');

      rows.push({
        title: (mts[0].title ?? 'Unknown').slice(0, 44), out: (mts[0].outcome ?? '—').slice(0, 4),
        cur, tBuyUsdc, tSellUsdc, tVwap, bBuyUsdc, bVwap, bPnl, missedPnl: mktMissed, skipStr,
      });
    }

    // Show only markets with meaningful activity
    const visible = rows
      .filter(r => r.tBuyUsdc + r.tSellUsdc >= MIN_USDC || r.bBuyUsdc > 0)
      .sort((a, b) => (b.tBuyUsdc + b.tSellUsdc) - (a.tBuyUsdc + a.tSellUsdc));

    if (!visible.length) continue;

    console.log('\n' + '═'.repeat(W));
    console.log(
      `  ${s.label}` +
      `  |  T.Realized: ${$(s.tRealized)}  T.Total: ${$(s.tTotal)}` +
      `  |  Bot: ${$(s.bTotal)}  Missed: ${$(s.missedPnl)}` +
      `  |  ${s.action}`
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

    for (const r of visible.slice(0, 15)) {
      console.log(
        '  ' + pad(r.title, 44) + '  ' + pad(r.out, 4) + '  ' +
        rpad(r.cur > 0 ? r.cur.toFixed(3) : '—', 6) + '  ' +
        rpad(p3(r.tVwap), 7) + '  ' +
        rpad('$' + r.tBuyUsdc.toFixed(0), 9) + '  ' +
        rpad(r.tSellUsdc > 0 ? '$' + r.tSellUsdc.toFixed(0) : '—', 8) + '  ' +
        rpad(r.bBuyUsdc > 0 ? p3(r.bVwap) : '—', 7) + '  ' +
        rpad(r.bBuyUsdc > 0 ? $(r.bPnl) : '—', 8) + '  ' +
        rpad(r.missedPnl !== 0 ? $(r.missedPnl) : '—', 8) + '  ' +
        r.skipStr
      );
    }
    if (visible.length > 15) console.log(`  ... and ${visible.length - 15} more markets`);
  }

  // ══ note ══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  NOTES');
  console.log('  · Trader PnL uses Polymarket activity API (all buys, sells, redeems) — accurate cashflow.');
  console.log('  · Bot PnL uses MongoDB FILLED records — same cashflow method, −bought +sold +openValue.');
  console.log('  · Missed$ = est. PnL on above-avgBet trades blocked by ALLOCATION_FULL/PRICEDRIFT/WIDE_SPREAD.');
  console.log('  · T.OpenVal includes only mid-market positions (0.01 < price < 0.99).');
  if (FILTER_DAYS > 0) console.log(`  · Activity limited to last ${FILTER_DAYS} days — older trades excluded from cashflow.`);
  console.log('═'.repeat(W) + '\n');

  await mongoose.disconnect();
}

main().catch(console.error);
