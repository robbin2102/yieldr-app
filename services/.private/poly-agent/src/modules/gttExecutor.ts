import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { CopyTrade } from '../db/models/CopyTrade';
import { TraderLoader } from './traderLoader';
import { calcCopyBet } from './betSizer';
import { positionFetcher } from './positionFetcher';
import { DetectedTradeEvent } from './multiDetector';

/**
 * GTTExecutor — places GTT limit orders for copy trades.
 *
 * Order strategy:
 *   BUY  → GTT limit at (best_ask - slack)  — buy slightly below ask
 *   SELL → GTT limit at (best_bid + slack)  — sell slightly above bid
 *
 * Retry with tightening slack:
 *   Attempt 1: 1.5¢  (best price — passive)
 *   Attempt 2: 1.0¢
 *   Attempt 3: 0.5¢  (near-guaranteed fill)
 *
 * Skip reasons:
 *   BELOW_AVG        — trader bet < avgBet
 *   ALLOCATION_FULL  — spentUsdc >= allocationUsdc
 *   NO_ORDERBOOK     — can't fetch orderbook
 *   SELL_NO_POSITION — we don't hold the position
 *   DUPLICATE        — txHash already processed
 *   ORDER_FAILED     — GTT failed after all retries
 *   NON_TRADE        — REDEEM/MERGE/SPLIT activity
 */
export class GTTExecutor {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;
    eventBus.on('trade:detected', (event: DetectedTradeEvent) => {
      this.handleTrade(event).catch(err =>
        console.error('[GTTExecutor] Unhandled error:', err.message)
      );
    });
  }

  private async handleTrade(event: DetectedTradeEvent): Promise<void> {
    const { traderConfig, txHash, side, traderBetUsdc, traderPrice, traderSize,
            tokenId, conditionId, title, outcome, traderTs, detectedAt, discoveryLatencyMs } = event;

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`\n[${ts}] ━━━ ${traderConfig.label} ${side} $${traderBetUsdc.toFixed(0)} | "${title.slice(0, 40)}" | lag ${discoveryLatencyMs}ms`);

    // ── 1. Dedup via unique txHash ────────────────────────────────────────────
    let tradeDoc;
    try {
      tradeDoc = await CopyTrade.create({
        sourceWallet: traderConfig.wallet,
        traderLabel:  traderConfig.label,
        txHash, conditionId, tokenId, title, outcome, side,
        traderBetUsdc, traderPrice, traderSize,
        traderTs, detectedAt, discoveryLatencyMs,
        status: 'DETECTED',
        copyBetUsdc: 0,
      });
      console.log(`[${ts}]     📋 doc: ${tradeDoc._id}  tx: ${txHash.slice(0, 12)}...`);
    } catch (err: any) {
      if (err.code === 11000) {
        console.log(`[${ts}]     ⏭  duplicate txHash — skipping`);
        return;
      }
      throw err;
    }

    await TraderLoader.recordDetected(traderConfig.wallet);

    // ── 2. Fresh trader state + conviction-proportional bet sizing ───────────
    const freshTrader = await TraderLoader.get(traderConfig.wallet);
    if (!freshTrader) return;

    const sizing = calcCopyBet(traderBetUsdc, freshTrader);

    if (sizing.skip) {
      await this.skip(tradeDoc, sizing.skipReason!, sizing.skipDetail, freshTrader.wallet);
      if (sizing.skipReason !== 'BELOW_AVG') {
        await TraderLoader.recordAboveAvg(freshTrader.wallet);
      }
      return;
    }

    await TraderLoader.recordAboveAvg(freshTrader.wallet);

    // ── 3. Orderbook ─────────────────────────────────────────────────────────
    const book = await orderbookCache.getBothPrices(tokenId);
    if (!book.bestAsk || !book.bestBid) {
      await this.skip(tradeDoc, 'NO_ORDERBOOK', 'orderbook fetch failed or empty', freshTrader.wallet);
      return;
    }
    const safeBook = book as { bestAsk: number; bestBid: number };

    // ── 4. SELL guard: verify we hold this position ───────────────────────────
    if (side === 'SELL') {
      const ourShares  = await positionFetcher.getOurShares(tokenId);
      const needShares = sizing.betUsdc / safeBook.bestBid;
      if (ourShares < needShares * 0.5) {
        await this.skip(
          tradeDoc, 'SELL_NO_POSITION',
          `have ${ourShares.toFixed(2)} shares, need ~${needShares.toFixed(2)}`,
          freshTrader.wallet
        );
        return;
      }
    }

    // ── 5. Update doc to EXECUTING ────────────────────────────────────────────
    const submittedAt        = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    tradeDoc.copyBetUsdc          = sizing.betUsdc;
    tradeDoc.submittedAt          = submittedAt;
    tradeDoc.submissionLatencyMs  = submissionLatencyMs;
    tradeDoc.status               = 'EXECUTING';
    await tradeDoc.save();

    eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: sizing.betUsdc });

    // ── 6. GTT order with progressive retry ──────────────────────────────────
    const result  = await this.executeGTT(side, tokenId, sizing.betUsdc, safeBook);
    const filledAt = Date.now();

    if (result.filledSize > 0) {
      const fillLatencyMs  = filledAt - submittedAt;
      const totalLatencyMs = filledAt - traderTs;
      const priceDrift     = traderPrice > 0
        ? ((result.avgPrice - traderPrice) / traderPrice) * 100 : 0;
      const filledUsdc     = result.filledSize * result.avgPrice;
      const status         = result.filledSize >= sizing.betUsdc / safeBook.bestAsk * 0.9
        ? 'FILLED' : 'PARTIAL';

      tradeDoc.filledAt      = filledAt;
      tradeDoc.fillLatencyMs = fillLatencyMs;
      tradeDoc.totalLatencyMs= totalLatencyMs;
      tradeDoc.filledSize    = result.filledSize;
      tradeDoc.avgFillPrice  = result.avgPrice;
      tradeDoc.filledUsdc    = filledUsdc;
      tradeDoc.priceDrift    = priceDrift;
      tradeDoc.attempts      = result.attempts;
      tradeDoc.status        = status;
      await tradeDoc.save();

      await TraderLoader.recordFill(freshTrader.wallet, filledUsdc);

      const tsF = new Date().toISOString().slice(11, 19);
      console.log(
        `[${tsF}]     ✅ ${status} [${tradeDoc._id}]\n` +
        `          ${result.filledSize.toFixed(2)} shares @ $${result.avgPrice.toFixed(4)}` +
        ` | drift ${priceDrift >= 0 ? '+' : ''}${priceDrift.toFixed(2)}%` +
        ` | latency ${totalLatencyMs}ms | ${result.attempts} attempt(s)`
      );

      eventBus.emit('trade:filled', {
        txHash, traderLabel: traderConfig.label,
        filledSize: result.filledSize, avgPrice: result.avgPrice,
        priceDrift, totalLatencyMs, attempts: result.attempts,
      });

    } else {
      tradeDoc.status     = 'FAILED';
      tradeDoc.failReason = `GTT unfilled after ${result.attempts} attempts`;
      tradeDoc.attempts   = result.attempts;
      await tradeDoc.save();

      await TraderLoader.recordSkip(freshTrader.wallet, 'ORDER_FAILED');

      const tsX = new Date().toISOString().slice(11, 19);
      console.log(`[${tsX}]     ❌ FAILED [${tradeDoc._id}]  GTT unfilled after ${result.attempts} attempts`);
      eventBus.emit('trade:failed', { txHash, traderLabel: traderConfig.label });
    }
  }

  /**
   * GTT limit order with progressive slack tightening.
   *   attempt 1 → 1.5¢  (best price — passive)
   *   attempt 2 → 1.0¢
   *   attempt 3 → 0.5¢  (near-guaranteed fill)
   */
  private async executeGTT(
    side: 'BUY' | 'SELL',
    tokenId: string,
    targetUsdc: number,
    initialBook: { bestAsk: number; bestBid: number }
  ): Promise<{ filledSize: number; avgPrice: number; attempts: number }> {
    const slackSchedule = [0.015, 0.010, 0.005];
    const maxAttempts   = Math.min(config.maxOrderRetries, slackSchedule.length);

    let totalFilled = 0;
    let totalCost   = 0;
    let attempts    = 0;

    // feeRateBps starts from config but gets corrected on first fee-error response.
    // Polymarket markets have either 0 or 1000 bps maker fee — not all markets match
    // the config default, so we auto-correct on the first attempt.
    let feeRateBps = config.feeRateBps;

    for (let i = 0; i < maxAttempts; i++) {
      attempts++;
      const slack = slackSchedule[i];

      const book     = await orderbookCache.getBothPrices(tokenId);
      const refPrice = side === 'BUY'
        ? (book.bestAsk ?? initialBook.bestAsk)
        : (book.bestBid ?? initialBook.bestBid);

      const limitPrice = side === 'BUY'
        ? Math.max(0.01, refPrice - slack)
        : Math.min(0.99, refPrice + slack);

      const remainingUsdc = targetUsdc - totalCost;
      const shares        = remainingUsdc / limitPrice;
      if (shares < 0.1) break;

      console.log(`[GTTExecutor] Attempt ${attempts}: ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)} (slack ${(slack * 100).toFixed(1)}¢, fee ${feeRateBps}bps)`);

      try {
        // Polymarket requires expiration >= now + 60s (security threshold).
        // We add 60s buffer on top of the configured GTT window.
        const expiration = Math.floor(Date.now() / 1000) + 60 + config.gttExpirySeconds;

        const order = await this.clobClient.createOrder({
          tokenID:    tokenId,
          price:      limitPrice,
          size:       shares,
          side:       side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps: feeRateBps,
          nonce:      0,
          expiration,
        });

        // GTD = Good Till Date — clob-client v3 name for time-limited orders
        const postResp = await this.clobClient.postOrder(order, OrderType.GTD);
        const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

        if (!orderId) {
          console.warn(`[GTTExecutor] No orderId returned, attempt ${attempts}`);
          await this.sleep(config.orderRetryDelayMs);
          continue;
        }

        const fillResult = await this.waitForGTTFill(orderId, config.gttExpirySeconds * 1000 + 1000);

        if (fillResult.filled > 0) {
          totalFilled += fillResult.filled;
          totalCost   += fillResult.filled * fillResult.price;
          console.log(`[GTTExecutor] Attempt ${attempts} filled: ${fillResult.filled.toFixed(2)} @ $${fillResult.price.toFixed(4)}`);
          if (totalCost >= targetUsdc * 0.9) break;
        } else {
          console.log(`[GTTExecutor] Attempt ${attempts}: GTT expired unfilled`);
        }

      } catch (err: any) {
        // Auto-correct fee rate: Polymarket returns the correct fee in the error.
        // The CLOB client may surface it in err.message, err.data?.error, or
        // err.response?.data?.error depending on how it wraps HTTP errors.
        // e.g. "invalid fee rate (1000), current market's maker fee: 0"
        const errText = err.message ?? '';
        const errData = err.data?.error ?? err.response?.data?.error ?? '';
        const feeMatch = (errText + ' ' + errData).match(/current market's maker fee:\s*(\d+)/i);
        if (feeMatch) {
          const correctFee = parseInt(feeMatch[1]);
          if (correctFee !== feeRateBps) {
            console.log(`[GTTExecutor] Fee correction: ${feeRateBps} → ${correctFee} bps — retrying same slack`);
            feeRateBps = correctFee;
            i--;  // retry this slack level with the corrected fee
            attempts--;
            continue;
          }
        }
        console.error(`[GTTExecutor] Order error attempt ${attempts}: ${err.message}`);
      }

      if (i < maxAttempts - 1) await this.sleep(config.orderRetryDelayMs);
    }

    const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
    return { filledSize: totalFilled, avgPrice, attempts };
  }

  private async waitForGTTFill(
    orderId: string,
    timeoutMs: number
  ): Promise<{ filled: number; price: number }> {
    const deadline      = Date.now() + timeoutMs;
    const pollIntervalMs = 1000;

    while (Date.now() < deadline) {
      await this.sleep(pollIntervalMs);
      try {
        const order      = await this.clobClient.getOrder(orderId) as any;
        const status     = order?.status ?? order?.orderStatus;
        const sizeFilled = parseFloat(order?.size_matched ?? order?.sizeFilled ?? '0');
        const avgPrice   = parseFloat(order?.price ?? '0');

        if (status === 'MATCHED'   && sizeFilled > 0) return { filled: sizeFilled, price: avgPrice };
        if (status === 'CANCELLED' || status === 'EXPIRED') return { filled: sizeFilled, price: avgPrice };
      } catch (err: any) {
        console.warn(`[GTTExecutor] Poll error for ${orderId.slice(0, 8)}...: ${err.message}`);
      }
    }

    return { filled: 0, price: 0 };
  }

  private async skip(tradeDoc: any, reason: string, detail: string | undefined, wallet: string): Promise<void> {
    tradeDoc.status     = 'SKIPPED';
    tradeDoc.skipReason = reason;
    tradeDoc.skipDetail = detail ?? '';
    await tradeDoc.save();
    await TraderLoader.recordSkip(wallet, reason);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]     ⏭  SKIP [${tradeDoc._id}]  reason=${reason}  ${detail ?? ''}`);
    eventBus.emit('trade:skipped', { skipReason: reason, skipDetail: detail, docId: tradeDoc._id });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
