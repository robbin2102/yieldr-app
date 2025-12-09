import WebSocket from 'ws';
import crypto from 'crypto';
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

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      console.log('[Confirmer] Connecting to User Channel...');

      this.ws = new WebSocket(config.wssUser);

      this.ws.on('open', () => {
        this.authenticate();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        // Auth success
        if (msg.type === 'auth' && msg.status === 'success') {
          console.log('[Confirmer] ✅ Authenticated');
          this.reconnecting = false;
          resolve();
          return;
        }

        // Alternative auth success format
        if (msg.channel === 'user' && !msg.event_type) {
          console.log('[Confirmer] ✅ Authenticated');
          this.reconnecting = false;
          resolve();
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
      });

      this.ws.on('close', () => {
        console.log('[Confirmer] Disconnected');
        this.reconnect();
      });

      this.ws.on('error', (err) => {
        console.error('[Confirmer] Error:', err.message);
      });

      // Listen for submitted orders from Executor
      eventBus.on('trade:submitted', (data: PendingOrder) => {
        this.pendingOrders.set(data.orderId, data);
        console.log(`[Confirmer] Tracking order ${data.orderId.slice(0, 16)}...`);
      });
    });
  }

  private authenticate() {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${timestamp}GET/ws/user`;
    const signature = crypto
      .createHmac('sha256', config.apiSecret)
      .update(message)
      .digest('base64');

    this.ws?.send(JSON.stringify({
      type: 'auth',
      apiKey: config.apiKey,
      timestamp,
      signature,
      passphrase: config.passphrase,
    }));
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
    this.ws?.close();
    this.ws = null;
  }
}
