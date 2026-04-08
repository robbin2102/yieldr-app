/**
 * analyze-pnl.ts  —  Trader vs Bot PnL Analysis
 *
 * Compares each trader's market activity against what the bot actually copied.
 * Fetches live mid-prices from Polymarket CLOB to compute unrealized PnL.
 *
 * Sections per trader:
 *   A. Per-market PnL table     — trader entry/PnL vs bot entry/PnL side by side
 *   B. Missed conviction trades — ALLOCATION_FULL / PRICEDRIFT_FAILED / WIDE_SPREAD
 *                                 above avgBet, with estimated missed PnL
 *   C. Grouped scanner audit    — which groups fired, which hit WIDE_SPREAD again
 *   D. SELL_NO_POSITION         — trader exits the bot never mirrored
 *
 * Usage:
 *   npx tsx analyze-pnl.ts                         # all traders, all time
 *   npx tsx analyze-pnl.ts --trader T3-Active       # one trader by label
 *   npx tsx analyze-pnl.ts --days 7                 # last N days only
 *   npx tsx analyze-pnl.ts --min-usdc 10            # hide markets < $10 trader volume
 */

import mongoose from 'mongoose';
import { config }    from './src/config';
import { connectDB } from './src/db/connection';
import { CopyTrade }  from './src/db/models/CopyTrade';
import { CopyTrader } from './src/db/models/CopyTrader';

// ── CLI args ──────────────────────────────────────────────────────────────────
function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const FILTER_TRADER = argVal('trader');
const FILTER_DAYS   = parseInt(argVal('days')     ?? '0');
const MIN_USDC      = parseFloat(argVal('min-usdc') ?? '0');

// ── formatting helpers ────────────────────────────────────────────────────────
const pad  = (s: string | number, n: number) => String(s).slice(0, n).padEnd(n);
const rpad = (s: string | number, n: number) => String(s).slice(0, n).padStart(n);
const fmt  = (n: number, d = 2) => isFinite(n) ? n.toFixed(d) : '—';
const pnlFmt = (n: number) =>
  !isFinite(n) || n === 0 ? '—' : (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(2);

// ── price fetching ────────────────────────────────────────────────────────────
const priceCache = new Map<string, number>();

async function fetchMidprice(tokenId: string): Promise<number> {
  if (!tokenId) return 0;
  if (priceCache.has(tokenId)) return priceCache.get(tokenId)!;
  try {
    const res  = await fetch(`${config.clobApiBase}/midpoint?token_id=${tokenId}`);
    if (!res.ok) return 0;
    const data: any = await res.json();
    const price = parseFloat(data.mid ?? '0');
    priceCache.set(tokenId, price);
    return price;
  } catch {
    return 0;
  }
}

async function fetchPricesBatch(tokenIds: string[]): Promise<void> {
  const BATCH = 10;
  const DELAY = 150; // ms between batches — avoid rate limiting
  for (let i = 0; i < tokenIds.length; i += BATCH) {
    await Promise.all(tokenIds.slice(i, i + BATCH).map(fetchMidprice));
    if (i + BATCH < tokenIds.length) await new Promise(r => setTimeout(r, DELAY));
  }
}

// ── derive shares when traderSize is missing ──────────────────────────────────
function deriveShares(t: any): number {
  const stored = t.traderSize ?? 0;
  if (stored > 0) return stored;
  return t.traderPrice > 0 ? (t.traderBetUsdc ?? 0) / t.traderPrice : 0;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();

  const now   = Date.now();
  const since = FILTER_DAYS > 0 ? now - FILTER_DAYS * 86_400_000 : 0;

  // ── load traders ──────────────────────────────────────────────────────────
  const traderQuery: any = FILTER_TRADER ? { label: FILTER_TRADER } : {};
  const traders = await CopyTrader.find(traderQuery).sort({ label: 1 }).lean();

  if (traders.length === 0) {
    console.log(`No traders found${FILTER_TRADER ? ` matching '${FILTER_TRADER}'` : ''}`);
    process.exit(0);
  }

  // ── load all copyTrades ───────────────────────────────────────────────────
  const wallets     = traders.map(t => t.wallet.toLowerCase());
  const tradeQuery: any = { sourceWallet: { $in: wallets } };
  if (since > 0) tradeQuery.detectedAt = { $gte: since };

  const allTrades = await CopyTrade.find(tradeQuery).lean() as any[];

  // ── fetch current prices for all markets ─────────────────────────────────
  const uniqueIds = [...new Set(allTrades.map((t: any) => t.tokenId).filter(Boolean))];
  process.stdout.write(`Fetching prices for ${uniqueIds.length} markets... `);
  await fetchPricesBatch(uniqueIds);
  console.log('done.');
  console.log(`Analysing ${allTrades.length} trade records across ${traders.length} trader(s).\n`);

  // ── per-trader analysis ───────────────────────────────────────────────────
  let grandTraderPnl  = 0;
  let grandBotPnl     = 0;
  let grandMissedPnl  = 0;

  for (const trader of traders) {
    const trades = allTrades.filter(
      (t: any) => t.sourceWallet === trader.wallet.toLowerCase()
    );

    // ── group by tokenId (fallback to title for missing tokenIds) ──────────
    const byMarket = new Map<string, any[]>();
    for (const t of trades) {
      const key = t.tokenId || `notokenid_${t.title}`;
      if (!byMarket.has(key)) byMarket.set(key, []);
      byMarket.get(key)!.push(t);
    }

    // ── per-market calculations ────────────────────────────────────────────
    interface MktRow {
      tokenId:    string;
      title:      string;
      outcome:    string;
      curPrice:   number;

      // Trader
      traderBuyUsdc:    number;
      traderBuyShares:  number;
      traderSellUsdc:   number;
      traderSellShares: number;
      traderBuyVwap:    number;
      traderTotalPnl:   number;  // (netShares×cur + sellUsdc) − buyUsdc

      // Bot
      botBuyUsdc:    number;
      botBuyShares:  number;
      botSellUsdc:   number;
      botBuyVwap:    number;
      botTotalPnl:   number;

      // Skips per reason
      skips: Record<string, number>;

      // Missed conviction (above avgBet, blocked by non-filter reasons)
      missedDocs: Array<{
        reason: string; traderUsdc: number; traderPrice: number;
        hypotheticalBet: number; missedPnl: number;
      }>;

      // Grouped scanner
      groupedSubOrders: number;
      groupedSubUsdc:   number;
      groupedFiredDocs: number;
      groupedFilledDocs: number;
      groupedFiredReasons: string[];

      // SELL_NO_POSITION
      sellNoPosCount: number;
      sellNoPosUsdc:  number;
      sellNoPosAvgPrice: number;
    }

    const rows: MktRow[] = [];

    for (const [tokenId, mTrades] of byMarket) {
      const first    = mTrades[0];
      const curPrice = priceCache.get(tokenId) ?? 0;

      // ── Trader side ──────────────────────────────────────────────────────
      const buyDocs  = mTrades.filter((t: any) => t.side === 'BUY');
      const sellDocs = mTrades.filter((t: any) => t.side === 'SELL');

      const traderBuyUsdc    = buyDocs.reduce((s: number, t: any)  => s + (t.traderBetUsdc ?? 0), 0);
      const traderBuyShares  = buyDocs.reduce((s: number, t: any)  => s + deriveShares(t), 0);
      const traderSellUsdc   = sellDocs.reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);
      const traderSellShares = sellDocs.reduce((s: number, t: any) => s + deriveShares(t), 0);

      const traderBuyVwap   = traderBuyShares > 0 ? traderBuyUsdc / traderBuyShares : 0;
      const traderNetShares = Math.max(0, traderBuyShares - traderSellShares);

      // Total PnL = value of remaining position + sell proceeds − total invested
      const traderTotalPnl = (curPrice > 0 ? traderNetShares * curPrice : 0)
        + traderSellUsdc
        - traderBuyUsdc;

      // ── Bot side ─────────────────────────────────────────────────────────
      const botBuyFills  = mTrades.filter((t: any) => t.side === 'BUY'  && t.status === 'FILLED');
      const botSellFills = mTrades.filter((t: any) => t.side === 'SELL' && t.status === 'FILLED');

      const botBuyUsdc    = botBuyFills.reduce((s: number, t: any)  => s + (t.filledUsdc ?? 0), 0);
      const botBuyShares  = botBuyFills.reduce((s: number, t: any)  => s + (t.filledSize ?? 0), 0);
      const botSellUsdc   = botSellFills.reduce((s: number, t: any) => s + (t.filledUsdc ?? 0), 0);
      const botSellShares = botSellFills.reduce((s: number, t: any) => s + (t.filledSize ?? 0), 0);
      const botBuyVwap    = botBuyShares > 0 ? botBuyUsdc / botBuyShares : 0;
      const botNetShares  = Math.max(0, botBuyShares - botSellShares);

      const botTotalPnl = (curPrice > 0 ? botNetShares * curPrice : 0)
        + botSellUsdc
        - botBuyUsdc;

      // ── Skip breakdown ────────────────────────────────────────────────────
      const skips: Record<string, number> = {};
      for (const t of mTrades) {
        if (t.status === 'SKIPPED' && t.skipReason) {
          skips[t.skipReason] = (skips[t.skipReason] ?? 0) + 1;
        }
      }

      // ── Missed conviction — above avgBet, skipped for execution reasons ──
      const MISSED_REASONS = new Set(['ALLOCATION_FULL', 'PRICEDRIFT_FAILED', 'WIDE_SPREAD']);
      const missedDocs = buyDocs
        .filter((t: any) =>
          t.status === 'SKIPPED' &&
          (t.traderBetUsdc ?? 0) >= trader.avgBet &&
          MISSED_REASONS.has(t.skipReason)
        )
        .map((t: any) => {
          // What copy bet WOULD have been placed (mirrors calcCopyBet logic)
          const ratio          = (t.traderBetUsdc ?? 0) / trader.avgBet;
          const hypotheticalBet = Math.min(trader.maxBetUsdc, trader.baseBetUsdc * ratio);
          const hypShares      = (t.traderPrice ?? 0) > 0 ? hypotheticalBet / t.traderPrice : 0;
          const missedPnl      = curPrice > 0 && hypShares > 0
            ? hypShares * (curPrice - (t.traderPrice ?? 0))
            : 0;
          return {
            reason:          t.skipReason as string,
            traderUsdc:      t.traderBetUsdc  ?? 0,
            traderPrice:     t.traderPrice    ?? 0,
            hypotheticalBet,
            missedPnl,
          };
        });

      // ── Grouped scanner ───────────────────────────────────────────────────
      const groupedSubDocs   = mTrades.filter((t: any) => t.skipReason === 'GROUPED_BELOW_AVG');
      const groupedSubUsdc   = groupedSubDocs.reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);

      // Synthetic docs produced by the group scanner (txHash starts with 'grouped_')
      const groupFiredDocs   = mTrades.filter((t: any) => (t.txHash ?? '').startsWith('grouped_'));
      const groupFilledDocs  = groupFiredDocs.filter((t: any) => t.status === 'FILLED');

      // Deduplicated skip reasons on fired-but-failed group docs
      const groupFiredReasons = [...new Set(
        groupFiredDocs
          .filter((t: any) => t.status === 'SKIPPED')
          .map((t: any) => `${t.skipReason}`)
      )];

      // ── SELL_NO_POSITION ─────────────────────────────────────────────────
      const sellNoPosDoc = sellDocs.filter((t: any) => t.skipReason === 'SELL_NO_POSITION');
      const sellNoPosUsdc  = sellNoPosDoc.reduce((s: number, t: any) => s + (t.traderBetUsdc ?? 0), 0);
      const snpShares      = sellNoPosDoc.reduce((s: number, t: any) => s + deriveShares(t), 0);
      const sellNoPosAvgPrice = snpShares > 0 ? sellNoPosUsdc / snpShares : 0;

      rows.push({
        tokenId, title: (first.title ?? 'Unknown').slice(0, 50),
        outcome: (first.outcome ?? '—'),
        curPrice,
        traderBuyUsdc, traderBuyShares, traderSellUsdc, traderSellShares,
        traderBuyVwap, traderNetShares, traderTotalPnl,
        botBuyUsdc, botBuyShares, botSellUsdc, botBuyVwap, botNetShares,
        botTotalPnl,
        skips, missedDocs,
        groupedSubOrders:  groupedSubDocs.length,
        groupedSubUsdc,
        groupedFiredDocs:  groupFiredDocs.length,
        groupedFilledDocs: groupFilledDocs.length,
        groupedFiredReasons,
        sellNoPosCount:    sellNoPosDoc.length,
        sellNoPosUsdc,
        sellNoPosAvgPrice,
      });
    }

    // Sort by trader buy volume desc
    rows.sort((a, b) => b.traderBuyUsdc - a.traderBuyUsdc);

    const traderTotalPnl = rows.reduce((s, r) => s + r.traderTotalPnl, 0);
    const botTotalPnl    = rows.reduce((s, r) => s + r.botTotalPnl,    0);
    const missedTotal    = rows.reduce((s, r) =>
      s + r.missedDocs.reduce((ms, m) => ms + m.missedPnl, 0), 0);

    grandTraderPnl += traderTotalPnl;
    grandBotPnl    += botTotalPnl;
    grandMissedPnl += missedTotal;

    // ══ TRADER HEADER ════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(120));
    console.log(
      `  ${trader.label}  |  alloc $${trader.allocationUsdc}  |  spent $${fmt(trader.spentUsdc)}` +
      `  |  avgBet $${trader.avgBet}  |  base $${trader.baseBetUsdc}  |  max $${trader.maxBetUsdc}`
    );
    console.log(
      `  Trader total PnL: ${pnlFmt(traderTotalPnl)}  |  Bot actual PnL: ${pnlFmt(botTotalPnl)}` +
      `  |  Est. missed conviction PnL: ${pnlFmt(missedTotal)}`
    );
    console.log('═'.repeat(120));

    // ── A. Per-market table ───────────────────────────────────────────────────
    const visibleRows = rows.filter(r =>
      (r.traderBuyUsdc >= MIN_USDC || r.botBuyUsdc > 0 || r.sellNoPosUsdc >= MIN_USDC)
    );

    if (visibleRows.length === 0) {
      console.log('  (no markets above min-usdc threshold)');
    } else {
      console.log(`\n  ${'Market'.padEnd(50)}  Out   CurPr   T.VWAP  T.PnL$    B.VWAP  B.PnL$    Skips`);
      console.log(`  ${'─'.repeat(118)}`);

      for (const r of visibleRows) {
        const skipStr = Object.entries(r.skips)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ') || '—';

        // Flag: bot's entry vs trader's entry quality
        const slippageFlag = r.botBuyVwap > 0 && r.traderBuyVwap > 0
          ? (() => {
              const drift = (r.botBuyVwap - r.traderBuyVwap) / r.traderBuyVwap * 100;
              return Math.abs(drift) >= 1 ? ` [bot ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}%]` : '';
            })()
          : '';

        console.log(
          `  ${pad(r.title, 50)}  ${pad(r.outcome, 4)}  ` +
          `${rpad(r.curPrice > 0 ? fmt(r.curPrice, 3) : '—', 6)}  ` +
          `${rpad(r.traderBuyVwap > 0 ? fmt(r.traderBuyVwap, 3) : '—', 6)}  ` +
          `${rpad(pnlFmt(r.traderTotalPnl), 9)}  ` +
          `${rpad(r.botBuyVwap > 0 ? fmt(r.botBuyVwap, 3) + slippageFlag : '—', 8)}  ` +
          `${rpad(pnlFmt(r.botTotalPnl), 9)}  ` +
          skipStr
        );

        // SELL_NO_POSITION annotation
        if (r.sellNoPosCount > 0) {
          console.log(
            `  ${''.padEnd(50)}  ↳ Trader exited ${r.sellNoPosCount}× $${fmt(r.sellNoPosUsdc)}` +
            ` @ avg $${fmt(r.sellNoPosAvgPrice, 3)} — bot had no position`
          );
        }
      }
    }

    // ── B. Missed conviction trades ───────────────────────────────────────────
    const allMissed = rows.flatMap(r =>
      r.missedDocs.map(m => ({ ...m, title: r.title, curPrice: r.curPrice }))
    );

    if (allMissed.length > 0) {
      const totalMissedPnl = allMissed.reduce((s, m) => s + m.missedPnl, 0);
      console.log(`\n  ── B. MISSED CONVICTION TRADES ─── ${allMissed.length} trades | est. missed PnL: ${pnlFmt(totalMissedPnl)}`);
      console.log(`  ${'Market'.padEnd(46)}  Reason                T.$     T.Price  Cur.Pr  Hyp.Bet  Missed$`);
      console.log(`  ${'─'.repeat(116)}`);

      // Group by market for cleaner output
      const missedByTitle = new Map<string, typeof allMissed>();
      for (const m of allMissed) {
        if (!missedByTitle.has(m.title)) missedByTitle.set(m.title, []);
        missedByTitle.get(m.title)!.push(m);
      }

      // Sort markets by total missed PnL desc
      const sortedTitles = [...missedByTitle.entries()].sort((a, b) =>
        Math.abs(b[1].reduce((s, m) => s + m.missedPnl, 0)) -
        Math.abs(a[1].reduce((s, m) => s + m.missedPnl, 0))
      );

      for (const [title, mDocs] of sortedTitles) {
        // If multiple docs for same reason, aggregate
        const byReason = new Map<string, { count: number; totalTraderUsdc: number; totalMissed: number; avgPrice: number; hypBet: number }>();
        for (const m of mDocs) {
          const existing = byReason.get(m.reason);
          if (existing) {
            existing.count++;
            existing.totalTraderUsdc += m.traderUsdc;
            existing.totalMissed     += m.missedPnl;
            existing.avgPrice         = (existing.avgPrice * (existing.count - 1) + m.traderPrice) / existing.count;
            existing.hypBet          += m.hypotheticalBet;
          } else {
            byReason.set(m.reason, {
              count: 1, totalTraderUsdc: m.traderUsdc,
              totalMissed: m.missedPnl, avgPrice: m.traderPrice, hypBet: m.hypotheticalBet,
            });
          }
        }

        for (const [reason, agg] of byReason) {
          const curPr   = mDocs[0]?.curPrice ?? 0;
          const label   = agg.count > 1 ? `${reason} ×${agg.count}` : reason;
          console.log(
            `  ${pad(title, 46)}  ${pad(label, 20)}  ` +
            `${rpad(fmt(agg.totalTraderUsdc), 7)}  ` +
            `${rpad(fmt(agg.avgPrice, 3), 7)}  ` +
            `${rpad(curPr > 0 ? fmt(curPr, 3) : '—', 6)}  ` +
            `${rpad(fmt(agg.hypBet), 7)}  ` +
            `${rpad(pnlFmt(agg.totalMissed), 7)}`
          );
        }
      }
    }

    // ── C. Grouped scanner audit ──────────────────────────────────────────────
    const groupedRows = rows.filter(r => r.groupedSubOrders > 0 || r.groupedFiredDocs > 0);
    if (groupedRows.length > 0) {
      console.log(`\n  ── C. GROUPED SCANNER AUDIT`);
      console.log(`  ${'Market'.padEnd(46)}  Sub-ord  SubUsdc  Fired#  Filled#  CurPr  Outcome/Reason`);
      console.log(`  ${'─'.repeat(108)}`);

      for (const r of groupedRows) {
        const firedReason = r.groupedFiredDocs === 0 ? 'NOT_FIRED'
          : r.groupedFilledDocs > 0             ? `FILLED ×${r.groupedFilledDocs}`
          : r.groupedFiredReasons.join(', ')     || '?';

        console.log(
          `  ${pad(r.title, 46)}  ` +
          `${rpad(r.groupedSubOrders, 7)}  ` +
          `${rpad(fmt(r.groupedSubUsdc), 7)}  ` +
          `${rpad(r.groupedFiredDocs, 6)}  ` +
          `${rpad(r.groupedFilledDocs, 7)}  ` +
          `${rpad(r.curPrice > 0 ? fmt(r.curPrice, 3) : '—', 5)}  ` +
          firedReason
        );

        // Note repeated fires (WIDE_SPREAD causes re-fire next scan cycle)
        if (r.groupedFiredDocs > 3 && r.groupedFilledDocs === 0) {
          console.log(`  ${''.padEnd(46)}  ↳ Note: group re-fires every 10m while WIDE_SPREAD blocks — ${r.groupedFiredDocs} attempts`);
        }
      }
    }

    // ── D. SELL_NO_POSITION summary ────────────────────────────────────────────
    const sellRows = rows.filter(r => r.sellNoPosCount > 0 && r.traderBuyUsdc === 0);
    // (those already annotated inline in section A; here show pure-sell markets only)
    if (sellRows.length > 0) {
      const total = sellRows.reduce((s, r) => s + r.sellNoPosUsdc, 0);
      console.log(`\n  ── D. SELL_NO_POSITION (exits with no bot entry) — ${sellRows.length} markets, $${fmt(total)} exit value`);
      console.log(`  Note: bot never entered these — BUYs were pre-monitoring or filtered on buy side`);
      console.log(`  ${'Market'.padEnd(46)}  Sells  ExitUsdc$  AvgExit$  CurPr`);
      console.log(`  ${'─'.repeat(80)}`);
      for (const r of sellRows.sort((a, b) => b.sellNoPosUsdc - a.sellNoPosUsdc)) {
        console.log(
          `  ${pad(r.title, 46)}  ` +
          `${rpad(r.sellNoPosCount, 5)}  ` +
          `${rpad(fmt(r.sellNoPosUsdc), 9)}  ` +
          `${rpad(fmt(r.sellNoPosAvgPrice, 3), 8)}  ` +
          `${r.curPrice > 0 ? fmt(r.curPrice, 3) : '—'}`
        );
      }
    }
  } // end per-trader loop

  // ── Grand totals ──────────────────────────────────────────────────────────
  if (traders.length > 1) {
    console.log('\n' + '═'.repeat(120));
    console.log('  GRAND TOTALS (all traders)');
    console.log(`  Trader combined PnL (simulated):  ${pnlFmt(grandTraderPnl)}`);
    console.log(`  Bot actual PnL:                   ${pnlFmt(grandBotPnl)}`);
    console.log(`  Est. missed conviction PnL:       ${pnlFmt(grandMissedPnl)}`);
    console.log('  Note: Trader PnL is simulated — assumes they held all detected positions');
    console.log('        and does not account for positions entered before monitoring started.');
    console.log('═'.repeat(120));
  }

  await mongoose.disconnect();
}

main().catch(console.error);
