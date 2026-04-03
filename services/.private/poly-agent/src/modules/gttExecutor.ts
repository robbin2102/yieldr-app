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
 * GTTExecutor — places GTD (Good Till Date) limit orders for copy trades.
 *
 * Uses GTD (maker) orders so we add liquidity and pay zero maker fees.
 * Orders rest on the book until filled or the GTT expiry is reached.
 *
 * Order strategy (maker pricing — never cross the spread):
 *   BUY  → GTD via createOrder at best_bid  (join the bid queue)
 *   SELL → GTD via createOrder at best_ask  (join the ask queue)
 *
 *
 * Retry: if a GTD expires unfilled, retry up to maxOrderRetries times
 * with a fresh orderbook price each attempt.
 *
 * Skip reasons:
 *   BELOW_AVG        — trader bet < avgBet
 *   ALLOCATION_FULL  — spentUsdc >= allocationUsdc
 *   NO_ORDERBOOK     — can't fetch orderbook
 *   SELL_NO_POSITION — we don't hold the position
 *   DUPLICATE        — txHash already processed
 *   ORDER_FAILED     — GTD unfilled after all retries
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
      const needShares = sizing.betUsdc / safeBook.bestAsk;
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
      tradeDoc.failReason = `GTD unfilled after ${result.attempts} attempts`;
      tradeDoc.attempts   = result.attempts;
      await tradeDoc.save();

      await TraderLoader.recordSkip(freshTrader.wallet, 'ORDER_FAILED');

      const tsX = new Date().toISOString().slice(11, 19);
      console.log(`[${tsX}]     ❌ FAILED [${tradeDoc._id}]  GTD unfilled after ${result.attempts} attempts`);
      eventBus.emit('trade:failed', { txHash, traderLabel: traderConfig.label });
    }
  }

  /**
   * GTD (Good Till Date) maker limit order with retry on expiry.
   *
   * Maker pricing: join the existing bid/ask queue — never cross the spread.
   *   BUY  → post at best_bid  (join the bid side)
   *   SELL → post at best_ask  (join the ask side)
   *
   * postOnly: true ensures the order is rejected (not converted to taker)
   * if it would cross the spread when it reaches the matching engine.
   *
   * Each attempt waits up to gttExpirySeconds for a fill. If the GTD
   * expires unfilled, retry up to maxOrderRetries times with a fresh price.
   */
  private async executeGTT(
    side: 'BUY' | 'SELL',
    tokenId: string,
    targetUsdc: number,
    initialBook: { bestAsk: number; bestBid: number }
  ): Promise<{ filledSize: number; avgPrice: number; attempts: number }> {
    const maxAttempts = config.maxOrderRetries;

    let totalFilled = 0;
    let totalCost   = 0;
    let attempts    = 0;

    // feeRateBps: maker fee is always 0 on Polymarket for GTD orders.
    // config.feeRateBps (default 1000) is the taker fee — wrong for makers.
    let feeRateBps = 0;

    for (let i = 0; i < maxAttempts; i++) {
      attempts++;

      const book    = await orderbookCache.getBothPrices(tokenId);
      const bestBid = book.bestBid ?? initialBook.bestBid;
      const bestAsk = book.bestAsk ?? initialBook.bestAsk;

      // Maker pricing: join the queue without crossing the spread.
      const limitPrice = side === 'BUY'
        ? Math.max(0.01, bestBid)   // Join the bid side (maker)
        : Math.min(0.99, bestAsk);  // Join the ask side (maker)

      const remainingUsdc = targetUsdc - totalCost;
      const shares        = remainingUsdc / limitPrice;
      if (shares < 0.1) break;

      const expiration = Math.floor(Date.now() / 1000) + 60 + config.gttExpirySeconds; // API requires now + 1min security threshold + desired expiry

      console.log(`[GTTExecutor] Attempt ${attempts}: GTD ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)} (expiry ${config.gttExpirySeconds}s, fee ${feeRateBps}bps)`);

      try {
        const order = await this.clobClient.createOrder({
          tokenID:    tokenId,
          price:      limitPrice,
          size:       shares,
          side:       side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps: feeRateBps,
          nonce:      0,
          expiration,
        });

        // GTD = Good Till Date: order rests on the book as a maker until filled
        // or the expiration timestamp is reached.
        const postResp = await this.clobClient.postOrder(order, OrderType.GTD);
        const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

        if (!orderId) {
          console.warn(`[GTTExecutor] No orderId returned, attempt ${attempts}`);
          await this.sleep(config.orderRetryDelayMs);
          continue;
        }

        // Poll until filled or the GTD expiry window elapses
        const fillResult = await this.waitForGTDFill(orderId, tokenId, Date.now());

        if (fillResult.filled > 0) {
          totalFilled += fillResult.filled;
          totalCost   += fillResult.filled * fillResult.price;
          console.log(`[GTTExecutor] Attempt ${attempts} filled: ${fillResult.filled.toFixed(2)} @ $${fillResult.price.toFixed(4)}`);
          if (totalCost >= targetUsdc * 0.9) break;
        } else {
          console.log(`[GTTExecutor] Attempt ${attempts}: GTD expired unfilled — will retry with fresh price`);
        }

      } catch (err: any) {
        // Auto-correct fee rate from error message.
        // e.g. "invalid fee rate (0), current market's maker fee: 1000"
        const errText = err.message ?? '';
        const errData = err.data?.error ?? err.response?.data?.error ?? '';
        const feeMatch = (errText + ' ' + errData).match(/current market's (?:taker|maker) fee:\s*(\d+)/i);
        if (feeMatch) {
          const correctFee = parseInt(feeMatch[1]);
          if (correctFee !== feeRateBps) {
            console.log(`[GTTExecutor] Fee correction: ${feeRateBps} → ${correctFee} bps — retrying`);
            feeRateBps = correctFee;
            i--;
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

  /**
   * GTD orders rest on the book — poll until filled/expired, timeout = expiry + 2s buffer.
   *
   * NOTE: Polymarket's GET /data/order/{id} returns 404 once an order is no longer active
   * (filled, cancelled, or expired). 404 is NOT a transient error — it means the order
   * is done. We break immediately on 404 and check recent trades to detect fills.
   */
  private async waitForGTDFill(
    orderId: string,
    tokenId: string,
    postedAt: number
  ): Promise<{ filled: number; price: number }> {
    const deadline       = Date.now() + (60 + config.gttExpirySeconds + 2) * 1000;
    const pollIntervalMs = 500;
    let orderGone = false;

    while (Date.now() < deadline) {
      await this.sleep(pollIntervalMs);
      try {
        const order      = await this.clobClient.getOrder(orderId) as any;
        const status     = order?.status ?? order?.orderStatus;
        const sizeFilled = parseFloat(order?.size_matched ?? order?.sizeFilled ?? '0');
        const avgPrice   = parseFloat(order?.price ?? '0');

        if ((status === 'MATCHED' || status === 'FILLED') && sizeFilled > 0) return { filled: sizeFilled, price: avgPrice };
        if (status === 'CANCELLED' || status === 'EXPIRED') {
          console.log(`[GTTExecutor] Order ${orderId.slice(0, 10)}... status=${status} sizeFilled=${sizeFilled}`);
          return { filled: sizeFilled, price: avgPrice };
        }
      } catch (err: any) {
        const is404 = err?.status === 404 || err?.response?.status === 404 ||
          String(err?.message ?? '').includes('404') || String(err?.message ?? '').includes('Not Found');

        if (is404) {
          // 404 = order no longer active (filled, cancelled, or expired by matching engine)
          // Do NOT keep polling — check trades instead
          console.log(`[GTTExecutor] Order ${orderId.slice(0, 10)}... returned 404 — order is no longer active, checking trades`);
          orderGone = true;
          break;
        }

        console.warn(`[GTTExecutor] Poll error for ${orderId.slice(0, 8)}...: ${err.message}`);
      }
    }

    if (orderGone) {
      return await this.checkFillFromTrades(tokenId, postedAt);
    }

    return { filled: 0, price: 0 };
  }

  /**
   * After a GTD order disappears (404 from getOrder), check recent trades
   * to determine if it actually filled. Looks for maker trades on the given
   * tokenId placed after postedAt.
   */
  private async checkFillFromTrades(
    tokenId: string,
    postedAt: number
  ): Promise<{ filled: number; price: number }> {
    try {
      console.log(`[GTTExecutor] Checking trades for tokenId=${tokenId.slice(0, 12)}... since ${new Date(postedAt).toISOString()}`);

      const trades = await (this.clobClient as any).getTrades({
        maker_address: config.botWalletAddress,
        asset_id: tokenId,
      }) as any[];

      if (!Array.isArray(trades) || trades.length === 0) {
        console.log(`[GTTExecutor] No trades found for tokenId=${tokenId.slice(0, 12)}...`);
        return { filled: 0, price: 0 };
      }

      // Keep only trades that happened at or after order post time (with 5s buffer)
      const cutoff = Math.floor((postedAt - 5000) / 1000);
      const recent = trades.filter((t: any) => {
        const ts = parseFloat(t.timestamp ?? t.created_at ?? '0');
        return ts >= cutoff;
      });

      if (recent.length === 0) {
        console.log(`[GTTExecutor] No recent trades found after ${new Date(postedAt).toISOString()}`);
        return { filled: 0, price: 0 };
      }

      const totalFilled = recent.reduce((sum: number, t: any) => sum + parseFloat(t.size ?? t.size_matched ?? '0'), 0);
      const avgPrice    = recent.reduce((sum: number, t: any) => sum + parseFloat(t.price ?? '0'), 0) / recent.length;

      console.log(`[GTTExecutor] Found ${recent.length} trade(s) via /data/trades: totalFilled=${totalFilled.toFixed(4)} avgPrice=${avgPrice.toFixed(4)}`);
      return { filled: totalFilled, price: avgPrice };

    } catch (err: any) {
      console.warn(`[GTTExecutor] getTrades fallback failed: ${err.message}`);
      return { filled: 0, price: 0 };
    }
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
