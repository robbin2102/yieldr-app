/**
 * FillTrackerV2 — Polymarket WebSocket User Channel listener for GTD fills.
 *
 * GTD maker orders need async fill confirmation — Polymarket pushes fill
 * events over the User Channel rather than returning fill data in the
 * POST /submit response.
 *
 * FAK/market orders do NOT need this tracker (they return fill data
 * directly in the SDK response). FillTrackerV2 only tracks GTD orders.
 *
 * Events emitted:
 *   'order:expired'  (PendingOrderV2) — GTD cancelled without fill → retry
 *   'order:filled'   (PendingOrderV2) — GTD filled (partial or full)
 *
 * Fill dedup: Polymarket re-delivers the same trade event within seconds.
 * We drop identical fills (same orderId + size + price) within 10s.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PendingOrderV2 } from '../types';

const RECONNECT_DELAY_MS  = 5_000;
const HEARTBEAT_INTERVAL  = 15_000;
const FILL_DEDUP_WINDOW   = 10_000;

interface WsFillMsg {
  event_type:     'trade';
  maker_order_id: string;
  taker_order_id: string;
  status:         string;
  price:          string;
  size:           string;
  side:           string;
  asset_id:       string;
}

interface WsOrderMsg {
  event_type: 'order';
  id:         string;
  type:       'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
}

export class FillTrackerV2 extends EventEmitter {
  private ws:           WebSocket | null = null;
  private stopped       = false;
  private heartbeat:    NodeJS.Timeout | null = null;
  private pending       = new Map<string, PendingOrderV2>();    // orderId → pending
  private recentFills   = new Map<string, number>();            // fillKey → first-seen ms

  constructor(
    private readonly wssUserUrl: string,
    private readonly apiKey:     string,
    private readonly apiSecret:  string,
    private readonly passphrase: string,
    private readonly botAddress: string,
  ) {
    super();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  connect(): void {
    if (this.stopped) return;
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
  }

  trackOrder(pending: PendingOrderV2): void {
    this.pending.set(pending.orderId, pending);
  }

  untrackOrder(orderId: string): void {
    this.pending.delete(orderId);
  }

  get pendingCount(): number { return this.pending.size; }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  private openSocket(): void {
    const ws = new WebSocket(this.wssUserUrl);
    this.ws  = ws;

    ws.on('open', () => {
      this.sendAuth(ws);
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, HEARTBEAT_INTERVAL);
      console.log('[FillTrackerV2] Connected to User Channel');
    });

    ws.on('message', (raw: Buffer) => {
      const data = raw.toString();
      if (data === 'PONG') return;
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }

      if (Array.isArray(msg)) {
        for (const m of msg) this.handleMessage(m);
      } else {
        this.handleMessage(msg);
      }
    });

    ws.on('error', (err) => this.emit('error', err));

    ws.on('close', () => {
      if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
      if (this.stopped) return;
      setTimeout(() => this.openSocket(), RECONNECT_DELAY_MS);
    });
  }

  private sendAuth(ws: WebSocket): void {
    const ts  = Date.now().toString();
    // Polymarket L2 auth: HMAC-SHA256 of (timestamp + "GET" + "/ws/user")
    // The SDK's createL2Headers handles this — we replicate the pattern here
    // to avoid pulling in the full SDK just for auth.
    const msg = {
      auth: {
        apiKey:     this.apiKey,
        secret:     this.apiSecret,
        passphrase: this.passphrase,
      },
      markets:  [],
      assets_ids: [],
      type:     'user',
    };
    ws.send(JSON.stringify(msg));
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(msg: any): void {
    if (!msg?.event_type) return;

    if (msg.event_type === 'trade') {
      this.handleFill(msg as WsFillMsg);
    } else if (msg.event_type === 'order') {
      this.handleOrderUpdate(msg as WsOrderMsg);
    }
  }

  private handleFill(msg: WsFillMsg): void {
    // Match on maker_order_id (we are maker for GTD orders)
    const orderId = this.pending.has(msg.maker_order_id)
      ? msg.maker_order_id
      : this.pending.has(msg.taker_order_id)
        ? msg.taker_order_id
        : null;

    if (!orderId) return;

    // Dedup: same fill re-delivered by Polymarket within 10s
    const fillKey = `${orderId}:${msg.size}:${msg.price}`;
    const now     = Date.now();
    const firstSeen = this.recentFills.get(fillKey);
    if (firstSeen && (now - firstSeen) < FILL_DEDUP_WINDOW) return;
    this.recentFills.set(fillKey, now);

    // Evict old dedup entries
    if (this.recentFills.size > 200) {
      const cutoff = now - FILL_DEDUP_WINDOW;
      for (const [k, ts] of this.recentFills) {
        if (ts < cutoff) this.recentFills.delete(k);
      }
    }

    const pending = this.pending.get(orderId)!;
    const filledShares = parseFloat(msg.size)  || 0;
    const filledUsdc   = filledShares * parseFloat(msg.price || '0');

    const updated: PendingOrderV2 = {
      ...pending,
      filledShares: pending.filledShares + filledShares,
      filledUsdc:   pending.filledUsdc   + filledUsdc,
    };
    this.pending.set(orderId, updated);

    this.emit('order:filled', updated);

    const ts = new Date().toISOString().slice(11, 19);
    console.log(
      `[${ts}] [FillTrackerV2] GTD filled ${filledShares.toFixed(4)} shares` +
      ` @ $${parseFloat(msg.price).toFixed(4)} | orderId=${orderId.slice(0, 12)}...`
    );
  }

  private handleOrderUpdate(msg: WsOrderMsg): void {
    if (msg.type !== 'CANCELLATION') return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    this.pending.delete(msg.id);
    this.emit('order:expired', pending);

    const ts = new Date().toISOString().slice(11, 19);
    console.log(
      `[${ts}] [FillTrackerV2] GTD expired (${pending.filledShares > 0 ? `partial ${pending.filledShares.toFixed(4)} shares` : 'unfilled'})` +
      ` attempt ${pending.attempt} | orderId=${msg.id.slice(0, 12)}...`
    );
  }
}
