/**
 * analyze-pnl.ts  —  Trader vs Bot PnL Analysis
 *
 * Data source: MongoDB only (ahf-copyTrades + ahf-copyTraders).
 * Covers all activity since the bot started monitoring each trader.
 *
 * Trader PnL — cashflow from detected trades in MongoDB:
 *   traderRealized = − Σ(traderBetUsdc, BUY)
 *                   + Σ(traderBetUsdc, SELL)
 *                   + Σ(traderBetUsdc, NON_TRADE with value > 0)   ← redemptions
 *   traderOpenVal  = Σ(netShares × curPrice) per market
 *   traderTotal    = traderRealized + traderOpenVal
 *
 * Bot PnL — same cashflow from FILLED docs + data API redemptions:
 *   botRealized  = − Σ(filledUsdc, FILLED BUY) + Σ(filledUsdc, FILLED SELL)
 *   botRedeemed  = Σ(usdcSize, REDEEM events for bot wallet from data API)
 *   botOpenVal   = Σ(netBotShares × curPrice) — EXCLUDING already-redeemed tokens
 *   botTotal     = botRealized + botOpenVal + botRedeemed
 *
 * Current prices fetched from Polymarket CLOB midpoint (for open positions only).
 *
 * Output:
 *   1. Grand summary table  — one row per trader
 *   2. Recommendations      — CONTINUE / INCREASE_ALLOC / FIX_ENTRY / WATCH / STOP
 *   3. Per-trader detail    — top markets, bot fills vs trader activity
 *
 * Usage:
 *   npx tsx analyze-pnl.ts                      # all traders
 *   npx tsx analyze-pnl.ts --trader T3-Active    # single trader
 *   npx tsx analyze-pnl.ts --min-usdc 10         # hide tiny markets in detail
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

// ── fetch bot portfolio positions (data API) — more accurate than CLOB for ────
// resolved markets. Returns Map<tokenId, {curPrice, size}>.
// Overrides priceCache entries where portfolio shows a higher-confidence price.
async function fetchBotPortfolioPrices(): Promise<Map<string, { curPrice: number; size: number }>> {
  const m = new Map<string, { curPrice: number; size: number }>();
  try {
    const url = `${config.dataApiBase}/positions?user=${config.botWalletAddress}&sizeThreshold=0.01&limit=500`;
    const res = await fetch(url);
    if (!res.ok) { process.stdout.write(`HTTP ${res.status} `); return m; }
    const raw: any = await res.json();
    const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);
    for (const p of items) {
      const tid = p.asset ?? p.tokenId ?? '';
      if (!tid) continue;
      const cur  = parseFloat(p.curPrice ?? p.currentPrice ?? '0');
      const size = parseFloat(p.size ?? '0');
      m.set(tid, { curPrice: cur, size });
      // Seed priceCache — portfolio price is authoritative (handles resolved markets)
      if (cur > 0) priceCache.set(tid, cur);
    }
  } catch (e: any) {
    process.stdout.write(`WARN(${(e as any).message}) `);
  }
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

// ── types ─────────────────────────────────────────────────────────────────────
interface Stats {
  label: string; wallet: string;
  avgBet: number; baseBet: number; maxBet: number; alloc: number; spent: number;
  // Trader cashflow (from MongoDB detected docs)
  tBought: number; tSold: number; tRedeemed: number; tOpenVal: number;
  tRealized: number; tTotal: number;
  // Bot cashflow (from MongoDB FILLED docs + data API redeems)
  bBought: number; bSold: number; bRedeemed: number; bOpenVal: number;
  bRealized: number; bTotal: number;
  // Activity counts
  detected: number; filled: number; skips: Record<string, number>;
  // Missed conviction PnL
  missedPnl: number;
  action: string; reason: string;
}

// ── recommendation ────────────────────────────────────────────────────────────
function recommend(s: Stats): { action: string; reason: string } {
  const topSkip  = Object.entries(s.skips).sort((a,b) => b[1]-a[1])[0]?.[0] ?? '';
  const capRate  = s.detected > 0 ? s.filled / s.detected : 0;
  const snpCount = s.skips['SELL_NO_POSITION'] ?? 0;

  if (s.tTotal < -500 && s.tRealized < -100) {
    return { action: '🔴 STOP',           reason: `trader losing: realized ${$(s.tRealized)}, total ${$(s.tTotal)}` };
  }
  if (s.bTotal < -15 && s.tTotal < -100) {
    return { action: '🔴 STOP',           reason: `both trader and bot losing` };
  }
  if (s.tTotal > 50 && topSkip === 'ALLOCATION_FULL') {
    return { action: '🟡 INCREASE_ALLOC', reason: `trader ${$(s.tTotal)} but allocation maxed ($${s.spent.toFixed(0)}/$${s.alloc})` };
  }
  if (s.tTotal > 30 && snpCount > s.detected * 0.4) {
    return { action: '🟡 FIX_ENTRY',      reason: `trader ${$(s.tTotal)} but bot missing buy entries — ${snpCount} SELL_NO_POSITION` };
  }
  if (s.tTotal > 50 && topSkip === 'WIDE_SPREAD' && capRate < 0.05) {
    return { action: '🟡 WATCH',          reason: `trader ${$(s.tTotal)} but trades too illiquid to copy` };
  }
  if (s.tTotal > 30 && capRate > 0.04) {
    return { action: '🟢 CONTINUE',       reason: `trader ${$(s.tTotal)}, bot ${$(s.bTotal)}, cap ${(capRate*100).toFixed(0)}%` };
  }
  if (s.tRealized >= 0 && s.tTotal > 0) {
    return { action: '🟢 CONTINUE',       reason: `trader profitable — realized ${$(s.tRealized)}` };
  }
  return   { action: '🟡 WATCH',          reason: `mixed signals — tTotal ${$(s.tTotal)}, bot ${$(s.bTotal)}` };
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

    // ── Missed conviction PnL ─────────────────────────────────────────────────
    const MISSED = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
    let missedPnl = 0;
    for (const t of buyDocs) {
      if (t.status !== 'SKIPPED' || (t.traderBetUsdc ?? 0) < tr.avgBet || !MISSED.has(t.skipReason)) continue;
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
      bBought, bSold, bRedeemed, bOpenVal, bRealized, bTotal,
      detected, filled, skips, missedPnl,
      action: '', reason: '',
    };
    const rec  = recommend(s);
    s.action   = rec.action;
    s.reason   = rec.reason;
    allStats.push(s);
  }

  // ══ 1. GRAND SUMMARY TABLE ═════════════════════════════════════════════════
  const W = 150;
  console.log('═'.repeat(W));
  console.log('  COPY TRADING PERFORMANCE SUMMARY  (since monitoring started — MongoDB data)');
  console.log('═'.repeat(W));
  console.log(
    '\n  ' + pad('Trader', 22) +
    rpad('T.Bought', 10) + rpad('T.Sold', 9) + rpad('T.Redeem', 10) +
    rpad('T.OpenVal', 10) + rpad('T.Realized', 12) + rpad('T.Total', 10) +
    rpad('Det/Fill', 9) +
    rpad('B.Cost', 9) + rpad('B.Redeem', 10) + rpad('B.PnL', 9) +
    rpad('Missed', 9) + '  Action'
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

  // ══ 2. RECOMMENDATIONS ════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(W));
  console.log('  RECOMMENDATIONS');
  console.log('═'.repeat(W));
  for (const s of allStats) {
    const skipSummary = Object.entries(s.skips).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([k,v]) => `${k}:${v}`).join('  ');
    console.log(`\n  ${s.action.padEnd(26)}  ${pad(s.label, 22)}  ${s.reason}`);
    if (skipSummary) console.log(`  ${''.padEnd(26)}  ${''.padEnd(22)}  Skips → ${skipSummary}`);
  }

  // ══ 3. PER-TRADER DETAIL ══════════════════════════════════════════════════
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
        const hyp = Math.min(s.maxBet, s.baseBet * ((t.traderBetUsdc ?? 0) / s.avgBet));
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
  console.log('  · Trader PnL reflects only what the scanner detected (not their full portfolio).');
  console.log('  · T.OpenVal: net detected shares × current mid-price (includes resolved positions).');
  console.log('  · Missed$: est. PnL on above-avgBet trades blocked by ALLOC_FULL/PRICEDRIFT/WIDE_SPREAD.');
  console.log('  · NON_TRADE (redeems/merges) counted as positive cashflow where traderBetUsdc > 0.');
  console.log('  · B.Redeem: USDC bot received from resolved YES positions, fetched from Polymarket data API.');
  console.log('    Redeemed tokens are excluded from B.OpenVal to prevent double-counting.');
  console.log('  · Bot portfolio prices fetched from data API /positions — overrides CLOB for resolved markets');
  console.log(`    (e.g. resolved YES positions show $1.00 even when CLOB orderbook is gone).`);
  console.log(`  · Portfolio total value: $${[...botPortfolio.values()].reduce((s,p) => s + p.curPrice * p.size, 0).toFixed(2)} across ${botPortfolio.size} open positions.`);
  console.log('═'.repeat(W) + '\n');

  await mongoose.disconnect();
}

main().catch(console.error);
