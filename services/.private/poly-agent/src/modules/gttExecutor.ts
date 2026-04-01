import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { CopyTrade } from '../db/models/CopyTrade';
import { TraderLoader } from './traderLoader';
import { calcCopyBet } from './betSizer';
import { DetectedTradeEvent } from './multiDetector';

/**
 * GTTExecutor — places GTT limit orders for copy trades.
 *
 * Order strategy:
 *   BUY  → GTT limit at (best_ask - slack)  — buy slightly below ask
 *   SELL → GTT limit at (best_bid + slack)  — sell slightly above bid
 *
 * Retry with tightening slack each attempt:
 *   Attempt 1: 1.5¢ slack  (best entry/exit price)
 *   Attempt 2: 1.0¢ slack
 *   Attempt 3: 0.5¢ slack  (essentially at ask/bid — fills almost guaranteed)
 *
 * Skip reasons logged to MongoDB:
 *   BELOW_AVG        — trader bet < avgBet
 *   ALLOCATION_FULL  — spentUsdc >= allocationUsdc
 *   MIN_BET          — copy bet < $5
 *   NO_ORDERBOOK     — can't fetch book
 *   SELL_NO_POSITION — no position to copy the sell
 *   DUPLICATE        — txHash already processed
 *   ORDER_FAILED     — GTT failed after all retries
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
        traderLabel: traderConfig.label,
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

    // ── 2. Bet sizing (skip below avg, proportional scaling) ─────────────────
    // Re-read trader from DB for fresh spentUsdc before making size decision
    const freshTrader = await TraderLoader.get(traderConfig.wallet);
    if (!freshTrader) return;

    const sizing = calcCopyBet(traderBetUsdc, freshTrader);

    if (sizing.skip) {
      await this.skip(tradeDoc, sizing.skipReason!, sizing.skipDetail, freshTrader.wallet);
      // Track above-avg separately only if it wasn't below-avg
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
    // Narrow to non-null after the guard above
    const safeBook = book as { bestAsk: number; bestBid: number };

    // ── 4. SELL guard: verify we hold this position ───────────────────────────
    if (side === 'SELL') {
      const ourShares = await this.getOurPosition(tokenId);
      const targetShares = sizing.betUsdc / safeBook.bestBid;
      if (ourShares < targetShares * 0.5) {  // at least 50% of what we need
        await this.skip(
          tradeDoc,
          'SELL_NO_POSITION',
          `have ${ourShares.toFixed(2)} shares, need ~${targetShares.toFixed(2)}`,
          freshTrader.wallet
        );
        return;
      }
    }

    // ── 5. Update doc to EXECUTING ────────────────────────────────────────────
    const submittedAt = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    tradeDoc.copyBetUsdc = sizing.betUsdc;
    tradeDoc.submittedAt = submittedAt;
    tradeDoc.submissionLatencyMs = submissionLatencyMs;
    tradeDoc.status = 'EXECUTING';
    await tradeDoc.save();

    eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: sizing.betUsdc });

    // ── 6. GTT order with progressive retry ──────────────────────────────────
    const result = await this.executeGTT(side, tokenId, sizing.betUsdc, safeBook);
    const filledAt = Date.now();

    if (result.filledSize > 0) {
      const fillLatencyMs = filledAt - submittedAt;
      const totalLatencyMs = filledAt - traderTs;
      const priceDrift = traderPrice > 0
        ? ((result.avgPrice - traderPrice) / traderPrice) * 100
        : 0;
      const filledUsdc = result.filledSize * result.avgPrice;

      tradeDoc.filledAt = filledAt;
      tradeDoc.fillLatencyMs = fillLatencyMs;
      tradeDoc.totalLatencyMs = totalLatencyMs;
      tradeDoc.filledSize = result.filledSize;
      tradeDoc.avgFillPrice = result.avgPrice;
      tradeDoc.filledUsdc = filledUsdc;
      tradeDoc.priceDrift = priceDrift;
      tradeDoc.attempts = result.attempts;
      tradeDoc.status = result.filledSize >= sizing.betUsdc / book.bestAsk * 0.9
        ? 'FILLED'
        : 'PARTIAL';
      await tradeDoc.save();

      await TraderLoader.recordFill(freshTrader.wallet, filledUsdc);

      const tsF = new Date().toISOString().slice(11, 19);
      console.log(
        `[${tsF}]     ✅ ${tradeDoc.status} [${tradeDoc._id}]\n` +
        `          ${result.filledSize.toFixed(2)} shares @ $${result.avgPrice.toFixed(4)}` +
        ` | drift ${priceDrift >= 0 ? '+' : ''}${priceDrift.toFixed(2)}%` +
        ` | total latency ${totalLatencyMs}ms | ${result.attempts} attempt(s)`
      );

      eventBus.emit('trade:filled', {
        txHash, traderLabel: traderConfig.label,
        filledSize: result.filledSize, avgPrice: result.avgPrice,
        priceDrift, totalLatencyMs, attempts: result.attempts,
      });

    } else {
      tradeDoc.status = 'FAILED';
      tradeDoc.failReason = `GTT unfilled after ${result.attempts} attempts`;
      tradeDoc.attempts = result.attempts;
      await tradeDoc.save();

      await TraderLoader.recordSkip(freshTrader.wallet, 'ORDER_FAILED');

      const tsX = new Date().toISOString().slice(11, 19);
      console.log(`[${tsX}]     ❌ FAILED [${tradeDoc._id}]  GTT unfilled after ${result.attempts} attempts`);
      eventBus.emit('trade:failed', { txHash, traderLabel: traderConfig.label });
    }
  }

  /**
   * GTT limit order with progressive tightening.
   *
   * Slack schedule:
   *   attempt 1 → 1.5¢  (best price — passive)
   *   attempt 2 → 1.0¢  (tighter)
   *   attempt 3 → 0.5¢  (almost at ask/bid — near-guaranteed fill)
   */
  private async executeGTT(
    side: 'BUY' | 'SELL',
    tokenId: string,
    targetUsdc: number,
    initialBook: { bestAsk: number; bestBid: number }
  ): Promise<{ filledSize: number; avgPrice: number; attempts: number }> {
    const slackSchedule = [0.015, 0.010, 0.005];
    const maxAttempts = Math.min(config.maxOrderRetries, slackSchedule.length);

    let totalFilled = 0;
    let totalCost = 0;
    let attempts = 0;

    for (let i = 0; i < maxAttempts; i++) {
      attempts++;
      const slack = slackSchedule[i];

      // Fresh book each attempt
      const book = await orderbookCache.getBothPrices(tokenId);
      const refPrice = side === 'BUY' ? (book.bestAsk ?? initialBook.bestAsk) : (book.bestBid ?? initialBook.bestBid);

      const limitPrice = side === 'BUY'
        ? Math.max(0.01, refPrice - slack)
        : Math.min(0.99, refPrice + slack);

      const remainingUsdc = targetUsdc - totalCost;
      const shares = remainingUsdc / limitPrice;

      if (shares < 0.1) break;  // effectively filled

      console.log(`[GTTExecutor] Attempt ${attempts}: ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)} (slack ${(slack * 100).toFixed(1)}¢)`);

      try {
        const expiration = Math.floor(Date.now() / 1000) + config.gttExpirySeconds;

        const order = await this.clobClient.createOrder({
          tokenID: tokenId,
          price: limitPrice,
          size: shares,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps: 0,
          nonce: 0,
          expiration,
        });

        // GTD = Good Till Date — the Polymarket clob-client v3 name for time-limited orders
        const postResp = await this.clobClient.postOrder(order, OrderType.GTD);
        const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

        if (!orderId) {
          console.warn(`[GTTExecutor] No orderId returned, attempt ${attempts}`);
          await this.sleep(config.orderRetryDelayMs);
          continue;
        }

        // Poll for fill until GTT expires
        const fillResult = await this.waitForGTTFill(orderId, config.gttExpirySeconds * 1000 + 1000);

        if (fillResult.filled > 0) {
          totalFilled += fillResult.filled;
          totalCost += fillResult.filled * fillResult.price;
          console.log(`[GTTExecutor] Attempt ${attempts} filled: ${fillResult.filled.toFixed(2)} @ $${fillResult.price.toFixed(4)}`);

          if (totalCost >= targetUsdc * 0.9) break;  // 90%+ filled = done
        } else {
          console.log(`[GTTExecutor] Attempt ${attempts}: GTT expired unfilled`);
        }

      } catch (err: any) {
        console.error(`[GTTExecutor] Order error attempt ${attempts}: ${err.message}`);
      }

      if (i < maxAttempts - 1) await this.sleep(config.orderRetryDelayMs);
    }

    const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
    return { filledSize: totalFilled, avgPrice, attempts };
  }

  /**
   * Poll CLOB order status until filled, cancelled, or timeout.
   */
  private async waitForGTTFill(
    orderId: string,
    timeoutMs: number
  ): Promise<{ filled: number; price: number }> {
    const deadline = Date.now() + timeoutMs;
    const pollIntervalMs = 1000;

    while (Date.now() < deadline) {
      await this.sleep(pollIntervalMs);
      try {
        const order = await this.clobClient.getOrder(orderId) as any;
        const status = order?.status ?? order?.orderStatus;
        const sizeFilled = parseFloat(order?.size_matched ?? order?.sizeFilled ?? '0');
        const avgPrice = parseFloat(order?.price ?? '0');

        if (status === 'MATCHED' && sizeFilled > 0) {
          return { filled: sizeFilled, price: avgPrice };
        }
        if (status === 'CANCELLED' || status === 'EXPIRED') {
          return { filled: sizeFilled, price: avgPrice };
        }
      } catch (err: any) {
        console.warn(`[GTTExecutor] Poll error for ${orderId.slice(0, 8)}...: ${err.message}`);
      }
    }

    return { filled: 0, price: 0 };
  }

  private async getOurPosition(tokenId: string): Promise<number> {
    try {
      const url = `${config.dataApiBase}/positions?user=${config.botWalletAddress}&sizeThreshold=0.01&limit=100`;
      const res = await fetch(url);
      if (!res.ok) return 0;
      const data = await res.json() as any[];
      const pos = data.find((p: any) => p.asset === tokenId || p.tokenId === tokenId);
      return pos ? parseFloat(pos.size ?? '0') : 0;
    } catch {
      return 0;
    }
  }

  private async skip(tradeDoc: any, reason: string, detail: string | undefined, wallet: string): Promise<void> {
    tradeDoc.status = 'SKIPPED';
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
