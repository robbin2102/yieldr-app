/**
 * PositionAccumulator — in-memory accumulator for split/chunked trader orders.
 *
 * Problem: traders often split large positions into many small orders to get a
 * good avg entry price. Each individual order is too small to copy (scaled bet
 * < $5 min), but collectively they represent a real conviction position.
 *
 * Solution: accumulate scaled_bets per (traderWallet, tokenId, side).
 * When the accumulated total crosses min_bet ($5), fire a single consolidated order.
 *
 * Key fields:
 *   scaledTotalUsdc   — running sum of portfolio-proportional copy bets
 *   traderTotalUsdc   — running sum of raw trader bets (for logging/context)
 *   avgTraderPrice    — weighted avg of trader's fill prices (drift anchor)
 *   pendingDocIds     — CopyTrade MongoDB doc IDs waiting for this batch execution
 *
 * Execution trigger:
 *   accumulator.scaledTotalUsdc >= minBetUsdc ($5) → attempt GTT order
 *
 * Discards:
 *   PRICE_DRIFT    — at execution time, current_ask drifted >priceDriftPct% from avgTraderPrice
 *   SIDE_CONFLICT  — SELL detected while BUY accumulating (or vice versa) on same token
 */

export interface AccumulatorEntry {
  side: 'BUY' | 'SELL';
  scaledTotalUsdc: number;    // sum of all copy_bets → triggers order when >= minBetUsdc
  traderTotalUsdc: number;    // sum of all raw trader bets
  tradeCount: number;
  avgTraderPrice: number;     // weighted avg of trader fill prices (price drift anchor)
  firstDetectedAt: number;    // unix ms of first trade in accumulation
  lastUpdatedAt: number;      // unix ms of most recent addition
  pendingDocIds: string[];    // CopyTrade doc IDs to mark FILLED/SKIPPED on resolution
}

export class PositionAccumulator {
  // key: `${traderWallet.toLowerCase()}:${tokenId}:${side}`
  private state = new Map<string, AccumulatorEntry>();

  private key(wallet: string, tokenId: string, side: 'BUY' | 'SELL'): string {
    return `${wallet.toLowerCase()}:${tokenId}:${side}`;
  }

  /**
   * Add a new scaled bet to the accumulator for this (wallet, tokenId, side).
   * Returns the updated entry so caller can check if threshold is crossed.
   */
  add(
    wallet: string,
    tokenId: string,
    side: 'BUY' | 'SELL',
    scaledBetUsdc: number,
    traderBetUsdc: number,
    traderPrice: number,
    docId: string
  ): AccumulatorEntry {
    const k = this.key(wallet, tokenId, side);
    const existing = this.state.get(k);

    if (!existing) {
      const entry: AccumulatorEntry = {
        side,
        scaledTotalUsdc: scaledBetUsdc,
        traderTotalUsdc: traderBetUsdc,
        tradeCount: 1,
        avgTraderPrice: traderPrice,
        firstDetectedAt: Date.now(),
        lastUpdatedAt: Date.now(),
        pendingDocIds: [docId],
      };
      this.state.set(k, entry);
      return entry;
    }

    // Weighted average price update
    const totalShares = existing.traderTotalUsdc + traderBetUsdc;
    const newAvgPrice = totalShares > 0
      ? (existing.avgTraderPrice * existing.traderTotalUsdc + traderPrice * traderBetUsdc) / totalShares
      : traderPrice;

    existing.scaledTotalUsdc += scaledBetUsdc;
    existing.traderTotalUsdc += traderBetUsdc;
    existing.tradeCount += 1;
    existing.avgTraderPrice = newAvgPrice;
    existing.lastUpdatedAt = Date.now();
    existing.pendingDocIds.push(docId);

    return existing;
  }

  get(wallet: string, tokenId: string, side: 'BUY' | 'SELL'): AccumulatorEntry | undefined {
    return this.state.get(this.key(wallet, tokenId, side));
  }

  /** Remove accumulator entry after successful execution or discard */
  clear(wallet: string, tokenId: string, side: 'BUY' | 'SELL'): void {
    this.state.delete(this.key(wallet, tokenId, side));
  }

  /**
   * Check for side conflict: incoming SELL while BUY is accumulating (or vice versa).
   * Returns the conflicting entry's pendingDocIds if a conflict exists, null otherwise.
   * Clears the conflicting accumulator.
   */
  clearConflict(wallet: string, tokenId: string, incomingSide: 'BUY' | 'SELL'): string[] | null {
    const oppositeSide: 'BUY' | 'SELL' = incomingSide === 'BUY' ? 'SELL' : 'BUY';
    const k = this.key(wallet, tokenId, oppositeSide);
    const conflict = this.state.get(k);
    if (!conflict) return null;
    this.state.delete(k);
    return conflict.pendingDocIds;
  }

  /** All active accumulator keys — for diagnostics */
  activeKeys(): string[] {
    return Array.from(this.state.keys());
  }

  size(): number {
    return this.state.size;
  }
}

export const positionAccumulator = new PositionAccumulator();
