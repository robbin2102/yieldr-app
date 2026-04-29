/**
 * GTDExecutorV2 — GTD maker order execution with spread-proportional aggression.
 *
 * Same logic as v1 GTTExecutor but:
 * - Uses CLOBv2 SDK (ClobV2Client wrapper)
 * - Fill confirmation via FillTrackerV2 (emits 'order:expired' on cancellation)
 * - Retry triggered by FillTrackerV2 emitting 'order:expired' with PendingOrderV2
 *
 * Aggression per attempt (spread-proportional):
 *   Attempt 1: passive  — BUY @ bestBid,          SELL @ bestAsk
 *   Attempt 2: midpoint — BUY @ bestBid + 50%,    SELL @ bestAsk - 50%
 *   Attempt 3+: cross   — BUY @ bestAsk (taker),  SELL @ bestBid (taker)
 *
 * The cross (attempt 3+) prices at the opposite side — this is a taker order
 * despite being submitted as GTD. It fills immediately against resting liquidity.
 *
 * All safety checks (drift + spread) run on every attempt including retries.
 */

import { EventEmitter } from 'events';
import { IExecutor } from './executionRouter';
import { RoutedTrade, ExecutionResult, OrderAttempt, PendingOrderV2 } from '../types';
import { ClobV2Client } from '../clob/clobV2Client';
import { OrderbookCacheV2 } from '../state/orderbookCache';
import { SafetyGuard } from '../state/safetyGuard';
import { TradeRecorder } from '../db/tradeRecorder';
import { OrderBook } from '../types';

const AGGRESSION_FRACTIONS = [0, 0.5, 1.0];  // per attempt: passive, midpoint, cross
const GTD_EXPIRY_SECONDS   = 8;               // GTD order lifetime before auto-cancel

export class GTDExecutorV2 implements IExecutor {
  constructor(
    private readonly clob:      ClobV2Client,
    private readonly books:     OrderbookCacheV2,
    private readonly safety:    SafetyGuard,
    private readonly recorder:  TradeRecorder,
    private readonly tracker:   EventEmitter,   // FillTrackerV2 events
    private readonly maxAttempts: number = 3,
  ) {
    // FillTrackerV2 emits 'order:expired' when a GTD order cancels without filling
    this.tracker.on('order:expired', (pending: PendingOrderV2) => {
      this.handleExpired(pending).catch(err =>
        console.error('[GTDExecutorV2] Retry error:', err.message)
      );
    });
  }

  async execute(trade: RoutedTrade): Promise<void> {
    const fmtTs = () => new Date().toISOString().slice(11, 19);
    const startMs = Date.now();
    console.log(`[${fmtTs()}] [GTDExec] START ${trade.label} ${trade.side} $${trade.copyBetUsdc.toFixed(2)} tokenId=${trade.tokenId.slice(0, 14)}... exchange=${trade.exchange}`);

    console.log(`[${fmtTs()}] [GTDExec] fetching orderbook...`);
    const book = await this.books.get(trade.tokenId);
    if (!book) {
      console.log(`[${fmtTs()}] [GTDExec] NO_ORDERBOOK — aborting`);
      await this.recorder.fail(trade, 'NO_ORDERBOOK', 'orderbook unavailable', [], startMs);
      return;
    }
    console.log(`[${fmtTs()}] [GTDExec] book: bid=${book.bestBid} ask=${book.bestAsk} spread=${((book.bestAsk - book.bestBid) / book.bestAsk * 100).toFixed(1)}%`);

    const spread = this.safety.checkSpread(book);
    if (!spread.pass) {
      console.log(`[${fmtTs()}] [GTDExec] WIDE_SPREAD: ${spread.reason} — aborting`);
      await this.recorder.fail(trade, 'WIDE_SPREAD', spread.reason!, [], startMs);
      return;
    }

    const drift = this.safety.checkDrift(trade.impliedPrice, book, trade.side);
    if (!drift.pass) {
      console.log(`[${fmtTs()}] [GTDExec] PRICEDRIFT_FAILED: ${drift.reason} — aborting`);
      await this.recorder.fail(trade, 'PRICEDRIFT_FAILED', drift.reason!, [], startMs);
      return;
    }
    console.log(`[${fmtTs()}] [GTDExec] safety OK`);

    await this.placeOrder(trade, book, 1, 0, 0);
  }

  // ── Retry on GTD expiry ───────────────────────────────────────────────────

  private async handleExpired(pending: PendingOrderV2): Promise<void> {
    const fmtTs = () => new Date().toISOString().slice(11, 19);
    console.log(`[${fmtTs()}] [GTDExec] order:expired orderId=${pending.orderId} attempt=${pending.attempt}/${this.maxAttempts} filled=${pending.filledShares.toFixed(4)}sh`);

    if (pending.attempt >= this.maxAttempts) {
      console.log(`[${fmtTs()}] [GTDExec] max attempts reached — failing`);
      await this.recorder.failById(
        pending.tradeDocId,
        'ORDER_FAILED',
        `GTD expired after ${pending.attempt} attempts with no fill`,
        pending.filledShares,
        pending.filledUsdc,
      );
      return;
    }

    console.log(`[${fmtTs()}] [GTDExec] retrying — fetching orderbook...`);
    const book = await this.books.get(pending.tokenId);
    if (!book) {
      console.log(`[${fmtTs()}] [GTDExec] NO_ORDERBOOK on retry — failing`);
      await this.recorder.failById(pending.tradeDocId, 'NO_ORDERBOOK', 'orderbook unavailable on retry', pending.filledShares, pending.filledUsdc);
      return;
    }

    // Re-check safety before retry
    const spread = this.safety.checkSpread(book);
    if (!spread.pass) {
      console.log(`[${fmtTs()}] [GTDExec] WIDE_SPREAD on retry: ${spread.reason} — failing`);
      await this.recorder.failById(pending.tradeDocId, 'WIDE_SPREAD', spread.reason!, pending.filledShares, pending.filledUsdc);
      return;
    }

    const drift = this.safety.checkDrift(pending.impliedPrice, book, pending.side);
    if (!drift.pass) {
      console.log(`[${fmtTs()}] [GTDExec] PRICEDRIFT_FAILED on retry: ${drift.reason} — failing`);
      await this.recorder.failById(pending.tradeDocId, 'PRICEDRIFT_FAILED', drift.reason!, pending.filledShares, pending.filledUsdc);
      return;
    }

    // Reconstruct enough context for placeOrder — use pending for accumulated fills
    const trade = {
      tokenId:      pending.tokenId,
      side:         pending.side,
      exchange:     pending.exchange,
      impliedPrice: pending.impliedPrice,
      meta:         { conditionId: pending.conditionId, negRisk: pending.exchange === 'NEG_RISK' || pending.exchange === 'NEG_RISK_V2', feeRateBps: 0, title: '', outcome: '' },
      copyBetUsdc:  pending.targetUsdc - pending.filledUsdc,
      copyShares:   pending.targetShares ? pending.targetShares - pending.filledShares : undefined,
    } as any;

    await this.placeOrder(trade, book, pending.attempt + 1, pending.filledShares, pending.filledUsdc, pending.tradeDocId);
  }

  // ── Order placement ───────────────────────────────────────────────────────

  private async placeOrder(
    trade:        RoutedTrade | any,
    book:         OrderBook,
    attempt:      number,
    accFilled:    number,   // shares filled across previous attempts
    accUsdc:      number,   // usdc filled across previous attempts
    tradeDocId?:  string,
  ): Promise<void> {
    const { side, tokenId } = trade;
    const negRisk = trade.exchange === 'NEG_RISK' || trade.exchange === 'NEG_RISK_V2' || trade.meta?.negRisk;

    const spread    = book.bestAsk - book.bestBid;
    const fraction  = AGGRESSION_FRACTIONS[Math.min(attempt - 1, AGGRESSION_FRACTIONS.length - 1)];
    const aggrStep  = spread * fraction;

    let limitPrice: number;
    if (side === 'BUY') {
      limitPrice = fraction >= 1.0
        ? book.bestAsk                                                // cross the spread
        : Math.min(book.bestBid + aggrStep, book.bestAsk - 0.001);   // stay below ask
    } else {
      limitPrice = fraction >= 1.0
        ? book.bestBid                                                // cross the spread
        : Math.max(book.bestAsk - aggrStep, book.bestBid + 0.001);   // stay above bid
    }

    // Round to Polymarket 4 decimal places
    limitPrice = Math.round(limitPrice * 10000) / 10000;

    // Convert remaining USDC budget to shares
    const remainingUsdc   = trade.copyBetUsdc;
    const targetShares    = trade.copyShares ?? (side === 'BUY' ? remainingUsdc / limitPrice : 0);
    const expiresAt       = Math.floor(Date.now() / 1000) + GTD_EXPIRY_SECONDS;
    const submittedAtMs   = Date.now();

    const fmtTs = () => new Date().toISOString().slice(11, 19);
    const aggrLabel = fraction === 0 ? 'passive' : fraction === 0.5 ? 'midpoint' : 'cross';
    console.log(
      `[${fmtTs()}] [GTDExec] ${(trade.label || '')} ${side} attempt ${attempt}/${this.maxAttempts}` +
      ` @ $${limitPrice.toFixed(4)} (${aggrLabel}) ${targetShares.toFixed(4)} shares negRisk=${negRisk} expiresIn=${GTD_EXPIRY_SECONDS}s`
    );

    let response: Awaited<ReturnType<ClobV2Client['postGTDOrder']>>;
    try {
      response = await this.clob.postGTDOrder({
        tokenId,
        side,
        price:     limitPrice,
        size:      targetShares,
        negRisk,
        expiresAt,
      });
    } catch (err: any) {
      console.log(`[${fmtTs()}] [GTDExec] CLOB call threw: ${err.message}`);
      await this.recorder.fail(trade, 'ORDER_FAILED', `GTD submit failed attempt ${attempt}: ${err.message}`, [], submittedAtMs);
      return;
    }

    console.log(`[${fmtTs()}] [GTDExec] response: success=${response.success} orderId=${response.orderID} status=${response.status} errorMsg=${response.errorMsg ?? 'none'}`);

    if (!response.success || !response.orderID) {
      console.log(`[${fmtTs()}] [GTDExec] ORDER_FAILED: ${response.errorMsg} — aborting`);
      await this.recorder.fail(trade, 'ORDER_FAILED', `GTD rejected attempt ${attempt}: ${response.errorMsg}`, [], submittedAtMs);
      return;
    }

    // Register with FillTrackerV2 — it will emit 'order:expired' if GTD cancels
    const pending: PendingOrderV2 = {
      orderId:       response.orderID,
      transactionId: response.transactionsHashes?.[0],
      tradeDocId:    tradeDocId ?? trade.tradeDocId ?? '',
      traderWallet:  trade.wallet ?? '',
      side,
      tokenId,
      conditionId:   trade.meta?.conditionId ?? '',
      exchange:      trade.exchange ?? 'CTF_V2',
      limitPrice,
      targetUsdc:    (trade.copyBetUsdc ?? 0) + accUsdc,
      targetShares:  targetShares + accFilled,
      submittedAtMs,
      attempt,
      impliedPrice:  trade.impliedPrice,
      filledShares:  accFilled,
      filledUsdc:    accUsdc,
    };

    this.tracker.emit('order:submitted', pending);
    console.log(`[${fmtTs()}] [GTDExec] order registered with FillTracker — waiting for fill or expiry (${GTD_EXPIRY_SECONDS}s)`);

    // If matched immediately (status = "matched"), handle as immediate fill
    if (response.status === 'matched') {
      console.log(`[${fmtTs()}] [GTDExec] MATCHED immediately — recording fill`);
      const filledShares = parseFloat(response.takingAmount ?? '0');
      const filledUsdc   = parseFloat(response.makingAmount ?? '0');
      const attempt_rec: OrderAttempt = {
        attemptNumber:   attempt,
        orderId:         response.orderID,
        transactionId:   response.transactionsHashes?.[0],
        limitPrice,
        requestedUsdc:   remainingUsdc,
        requestedShares: targetShares,
        filledShares,
        filledUsdc,
        avgFillPrice:    filledShares > 0 ? filledUsdc / filledShares : limitPrice,
        submittedAtMs,
        confirmedAtMs:   Date.now(),
      };

      const result: ExecutionResult = {
        success:     true,
        totalFilled: accFilled + filledShares,
        totalUsdc:   accUsdc   + filledUsdc,
        avgPrice:    (accFilled + filledShares) > 0
          ? (accUsdc + filledUsdc) / (accFilled + filledShares)
          : limitPrice,
        attempts:    [attempt_rec],
        durationMs:  Date.now() - submittedAtMs,
      };
      await this.recorder.complete(trade, result);
    }
    // Otherwise: FillTrackerV2 will handle fill confirmation or expiry event
  }
}
