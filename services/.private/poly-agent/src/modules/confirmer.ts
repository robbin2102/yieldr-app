import WebSocket from 'ws';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { CopyTrade } from '../db/models/CopyTrade';
import { TraderLoader } from './traderLoader';
import { PendingOrder } from '../types';
import { DetectedTradeEvent } from './multiDetector';

/**
 * Confirmer — tracks GTD maker order fills via Polymarket WebSocket User Channel.
 *
 * WHY WEBSOCKET (NOT REST POLLING):
 *   Polymarket's GET /order/{id} returns 404 as soon as an order leaves the
 *   active-orders index (i.e. the moment it fills, cancels, or expires).
 *   There is no way to poll for fill status without hitting 404s on every fill.
 *   The correct approach — used by all Polymarket market-maker bots — is to
 *   subscribe to the User Channel and receive push notifications.
 *
 * Fill detection for GTD MAKER orders:
 *   When our maker order fills, Polymarket pushes a 'trade' event containing:
 *     maker_order_id = our order ID   ← we match on this
 *     taker_order_id = counterparty's order ID
 *   The previous code matched on taker_order_id, which NEVER matched our
 *   maker orders.
 *
 * Retry flow:
 *   When a GTD order expires without filling, Polymarket sends an 'order'
 *   event with type='CANCELLATION'. Confirmer emits 'order:expired' so
 *   GTTExecutor can place a fresh order with an updated price.
 *
 * Reconnect:
 *   Auto-reconnects on disconnect with 5s delay.
 *   No REST polling fallback — REST polling was the source of the 404 problem.
 */
export class Confirmer {
  private ws: WebSocket | null = null;
  private pendingOrders: Map<string, PendingOrder> = new Map();  // orderId → PendingOrder
  private reconnecting = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private stuckScanInterval: NodeJS.Timeout | null = null;
  private groupedScanInterval: NodeJS.Timeout | null = null;
  private stopped = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[Confirmer] Connecting to WebSocket User Channel...');
      this.ws = new WebSocket(config.wssUser);

      const authTimeout = setTimeout(() => {
        if (!this.stopped) {
          console.error('[Confirmer] Auth timeout — no response in 10s');
          this.ws?.close();
          reject(new Error('Confirmer auth timeout'));
        }
      }, 10_000);

      this.ws.on('open', () => {
        this.sendAuth();
        clearTimeout(authTimeout);
        this.reconnecting = false;
        this.startHeartbeat();
        console.log('[Confirmer] ✅ Connected to User Channel — waiting for fill events');
        resolve();
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();
        if (raw === 'PONG') return;

        let msg: any;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.event_type === 'trade') {
          this.handleTradeFill(msg).catch(err =>
            console.error('[Confirmer] Fill handler error:', err.message)
          );
        } else if (msg.event_type === 'order') {
          this.handleOrderUpdate(msg).catch(err =>
            console.error('[Confirmer] Order update error:', err.message)
          );
        }
      });

      this.ws.on('close', (code) => {
        clearTimeout(authTimeout);
        this.stopHeartbeat();
        console.log(`[Confirmer] Disconnected (code: ${code})`);
        if (!this.stopped) this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(authTimeout);
        console.error('[Confirmer] WebSocket error:', err.message);
      });

      // Track pending orders emitted by GTTExecutor
      eventBus.on('trade:submitted', (pending: PendingOrder) => {
        this.pendingOrders.set(pending.orderId, pending); // tracking silently — order logged above
      });
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.stuckScanInterval)   { clearInterval(this.stuckScanInterval);   this.stuckScanInterval   = null; }
    if (this.groupedScanInterval) { clearInterval(this.groupedScanInterval); this.groupedScanInterval = null; }
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Periodically scan for EXECUTING docs that have been stuck longer than
   * gttExpirySeconds + 60s. Emits 'order:expired' so GTTExecutor retries them.
   * Catches fills missed by WebSocket during running sessions (not just restarts).
   */
  startStuckOrderScan(): void {
    const scanIntervalMs = 60_000; // scan every 60s
    this.stuckScanInterval = setInterval(async () => {
      if (this.stopped) return;
      try {
        const staleMs  = (config.gttExpirySeconds + 60) * 1000;
        const cutoff   = Date.now() - staleMs;
        const { CopyTrade } = await import('../db/models/CopyTrade');
        const stale = await CopyTrade.find({ status: 'EXECUTING', submittedAt: { $lt: cutoff } });
        if (stale.length === 0) return;

        // Skip docs already tracked in-memory — they're mid-flight, not actually stuck
        const activeDocIds = new Set([...this.pendingOrders.values()].map(p => p.tradeDocId));
        const reallyStale = stale.filter(doc => !activeDocIds.has(doc._id.toString()));
        if (reallyStale.length === 0) return;

        const ts = new Date().toISOString().slice(11, 19);
        console.warn(`[${ts}] [Confirmer] ⚠️  ${reallyStale.length} stuck EXECUTING doc(s) found — triggering retry`);
        for (const doc of reallyStale) {
          // Build a minimal PendingOrder from the doc so GTTExecutor can retry
          const pending: PendingOrder = {
            tradeDocId:   doc._id.toString(),
            traderWallet: doc.sourceWallet,
            side:         doc.side as 'BUY' | 'SELL',
            tokenId:      doc.tokenId,
            conditionId:  doc.conditionId,
            targetUsdc:   doc.copyBetUsdc,
            targetShares: doc.side === 'SELL' ? (doc as any).targetShares : undefined,
            filledSize:   0,
            filledCost:   0,
            attempt:      (doc.attempts ?? 1),
            traderPrice:  doc.traderPrice,
            traderTs:     doc.traderTs,
            detectedAt:   doc.detectedAt,
            orderId:      (doc as any).orderId ?? '',
            limitPrice:   0,
            submittedAt:  doc.submittedAt ?? Date.now(),
          };
          eventBus.emit('order:expired', pending);
        }
      } catch (err: any) {
        // DB unavailable (e.g. network blip) — skip this scan cycle, Mongoose will reconnect
        console.warn(`[Confirmer] Stuck scan skipped — DB error: ${err.message?.slice(0, 80)}`);
      }
    }, scanIntervalMs);
  }

  /**
   * Periodically aggregate BELOW_AVG skipped trades on the same market.
   * When grouped total >= trader.avgBet, fires one conviction copy trade
   * using the same conviction multiplier as the real-time path.
   *
   * Runs every groupScanIntervalMs (10m), looks back groupScanWindowMs (30m).
   * Sub-orders that form a group are relabelled GROUPED_BELOW_AVG so they
   * are not counted again in future scans.
   */
  startGroupedTradeScanner(): void {
    this.groupedScanInterval = setInterval(async () => {
      if (this.stopped) return;
      try {
        await this.scanGroupedTrades();
      } catch (err: any) {
        console.warn(`[GroupScanner] Scan error: ${err.message?.slice(0, 80)}`);
      }
    }, config.groupScanIntervalMs);
  }

  /**
   * Run a one-time scan on startup with a wider lookback window (3h) to catch
   * accumulated BELOW_AVG trades from before the bot was last running.
   * The regular 30m rolling scanner won't reach these.
   */
  async runStartupScan(): Promise<void> {
    const startupWindowMs = 3 * 60 * 60 * 1000; // 3h
    try {
      await this.scanGroupedTrades(startupWindowMs);
    } catch (err: any) {
      console.warn(`[GroupScanner] Startup scan error: ${err.message?.slice(0, 80)}`);
    }
  }

  private async scanGroupedTrades(windowMs = config.groupScanWindowMs): Promise<void> {
    const since    = Date.now() - windowMs;
    const windowLabel = `${Math.round(windowMs / 60000)}m`;

    // Group BELOW_AVG skips by (sourceWallet, tokenId) within the rolling window.
    // Only picks up docs still labelled BELOW_AVG — GROUPED_BELOW_AVG are excluded.
    const groups = await CopyTrade.aggregate([
      {
        $match: {
          // Include GROUPED_BELOW_AVG so orphaned groups (relabelled but event
          // lost due to race condition on previous run) are re-processed.
          // syntheticTxHash dedup in handleTrade() prevents double-firing for
          // groups that already have a copy trade doc.
          skipReason: { $in: ['BELOW_AVG', 'GROUPED_BELOW_AVG'] },
          status:     'SKIPPED',
          side:       'BUY',
          detectedAt: { $gte: since },
        },
      },
      {
        $group: {
          _id:         { sourceWallet: '$sourceWallet', tokenId: '$tokenId' },
          totalUsdc:   { $sum: '$traderBetUsdc' },
          totalShares: { $sum: '$traderSize' },
          firstSeen:   { $min: '$detectedAt' },
          conditionId: { $first: '$conditionId' },
          title:       { $first: '$title' },
          outcome:     { $first: '$outcome' },
          traderLabel: { $first: '$traderLabel' },
          docIds:      { $push: '$_id' },
        },
      },
    ]);

    let qualified = 0;

    for (const group of groups) {
      const { sourceWallet, tokenId } = group._id;
      const { totalUsdc, totalShares, firstSeen, conditionId, title, outcome, traderLabel, docIds } = group;

      // Load fresh trader state
      const trader = await TraderLoader.get(sourceWallet);
      if (!trader || !trader.active) continue;

      // Trigger threshold: grouped total must reach avgBet (same filter as real-time path)
      if (totalUsdc < trader.avgBet) continue;

      qualified++;

      // VWAP — reference price for the drift check inside placeOrder()
      const vwap = totalUsdc / totalShares;

      // Relabel constituent docs BEFORE emitting so the next scan skips them.
      // updateMany is atomic per-doc — if this fails the scan retries next cycle cleanly.
      await CopyTrade.updateMany(
        { _id: { $in: docIds } },
        { $set: { skipReason: 'GROUPED_BELOW_AVG' } }
      );

      const ts = new Date().toISOString().slice(11, 19);
      console.log(`[${ts}] 🔄 GROUPED  ${traderLabel}  ${docIds.length} sub-orders → $${totalUsdc.toFixed(0)} USDC @ VWAP $${vwap.toFixed(4)} — firing copy`);

      // Synthetic txHash: deterministic per group so duplicate-key dedup in
      // handleTrade() silently no-ops if this fires twice (e.g. scanner overlap).
      const syntheticTxHash = `grouped_${sourceWallet.slice(2, 10)}_${tokenId.slice(0, 12)}_${firstSeen}`;

      eventBus.emit('trade:detected', {
        traderConfig:       trader,
        txHash:             syntheticTxHash,
        side:               'BUY' as const,
        traderBetUsdc:      totalUsdc,
        traderPrice:        vwap,
        traderSize:         totalShares,
        tokenId,
        conditionId,
        title,
        outcome,
        traderTs:           firstSeen,
        detectedAt:         Date.now(),
        discoveryLatencyMs: Date.now() - firstSeen,
      } as DetectedTradeEvent);
    }

    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] [GroupScanner] Scanned ${groups.length} group(s), ${qualified} qualified (window: last ${windowLabel})`);
  }

  private sendAuth(): void {
    this.ws?.send(JSON.stringify({
      type:    'user',
      markets: [],
      auth: {
        apiKey:     config.apiKey,
        secret:     config.apiSecret,
        passphrase: config.passphrase,
      },
    }));
  }

  /**
   * Handle 'trade' event from User Channel.
   *
   * For GTD maker orders our orderId is in maker_order_id.
   * We also check taker_order_id for completeness (handles any FAK/taker orders).
   *
   * Partial fills accumulate: multiple trade events may arrive for one order.
   * We keep the pending entry until the total filled cost covers 90%+ of target.
   */
  private async handleTradeFill(msg: any): Promise<void> {
    // Polymarket trade event format:
    //   maker_orders: [{ order_id, maker_address, matched_amount, fee_rate_bps }]  ← array, not a scalar
    //   taker_order_id: string
    const makerOrderId: string = (msg.maker_orders as any[])?.[0]?.order_id ?? '';
    const takerOrderId: string = msg.taker_order_id ?? '';

    const matchId = this.pendingOrders.has(makerOrderId)
      ? makerOrderId
      : (this.pendingOrders.has(takerOrderId) ? takerOrderId : '');

    const pending = this.pendingOrders.get(matchId);
    if (!pending) {
      // Log unmatched fills so we can diagnose orderId format mismatches
      if (this.pendingOrders.size > 0) {
        const knownIds = [...this.pendingOrders.keys()].map(k => k.slice(0, 12)).join(', ');
        const ts = new Date().toISOString().slice(11, 19);
        console.warn(`[${ts}] [Confirmer] ⚠️  Fill event — unmatched order maker=${makerOrderId.slice(0, 12)} taker=${takerOrderId.slice(0, 12)} | tracking: [${knownIds}]`);
      }
      return;  // Not our order
    }

    const fillSize  = parseFloat(msg.size  ?? '0');
    const fillPrice = parseFloat(msg.price ?? '0');

    if (fillSize <= 0) return;

    // Accumulate partial fills
    pending.filledSize += fillSize;
    pending.filledCost += fillSize * fillPrice;

    const avgFillPrice  = pending.filledCost / pending.filledSize;
    const filledUsdc    = pending.filledCost;
    const priceDrift    = pending.traderPrice > 0
      ? ((avgFillPrice - pending.traderPrice) / pending.traderPrice) * 100
      : 0;

    const filledAt       = Date.now();
    const fillLatencyMs  = filledAt - pending.submittedAt;
    const totalLatencyMs = filledAt - pending.traderTs;

    // Determine if fully filled (>= 90% of target).
    // SELL orders use targetShares (shares-based); BUY orders use targetUsdc.
    const fullyFilled = pending.targetShares !== undefined
      ? pending.filledSize >= pending.targetShares * 0.9
      : filledUsdc >= pending.targetUsdc * 0.9;
    const status      = fullyFilled ? 'FILLED' : 'PARTIAL';

    const ts = new Date().toISOString().slice(11, 19);
    const driftStr = `${priceDrift >= 0 ? '+' : ''}${priceDrift.toFixed(2)}%`;
    const latSec   = (totalLatencyMs / 1000).toFixed(0);
    console.log(`[${ts}] ✅ ${status}  ${pending.filledSize.toFixed(2)}sh @ $${avgFillPrice.toFixed(4)} | drift ${driftStr} | ${latSec}s | attempt ${pending.attempt}`);

    // Update CopyTrade document
    await CopyTrade.findByIdAndUpdate(pending.tradeDocId, {
      status,
      filledAt,
      fillLatencyMs,
      totalLatencyMs,
      filledSize:   pending.filledSize,
      avgFillPrice,
      filledUsdc,
      priceDrift,
      attempts:     pending.attempt,
    });

    // BUY fills consume allocation; SELL fills recycle proceeds back into the pool.
    if (pending.side === 'BUY') {
      await TraderLoader.recordFill(pending.traderWallet, filledUsdc);
    } else {
      await TraderLoader.recordSellFill(pending.traderWallet, filledUsdc);
    }

    eventBus.emit('trade:filled', {
      tradeDocId:   pending.tradeDocId,
      traderWallet: pending.traderWallet,
      filledSize:   pending.filledSize,
      avgFillPrice,
      priceDrift,
      totalLatencyMs,
      attempts: pending.attempt,
    });

    if (fullyFilled) {
      this.pendingOrders.delete(matchId);
    }
    // If partial: keep tracking — more fill events may arrive for same order
  }

  /**
   * Handle 'order' event from User Channel.
   *
   * CANCELLATION = order left the book without filling (expired GTD or manual cancel).
   * Emit 'order:expired' so GTTExecutor can retry with a fresh price.
   */
  private async handleOrderUpdate(msg: any): Promise<void> {
    if (msg.type !== 'CANCELLATION') return;

    const pending = this.pendingOrders.get(msg.id);
    if (!pending) return;

    this.pendingOrders.delete(msg.id);

    const ts = new Date().toISOString().slice(11, 19);

    if (pending.filledSize > 0) {
      // Partially filled before expiry — record what we got
      const avgFillPrice  = pending.filledCost / pending.filledSize;
      const filledUsdc    = pending.filledCost;
      const totalLatencyMs = Date.now() - pending.traderTs;
      const priceDrift    = pending.traderPrice > 0
        ? ((avgFillPrice - pending.traderPrice) / pending.traderPrice) * 100
        : 0;

      console.log(`[${ts}] [Confirmer] ⚠️  Order expired with partial fill: ${pending.filledSize.toFixed(2)} shares`);

      await CopyTrade.findByIdAndUpdate(pending.tradeDocId, {
        status:       'PARTIAL',
        filledSize:   pending.filledSize,
        avgFillPrice,
        filledUsdc,
        priceDrift,
        totalLatencyMs,
        attempts:     pending.attempt,
      });

      if (pending.side === 'BUY') {
        await TraderLoader.recordFill(pending.traderWallet, filledUsdc);
      } else {
        await TraderLoader.recordSellFill(pending.traderWallet, filledUsdc);
      }
      // Don't retry — we got a partial fill, not a full miss
      return;
    }

    // Expired with zero fill — trigger retry in GTTExecutor
    console.log(`[${ts}]     ⏱  expired attempt ${pending.attempt} — retrying`);
    eventBus.emit('order:expired', pending);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    console.log('[Confirmer] Reconnecting in 5s...');
    setTimeout(() => {
      this.reconnecting = false;
      this.connect()
        .then(() => this.reviewStaleOrders())
        .catch(err => console.error('[Confirmer] Reconnect failed:', err.message));
    }, 5_000);
  }

  /**
   * Called after reconnect to handle orders whose fill events may have been
   * missed during the disconnect window.
   *
   * Any pending order older than gttExpirySeconds + 30s has definitely expired
   * on Polymarket's side. Emit 'order:expired' so GTTExecutor retries it.
   * This prevents orders getting stuck in EXECUTING forever after a WS gap.
   */
  private reviewStaleOrders(): void {
    const staleThresholdMs = (config.gttExpirySeconds + 30) * 1000;
    const now = Date.now();
    let staleCount = 0;

    for (const [orderId, pending] of this.pendingOrders) {
      if (now - pending.submittedAt > staleThresholdMs) {
        console.warn(`[Confirmer] Stale order after reconnect: ${orderId.slice(0, 12)}... (doc ${pending.tradeDocId}) — re-queuing as expired`);
        this.pendingOrders.delete(orderId);
        eventBus.emit('order:expired', pending);
        staleCount++;
      }
    }

    if (staleCount > 0) {
      console.log(`[Confirmer] Reviewed ${staleCount} stale order(s) after reconnect`);
    }
  }

  /**
   * On bot startup, scan MongoDB for EXECUTING docs left over from a previous
   * run. These will never receive a fill event (WebSocket session is new).
   * Mark them FAILED so they don't silently block allocation.
   */
  static async clearStaleExecutingDocs(): Promise<void> {
    const { CopyTrade } = await import('../db/models/CopyTrade');
    const staleMs = 5 * 60 * 1000; // anything EXECUTING for > 5min is from a prior run
    const cutoff  = Date.now() - staleMs;
    const result  = await CopyTrade.updateMany(
      { status: 'EXECUTING', submittedAt: { $lt: cutoff } },
      { $set: { status: 'FAILED', failReason: 'Bot restarted while order was in-flight' } }
    );
    if (result.modifiedCount > 0) {
      console.warn(`[Confirmer] Cleared ${result.modifiedCount} stale EXECUTING doc(s) from previous run`);
    }
  }
}
