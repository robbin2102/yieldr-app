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
const FEE_CACHE_PATH     = resolve(__dirname, '../../data/fee-rate-cache.json');
// Persist negRisk flag to disk — eliminates per-order API call and version dependency.
const NEG_RISK_CACHE_PATH = resolve(__dirname, '../../data/neg-risk-cache.json');

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

function loadNegRiskCache(): Map<string, boolean> {
  try {
    if (existsSync(NEG_RISK_CACHE_PATH)) {
      const raw = readFileSync(NEG_RISK_CACHE_PATH, 'utf8');
      return new Map(Object.entries(JSON.parse(raw)) as [string, boolean][]);
    }
  } catch { /* corrupt file — start fresh */ }
  return new Map();
}

function saveNegRiskCache(cache: Map<string, boolean>): void {
  try {
    const dir = resolve(NEG_RISK_CACHE_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(NEG_RISK_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
  } catch (e: any) {
    console.warn('[GTTExecutor] Could not persist negRisk cache:', e.message);
  }
}

/**
 * Fetch the negRisk flag for a market from the CLOB /markets endpoint.
 * Returns null on failure (caller falls back to false = standard CTF exchange).
 */
async function fetchNegRiskFromMarketAPI(conditionId: string, clobApiBase: string): Promise<boolean | null> {
  try {
    const url = `${clobApiBase}/markets/${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    const val = data.neg_risk;
    if (typeof val !== 'boolean') return null;
    return val;
  } catch {
    return null;
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
 *   Attempt 3+: cross   — BUY @ bestAsk (take),   SELL @ bestBid (take)  — immediate fill
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
  // Per-token negRisk flag cache — persisted to disk.
  // Avoids calling clobClient.getNegRisk() (version-dependent) on every order.
  // Populated on first encounter via GET /markets/<conditionId>; never changes for a market.
  private negRiskCache: Map<string, boolean> = loadNegRiskCache();
  // In-memory reservation map for per-position cap race-condition fix.
  // Key: `wallet:conditionId` — Value: USDC reserved by in-flight BUYs not yet EXECUTING in DB.
  // Updated SYNCHRONOUSLY (no await) so concurrent handleTrade() calls see each other's reservations.
  private positionReserved = new Map<string, number>();

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
    } catch (err: any) {
      if (err.code === 11000) return; // silent dedup — already processed
      throw err;
    }

    await TraderLoader.recordDetected(traderConfig.wallet);

    // ── 2. Fresh trader state + conviction-proportional bet sizing ───────────
    const freshTrader = await TraderLoader.get(traderConfig.wallet);
    if (!freshTrader) return;

    // ── 3. BUY: conviction-proportional sizing via avgBet filter ─────────────
    // Run calcCopyBet early — before fetching orderbook or printing header.
    // BELOW_AVG trades (e.g. 31 × $1 from T1) are silently skipped with a
    // compact one-liner so they don't flood the terminal.
    let targetUsdc  = 0;
    let targetShares: number | undefined;
    let buyBetUsdc  = 0;

    if (side === 'BUY') {
      const sizing = calcCopyBet(traderBetUsdc, freshTrader);
      if (sizing.skip) {
        await this.skip(tradeDoc, sizing.skipReason!, sizing.skipDetail, freshTrader.wallet, freshTrader.avgBet);
        if (sizing.skipReason !== 'BELOW_AVG') await TraderLoader.recordAboveAvg(freshTrader.wallet);
        return;
      }
      await TraderLoader.recordAboveAvg(freshTrader.wallet);
      buyBetUsdc = sizing.betUsdc;

      const ratio    = (traderBetUsdc / freshTrader.avgBet).toFixed(1);
      const lagSec   = (discoveryLatencyMs / 1000).toFixed(0);
      console.log(`\n[${ts}] ${traderConfig.label} BUY $${traderBetUsdc.toFixed(0)} "${title.slice(0, 42)}" lag ${lagSec}s | ×${ratio} avg $${freshTrader.avgBet} → copy $${buyBetUsdc.toFixed(2)}`);
    } else {
      const lagSec = (discoveryLatencyMs / 1000).toFixed(0);
      console.log(`\n[${ts}] ${traderConfig.label} SELL $${traderBetUsdc.toFixed(0)} "${title.slice(0, 42)}" lag ${lagSec}s`);
    }

    // ── Orderbook (needed for both BUY and SELL sizing) ───────────────────────
    const book = await orderbookCache.getBothPrices(tokenId);
    if (!book.bestBid) {
      await this.skip(tradeDoc, 'NO_ORDERBOOK', 'orderbook fetch failed or empty', freshTrader.wallet);
      return;
    }
    if (side === 'BUY' && !book.bestAsk) {
      // BUY needs an ask to derive share count and price — can't proceed without one
      await this.skip(tradeDoc, 'NO_ORDERBOOK', 'no ask side — cannot price BUY order', freshTrader.wallet);
      return;
    }
    // For SELL with no ask (resolved/illiquid market where everyone is selling),
    // synthesize bestAsk = bestBid + 0.01 so spread math works and order can proceed.
    const safeBook = {
      bestBid: book.bestBid,
      bestAsk: book.bestAsk ?? (book.bestBid + 0.01),
    };

    // ── Spread check: skip wide/illiquid markets before placing any order ─────
    const spreadPct = (safeBook.bestAsk - safeBook.bestBid) / safeBook.bestBid;
    if (spreadPct > config.maxSpreadPct) {
      const ts2 = new Date().toISOString().slice(11, 19);
      console.log(`[${ts2}]     ⏭  WIDE_SPREAD  ${(spreadPct * 100).toFixed(1)}% > ${(config.maxSpreadPct * 100).toFixed(0)}%  bid $${safeBook.bestBid.toFixed(4)} ask $${safeBook.bestAsk.toFixed(4)}`);
      await this.skip(tradeDoc, 'WIDE_SPREAD', `spread ${(spreadPct * 100).toFixed(1)}% > ${(config.maxSpreadPct * 100).toFixed(0)}% limit`, freshTrader.wallet);
      return;
    }

    if (side === 'BUY') {
      targetUsdc = buyBetUsdc;

      // ── Per-position cap: max 20% of allocationUsdc on any single market ──
      // Race-condition fix: combine DB-persisted spend with in-memory reservations
      // from concurrent handleTrade() calls that haven't saved EXECUTING yet.
      // positionReserved.set() is SYNCHRONOUS — no await between check and set —
      // so concurrent promises see each other's reservation without yielding.
      const lockKey         = `${freshTrader.wallet}:${conditionId || tokenId}`;
      const alreadyReserved = this.positionReserved.get(lockKey) ?? 0;

      // Pre-reserve the FULL buyBetUsdc BEFORE any await.
      // This is the race-condition fix: all concurrent handleTrade() calls read
      // the reservation synchronously, so each sees the previous one's claim.
      // Without this, 4 simultaneous trades all read 0 and all pass the cap check.
      this.positionReserved.set(lockKey, alreadyReserved + buyBetUsdc);

      const dbSpent        = await this.getPositionSpent(freshTrader.wallet, tokenId, conditionId);
      const maxPerPosition = freshTrader.allocationUsdc * 0.20;
      // Use alreadyReserved (what was there BEFORE us) — that's the committed amount
      const positionAvail  = maxPerPosition - dbSpent - alreadyReserved;

      if (positionAvail <= 0) {
        // Release our pre-reservation since we're skipping
        const cur = this.positionReserved.get(lockKey) ?? 0;
        const upd = Math.max(0, cur - buyBetUsdc);
        if (upd === 0) this.positionReserved.delete(lockKey);
        else           this.positionReserved.set(lockKey, upd);
        await this.skip(tradeDoc, 'ALLOCATION_FULL',
          `position cap reached ($${(dbSpent + alreadyReserved).toFixed(2)} / $${maxPerPosition.toFixed(2)} max per position)`,
          freshTrader.wallet, freshTrader.avgBet);
        return;
      }

      const betCapped = Math.min(buyBetUsdc, positionAvail);
      if (betCapped < buyBetUsdc) {
        // Trim reservation down to what we'll actually use
        const cur = this.positionReserved.get(lockKey) ?? 0;
        this.positionReserved.set(lockKey, Math.max(0, cur - (buyBetUsdc - betCapped)));
        // cap applied silently — header already shows final copy amount
      }
      targetUsdc = betCapped;

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

      targetUsdc   = exitShares * safeBook.bestAsk; // use ask (our posting price) for doc accuracy
      targetShares = exitShares;
    }

    // ── 5. Update doc to EXECUTING ────────────────────────────────────────────
    const submittedAt         = Date.now();
    const submissionLatencyMs = submittedAt - detectedAt;

    tradeDoc.copyBetUsdc         = targetUsdc;
    tradeDoc.submittedAt         = submittedAt;
    tradeDoc.submissionLatencyMs = submissionLatencyMs;
    tradeDoc.status              = 'EXECUTING';

    // Wrap save in try/finally so the BUY reservation is ALWAYS released,
    // even if the DB write fails. Without this, a DB error between reservation
    // and release would permanently block future BUYs on that position until restart.
    try {
      await tradeDoc.save();
    } finally {
      if (side === 'BUY') {
        const lockKey = `${freshTrader.wallet}:${conditionId || tokenId}`;
        const prev = this.positionReserved.get(lockKey) ?? 0;
        const updated = Math.max(0, prev - targetUsdc);
        if (updated === 0) this.positionReserved.delete(lockKey);
        else               this.positionReserved.set(lockKey, updated);
      }
    }

    eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: targetUsdc });

    // ── 6. Final real-time allocation guard ──────────────────────────────────
    // calcCopyBet used a snapshot from the start of handleTrade. A concurrent fill
    // between then and now could have consumed the allocation. Re-check DB before
    // committing to an order.
    if (side === 'BUY' && !(await TraderLoader.hasAllocation(freshTrader.wallet, targetUsdc))) {
      await this.skip(tradeDoc, 'ALLOCATION_FULL', 'allocation consumed by concurrent fill', freshTrader.wallet);
      return;
    }

    // ── 7. Place GTD maker order (attempt 1) ──────────────────────────────────
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
  /**
   * Returns our net USDC spent on a specific position (BUY fills minus SELL fills).
   * Used to enforce the 20% per-position cap.
   */
  private async getPositionSpent(wallet: string, tokenId: string, conditionId: string): Promise<number> {
    const filter = (side: 'BUY' | 'SELL', statuses: string[]) => ({
      sourceWallet: wallet.toLowerCase(),
      side,
      status: { $in: statuses },
      $or: [{ tokenId }, { conditionId }],
    });

    const [buys, sells] = await Promise.all([
      CopyTrade.aggregate([
        { $match: filter('BUY', ['FILLED', 'PARTIAL', 'EXECUTING']) },
        { $group: { _id: null, total: {
          // EXECUTING: committed but not yet filled — count copyBetUsdc
          // FILLED/PARTIAL: count actual filledUsdc
          $sum: { $cond: [{ $eq: ['$status', 'EXECUTING'] }, '$copyBetUsdc', '$filledUsdc'] }
        } } },
      ]),
      CopyTrade.aggregate([
        { $match: filter('SELL', ['FILLED', 'PARTIAL']) },
        { $group: { _id: null, total: { $sum: '$filledUsdc' } } },
      ]),
    ]);

    const buySpent      = buys[0]?.total  ?? 0;
    const sellRecovered = sells[0]?.total ?? 0;
    return Math.max(0, buySpent - sellRecovered);
  }

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
    book: { bestBid: number; bestAsk: number },
    feeRetried = false   // guard against infinite recursion on fee correction
  ): Promise<void> {
    const { side, tokenId, targetUsdc, filledCost, attempt } = ctx;
    // targetShares is checked via ctx.targetShares in shares calculation below

    // Spread-proportional aggression: each retry covers more of the spread toward the opposite side.
    // Attempt 1: passive  — BUY @ bestBid,              SELL @ bestAsk
    // Attempt 2: midpoint — BUY @ bestBid + 50% spread, SELL @ bestAsk - 50% spread
    // Attempt 3+: cross   — BUY @ bestAsk (take liquidity), SELL @ bestBid (take liquidity)
    //   Placing AT the opposite side crosses the spread and fills as a taker immediately.
    //   The old cap (bestAsk - 0.001) kept the order below the ask, causing all 3 GTD
    //   orders to expire unfilled in illiquid near-resolved markets.
    const spread = book.bestAsk - book.bestBid;
    const fraction = AGGRESSION_FRACTIONS[attempt - 1] ?? 1.0;
    const aggrStep = spread * fraction;
    const rawPrice = side === 'BUY'
      ? (fraction >= 1.0
          ? book.bestAsk                                              // cross: take standing ask liquidity
          : Math.min(book.bestBid + aggrStep, book.bestAsk - 0.001)) // passive/midpoint: stay below ask
      : (fraction >= 1.0
          ? book.bestBid                                              // cross: take standing bid liquidity
          : Math.max(book.bestAsk - aggrStep, book.bestBid + 0.001)); // passive/midpoint: stay above bid
    // Polymarket prices must be strictly between 0 and 1
    const limitPrice = parseFloat(Math.min(0.999, Math.max(0.001, rawPrice)).toFixed(4));

    // ── Price drift check: abort if our limit price has drifted too far ───────
    // BUY: we're paying more than the trader did → unfavourable drift upward.
    // SELL: we're selling below what the trader sold for → unfavourable drift downward.
    if (ctx.traderPrice > 0) {
      const drift = side === 'BUY'
        ? (limitPrice - ctx.traderPrice) / ctx.traderPrice
        : (ctx.traderPrice - limitPrice) / ctx.traderPrice;
      if (drift > config.maxDriftPct) {
        const ts2 = new Date().toISOString().slice(11, 19);
        console.log(`[${ts2}]     ⏭  PRICEDRIFT  limit $${limitPrice.toFixed(4)} vs trader $${ctx.traderPrice.toFixed(4)}  drift ${(drift * 100).toFixed(1)}% > ${(config.maxDriftPct * 100).toFixed(0)}%`);
        await this.markPriceDrift(ctx.tradeDocId, ctx.traderWallet, attempt, `drift ${(drift * 100).toFixed(1)}% > ${(config.maxDriftPct * 100).toFixed(0)}% limit`);
        return;
      }
    }

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
    const aggrLabel  = fraction === 0 ? 'passive' : fraction === 1.0 ? 'cross' : 'midpoint';
    const ts2 = new Date().toISOString().slice(11, 19);
    console.log(`[${ts2}]     #${attempt} ${side} ${shares.toFixed(2)}sh @ $${limitPrice.toFixed(4)} (${aggrLabel} bid $${book.bestBid.toFixed(4)} ask $${book.bestAsk.toFixed(4)})`);

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
        // fee rate cached silently
      } else {
        feeRateBps = config.feeRateBps;
        console.warn(`[GTTExecutor] Fee rate API unavailable — using config default ${feeRateBps} bps`);
      }
    }

    try {
      // negRisk flag comes from our own disk-persisted cache (populated via GET /markets/<conditionId>).
      // No dependency on clob-client version — works with v3, v5, or any future version.
      const isNegRisk = await this.getNegRiskCached(tokenId, ctx.conditionId);
      // isNegRisk routes to correct exchange silently

      const userOrder = {
        tokenID:    tokenId,
        price:      limitPrice,
        size:       shares,
        side:       side === 'BUY' ? Side.BUY : Side.SELL,
        feeRateBps: feeRateBps,
        nonce:      0,
        expiration,
      };

      const order = await this.clobClient.createOrder(userOrder, { negRisk: isNegRisk });

      const postResp = await this.clobClient.postOrder(order, OrderType.GTD);

      // clob-client sometimes returns an error object instead of throwing (400 responses)
      const respError = String((postResp as any)?.error ?? (postResp as any)?.errorMsg ?? '');
      const feeMatchResp = respError.match(/current market's (?:taker|maker) fee:\s*(\d+)/i);
      if (feeMatchResp) {
        const corrected = parseInt(feeMatchResp[1]);
        this.feeRateCache.set(tokenId, corrected);
        saveFeeCache(this.feeRateCache);
        if (feeRetried) {
          console.error(`[GTTExecutor] Fee correction loop detected (response) — giving up`);
          await this.markFailed(ctx.tradeDocId, ctx.traderWallet, ctx.attempt, 'Fee correction loop');
          return;
        }
        console.log(`[GTTExecutor] Fee correction (response): ${feeRateBps} → ${corrected} bps — retrying`);
        await this.placeOrder(ctx, book, true);
        return;
      }

      const orderId: string = (postResp as any).orderID ?? (postResp as any).id ?? '';

      if (!orderId) {
        // Log the full response so we can diagnose what Polymarket returned
        const rawResp = JSON.stringify(postResp).slice(0, 300);
        console.warn(`[GTTExecutor] No orderId on attempt ${attempt} — raw response: ${rawResp}`);

        // If order size is below Polymarket minimum on a passive limit, keep retrying —
        // aggressive crossing orders (attempt 3 at 100% spread) bypass the passive minimum.
        // Only skip gracefully if ALL attempts exhausted with this error.
        const errMsg = String((postResp as any)?.error ?? '');
        const isSizeTooSmall = /lower than the minimum/i.test(errMsg);
        if (isSizeTooSmall && attempt >= config.maxOrderRetries) {
          await this.skip(ctx.tradeDocId, ctx.traderWallet, 'ALLOCATION_FULL',
            `Order size below Polymarket minimum after ${attempt} attempt(s) — capped bet too small`);
          return;
        }
        if (isSizeTooSmall) {
          console.log(`[GTTExecutor] Size below passive minimum — retrying with more aggression`);
        }

        // Retry up to maxOrderRetries before giving up
        if (attempt < config.maxOrderRetries) {
          const nextAttempt = attempt + 1;
          console.log(`[GTTExecutor] Retrying (attempt ${nextAttempt}/${config.maxOrderRetries}) after no-orderId response`);
          await this.sleep(config.orderRetryDelayMs);
          const freshBook = await orderbookCache.getBothPrices(ctx.tokenId);
          if (freshBook.bestBid && (ctx.side === 'SELL' || freshBook.bestAsk)) {
            await this.placeOrder({ ...ctx, attempt: nextAttempt }, freshBook as { bestBid: number; bestAsk: number });
          } else {
            await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, 'No orderId + no orderbook on retry');
          }
        } else {
          await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, `No orderId after ${attempt} attempts`);
        }
        return;
      }

      const ts3 = new Date().toISOString().slice(11, 19);
      console.log(`[${ts3}]     → order ${orderId.slice(0, 12)}...`);

      // Persist orderId + current attempt so stuck scan uses the correct attempt number
      await CopyTrade.findByIdAndUpdate(ctx.tradeDocId, { orderId, attempts: attempt });

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
        if (feeRetried) {
          console.error(`[GTTExecutor] Fee correction loop detected (catch) — giving up`);
          await this.markFailed(ctx.tradeDocId, ctx.traderWallet, ctx.attempt, 'Fee correction loop');
          return;
        }
        console.log(`[GTTExecutor] Fee correction (catch): ${feeRateBps} → ${corrected} bps — retrying`);
        await this.placeOrder(ctx, book, true);
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
    const needsAsk = pending.side === 'BUY';
    if (!book.bestBid || (needsAsk && !book.bestAsk)) {
      console.error(`[GTTExecutor] No orderbook for retry (bid=${book.bestBid} ask=${book.bestAsk}) — marking FAILED`);
      await this.markFailed(pending.tradeDocId, pending.traderWallet, pending.attempt, 'No orderbook on retry');
      return;
    }

    const ts = new Date().toISOString().slice(11, 19);
    // retry log handled by placeOrder attempt line

    await this.placeOrder(
      { ...pending, attempt: nextAttempt },
      book as { bestBid: number; bestAsk: number }
    );
  }

  private async markPriceDrift(tradeDocId: string, traderWallet: string, attempts: number, detail: string): Promise<void> {
    await CopyTrade.findByIdAndUpdate(tradeDocId, {
      status:     'SKIPPED',
      skipReason: 'PRICEDRIFT_FAILED',
      skipDetail: detail,
      attempts,
    });
    await TraderLoader.recordSkip(traderWallet, 'PRICEDRIFT_FAILED');
    eventBus.emit('trade:skipped', { skipReason: 'PRICEDRIFT_FAILED', skipDetail: detail, docId: tradeDocId });
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

  private async skip(tradeDoc: any, reason: string, detail: string | undefined, wallet: string, avgBet?: number): Promise<void> {
    tradeDoc.status     = 'SKIPPED';
    tradeDoc.skipReason = reason;
    tradeDoc.skipDetail = detail ?? '';
    await tradeDoc.save();
    await TraderLoader.recordSkip(wallet, reason);
    const ts         = new Date().toISOString().slice(11, 19);
    const shortTitle = (tradeDoc.title ?? '').slice(0, 45);
    const betStr     = `$${(tradeDoc.traderBetUsdc ?? 0).toFixed(2)}`;
    const avgStr     = avgBet !== undefined ? `  avgBet $${avgBet}` : '';
    console.log(`[${ts}]     ⏭  SKIP  ${tradeDoc.traderLabel} ${tradeDoc.side} ${betStr} "${shortTitle}"  ${reason}${avgStr}`);
    eventBus.emit('trade:skipped', { skipReason: reason, skipDetail: detail, docId: tradeDoc._id });
  }

  /**
   * Returns the negRisk flag for a market, using a disk-persisted cache keyed by conditionId.
   * Keyed by conditionId (not tokenId) so all outcome tokens of the same market share one entry —
   * a 3-outcome negRisk market fetches metadata once, not 3 times.
   *
   * On cache miss: fetches GET /markets/<conditionId> and persists to disk.
   * On API failure for an unknown market: throws so the order is skipped with a visible error.
   * Defaulting to false would sign against the wrong exchange for negRisk markets — a reverted
   * on-chain tx with no obvious log trail. A skipped order is always preferable.
   */
  private async getNegRiskCached(tokenId: string, conditionId: string): Promise<boolean> {
    if (this.negRiskCache.has(conditionId)) {
      return this.negRiskCache.get(conditionId)!;
    }
    const result = await fetchNegRiskFromMarketAPI(conditionId, config.clobApiBase);
    if (result === null) {
      // Don't default to false — signing against the wrong exchange silently fails on-chain.
      throw new Error(`negRisk lookup failed for conditionId ${conditionId.slice(0, 12)}... — order skipped to avoid wrong-exchange signature`);
    }
    this.negRiskCache.set(conditionId, result);
    saveNegRiskCache(this.negRiskCache);
    if (result) console.log(`[GTTExecutor] NegRisk market cached: conditionId ${conditionId.slice(0, 12)}... (tokenId ${tokenId.slice(0, 10)}...)`);
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
