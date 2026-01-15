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
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private pollingActive: boolean = false;

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[Confirmer] Connecting to User Channel...');
      console.log(`[Confirmer] URL: ${config.wssUser}`);

      this.ws = new WebSocket(config.wssUser);

      let authenticated = false;
      const connectTime = Date.now();

      // Timeout if auth doesn't succeed in 10 seconds
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          console.error('[Confirmer] Authentication timeout - no response from server');
          this.ws?.close();
          reject(new Error('Authentication timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        console.log('[Confirmer] WebSocket opened, sending auth...');
        this.authenticate();

        // Resolve immediately after sending auth (like Market Channel does)
        // Server doesn't send explicit confirmation - it just starts sending data
        console.log('[Confirmer] ✅ Auth message sent, connection established');
        clearTimeout(authTimeout);
        authenticated = true;
        this.reconnecting = false;
        this.startHeartbeat();

        // Stop polling if WebSocket connects
        this.stopPolling();

        resolve();
      });

      this.ws.on('message', (data) => {
        const dataStr = data.toString();

        // Handle PONG responses (plain text, not JSON)
        if (dataStr === 'PONG') {
          console.log('[Confirmer] 🏓 PONG received');
          return;
        }

        // Parse JSON messages
        const msg = JSON.parse(dataStr);
        console.log('[Confirmer] Message received:', JSON.stringify(msg, null, 2));

        // Check for error messages
        if (msg.type === 'error' || msg.status === 'error') {
          console.error('[Confirmer] ❌ Server error:', msg.message || msg.error || JSON.stringify(msg));
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
        const duration = Date.now() - connectTime;
        console.log(`[Confirmer] Disconnected (code: ${code}, reason: ${reason.toString()}, duration: ${duration}ms)`);

        if (duration < 1000) {
          console.error('[Confirmer] ⚠️  Connection closed very quickly (< 1s) - likely auth/config issue');
          console.log('[Confirmer] 🔄 Falling back to REST API polling for fill tracking');

          // Start polling as fallback
          this.startPolling();
        }

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
    // Correct format from Polymarket docs: type = "user", not "subscribe"
    const subscribeMessage = {
      type: 'user',          // Channel type
      markets: [],           // Array of market condition IDs (empty = all markets)
      auth: {
        apiKey: config.apiKey,
        secret: config.apiSecret,
        passphrase: config.passphrase,
      },
    };

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
   * Start polling REST API for fill tracking (fallback when WebSocket fails)
   */
  private startPolling() {
    if (this.pollingActive) return;

    this.pollingActive = true;
    console.log('[Confirmer] 📡 Starting REST API polling (1s interval)');

    // Poll every 1 second for pending orders
    this.pollingInterval = setInterval(() => {
      this.checkPendingOrders().catch((error) => {
        console.error('[Confirmer] Polling error:', error.message);
      });
    }, 1000);
  }

  /**
   * Stop REST API polling
   */
  private stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.pollingActive = false;
      console.log('[Confirmer] Stopped REST API polling');
    }
  }

  /**
   * Check pending orders via REST API
   */
  private async checkPendingOrders() {
    if (this.pendingOrders.size === 0) return;

    console.log(`[Confirmer] 🔍 Checking ${this.pendingOrders.size} pending order(s)...`);

    for (const [orderId, pending] of this.pendingOrders) {
      try {
        // Query order status from CLOB API
        const response = await fetch(
          `${config.clobApiBase}/order/${orderId}`,
          {
            headers: {
              'POLY-API-KEY': config.apiKey,
              'POLY-SIGNATURE': this.generateSignature(orderId),
              'POLY-TIMESTAMP': Math.floor(Date.now() / 1000).toString(),
              'POLY-PASSPHRASE': config.passphrase,
            },
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            // Order not found - might be cancelled or expired
            console.log(`[Confirmer] Order ${orderId.slice(0, 16)}... not found (404)`);
            this.pendingOrders.delete(orderId);
          }
          continue;
        }

        const orderData = await response.json() as any;

        // Check if order is filled
        if (orderData.status === 'MATCHED' || orderData.status === 'FILLED') {
          console.log(`[Confirmer] ✅ Order filled via polling: ${orderId.slice(0, 16)}...`);

          // Process the fill (same logic as WebSocket)
          await this.processFill(pending, {
            size: orderData.size_matched || orderData.original_size,
            price: orderData.price,
            status: orderData.status,
          });

          this.pendingOrders.delete(orderId);
        }
      } catch (error: any) {
        console.error(`[Confirmer] Error checking order ${orderId.slice(0, 16)}...:`, error.message);
      }
    }

    if (this.pendingOrders.size > 0) {
      console.log(`[Confirmer] 📋 Tracking ${this.pendingOrders.size} pending order(s)...`);
    }
  }

  /**
   * Generate HMAC signature for REST API requests
   */
  private generateSignature(orderId: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${timestamp}GET/order/${orderId}`;

    return crypto
      .createHmac('sha256', config.apiSecret)
      .update(message)
      .digest('base64');
  }

  /**
   * Process fill data (common logic for WebSocket and polling)
   */
  private async processFill(pending: PendingOrder, fillData: { size: string; price: string; status: string }) {
    const executedSize = parseFloat(fillData.size);
    const executedPrice = parseFloat(fillData.price);
    const executedUsdcSize = executedSize * executedPrice;

    // Update trade record
    const tradeRecord = await PolyAgentTrade.findById(pending.tradeId);
    if (!tradeRecord) {
      console.error(`[Confirmer] Trade record not found: ${pending.tradeId}`);
      return;
    }

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
    const slippageUsdc = expectedCost - actualCost;
    const slippageBps = ((pending.originalTrade.price - executedPrice) / pending.originalTrade.price) * 10000;

    tradeRecord.slippage = {
      expectedCost,
      actualCost,
      slippageUsdc,
      slippageBps,
    };

    await tradeRecord.save();

    // Update slippage buffer
    await this.updateSlippageBuffer(expectedCost, actualCost, slippageUsdc);

    // Calculate end-to-end timing
    const detectedTime = tradeRecord.detectedAt ? new Date(tradeRecord.detectedAt).getTime() : Date.now();
    const executedTime = tradeRecord.executedAt ? new Date(tradeRecord.executedAt).getTime() : detectedTime;
    const totalLatency = Date.now() - detectedTime;
    const fillLatency = tradeRecord.confirmedAt.getTime() - executedTime;

    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`[Confirmer] ✅ TRADE FILLED SUCCESSFULLY`);
    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`  Order ID: ${pending.orderId.slice(0, 16)}...`);
    console.log(`  Executed: ${executedSize} @ $${executedPrice.toFixed(4)} ($${executedUsdcSize.toFixed(2)})`);
    console.log(`  Slippage: $${slippageUsdc.toFixed(4)} (${(slippageBps / 100).toFixed(2)}%)`);
    console.log(`  Timing:`);
    console.log(`    - Submission latency: ${tradeRecord.latencyMs || 0}ms`);
    console.log(`    - Fill confirmation: ${fillLatency}ms`);
    console.log(`    - Total end-to-end: ${totalLatency}ms`);
    console.log(`═══════════════════════════════════════════════════════════\n`);

    eventBus.emit('trade:filled', { tradeId: pending.tradeId });
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
      await this.processFill(pending, {
        size: msg.size,
        price: msg.price,
        status: msg.status,
      });

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
    this.stopPolling();
    this.ws?.close();
    this.ws = null;
  }
}
