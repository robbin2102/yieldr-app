import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { CopyTrade } from '../db/models/CopyTrade';
import { TraderLoader } from './traderLoader';
import { calcCopyBet } from './betSizer';
import { positionAccumulator, AccumulatorEntry } from './positionAccumulator';
import { positionFetcher } from './positionFetcher';
import { ratioScheduler } from './ratioScheduler';
import { DetectedTradeEvent } from './multiDetector';

/**
 * GTTExecutor — portfolio-proportional copy trading with position-level accumulation.
 *
 * Flow per detected trade:
 *   1. Dedup via unique txHash — create DETECTED doc
 *   2. Fetch trader's open positions (cached) → compute copy_ratio
 *   3. Scale bet: scaled_bet = traderBet × copy_ratio (capped at maxBetUsdc)
 *   4. Check SIDE_CONFLICT: SELL incoming while BUY accumulating → discard BUYs
 *   5. Add scaled_bet to accumulator[wallet:tokenId:side]
 *   6. If accumulator.scaledTotal < baseBetUsdc ($5) → log "accumulating", done
 *   7. If accumulator.scaledTotal >= baseBetUsdc → attempt execution:
 *      a. Check price drift vs accumulator.avgTraderPrice
 *         drift > priceDriftPct% → PRICE_DRIFT skip all pending docs, clear
 *      b. Execute GTT order for accumulated total
 *         fill  → mark all pending docs FILLED, clear accumulator
 *         fail  → mark all pending docs FAILED, clear accumulator
 *
 * Skip reasons:
 *   ALLOCATION_FULL  — spentUsdc >= allocationUsdc
 *   PRICE_DRIFT      — price moved >2% before threshold hit
 *   SIDE_CONFLICT    — BUY accumulation discarded due to incoming SELL
 *   NO_ORDERBOOK     — can't fetch orderbook
 *   SELL_NO_POSITION — we don't hold the position being sold
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

    // ── 2. Fresh trader state (copyRatio already stored by ratioScheduler) ────
    const freshTrader = await TraderLoader.get(traderConfig.wallet);
    if (!freshTrader) return;

    // ── 3. Portfolio-proportional bet sizing using fixed daily copyRatio ──────
    let sizing = calcCopyBet(traderBetUsdc, freshTrader);

    // NO_RATIO: ratio not yet computed (new trader or startup race).
    // Trigger immediate recompute — this sets a fallback ratio if still no positions.
    if (sizing.skipReason === 'NO_RATIO') {
      const ts0 = new Date().toISOString().slice(11, 19);
      console.log(`[${ts0}]     🔄 NO_RATIO — triggering immediate ratio recompute for ${freshTrader.label}`);
      await ratioScheduler.recompute(freshTrader.wallet);
      const reloadedTrader = await TraderLoader.get(freshTrader.wallet);
      if (reloadedTrader) {
        sizing = calcCopyBet(traderBetUsdc, reloadedTrader);
        // Replace freshTrader reference for the rest of this handler
        Object.assign(freshTrader, reloadedTrader);
      }
    }

    if (sizing.skip) {
      await this.skipDoc(tradeDoc, sizing.skipReason!, sizing.skipDetail, freshTrader.wallet);
      return;
    }

    // Trade accepted into accumulator — count it
    await TraderLoader.recordAboveAvg(freshTrader.wallet);

    // ── 4. SIDE_CONFLICT check: SELL incoming while BUY accumulating ──────────
    const conflictDocIds = positionAccumulator.clearConflict(freshTrader.wallet, tokenId, side);
    if (conflictDocIds && conflictDocIds.length > 0) {
      const tsC = new Date().toISOString().slice(11, 19);
      console.log(`[${tsC}]     ⚠️  SIDE_CONFLICT on ${tokenId.slice(0, 12)}... — discarding ${conflictDocIds.length} accumulated ${side === 'BUY' ? 'SELL' : 'BUY'}(s)`);
      await this.skipDocIds(conflictDocIds, 'SIDE_CONFLICT', `incoming ${side} on same token`, freshTrader.wallet);
    }

    // ── 5. Add to accumulator ─────────────────────────────────────────────────
    const entry = positionAccumulator.add(
      freshTrader.wallet, tokenId, side,
      sizing.scaledBetUsdc, traderBetUsdc, traderPrice,
      String(tradeDoc._id)
    );

    const tsA = new Date().toISOString().slice(11, 19);
    const ratioStr = freshTrader.copyRatio ? `${(freshTrader.copyRatio * 100).toFixed(2)}%` : 'n/a';
    console.log(
      `[${tsA}]     📥 accumulating ${tokenId.slice(0, 12)}... ` +
      `scaled+$${sizing.scaledBetUsdc.toFixed(2)} → total $${entry.scaledTotalUsdc.toFixed(2)} ` +
      `(${entry.tradeCount} trade${entry.tradeCount === 1 ? '' : 's'}, ` +
      `trader total $${entry.traderTotalUsdc.toFixed(0)}, ` +
      `ratio ${ratioStr})`
    );

    // ── 6. Check if accumulator threshold crossed ─────────────────────────────
    if (entry.scaledTotalUsdc < freshTrader.baseBetUsdc) {
      // Not enough yet — keep accumulating
      return;
    }

    // ── 7. Threshold crossed — attempt execution ──────────────────────────────
    await this.executeAccumulatedBatch(
      freshTrader.wallet, tokenId, side, entry,
      traderConfig.label, conditionId, title, outcome,
      traderTs, detectedAt
    );
  }

  /**
   * Execute a consolidated GTT order for the accumulated position.
   * Called when accumulator.scaledTotalUsdc >= baseBetUsdc.
   */
  private async executeAccumulatedBatch(
    wallet: string,
    tokenId: string,
    side: 'BUY' | 'SELL',
    entry: AccumulatorEntry,
    traderLabel: string,
    conditionId: string,
    title: string,
    outcome: string,
    traderTs: number,
    detectedAt: number
  ): Promise<void> {
    const ts = new Date().toISOString().slice(11, 19);
    const isBatch = entry.tradeCount > 1;

    console.log(
      `[${ts}]     🚀 ${isBatch ? `BATCH(${entry.tradeCount})` : 'SINGLE'} ` +
      `${side} $${entry.scaledTotalUsdc.toFixed(2)} | ` +
      `trader total $${entry.traderTotalUsdc.toFixed(0)} @ avg $${entry.avgTraderPrice.toFixed(4)}`
    );

    // Clear accumulator first — prevents duplicate execution if another trade arrives mid-fill
    const pendingDocIds = [...entry.pendingDocIds];
    positionAccumulator.clear(wallet, tokenId, side);

    // ── Orderbook ─────────────────────────────────────────────────────────────
    const book = await orderbookCache.getBothPrices(tokenId);
    if (!book.bestAsk || !book.bestBid) {
      await this.skipDocIds(pendingDocIds, 'NO_ORDERBOOK', 'orderbook fetch failed or empty', wallet);
      return;
    }
    const safeBook = book as { bestAsk: number; bestBid: number };

    // ── Price drift check ─────────────────────────────────────────────────────
    // Compare current market price vs trader's avg fill price across the accumulation
    const refPrice = side === 'BUY' ? safeBook.bestAsk : safeBook.bestBid;
    const drift = entry.avgTraderPrice > 0
      ? Math.abs((refPrice - entry.avgTraderPrice) / entry.avgTraderPrice) * 100
      : 0;

    if (drift > config.priceDriftPct) {
      const detail = `market $${refPrice.toFixed(4)} vs trader avg $${entry.avgTraderPrice.toFixed(4)} = ${drift.toFixed(1)}% drift`;
      console.log(`[${ts}]     🌊 PRICE_DRIFT — ${detail}, discarding batch`);
      await this.skipDocIds(pendingDocIds, 'PRICE_DRIFT', detail, wallet);
      return;
    }

    // ── SELL guard: verify we hold this position ──────────────────────────────
    if (side === 'SELL') {
      const ourShares = await positionFetcher.getOurShares(tokenId);
      const targetShares = entry.scaledTotalUsdc / safeBook.bestBid;
      if (ourShares < targetShares * 0.5) {
        const detail = `have ${ourShares.toFixed(2)} shares, need ~${targetShares.toFixed(2)}`;
        await this.skipDocIds(pendingDocIds, 'SELL_NO_POSITION', detail, wallet);
        return;
      }
    }

    // ── Mark all pending docs as EXECUTING ────────────────────────────────────
    const submittedAt = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    await CopyTrade.updateMany(
      { _id: { $in: pendingDocIds } },
      {
        $set: {
          copyBetUsdc: entry.scaledTotalUsdc / pendingDocIds.length,  // distribute evenly for reporting
          status: 'EXECUTING',
          submittedAt,
          submissionLatencyMs,
        }
      }
    );

    eventBus.emit('trade:executing', { traderLabel, betUsdc: entry.scaledTotalUsdc });

    // ── GTT order ─────────────────────────────────────────────────────────────
    const result = await this.executeGTT(side, tokenId, entry.scaledTotalUsdc, safeBook);
    const filledAt = Date.now();

    if (result.filledSize > 0) {
      const fillLatencyMs = filledAt - submittedAt;
      const totalLatencyMs = filledAt - traderTs;
      const priceDrift = entry.avgTraderPrice > 0
        ? ((result.avgPrice - entry.avgTraderPrice) / entry.avgTraderPrice) * 100
        : 0;
      const filledUsdc = result.filledSize * result.avgPrice;
      const status = result.filledSize >= (entry.scaledTotalUsdc / safeBook.bestAsk) * 0.9
        ? 'FILLED' : 'PARTIAL';

      // Update all accumulated docs with fill result
      await CopyTrade.updateMany(
        { _id: { $in: pendingDocIds } },
        {
          $set: {
            filledAt,
            fillLatencyMs,
            totalLatencyMs,
            filledSize: result.filledSize / pendingDocIds.length,  // distributed for reporting
            avgFillPrice: result.avgPrice,
            filledUsdc: filledUsdc / pendingDocIds.length,
            priceDrift,
            attempts: result.attempts,
            status,
            ...(isBatch && {
              isAccumulatedBatch: true,
              batchTradeCount: entry.tradeCount,
              accumulatedDocIds: pendingDocIds,
            }),
          }
        }
      );

      // Record fill against trader's allocation (spentUsdc += filledUsdc)
      await TraderLoader.recordFill(wallet, filledUsdc);

      const tsF = new Date().toISOString().slice(11, 19);
      console.log(
        `[${tsF}]     ✅ ${status} ${isBatch ? `[batch:${entry.tradeCount}]` : `[${pendingDocIds[0]}]`}\n` +
        `          ${result.filledSize.toFixed(2)} shares @ $${result.avgPrice.toFixed(4)}` +
        ` | drift ${priceDrift >= 0 ? '+' : ''}${priceDrift.toFixed(2)}%` +
        ` | latency ${totalLatencyMs}ms | ${result.attempts} attempt(s)`
      );

      eventBus.emit('trade:filled', {
        traderLabel,
        filledSize: result.filledSize, avgPrice: result.avgPrice,
        priceDrift, totalLatencyMs, attempts: result.attempts,
      });

    } else {
      await CopyTrade.updateMany(
        { _id: { $in: pendingDocIds } },
        { $set: { status: 'FAILED', failReason: `GTT unfilled after ${result.attempts} attempts`, attempts: result.attempts } }
      );

      await TraderLoader.recordSkip(wallet, 'ORDER_FAILED');

      const tsX = new Date().toISOString().slice(11, 19);
      console.log(`[${tsX}]     ❌ FAILED [batch:${entry.tradeCount}]  GTT unfilled after ${result.attempts} attempts`);
      eventBus.emit('trade:failed', { traderLabel });
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

      const book = await orderbookCache.getBothPrices(tokenId);
      const refPrice = side === 'BUY' ? (book.bestAsk ?? initialBook.bestAsk) : (book.bestBid ?? initialBook.bestBid);

      const limitPrice = side === 'BUY'
        ? Math.max(0.01, refPrice - slack)
        : Math.min(0.99, refPrice + slack);

      const remainingUsdc = targetUsdc - totalCost;
      const shares = remainingUsdc / limitPrice;

      if (shares < 0.1) break;

      console.log(`[GTTExecutor] Attempt ${attempts}: ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)} (slack ${(slack * 100).toFixed(1)}¢)`);

      try {
        const expiration = Math.floor(Date.now() / 1000) + config.gttExpirySeconds;

        const order = await this.clobClient.createOrder({
          tokenID: tokenId,
          price: limitPrice,
          size: shares,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps: config.feeRateBps,
          nonce: 0,
          expiration,
        });

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
          totalCost += fillResult.filled * fillResult.price;
          console.log(`[GTTExecutor] Attempt ${attempts} filled: ${fillResult.filled.toFixed(2)} @ $${fillResult.price.toFixed(4)}`);
          if (totalCost >= targetUsdc * 0.9) break;
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

        if (status === 'MATCHED' && sizeFilled > 0) return { filled: sizeFilled, price: avgPrice };
        if (status === 'CANCELLED' || status === 'EXPIRED') return { filled: sizeFilled, price: avgPrice };
      } catch (err: any) {
        console.warn(`[GTTExecutor] Poll error for ${orderId.slice(0, 8)}...: ${err.message}`);
      }
    }

    return { filled: 0, price: 0 };
  }

  /** Skip a single doc */
  private async skipDoc(tradeDoc: any, reason: string, detail: string | undefined, wallet: string): Promise<void> {
    tradeDoc.status = 'SKIPPED';
    tradeDoc.skipReason = reason;
    tradeDoc.skipDetail = detail ?? '';
    await tradeDoc.save();
    await TraderLoader.recordSkip(wallet, reason);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]     ⏭  SKIP [${tradeDoc._id}]  reason=${reason}  ${detail ?? ''}`);
    eventBus.emit('trade:skipped', { skipReason: reason, skipDetail: detail, docId: tradeDoc._id });
  }

  /** Skip multiple docs by ID (batch discard from accumulator) */
  private async skipDocIds(docIds: string[], reason: string, detail: string, wallet: string): Promise<void> {
    if (docIds.length === 0) return;
    await CopyTrade.updateMany(
      { _id: { $in: docIds } },
      { $set: { status: 'SKIPPED', skipReason: reason, skipDetail: detail } }
    );
    await TraderLoader.recordSkip(wallet, reason);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]     ⏭  SKIP [${docIds.length} docs]  reason=${reason}  ${detail}`);
    eventBus.emit('trade:skipped', { skipReason: reason, skipDetail: detail });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
