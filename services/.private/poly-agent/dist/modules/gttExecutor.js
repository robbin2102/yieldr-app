"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GTTExecutor = void 0;
const clob_client_1 = require("@polymarket/clob-client");
const fs_1 = require("fs");
const path_1 = require("path");
const config_1 = require("../config");
const eventBus_1 = require("../state/eventBus");
const orderbookCache_1 = require("../state/orderbookCache");
const CopyTrade_1 = require("../db/models/CopyTrade");
const traderLoader_1 = require("./traderLoader");
const betSizer_1 = require("./betSizer");
const positionFetcher_1 = require("./positionFetcher");
// Persist fee rate cache to disk so corrections survive process restarts.
const FEE_CACHE_PATH = (0, path_1.resolve)(__dirname, '../../data/fee-rate-cache.json');
// Persist negRisk flag to disk — eliminates per-order API call and version dependency.
const NEG_RISK_CACHE_PATH = (0, path_1.resolve)(__dirname, '../../data/neg-risk-cache.json');
function loadFeeCache() {
    try {
        if ((0, fs_1.existsSync)(FEE_CACHE_PATH)) {
            const raw = (0, fs_1.readFileSync)(FEE_CACHE_PATH, 'utf8');
            return new Map(Object.entries(JSON.parse(raw)));
        }
    }
    catch { /* corrupt file — start fresh */ }
    return new Map();
}
function saveFeeCache(cache) {
    try {
        const dir = (0, path_1.resolve)(FEE_CACHE_PATH, '..');
        if (!(0, fs_1.existsSync)(dir))
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        (0, fs_1.writeFileSync)(FEE_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
    }
    catch (e) {
        console.warn('[GTTExecutor] Could not persist fee cache:', e.message);
    }
}
function loadNegRiskCache() {
    try {
        if ((0, fs_1.existsSync)(NEG_RISK_CACHE_PATH)) {
            const raw = (0, fs_1.readFileSync)(NEG_RISK_CACHE_PATH, 'utf8');
            return new Map(Object.entries(JSON.parse(raw)));
        }
    }
    catch { /* corrupt file — start fresh */ }
    return new Map();
}
function saveNegRiskCache(cache) {
    try {
        const dir = (0, path_1.resolve)(NEG_RISK_CACHE_PATH, '..');
        if (!(0, fs_1.existsSync)(dir))
            (0, fs_1.mkdirSync)(dir, { recursive: true });
        (0, fs_1.writeFileSync)(NEG_RISK_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
    }
    catch (e) {
        console.warn('[GTTExecutor] Could not persist negRisk cache:', e.message);
    }
}
/**
 * Fetch the negRisk flag for a market from the CLOB /markets endpoint.
 * Returns null on failure (caller falls back to false = standard CTF exchange).
 */
async function fetchNegRiskFromMarketAPI(conditionId, clobApiBase) {
    try {
        const url = `${clobApiBase}/markets/${conditionId}`;
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const data = await res.json();
        const val = data.neg_risk;
        if (typeof val !== 'boolean')
            return null;
        return val;
    }
    catch {
        return null;
    }
}
/**
 * Fetch the correct fee rate for a token directly from the CLOB API.
 * Each market has its own fee rate (geopolitics=0, crypto=~72, sports=30, etc.).
 * Returns fee_rate_bps, or null on failure (caller falls back to config default).
 */
async function fetchFeeRateFromAPI(tokenId, clobApiBase) {
    try {
        const url = `${clobApiBase}/fee-rate?token_id=${tokenId}`;
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const data = await res.json();
        // API returns { base_fee: 0 } (confirmed). Also handle legacy shapes.
        const bps = data.base_fee ?? data.fee_rate_bps ?? data.maker_fee_rate ?? data.makerFeeRate;
        if (bps === undefined || bps === null)
            return null;
        return parseInt(String(bps), 10);
    }
    catch {
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
class GTTExecutor {
    constructor(clobClient) {
        // Per-token fee rate cache — persisted to disk so corrections survive restarts.
        // Eliminates fee correction round-trips for every subsequent order on same market.
        this.feeRateCache = loadFeeCache();
        // Per-token negRisk flag cache — persisted to disk.
        // Avoids calling clobClient.getNegRisk() (version-dependent) on every order.
        // Populated on first encounter via GET /markets/<conditionId>; never changes for a market.
        this.negRiskCache = loadNegRiskCache();
        // In-memory reservation map for per-position cap race-condition fix.
        // Key: `wallet:conditionId` — Value: USDC reserved by in-flight BUYs not yet EXECUTING in DB.
        // Updated SYNCHRONOUSLY (no await) so concurrent handleTrade() calls see each other's reservations.
        this.positionReserved = new Map();
        this.clobClient = clobClient;
        eventBus_1.eventBus.on('trade:detected', (event) => {
            this.handleTrade(event).catch(err => console.error('[GTTExecutor] Unhandled error:', err.message));
        });
        // Confirmer emits this when a GTD order expires without filling
        eventBus_1.eventBus.on('order:expired', (pending) => {
            this.handleOrderExpired(pending).catch(err => console.error('[GTTExecutor] Retry error:', err.message));
        });
    }
    async handleTrade(event) {
        const { traderConfig, txHash, side, traderBetUsdc, traderPrice, traderSize, tokenId, conditionId, title, outcome, traderTs, detectedAt, discoveryLatencyMs } = event;
        const ts = new Date().toISOString().slice(11, 19);
        // ── 1. Dedup via unique txHash ────────────────────────────────────────────
        let tradeDoc;
        try {
            tradeDoc = await CopyTrade_1.CopyTrade.create({
                sourceWallet: traderConfig.wallet,
                traderLabel: traderConfig.label,
                txHash, conditionId, tokenId, title, outcome, side,
                traderBetUsdc, traderPrice, traderSize,
                traderTs, detectedAt, discoveryLatencyMs,
                status: 'DETECTED',
                copyBetUsdc: 0,
            });
        }
        catch (err) {
            if (err.code === 11000)
                return; // silent dedup — already processed
            throw err;
        }
        await traderLoader_1.TraderLoader.recordDetected(traderConfig.wallet);
        // ── 2. Fresh trader state + conviction-proportional bet sizing ───────────
        const freshTrader = await traderLoader_1.TraderLoader.get(traderConfig.wallet);
        if (!freshTrader)
            return;
        // ── 3. BUY: conviction-proportional sizing via avgBet filter ─────────────
        // Run calcCopyBet early — before fetching orderbook or printing header.
        // BELOW_AVG trades (e.g. 31 × $1 from T1) are silently skipped with a
        // compact one-liner so they don't flood the terminal.
        let targetUsdc = 0;
        let targetShares;
        let buyBetUsdc = 0;
        if (side === 'BUY') {
            const sizing = (0, betSizer_1.calcCopyBet)(traderBetUsdc, freshTrader);
            if (sizing.skip) {
                await this.skip(tradeDoc, sizing.skipReason, sizing.skipDetail, freshTrader.wallet, freshTrader.avgBet);
                if (sizing.skipReason !== 'BELOW_AVG')
                    await traderLoader_1.TraderLoader.recordAboveAvg(freshTrader.wallet);
                return;
            }
            await traderLoader_1.TraderLoader.recordAboveAvg(freshTrader.wallet);
            buyBetUsdc = sizing.betUsdc; // saved — used below after header
        }
        // Verbose header only for trades that pass the initial BUY filter (or are SELLs)
        console.log(`\n[${ts}] ━━━ ${traderConfig.label} ${side} $${traderBetUsdc.toFixed(0)} | "${title.slice(0, 40)}" | lag ${discoveryLatencyMs}ms`);
        console.log(`[${ts}]     📋 doc: ${tradeDoc._id}  tx: ${txHash.slice(0, 12)}...`);
        // ── Orderbook (needed for both BUY and SELL sizing) ───────────────────────
        const book = await orderbookCache_1.orderbookCache.getBothPrices(tokenId);
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
        if (side === 'BUY') {
            targetUsdc = buyBetUsdc;
            // ── Per-position cap: max 20% of allocationUsdc on any single market ──
            // Race-condition fix: combine DB-persisted spend with in-memory reservations
            // from concurrent handleTrade() calls that haven't saved EXECUTING yet.
            // positionReserved.set() is SYNCHRONOUS — no await between check and set —
            // so concurrent promises see each other's reservation without yielding.
            const lockKey = `${freshTrader.wallet}:${conditionId || tokenId}`;
            const alreadyReserved = this.positionReserved.get(lockKey) ?? 0;
            // Pre-reserve the FULL buyBetUsdc BEFORE any await.
            // This is the race-condition fix: all concurrent handleTrade() calls read
            // the reservation synchronously, so each sees the previous one's claim.
            // Without this, 4 simultaneous trades all read 0 and all pass the cap check.
            this.positionReserved.set(lockKey, alreadyReserved + buyBetUsdc);
            const dbSpent = await this.getPositionSpent(freshTrader.wallet, tokenId, conditionId);
            const maxPerPosition = freshTrader.allocationUsdc * 0.20;
            // Use alreadyReserved (what was there BEFORE us) — that's the committed amount
            const positionAvail = maxPerPosition - dbSpent - alreadyReserved;
            if (positionAvail <= 0) {
                // Release our pre-reservation since we're skipping
                const cur = this.positionReserved.get(lockKey) ?? 0;
                const upd = Math.max(0, cur - buyBetUsdc);
                if (upd === 0)
                    this.positionReserved.delete(lockKey);
                else
                    this.positionReserved.set(lockKey, upd);
                await this.skip(tradeDoc, 'ALLOCATION_FULL', `position cap reached ($${(dbSpent + alreadyReserved).toFixed(2)} / $${maxPerPosition.toFixed(2)} max per position)`, freshTrader.wallet, freshTrader.avgBet);
                return;
            }
            const betCapped = Math.min(buyBetUsdc, positionAvail);
            if (betCapped < buyBetUsdc) {
                // Trim reservation down to what we'll actually use
                const cur = this.positionReserved.get(lockKey) ?? 0;
                this.positionReserved.set(lockKey, Math.max(0, cur - (buyBetUsdc - betCapped)));
                console.log(`[GTTExecutor] BUY capped to $${betCapped.toFixed(2)} (db=$${dbSpent.toFixed(2)} + inflight=$${alreadyReserved.toFixed(2)} / max $${maxPerPosition.toFixed(2)})`);
            }
            targetUsdc = betCapped;
            // ── 4. SELL: proportional exit — (traderSellSize / traderTotalBought) × ourShares ──
        }
        else {
            // Note: ALLOCATION_FULL does NOT block SELLs — selling returns capital, not consumes it.
            // 4a. Verify we hold this position (live API check)
            const ourCurrentShares = await positionFetcher_1.positionFetcher.getOurShares(tokenId);
            if (ourCurrentShares < 0.01) {
                await this.skip(tradeDoc, 'SELL_NO_POSITION', `have ${ourCurrentShares.toFixed(4)} shares`, freshTrader.wallet);
                return;
            }
            // 4c. Trader's total bought shares for this token (primary) or condition (fallback)
            const traderTotalBoughtShares = await this.getTraderTotalBoughtShares(traderConfig.wallet, tokenId, conditionId);
            // 4d. Proportional exit: sell the same fraction of our position as the trader
            let exitShares;
            if (traderTotalBoughtShares > 0) {
                const exitFraction = Math.min(traderSize / traderTotalBoughtShares, 1.0);
                exitShares = exitFraction * ourCurrentShares;
                console.log(`[GTTExecutor] SELL: trader selling ${(exitFraction * 100).toFixed(1)}% of position → exit ${exitShares.toFixed(4)} of our ${ourCurrentShares.toFixed(4)} shares`);
            }
            else {
                // No BUY history found — exit all shares as safe default
                exitShares = ourCurrentShares;
                console.log(`[GTTExecutor] SELL: no BUY history — exiting all ${ourCurrentShares.toFixed(4)} shares`);
            }
            exitShares = Math.min(exitShares, ourCurrentShares); // never oversell
            if (exitShares < 0.1) {
                await this.skip(tradeDoc, 'SELL_NO_POSITION', `exit shares too small (${exitShares.toFixed(4)})`, freshTrader.wallet);
                return;
            }
            targetUsdc = exitShares * safeBook.bestAsk; // use ask (our posting price) for doc accuracy
            targetShares = exitShares;
        }
        // ── 5. Update doc to EXECUTING ────────────────────────────────────────────
        const submittedAt = Date.now();
        const submissionLatencyMs = submittedAt - detectedAt;
        tradeDoc.copyBetUsdc = targetUsdc;
        tradeDoc.submittedAt = submittedAt;
        tradeDoc.submissionLatencyMs = submissionLatencyMs;
        tradeDoc.status = 'EXECUTING';
        // Wrap save in try/finally so the BUY reservation is ALWAYS released,
        // even if the DB write fails. Without this, a DB error between reservation
        // and release would permanently block future BUYs on that position until restart.
        try {
            await tradeDoc.save();
        }
        finally {
            if (side === 'BUY') {
                const lockKey = `${freshTrader.wallet}:${conditionId || tokenId}`;
                const prev = this.positionReserved.get(lockKey) ?? 0;
                const updated = Math.max(0, prev - targetUsdc);
                if (updated === 0)
                    this.positionReserved.delete(lockKey);
                else
                    this.positionReserved.set(lockKey, updated);
            }
        }
        eventBus_1.eventBus.emit('trade:executing', { txHash, traderLabel: traderConfig.label, betUsdc: targetUsdc });
        // ── 6. Final real-time allocation guard ──────────────────────────────────
        // calcCopyBet used a snapshot from the start of handleTrade. A concurrent fill
        // between then and now could have consumed the allocation. Re-check DB before
        // committing to an order.
        if (side === 'BUY' && !(await traderLoader_1.TraderLoader.hasAllocation(freshTrader.wallet, targetUsdc))) {
            await this.skip(tradeDoc, 'ALLOCATION_FULL', 'allocation consumed by concurrent fill', freshTrader.wallet);
            return;
        }
        // ── 7. Place GTD maker order (attempt 1) ──────────────────────────────────
        await this.placeOrder({
            tradeDocId: tradeDoc._id.toString(),
            traderWallet: freshTrader.wallet,
            side,
            tokenId,
            conditionId,
            targetUsdc,
            targetShares,
            attempt: 1,
            traderPrice,
            traderTs,
            detectedAt,
            filledSize: 0,
            filledCost: 0,
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
    async getPositionSpent(wallet, tokenId, conditionId) {
        const filter = (side, statuses) => ({
            sourceWallet: wallet.toLowerCase(),
            side,
            status: { $in: statuses },
            $or: [{ tokenId }, { conditionId }],
        });
        const [buys, sells] = await Promise.all([
            CopyTrade_1.CopyTrade.aggregate([
                { $match: filter('BUY', ['FILLED', 'PARTIAL', 'EXECUTING']) },
                { $group: { _id: null, total: {
                            // EXECUTING: committed but not yet filled — count copyBetUsdc
                            // FILLED/PARTIAL: count actual filledUsdc
                            $sum: { $cond: [{ $eq: ['$status', 'EXECUTING'] }, '$copyBetUsdc', '$filledUsdc'] }
                        } } },
            ]),
            CopyTrade_1.CopyTrade.aggregate([
                { $match: filter('SELL', ['FILLED', 'PARTIAL']) },
                { $group: { _id: null, total: { $sum: '$filledUsdc' } } },
            ]),
        ]);
        const buySpent = buys[0]?.total ?? 0;
        const sellRecovered = sells[0]?.total ?? 0;
        return Math.max(0, buySpent - sellRecovered);
    }
    async getTraderTotalBoughtShares(sourceWallet, tokenId, conditionId) {
        const match = async (filter) => {
            const result = await CopyTrade_1.CopyTrade.aggregate([
                { $match: { sourceWallet, side: 'BUY', status: { $in: ['FILLED', 'EXECUTING'] }, ...filter } },
                { $group: { _id: null, total: { $sum: '$traderSize' } } },
            ]);
            return result[0]?.total ?? 0;
        };
        const byToken = await match({ tokenId });
        if (byToken > 0)
            return byToken;
        const byCondition = await match({ conditionId });
        return byCondition;
    }
    /**
     * Place a single GTD maker order and emit 'trade:submitted'.
     * Confirmer picks it up and waits for the WebSocket fill push.
     */
    async placeOrder(ctx, book, feeRetried = false // guard against infinite recursion on fee correction
    ) {
        const { side, tokenId, targetUsdc, filledCost, attempt } = ctx;
        // targetShares is checked via ctx.targetShares in shares calculation below
        // Spread-proportional aggression: each retry covers more of the spread toward the opposite side.
        // Attempt 1: passive (bestBid / bestAsk), attempt 2: midpoint, attempt 3+: just inside opposite side.
        const spread = book.bestAsk - book.bestBid;
        const fraction = AGGRESSION_FRACTIONS[attempt - 1] ?? 1.0;
        const aggrStep = spread * fraction;
        const rawPrice = side === 'BUY'
            ? Math.min(book.bestBid + aggrStep, book.bestAsk - 0.001) // stay below ask
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
        const expiration = Math.floor(Date.now() / 1000) + 60 + config_1.config.gttExpirySeconds;
        const aggrLabel = fraction > 0 ? ` +${(fraction * 100).toFixed(0)}% spread (${(aggrStep * 100).toFixed(1)}¢)` : '';
        console.log(`[GTTExecutor] Attempt ${attempt}: GTD ${side} ~${shares.toFixed(2)} shares @ $${limitPrice.toFixed(4)}${aggrLabel} (expiry ${config_1.config.gttExpirySeconds}s)`);
        // Resolve fee rate: cached → API fetch → config default.
        // Fetching from API on first encounter eliminates the error-then-correct round trip
        // since each market has its own fee (geopolitics=0, crypto=72bps, sports=30bps, etc.)
        let feeRateBps;
        if (this.feeRateCache.has(tokenId)) {
            feeRateBps = this.feeRateCache.get(tokenId);
        }
        else {
            const apiFee = await fetchFeeRateFromAPI(tokenId, config_1.config.clobApiBase);
            if (apiFee !== null) {
                feeRateBps = apiFee;
                this.feeRateCache.set(tokenId, feeRateBps);
                saveFeeCache(this.feeRateCache);
                console.log(`[GTTExecutor] Fee rate fetched from API: ${feeRateBps} bps (${tokenId.slice(0, 10)}...)`);
            }
            else {
                feeRateBps = config_1.config.feeRateBps;
                console.warn(`[GTTExecutor] Fee rate API unavailable — using config default ${feeRateBps} bps`);
            }
        }
        try {
            // negRisk flag comes from our own disk-persisted cache (populated via GET /markets/<conditionId>).
            // No dependency on clob-client version — works with v3, v5, or any future version.
            const isNegRisk = await this.getNegRiskCached(tokenId, ctx.conditionId);
            if (isNegRisk)
                console.log(`[GTTExecutor] NegRisk market — using NegRisk exchange (${tokenId.slice(0, 10)}...)`);
            const userOrder = {
                tokenID: tokenId,
                price: limitPrice,
                size: shares,
                side: side === 'BUY' ? clob_client_1.Side.BUY : clob_client_1.Side.SELL,
                feeRateBps: feeRateBps,
                nonce: 0,
                expiration,
            };
            const order = await this.clobClient.createOrder(userOrder, { negRisk: isNegRisk });
            const postResp = await this.clobClient.postOrder(order, clob_client_1.OrderType.GTD);
            // clob-client sometimes returns an error object instead of throwing (400 responses)
            const respError = String(postResp?.error ?? postResp?.errorMsg ?? '');
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
            const orderId = postResp.orderID ?? postResp.id ?? '';
            if (!orderId) {
                // Log the full response so we can diagnose what Polymarket returned
                const rawResp = JSON.stringify(postResp).slice(0, 300);
                console.warn(`[GTTExecutor] No orderId on attempt ${attempt} — raw response: ${rawResp}`);
                // If order size is below Polymarket minimum on a passive limit, keep retrying —
                // aggressive crossing orders (attempt 3 at 100% spread) bypass the passive minimum.
                // Only skip gracefully if ALL attempts exhausted with this error.
                const errMsg = String(postResp?.error ?? '');
                const isSizeTooSmall = /lower than the minimum/i.test(errMsg);
                if (isSizeTooSmall && attempt >= config_1.config.maxOrderRetries) {
                    await this.skip(ctx.tradeDocId, ctx.traderWallet, 'ALLOCATION_FULL', `Order size below Polymarket minimum after ${attempt} attempt(s) — capped bet too small`);
                    return;
                }
                if (isSizeTooSmall) {
                    console.log(`[GTTExecutor] Size below passive minimum — retrying with more aggression`);
                }
                // Retry up to maxOrderRetries before giving up
                if (attempt < config_1.config.maxOrderRetries) {
                    const nextAttempt = attempt + 1;
                    console.log(`[GTTExecutor] Retrying (attempt ${nextAttempt}/${config_1.config.maxOrderRetries}) after no-orderId response`);
                    await this.sleep(config_1.config.orderRetryDelayMs);
                    const freshBook = await orderbookCache_1.orderbookCache.getBothPrices(ctx.tokenId);
                    if (freshBook.bestBid && (ctx.side === 'SELL' || freshBook.bestAsk)) {
                        await this.placeOrder({ ...ctx, attempt: nextAttempt }, freshBook);
                    }
                    else {
                        await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, 'No orderId + no orderbook on retry');
                    }
                }
                else {
                    await this.markFailed(ctx.tradeDocId, ctx.traderWallet, attempt, `No orderId after ${attempt} attempts`);
                }
                return;
            }
            console.log(`[GTTExecutor] Order placed: ${orderId.slice(0, 12)}... — handing off to Confirmer`);
            // Persist orderId to DB so stale EXECUTING docs can be diagnosed after restart
            await CopyTrade_1.CopyTrade.findByIdAndUpdate(ctx.tradeDocId, { orderId });
            // Hand off to Confirmer — it will receive the fill via WebSocket User Channel
            const pending = {
                ...ctx,
                orderId,
                limitPrice,
                submittedAt: Date.now(),
            };
            eventBus_1.eventBus.emit('trade:submitted', pending);
        }
        catch (err) {
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
    async handleOrderExpired(pending) {
        const nextAttempt = pending.attempt + 1;
        if (nextAttempt > config_1.config.maxOrderRetries) {
            console.log(`[GTTExecutor] Max retries (${config_1.config.maxOrderRetries}) reached for doc ${pending.tradeDocId} — marking FAILED`);
            await this.markFailed(pending.tradeDocId, pending.traderWallet, pending.attempt, `GTD unfilled after ${pending.attempt} attempts`);
            return;
        }
        // Small delay before retry
        await this.sleep(config_1.config.orderRetryDelayMs);
        // Fresh orderbook price for retry
        const book = await orderbookCache_1.orderbookCache.getBothPrices(pending.tokenId);
        const needsAsk = pending.side === 'BUY';
        if (!book.bestBid || (needsAsk && !book.bestAsk)) {
            console.error(`[GTTExecutor] No orderbook for retry (bid=${book.bestBid} ask=${book.bestAsk}) — marking FAILED`);
            await this.markFailed(pending.tradeDocId, pending.traderWallet, pending.attempt, 'No orderbook on retry');
            return;
        }
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] 🔁 Retrying order for doc ${pending.tradeDocId} (attempt ${nextAttempt}/${config_1.config.maxOrderRetries})`);
        await this.placeOrder({ ...pending, attempt: nextAttempt }, book);
    }
    async markFailed(tradeDocId, traderWallet, attempts, reason) {
        await CopyTrade_1.CopyTrade.findByIdAndUpdate(tradeDocId, {
            status: 'FAILED',
            failReason: reason,
            attempts,
        });
        await traderLoader_1.TraderLoader.recordSkip(traderWallet, 'ORDER_FAILED');
        eventBus_1.eventBus.emit('trade:failed', { tradeDocId, reason });
    }
    async skip(tradeDoc, reason, detail, wallet, avgBet) {
        tradeDoc.status = 'SKIPPED';
        tradeDoc.skipReason = reason;
        tradeDoc.skipDetail = detail ?? '';
        await tradeDoc.save();
        await traderLoader_1.TraderLoader.recordSkip(wallet, reason);
        const ts = new Date().toISOString().slice(11, 19);
        const shortTitle = (tradeDoc.title ?? '').slice(0, 45);
        const betStr = `$${(tradeDoc.traderBetUsdc ?? 0).toFixed(2)}`;
        const avgStr = avgBet !== undefined ? `  avgBet $${avgBet}` : '';
        console.log(`[${ts}]     ⏭  SKIP  ${tradeDoc.traderLabel} ${tradeDoc.side} ${betStr} "${shortTitle}"  ${reason}${avgStr}`);
        eventBus_1.eventBus.emit('trade:skipped', { skipReason: reason, skipDetail: detail, docId: tradeDoc._id });
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
    async getNegRiskCached(tokenId, conditionId) {
        if (this.negRiskCache.has(conditionId)) {
            return this.negRiskCache.get(conditionId);
        }
        const result = await fetchNegRiskFromMarketAPI(conditionId, config_1.config.clobApiBase);
        if (result === null) {
            // Don't default to false — signing against the wrong exchange silently fails on-chain.
            throw new Error(`negRisk lookup failed for conditionId ${conditionId.slice(0, 12)}... — order skipped to avoid wrong-exchange signature`);
        }
        this.negRiskCache.set(conditionId, result);
        saveNegRiskCache(this.negRiskCache);
        if (result)
            console.log(`[GTTExecutor] NegRisk market cached: conditionId ${conditionId.slice(0, 12)}... (tokenId ${tokenId.slice(0, 10)}...)`);
        return result;
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.GTTExecutor = GTTExecutor;
//# sourceMappingURL=gttExecutor.js.map