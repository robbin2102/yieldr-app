/**
 * StatsAggregator — rolling 30-min window stats for mempool vs confirmed comparison.
 * Prints automatically every 30 min and on shutdown.
 */

import { MatchedTrade, PendingTrade } from './types';

interface Entry {
  ts:         number;
  type:       'pending' | 'confirmed' | 'dropped';
  advanceMs?: number;
  confidence?: string;
}

const WINDOW_MS    = 30 * 60 * 1000;
const PRINT_EVERY  = 30 * 60 * 1000;

export class StatsAggregator {
  private entries:  Entry[] = [];
  private interval: NodeJS.Timeout;

  constructor() {
    this.interval = setInterval(() => this.print(), PRINT_EVERY);
  }

  recordPending(trade: PendingTrade): void {
    this.entries.push({ ts: Date.now(), type: 'pending', confidence: trade.confidence });
  }

  recordConfirmed(match: MatchedTrade): void {
    this.entries.push({ ts: Date.now(), type: 'confirmed',
                        advanceMs: match.advanceMs, confidence: match.pending.confidence });
  }

  recordDropped(trade: PendingTrade): void {
    this.entries.push({ ts: Date.now(), type: 'dropped', confidence: trade.confidence });
  }

  print(): void {
    const cutoff = Date.now() - WINDOW_MS;
    const w = this.entries.filter(e => e.ts >= cutoff);
    const evict = this.entries.findIndex(e => e.ts >= cutoff);
    if (evict > 0) this.entries.splice(0, evict); // evict old entries

    const pendingCount   = w.filter(e => e.type === 'pending').length;
    const confirmedList  = w.filter(e => e.type === 'confirmed');
    const droppedCount   = w.filter(e => e.type === 'dropped').length;

    if (pendingCount === 0) {
      console.log('[v3] ══ Mempool Stats (last 30min): no pending txs seen ══');
      return;
    }

    const advances = confirmedList.map(e => e.advanceMs!);
    const avg = advances.length ? Math.round(advances.reduce((a, b) => a + b, 0) / advances.length) : 0;
    const min = advances.length ? Math.min(...advances) : 0;
    const max = advances.length ? Math.max(...advances) : 0;

    const highPending   = w.filter(e => e.type === 'pending'   && e.confidence === 'HIGH').length;
    const highConfirmed = w.filter(e => e.type === 'confirmed' && e.confidence === 'HIGH').length;
    const lowPending    = w.filter(e => e.type === 'pending'   && e.confidence === 'LOW').length;
    const lowConfirmed  = w.filter(e => e.type === 'confirmed' && e.confidence === 'LOW').length;
    const privateTxs    = w.filter(e => e.type === 'confirmed' && e.advanceMs === undefined).length;

    const pct = (n: number, d: number) => d > 0 ? `${Math.round(n / d * 100)}%` : 'n/a';

    console.log(`[v3] ══ Mempool Stats (last 30min) ══════════════════════════`);
    console.log(`[v3]   Pending detected : ${pendingCount}`);
    console.log(`[v3]   Confirmed match  : ${confirmedList.length}  (${pct(confirmedList.length, pendingCount)})`);
    console.log(`[v3]   Dropped/replaced : ${droppedCount}  (${pct(droppedCount, pendingCount)})`);
    console.log(`[v3]   Private/flash tx : ${privateTxs}  (confirmed but never in mempool)`);
    console.log(`[v3]   Avg advance time : ${avg}ms`);
    console.log(`[v3]   Min / Max        : ${min}ms / ${max}ms`);
    if (highPending > 0) console.log(`[v3]   HIGH conf hits   : ${highConfirmed}/${highPending}  (${pct(highConfirmed, highPending)})`);
    if (lowPending  > 0) console.log(`[v3]   LOW  conf hits   : ${lowConfirmed}/${lowPending}  (${pct(lowConfirmed, lowPending)})`);
    console.log(`[v3] ════════════════════════════════════════════════════════`);
  }

  stop(): void { clearInterval(this.interval); }
}
