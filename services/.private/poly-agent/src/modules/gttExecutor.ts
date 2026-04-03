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
    // API returns { maker_fee_rate: "0", taker_fee_rate: "0" } or { fee_rate_bps: 0 }
    const bps = data.fee_rate_bps ?? data.maker_fee_rate ?? data.makerFeeRate;
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

    let sizing = calcCopyBet(traderBetUsdc, freshTrader);

    // For SELL orders: bypass BELOW_AVG filter — if we hold the position we must be
    // able to exit even if the trader's individual sell is below their avg bet size.
    // The SELL guard (step 4) will handle the case where we don't hold shares.
    // ALLOCATION_FULL still blocks SELLs (intentional — no free capital).
    if (sizing.skip && sizing.skipReason === 'BELOW_AVG' && side === 'SELL') {
      sizing = { betUsdc: freshTrader.baseBetUsdc, skip: false };
    }

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
    const submittedAt         = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    tradeDoc.copyBetUsdc         = sizing.betUsdc;
    tradeDoc.submittedAt         = submittedAt;
    tradeDoc.submissionLatencyMs = submissionLatencyMs;
    tradeDoc.status              = 'EXECUTING';
    await tradeDoc.save();

    eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: sizing.betUsdc });

    // ── 6. Place GTD maker order (attempt 1) ──────────────────────────────────
    await this.placeOrder({
      tradeDocId:   tradeDoc._id.toString(),
      traderWallet: freshTrader.wallet,
      side,
      tokenId,
      targetUsdc:  sizing.betUsdc,
      attempt:     1,
      traderPrice,
      traderTs,
      detectedAt,
      filledSize:  0,
      filledCost:  0,
    }, safeBook);
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

    const remainingUsdc = targetUsdc - filledCost;
    const shares        = remainingUsdc / limitPrice;

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
        feeRateBps = parseInt(feeMatchResp[1]);
        this.feeRateCache.set(tokenId, feeRateBps);
        saveFeeCache(this.feeRateCache);
        console.log(`[GTTExecutor] Fee correction (response): ${config.feeRateBps} → ${feeRateBps} bps (cached for ${tokenId.slice(0, 10)}...)`);
        const correctedOrder = await this.clobClient.createOrder({
          tokenID: tokenId, price: limitPrice, size: shares,
          side: side === 'BUY' ? Side.BUY : Side.SELL,
          feeRateBps, nonce: 0, expiration,
        });
        const correctedResp = await this.clobClient.postOrder(correctedOrder, OrderType.GTD);
        const correctedId: string = (correctedResp as any).orderID ?? (correctedResp as any).id ?? '';
        if (correctedId) {
          console.log(`[GTTExecutor] Order placed (fee-corrected): ${correctedId.slice(0, 12)}...`);
          eventBus.emit('trade:submitted', { ...ctx, orderId: correctedId, limitPrice, submittedAt: Date.now() });
        } else {
          await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, `Fee-corrected order returned no orderId`);
        }
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
        feeRateBps = parseInt(feeMatch[1]);
        this.feeRateCache.set(tokenId, feeRateBps);
        saveFeeCache(this.feeRateCache);
        console.log(`[GTTExecutor] Fee correction (catch): ${config.feeRateBps} → ${feeRateBps} bps (cached for ${tokenId.slice(0, 10)}...)`);
        // Rebuild and retry with corrected fee (same attempt number)
        try {
          const correctedOrder = await this.clobClient.createOrder({
            tokenID:    tokenId,
            price:      limitPrice,
            size:       shares,
            side:       side === 'BUY' ? Side.BUY : Side.SELL,
            feeRateBps: feeRateBps,
            nonce:      0,
            expiration,
          });
          const postResp = await this.clobClient.postOrder(correctedOrder, OrderType.GTD);
          const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

          if (orderId) {
            console.log(`[GTTExecutor] Order placed (fee-corrected): ${orderId.slice(0, 12)}...`);
            const pending: PendingOrder = { ...ctx, orderId, limitPrice, submittedAt: Date.now() };
            eventBus.emit('trade:submitted', pending);
            return;
          }
        } catch (retryErr: any) {
          console.error(`[GTTExecutor] Fee-corrected retry failed: ${retryErr.message}`);
        }
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
