import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { CopyTrade } from '../db/models/CopyTrade';
import { TraderLoader } from './traderLoader';
import { calcCopyBet } from './betSizer';
import { positionFetcher } from './positionFetcher';
import { DetectedTradeEvent } from './multiDetector';
import { PendingOrder } from '../types';

// Persist fee rate cache to disk so corrections survive process restarts.
const FEE_CACHE_PATH = resolve(__dirname, '../../data/fee-rate-cache.json');

function loadFeeCache(): Map<string, number> {
  try {
    if (existsSync(FEE_CACHE_PATH)) {
      const raw = readFileSync(FEE_CACHE_PATH, 'utf8');
      return new Map(Object.entries(JSON.parse(raw)));
    }
  } catch { /* corrupt file — start fresh */ }
  return new Map();
}

function saveFeeCache(cache: Map<string, number>): void {
  try {
    const dir = resolve(FEE_CACHE_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(FEE_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
  } catch (e: any) {
    console.warn('[GTTExecutor] Could not persist fee cache:', e.message);
  }
}

/**
 * Fetch the correct fee rate for a token directly from the CLOB API.
 * Each market has its own fee rate (geopolitics=0, crypto=~72, sports=30, etc.).
 * Returns fee_rate_bps, or null on failure (caller falls back to config default).
 */
async function fetchFeeRateFromAPI(tokenId: string, clobApiBase: string): Promise<number | null> {
  try {
    const url = `${clobApiBase}/fee-rate?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    // API returns { base_fee: 0 } (confirmed). Also handle legacy shapes.
    const bps = data.base_fee ?? data.fee_rate_bps ?? data.maker_fee_rate ?? data.makerFeeRate;
    if (bps === undefined || bps === null) return null;
    return parseInt(String(bps), 10);
  } catch {
    return null;
  }
}

/**
 * GTTExecutor — places GTD (Good Till Date) maker limit orders for copy trades.
 *
 * FILL DETECTION IS HANDLED BY Confirmer VIA WEBSOCKET USER CHANNEL.
 * This executor only places orders and emits 'trade:submitted'.
 * It never polls REST for fill status — that caused 404s on every fill.
 *
 * Flow:
 *   1. Detect trade (via MultiDetector → 'trade:detected' event)
 *   2. Dedup, bet sizing, orderbook, sell guard
 *   3. Place GTD maker order → get orderId
 *   4. Emit 'trade:submitted' → Confirmer tracks via WebSocket User Channel
 *   5. Return immediately — Confirmer records fill when Polymarket pushes it
 *
 * Retry flow (on GTD expiry):
 *   Confirmer receives order CANCELLATION event → emits 'order:expired'
 *   GTTExecutor.handleOrderExpired() places a fresh order (up to maxOrderRetries)
 *
 * Maker pricing — spread-proportional aggression:
 *   Attempt 1: passive  — BUY @ bestBid,          SELL @ bestAsk
 *   Attempt 2: midpoint — BUY @ bestBid + 50% spread, SELL @ bestAsk - 50% spread
 *   Attempt 3+: cross   — BUY @ bestAsk - 0.001,  SELL @ bestBid + 0.001  (near-certain fill)
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
// Spread fraction applied per attempt (0 = passive, 1.0 = cross the spread).
// Attempt 1: 0% → passive (best_bid / best_ask)
// Attempt 2: 50% → midpoint
// Attempt 3+: 100% → just inside the opposite side (near-certain fill)
const AGGRESSION_FRACTIONS = [0, 0.5, 1.0];

export class GTTExecutor {
  private clobClient: ClobClient;
  // Per-token fee rate cache — persisted to disk so corrections survive restarts.
  // Eliminates fee correction round-trips for every subsequent order on same market.
  private feeRateCache: Map<string, number> = loadFeeCache();

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;

    eventBus.on('trade:detected', (event: DetectedTradeEvent) => {
      this.handleTrade(event).catch(err =>
        console.error('[GTTExecutor] Unhandled error:', err.message)
      );
    });

    // Confirmer emits this when a GTD order expires without filling
    eventBus.on('order:expired', (pending: PendingOrder) => {
      this.handleOrderExpired(pending).catch(err =>
        console.error('[GTTExecutor] Retry error:', err.message)
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

    // ── 2. Orderbook (needed for both BUY and SELL sizing) ───────────────────
    const book = await orderbookCache.getBothPrices(tokenId);
    if (!book.bestAsk || !book.bestBid) {
      await this.skip(tradeDoc, 'NO_ORDERBOOK', 'orderbook fetch failed or empty', freshTrader.wallet);
      return;
    }
    const safeBook = book as { bestAsk: number; bestBid: number };

    // ── 3. BUY: conviction-proportional sizing via avgBet filter ─────────────
    let targetUsdc  = 0;
    let targetShares: number | undefined;

    if (side === 'BUY') {
      const sizing = calcCopyBet(traderBetUsdc, freshTrader);
      if (sizing.skip) {
        await this.skip(tradeDoc, sizing.skipReason!, sizing.skipDetail, freshTrader.wallet);
        if (sizing.skipReason !== 'BELOW_AVG') await TraderLoader.recordAboveAvg(freshTrader.wallet);
        return;
      }
      await TraderLoader.recordAboveAvg(freshTrader.wallet);
      targetUsdc = sizing.betUsdc;

    // ── 4. SELL: proportional exit — (traderSellSize / traderTotalBought) × ourShares ──
    } else {
      // Note: ALLOCATION_FULL does NOT block SELLs — selling returns capital, not consumes it.

      // 4a. Verify we hold this position (live API check)
      const ourCurrentShares = await positionFetcher.getOurShares(tokenId);
      if (ourCurrentShares < 0.01) {
        await this.skip(tradeDoc, 'SELL_NO_POSITION',
          `have ${ourCurrentShares.toFixed(4)} shares`,
          freshTrader.wallet);
        return;
      }

      // 4c. Trader's total bought shares for this token (primary) or condition (fallback)
      const traderTotalBoughtShares = await this.getTraderTotalBoughtShares(
        traderConfig.wallet, tokenId, conditionId
      );

      // 4d. Proportional exit: sell the same fraction of our position as the trader
      let exitShares: number;
      if (traderTotalBoughtShares > 0) {
        const exitFraction = Math.min(traderSize / traderTotalBoughtShares, 1.0);
        exitShares = exitFraction * ourCurrentShares;
        console.log(`[GTTExecutor] SELL: trader selling ${(exitFraction * 100).toFixed(1)}% of position → exit ${exitShares.toFixed(4)} of our ${ourCurrentShares.toFixed(4)} shares`);
      } else {
        // No BUY history found — exit all shares as safe default
        exitShares = ourCurrentShares;
        console.log(`[GTTExecutor] SELL: no BUY history — exiting all ${ourCurrentShares.toFixed(4)} shares`);
      }

      exitShares = Math.min(exitShares, ourCurrentShares); // never oversell
      if (exitShares < 0.1) {
        await this.skip(tradeDoc, 'SELL_NO_POSITION',
          `exit shares too small (${exitShares.toFixed(4)})`,
          freshTrader.wallet);
        return;
      }

      targetUsdc   = exitShares * safeBook.bestBid; // approximate USDC value for doc
      targetShares = exitShares;
    }

    // ── 5. Update doc to EXECUTING ────────────────────────────────────────────
    const submittedAt         = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    tradeDoc.copyBetUsdc         = targetUsdc;
    tradeDoc.submittedAt         = submittedAt;
    tradeDoc.submissionLatencyMs = submissionLatencyMs;
    tradeDoc.status              = 'EXECUTING';
    await tradeDoc.save();

    eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: targetUsdc });

    // ── 6. Place GTD maker order (attempt 1) ──────────────────────────────────
    await this.placeOrder({
      tradeDocId:   tradeDoc._id.toString(),
      traderWallet: freshTrader.wallet,
      side,
      tokenId,
      conditionId,
      targetUsdc,
      targetShares,
      attempt:     1,
      traderPrice,
      traderTs,
      detectedAt,
      filledSize:  0,
      filledCost:  0,
    }, safeBook);
  }

  /**
   * Sums traderSize from all FILLED/EXECUTING BUY docs for a given trader+token.
   * Falls back to conditionId match if no tokenId results (trader bought other outcome).
   */
  private async getTraderTotalBoughtShares(
    sourceWallet: string, tokenId: string, conditionId: string
  ): Promise<number> {
    const match = async (filter: Record<string, any>) => {
      const result = await CopyTrade.aggregate([
        { $match: { sourceWallet, side: 'BUY', status: { $in: ['FILLED', 'EXECUTING'] }, ...filter } },
        { $group: { _id: null, total: { $sum: '$traderSize' } } },
      ]);
      return result[0]?.total ?? 0;
    };
    const byToken     = await match({ tokenId });
    if (byToken > 0) return byToken;
    const byCondition = await match({ conditionId });
    return byCondition;
  }

  /**
   * Place a single GTD maker order and emit 'trade:submitted'.
   * Confirmer picks it up and waits for the WebSocket fill push.
   */
  private async placeOrder(
    ctx: Omit<PendingOrder, 'orderId' | 'limitPrice' | 'submittedAt'>,
    book: { bestBid: number; bestAsk: number }
  ): Promise<void> {
    const { side, tokenId, targetUsdc, filledCost, attempt } = ctx;
    // targetShares is checked via ctx.targetShares in shares calculation below

    // Spread-proportional aggression: each retry covers more of the spread toward the opposite side.
    // Attempt 1: passive (bestBid / bestAsk), attempt 2: midpoint, attempt 3+: just inside opposite side.
    const spread = book.bestAsk - book.bestBid;
    const fraction = AGGRESSION_FRACTIONS[attempt - 1] ?? 1.0;
    const aggrStep = spread * fraction;
    const rawPrice = side === 'BUY'
      ? Math.min(book.bestBid + aggrStep, book.bestAsk - 0.001)  // stay below ask
      : Math.max(book.bestAsk - aggrStep, book.bestBid + 0.001); // stay above bid
    // Polymarket prices must be strictly between 0 and 1
    const limitPrice = parseFloat(Math.min(0.999, Math.max(0.001, rawPrice)).toFixed(4));

    // SELL proportional: use remaining shares directly (not USDC-derived).
    // BUY: derive shares from remaining USDC at the limit price.
    const shares = ctx.targetShares !== undefined
      ? Math.max(0, ctx.targetShares - ctx.filledSize)
      : Math.max(0, (targetUsdc - filledCost) / limitPrice);

    if (shares < 0.1) {
      console.log(`[GTTExecutor] Shares too small (${shares.toFixed(4)}) — marking filled`);
      return;
    }

    const expiration = Math.floor(Date.now() / 1000) + 60 + config.gttExpirySeconds;
    const aggrLabel  = fraction > 0 ? ` +${(fraction * 100).toFixed(0)}% spread (${(aggrStep * 100).toFixed(1)}¢)` : '';
    console.log(`[GTTExecutor] Attempt ${attempt}: GTD ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)}${aggrLabel} (expiry ${config.gttExpirySeconds}s)`);

    // Resolve fee rate: cached → API fetch → config default.
    // Fetching from API on first encounter eliminates the error-then-correct round trip
    // since each market has its own fee (geopolitics=0, crypto=72bps, sports=30bps, etc.)
    let feeRateBps: number;
    if (this.feeRateCache.has(tokenId)) {
      feeRateBps = this.feeRateCache.get(tokenId)!;
    } else {
      const apiFee = await fetchFeeRateFromAPI(tokenId, config.clobApiBase);
      if (apiFee !== null) {
        feeRateBps = apiFee;
        this.feeRateCache.set(tokenId, feeRateBps);
        saveFeeCache(this.feeRateCache);
        console.log(`[GTTExecutor] Fee rate fetched from API: ${feeRateBps} bps (${tokenId.slice(0, 10)}...)`);
      } else {
        feeRateBps = config.feeRateBps;
        console.warn(`[GTTExecutor] Fee rate API unavailable — using config default ${feeRateBps} bps`);
      }
    }

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

      const postResp = await this.clobClient.postOrder(order, OrderType.GTD);

      // clob-client sometimes returns an error object instead of throwing (400 responses)
      const respError = String((postResp as any)?.error ?? (postResp as any)?.errorMsg ?? '');
      const feeMatchResp = respError.match(/current market's (?:taker|maker) fee:\s*(\d+)/i);
      if (feeMatchResp) {
        const corrected = parseInt(feeMatchResp[1]);
        this.feeRateCache.set(tokenId, corrected);
        saveFeeCache(this.feeRateCache);
        console.log(`[GTTExecutor] Fee correction (response): ${feeRateBps} → ${corrected} bps — retrying with fresh signature`);
        // Re-run placeOrder from scratch with the corrected fee now in cache.
        // Inline re-sign of the same order causes "invalid signature" — fresh call avoids it.
        await this.placeOrder(ctx, book);
        return;
      }

      const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

      if (!orderId) {
        console.warn(`[GTTExecutor] No orderId returned on attempt ${attempt} — order not placed`);
        await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, 'No orderId returned from postOrder');
        return;
      }

      console.log(`[GTTExecutor] Order placed: ${orderId.slice(0, 12)}... — handing off to Confirmer`);

      // Hand off to Confirmer — it will receive the fill via WebSocket User Channel
      const pending: PendingOrder = {
        ...ctx,
        orderId,
        limitPrice,
        submittedAt: Date.now(),
      };
      eventBus.emit('trade:submitted', pending);

    } catch (err: any) {
      // Auto-correct fee rate from API error message
      const errText = (err.message ?? '') + ' ' + (err.data?.error ?? err.response?.data?.error ?? '');
      const feeMatch = errText.match(/current market's (?:taker|maker) fee:\s*(\d+)/i);
      if (feeMatch) {
        const corrected = parseInt(feeMatch[1]);
        this.feeRateCache.set(tokenId, corrected);
        saveFeeCache(this.feeRateCache);
        console.log(`[GTTExecutor] Fee correction (catch): ${feeRateBps} → ${corrected} bps — retrying with fresh signature`);
        await this.placeOrder(ctx, book);
        return;
      }

      console.error(`[GTTExecutor] Order placement error attempt ${attempt}: ${err.message}`);
      await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, err.message);
    }
  }

  /**
   * Called by Confirmer when a GTD order expires without filling.
   * Places a new order with fresh orderbook price, up to maxOrderRetries.
   */
  private async handleOrderExpired(pending: PendingOrder): Promise<void> {
    const nextAttempt = pending.attempt + 1;

    if (nextAttempt > config.maxOrderRetries) {
      console.log(`[GTTExecutor] Max retries (${config.maxOrderRetries}) reached for doc ${pending.tradeDocId} — marking FAILED`);
      await this.markFailed(pending.tradeDocId, pending.traderWallet, pending.attempt, `GTD unfilled after ${pending.attempt} attempts`);
      return;
    }

    // Small delay before retry
    await this.sleep(config.orderRetryDelayMs);

    // Fresh orderbook price for retry
    const book = await orderbookCache.getBothPrices(pending.tokenId);
    if (!book.bestBid || !book.bestAsk) {
      console.error(`[GTTExecutor] No orderbook for retry — marking FAILED`);
      await this.markFailed(pending.tradeDocId, pending.traderWallet, pending.attempt, 'No orderbook on retry');
      return;
    }

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] 🔁 Retrying order for doc ${pending.tradeDocId} (attempt ${nextAttempt}/${config.maxOrderRetries})`);

    await this.placeOrder(
      { ...pending, attempt: nextAttempt },
      book as { bestBid: number; bestAsk: number }
    );
  }

  private async markFailed(tradeDocId: string, traderWallet: string, attempts: number, reason: string): Promise<void> {
    await CopyTrade.findByIdAndUpdate(tradeDocId, {
      status:     'FAILED',
      failReason: reason,
      attempts,
    });
    await TraderLoader.recordSkip(traderWallet, 'ORDER_FAILED');
    eventBus.emit('trade:failed', { tradeDocId, reason });
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
