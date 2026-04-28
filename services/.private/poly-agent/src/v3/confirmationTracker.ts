/**
 * ConfirmationTracker — cross-references pending mempool events with
 * on-chain confirmed events by txHash.
 *
 * When a pending tx is seen, it's held for up to 30s.
 * When the confirmed 'trade' event arrives with the same txHash,
 * the advance time (pending detection - confirmed detection) is computed.
 * If 30s passes with no confirmation, it's marked DROPPED.
 */

import { PendingTrade, MatchedTrade } from './types';

const DROP_TIMEOUT_MS = 30_000;

interface Entry {
  trade: PendingTrade;
  timer: NodeJS.Timeout;
}

export class ConfirmationTracker {
  private pending = new Map<string, Entry>();

  onPending(trade: PendingTrade, onDrop: (trade: PendingTrade) => void): void {
    if (this.pending.has(trade.txHash)) return; // dedup repeated mempool broadcasts
    const timer = setTimeout(() => {
      this.pending.delete(trade.txHash);
      onDrop(trade);
    }, DROP_TIMEOUT_MS);
    this.pending.set(trade.txHash, { trade, timer });
  }

  onConfirmed(txHash: string, confirmedAtMs: number): MatchedTrade | null {
    const entry = this.pending.get(txHash);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.pending.delete(txHash);
    return {
      pending:      entry.trade,
      confirmedAtMs,
      advanceMs:    confirmedAtMs - entry.trade.detectedAtMs,
    };
  }

  get size(): number { return this.pending.size; }

  stop(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
