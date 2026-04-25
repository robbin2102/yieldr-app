/**
 * SafetyGuard — price drift and spread checks.
 *
 * Extracted from GTTExecutor so both MarketOrderExecutor and GTDExecutorV2
 * share identical safety logic. Stateless — all methods are pure functions.
 *
 * Drift check: compares the trader's implied execution price against the
 * current best ask (BUY) or best bid (SELL). If the market has moved more
 * than maxDriftPct since the trader traded, we skip — we'd be paying a
 * significantly worse price than the trader did.
 *
 * Spread check: very wide spreads indicate illiquid or near-resolved markets
 * where our order is unlikely to fill or would fill at a terrible price.
 */

import { SafetyResult, OrderBook } from '../types';

export class SafetyGuard {
  constructor(
    private readonly maxDriftPct:   number,  // e.g. 0.05 = 5%
    private readonly maxSpreadPct:  number,  // e.g. 0.10 = 10%
  ) {}

  /**
   * Check if the current market price has drifted too far from the trader's
   * implied execution price. Run this before every order attempt (including
   * retries) so we don't chase a moving market.
   */
  checkDrift(
    impliedPrice: number,    // trader's execution price from OnChainDetector
    book: OrderBook,
    side: 'BUY' | 'SELL',
  ): SafetyResult {
    if (impliedPrice <= 0) return { pass: true }; // can't check — skip gracefully

    const currentPrice = side === 'BUY' ? book.bestAsk : book.bestBid;
    if (currentPrice <= 0) return { pass: true };

    // For BUY: drift = how much more expensive now vs when trader bought
    // For SELL: drift = how much cheaper now vs when trader sold
    const drift = side === 'BUY'
      ? (currentPrice - impliedPrice) / impliedPrice
      : (impliedPrice - currentPrice) / impliedPrice;

    if (drift > this.maxDriftPct) {
      return {
        pass: false,
        reason: `PRICEDRIFT_FAILED: ${(drift * 100).toFixed(1)}% > ${(this.maxDriftPct * 100).toFixed(0)}% limit (trader $${impliedPrice.toFixed(4)}, now $${currentPrice.toFixed(4)})`,
      };
    }
    return { pass: true };
  }

  /**
   * Check if the bid-ask spread is within acceptable bounds.
   * Wide spreads = illiquid market. For market orders this is especially
   * important as we pay the full spread as a taker.
   */
  checkSpread(book: OrderBook): SafetyResult {
    if (book.bestBid <= 0 || book.bestAsk <= 0) return { pass: true };

    const spread    = book.bestAsk - book.bestBid;
    const spreadPct = spread / book.bestBid;

    if (spreadPct > this.maxSpreadPct) {
      return {
        pass: false,
        reason: `WIDE_SPREAD: ${(spreadPct * 100).toFixed(1)}% > ${(this.maxSpreadPct * 100).toFixed(0)}% limit (bid $${book.bestBid.toFixed(4)}, ask $${book.bestAsk.toFixed(4)})`,
      };
    }
    return { pass: true };
  }
}
