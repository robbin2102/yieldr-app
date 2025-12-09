import WebSocket from 'ws';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';
import { PolyAgentSlippage } from '../db/models/PolyAgentSlippage';
import { PendingOrder } from '../types';

/**
 * Confirmer - Tracks trade fills via WebSocket User Channel
 *
 * Flow:
 * 1. Connect to WSS User Channel with authentication
 * 2. Listen for 'trade:submitted' events from Executor
 * 3. Store order details in pendingOrders Map (for correlation)
 * 4. Receive fill notifications via WSS
 * 5. Match orderId → update MongoDB with fill details + slippage
 *
 * Note: pendingOrders Map is NOT a performance cache - just a small
 * correlation table to match WSS messages to our submitted orders.
 * It doesn't affect execution speed (post-execution only).
 */
export class Confirmer {
  private ws: WebSocket | null = null;
  private pendingOrders: Map<string, PendingOrder> = new Map();
  private reconnecting: boolean = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[Confirmer] Connecting to User Channel...');
      console.log(`[Confirmer] URL: ${config.wssUser}`);

      this.ws = new WebSocket(config.wssUser);

      // Timeout if auth doesn't succeed in 10 seconds
      const authTimeout = setTimeout(() => {
        console.error('[Confirmer] Authentication timeout - no response from server');
        this.ws?.close();
        reject(new Error('Authentication timeout'));
      }, 10000);

      this.ws.on('open', () => {
        console.log('[Confirmer] WebSocket opened, sending auth...');
        this.authenticate();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        console.log('[Confirmer] Message received:', JSON.stringify(msg, null, 2));

        // Auth success - subscription confirmed
        if (msg.type === 'subscribed' && msg.channel === 'user') {
          clearTimeout(authTimeout);
          console.log('[Confirmer] ✅ Authenticated and subscribed to user channel');
          this.reconnecting = false;
          this.startHeartbeat();
          resolve();
          return;
        }

        // Alternative auth success formats
        if (msg.type === 'auth' && msg.status === 'success') {
          clearTimeout(authTimeout);
          console.log('[Confirmer] ✅ Authenticated');
          this.reconnecting = false;
          this.startHeartbeat();
          resolve();
          return;
        }

        if (msg.channel === 'user' && !msg.event_type) {
          clearTimeout(authTimeout);
          console.log('[Confirmer] ✅ Authenticated (user channel)');
          this.reconnecting = false;
          this.startHeartbeat();
          resolve();
          return;
        }

        // Auth/subscription failure
        if ((msg.type === 'error' || msg.status === 'error') && !this.reconnecting) {
          clearTimeout(authTimeout);
          console.error('[Confirmer] ❌ Authentication/subscription failed:', msg.message || msg.error || JSON.stringify(msg));
          this.ws?.close();
          reject(new Error(`Auth failed: ${msg.message || msg.error || 'Unknown error'}`));
          return;
        }

        // Trade fill notification
        if (msg.event_type === 'trade') {
          this.handleTradeFill(msg).catch((error) => {
            console.error('[Confirmer] Error handling fill:', error);
          });
        }

        // Order update notification
        if (msg.event_type === 'order') {
          this.handleOrderUpdate(msg).catch((error) => {
            console.error('[Confirmer] Error handling order update:', error);
          });
        }

        // Pong response (heartbeat)
        if (msg.type === 'pong') {
          console.log('[Confirmer] Received pong');
        }
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(authTimeout);
        this.stopHeartbeat();
        console.log(`[Confirmer] Disconnected (code: ${code}, reason: ${reason.toString()})`);
        this.reconnect();
      });

      this.ws.on('error', (err) => {
        clearTimeout(authTimeout);
        console.error('[Confirmer] WebSocket error:', err.message);
      });

      // Listen for submitted orders from Executor
      eventBus.on('trade:submitted', (data: PendingOrder) => {
        this.pendingOrders.set(data.orderId, data);
        console.log(`[Confirmer] Tracking order ${data.orderId.slice(0, 16)}...`);
      });
    });
  }

  private authenticate() {
    // Try subscription-based auth format (from real-time-data-client)
    const subscribeMessage = {
      type: 'subscribe',
      channel: 'user',
      auth: {
        apiKey: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.passphrase,
      },
    };

    console.log('[Confirmer] Sending auth message...');
    this.ws?.send(JSON.stringify(subscribeMessage));
  }

  private reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    console.log('[Confirmer] Reconnecting in 5s...');
    setTimeout(() => {
      this.connect().catch((error) => {
        console.error('[Confirmer] Reconnect failed:', error);
      });
    }, 5000);
  }

  private startHeartbeat() {
    // Send ping every 30 seconds to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        console.log('[Confirmer] Sending ping...');
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle trade fill notification from WSS
   */
  private async handleTradeFill(msg: any) {
    const orderId = msg.taker_order_id;
    const pending = this.pendingOrders.get(orderId);

    if (!pending) {
      // Not our order
      return;
    }

    console.log(`[Confirmer] Fill update: ${msg.status} - ${msg.size} @ ${msg.price}`);

    // Only process MATCHED or CONFIRMED status
    if (msg.status === 'MATCHED' || msg.status === 'CONFIRMED') {
      const executedSize = parseFloat(msg.size);
      const executedPrice = parseFloat(msg.price);
      const executedUsdcSize = executedSize * executedPrice;

      // Update trade record
      const tradeRecord = await PolyAgentTrade.findById(pending.tradeId);
      if (!tradeRecord) {
        console.error(`[Confirmer] Trade record not found: ${pending.tradeId}`);
        return;
      }

      // Ensure copy object exists (should always exist by this point, but TypeScript requires check)
      if (!tradeRecord.copy) {
        console.error(`[Confirmer] Copy object missing for trade: ${pending.tradeId}`);
        return;
      }

      tradeRecord.status = 'FILLED';
      tradeRecord.copy.executedSize = executedSize;
      tradeRecord.copy.executedPrice = executedPrice;
      tradeRecord.copy.executedUsdcSize = executedUsdcSize;
      tradeRecord.confirmedAt = new Date();

      // Calculate slippage
      const expectedCost = pending.originalTrade.price * executedSize;
      const actualCost = executedUsdcSize;
      const slippageUsdc = expectedCost - actualCost;  // Positive = saved money
      const slippageBps = ((pending.originalTrade.price - executedPrice) / pending.originalTrade.price) * 10000;

      tradeRecord.slippage = {
        expectedCost,
        actualCost,
        slippageUsdc,
        slippageBps,
      };

      await tradeRecord.save();

      // Update slippage buffer in MongoDB (direct write, no cache)
      await this.updateSlippageBuffer(expectedCost, actualCost, slippageUsdc);

      console.log(`[Confirmer] ✅ FILLED: ${executedSize} @ $${executedPrice.toFixed(4)}`);
      console.log(`  Slippage: $${slippageUsdc.toFixed(4)} (${(slippageBps / 100).toFixed(2)}%)`);

      eventBus.emit('trade:filled', { tradeId: pending.tradeId });
      this.pendingOrders.delete(orderId);
    }
  }

  /**
   * Handle order update notification from WSS
   */
  private async handleOrderUpdate(msg: any) {
    if (msg.type === 'CANCELLATION') {
      const pending = this.pendingOrders.get(msg.id);
      if (pending) {
        console.log(`[Confirmer] ⚠️ Order cancelled: ${msg.id.slice(0, 16)}...`);

        const tradeRecord = await PolyAgentTrade.findById(pending.tradeId);
        if (tradeRecord) {
          tradeRecord.status = 'FAILED';
          tradeRecord.failReason = 'Order cancelled (FOK not filled)';
          await tradeRecord.save();
        }

        eventBus.emit('trade:failed', { tradeId: pending.tradeId, error: 'FOK order not filled' });
        this.pendingOrders.delete(msg.id);
      }
    }
  }

  /**
   * Update slippage buffer in MongoDB (direct write, no cache)
   */
  private async updateSlippageBuffer(expectedCost: number, actualCost: number, slippageUsdc: number) {
    // Atomic update
    const result = await PolyAgentSlippage.findByIdAndUpdate(
      'current',
      {
        $inc: {
          totalExpectedCost: expectedCost,
          totalActualCost: actualCost,
          totalTrades: 1,
          totalPositiveSlippage: slippageUsdc > 0 ? 1 : 0,
          totalNegativeSlippage: slippageUsdc < 0 ? 1 : 0,
        },
        $set: { lastUpdated: new Date() },
      },
      { upsert: true, new: true }
    );

    // Calculate and save buffer
    const buffer = result.totalExpectedCost - result.totalActualCost;
    result.bufferUsdc = buffer;
    await result.save();

    console.log(`  Buffer: $${buffer.toFixed(2)} (${result.totalTrades} trades)`);
  }

  disconnect() {
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}
