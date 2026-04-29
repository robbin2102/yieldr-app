/**
 * MarketOrderExecutor — FAK (Fill-And-Kill) order execution with fill loop.
 *
 * Used for NEG_RISK (geopolitical) markets by default, and any market
 * when global or per-token strategy is overridden to 'market'.
 *
 * Fill loop:
 *   1. Fetch fresh orderbook
 *   2. Safety checks: spread + drift (on every iteration, not just first)
 *   3. Submit FAK order for remaining amount
 *   4. Inspect response (takingAmount / makingAmount for fill size)
 *   5. If partial fill and remaining > threshold → wait → retry from step 1
 *   6. Stop when: 100% filled, max attempts reached, safety check fails,
 *      or remaining amount too small (<0.01 USDC / <0.01 shares)
 *
 * Why FAK not FOK:
 *   FOK is all-or-nothing — if the book can't fill the full size, the
 *   order is rejected entirely. For large copy trades that might span
 *   multiple price levels, FAK is safer: grab available liquidity now,
 *   retry for the remainder. This matches the user's "try again with a
 *   new market order till 100% fill" requirement.
 */

import { IExecutor } from './executionRouter';
import { RoutedTrade, ExecutionResult, OrderAttempt } from '../types';
import { ClobV2Client } from '../clob/clobV2Client';
import { OrderbookCacheV2 } from '../state/orderbookCache';
import { SafetyGuard } from '../state/safetyGuard';
import { TradeRecorder } from '../db/tradeRecorder';

const MIN_REMAINING_USDC   = 0.10;  // stop retrying below this
const MIN_REMAINING_SHARES = 0.01;
const RETRY_DELAY_MS       = 200;   // wait between FAK attempts

export class MarketOrderExecutor implements IExecutor {
  constructor(
    private readonly clob:     ClobV2Client,
    private readonly books:    OrderbookCacheV2,
    private readonly safety:   SafetyGuard,
    private readonly recorder: TradeRecorder,
    private readonly maxAttempts: number = 5,
  ) {}

  async execute(trade: RoutedTrade): Promise<void> {
    const startMs = Date.now();
    const { side, tokenId, exchange, impliedPrice, meta } = trade;
    const negRisk = exchange === 'NEG_RISK' || exchange === 'NEG_RISK_V2';
    const fmtTs = () => new Date().toISOString().slice(11, 19);

    console.log(`[${fmtTs()}] [MarketExec] START ${trade.label} ${side} $${trade.copyBetUsdc.toFixed(2)} tokenId=${tokenId.slice(0, 14)}... negRisk=${negRisk}`);

    let remainingUsdc   = trade.copyBetUsdc;
    let remainingShares = trade.copyShares ?? 0;
    const attempts: OrderAttempt[] = [];
    let totalFilledShares = 0;
    let totalFilledUsdc   = 0;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // ── 1. Fresh orderbook (pre-fetched in background, likely cached) ──────
      console.log(`[${fmtTs()}] [MarketExec] attempt ${attempt}/${this.maxAttempts}: fetching orderbook...`);
      const book = await this.books.get(tokenId);
      if (!book) {
        console.log(`[${fmtTs()}] [MarketExec] NO_ORDERBOOK — aborting`);
        await this.recorder.fail(trade, 'NO_ORDERBOOK', `attempt ${attempt}: orderbook unavailable`, attempts, startMs);
        return;
      }
      console.log(`[${fmtTs()}] [MarketExec] book: bid=${book.bestBid} ask=${book.bestAsk} spread=${((book.bestAsk - book.bestBid) / book.bestAsk * 100).toFixed(1)}%`);

      // ── 2. Safety checks (run on every attempt) ───────────────────────────
      const spread = this.safety.checkSpread(book);
      if (!spread.pass) {
        console.log(`[${fmtTs()}] [MarketExec] WIDE_SPREAD: ${spread.reason} — aborting`);
        await this.recorder.fail(trade, 'WIDE_SPREAD', spread.reason!, attempts, startMs);
        return;
      }

      const drift = this.safety.checkDrift(impliedPrice, book, side);
      if (!drift.pass) {
        console.log(`[${fmtTs()}] [MarketExec] PRICEDRIFT_FAILED: ${drift.reason}`);
        if (attempt === 1) {
          await this.recorder.fail(trade, 'PRICEDRIFT_FAILED', drift.reason!, attempts, startMs);
          return;
        }
        break;
      }
      console.log(`[${fmtTs()}] [MarketExec] safety OK`);

      // ── 3. Determine order amount for this attempt ────────────────────────
      let amount: number;
      if (side === 'BUY') {
        amount = remainingUsdc;
        if (amount < MIN_REMAINING_USDC) { console.log(`[${fmtTs()}] [MarketExec] remaining USDC too small (${amount.toFixed(4)}) — done`); break; }
      } else {
        amount = remainingShares;
        if (amount < MIN_REMAINING_SHARES) { console.log(`[${fmtTs()}] [MarketExec] remaining shares too small (${amount.toFixed(4)}) — done`); break; }
      }

      // ── 4. Submit FAK order ───────────────────────────────────────────────
      const slippage = side === 'BUY' ? book.bestAsk + 0.001 : book.bestBid - 0.001;
      console.log(`[${fmtTs()}] [MarketExec] submitting FAK ${side} amount=${amount.toFixed(4)} slippage=${slippage.toFixed(4)}`);
      const submittedAtMs = Date.now();
      let response: Awaited<ReturnType<ClobV2Client['postMarketOrder']>>;
      try {
        response = await this.clob.postMarketOrder({
          tokenId,
          side,
          amount,
          price: slippage,
          negRisk,
          orderType: 'FAK',
        });
      } catch (err: any) {
        console.log(`[${fmtTs()}] [MarketExec] CLOB call threw: ${err.message}`);
        await this.recorder.fail(trade, 'ORDER_FAILED', `attempt ${attempt}: ${err.message}`, attempts, startMs);
        return;
      }

      if (!response.success || !response.orderID) {
        console.log(`[${fmtTs()}] [MarketExec] ORDER_FAILED: ${response.errorMsg}`);
        await this.recorder.fail(trade, 'ORDER_FAILED', `attempt ${attempt}: ${response.errorMsg}`, attempts, startMs);
        return;
      }

      // ── 5. Parse fill from response ───────────────────────────────────────
      // takingAmount = what WE received; makingAmount = what we gave
      // BUY: makingAmount = USDC spent, takingAmount = shares received
      // SELL: makingAmount = shares sold, takingAmount = USDC received
      const filledShares = side === 'BUY'
        ? parseFloat(response.takingAmount ?? '0')
        : parseFloat(response.makingAmount ?? '0');
      const filledUsdc = side === 'BUY'
        ? parseFloat(response.makingAmount ?? '0')
        : parseFloat(response.takingAmount ?? '0');
      const avgFillPrice = filledShares > 0 ? filledUsdc / filledShares : 0;

      const attemptRecord: OrderAttempt = {
        attemptNumber:   attempt,
        orderId:         response.orderID,
        transactionId:   response.transactionsHashes?.[0],
        limitPrice:      side === 'BUY' ? book.bestAsk : book.bestBid,
        requestedUsdc:   side === 'BUY' ? amount : amount * book.bestBid,
        requestedShares: side === 'BUY' ? amount / book.bestAsk : amount,
        filledShares,
        filledUsdc,
        avgFillPrice,
        submittedAtMs,
        confirmedAtMs:   Date.now(),
      };
      attempts.push(attemptRecord);

      totalFilledShares += filledShares;
      totalFilledUsdc   += filledUsdc;

      if (side === 'BUY') {
        remainingUsdc = Math.max(0, remainingUsdc - filledUsdc);
      } else {
        remainingShares = Math.max(0, remainingShares - filledShares);
      }

      console.log(
        `[${fmtTs()}] [MarketExec] ${trade.label} ${side} attempt ${attempt}/${this.maxAttempts}` +
        ` filled ${filledShares.toFixed(4)} shares @ $${avgFillPrice.toFixed(4)}` +
        ` ($${filledUsdc.toFixed(2)}) | status=${response.status}` +
        (side === 'BUY' ? ` | remaining $${remainingUsdc.toFixed(2)}` : ` | remaining ${remainingShares.toFixed(4)} shares`)
      );

      // ── 6. Done if fully filled ───────────────────────────────────────────
      const fullyFilled = side === 'BUY'
        ? remainingUsdc < MIN_REMAINING_USDC
        : remainingShares < MIN_REMAINING_SHARES;
      if (fullyFilled) break;

      // Wait before retrying
      if (attempt < this.maxAttempts) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    // ── Record result ─────────────────────────────────────────────────────
    const result: ExecutionResult = {
      success:     totalFilledShares > 0,
      totalFilled: totalFilledShares,
      totalUsdc:   totalFilledUsdc,
      avgPrice:    totalFilledShares > 0 ? totalFilledUsdc / totalFilledShares : 0,
      attempts,
      durationMs:  Date.now() - startMs,
    };

    await this.recorder.complete(trade, result);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
