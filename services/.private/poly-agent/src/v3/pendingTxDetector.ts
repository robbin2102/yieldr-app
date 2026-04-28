/**
 * PendingTxDetector — subscribes to Polygon mempool pending transactions
 * and emits 'pending' events for any tracked wallet appearing as Order.maker
 * in Polymarket exchange contract calldata.
 *
 * Requires QuickNode Growth plan (or higher) for full tx objects via the
 * `newPendingTransactions` subscription with `true` param.
 * Falls back gracefully with a one-time warning if hash-only mode is detected.
 *
 * Emits: 'pending' (PendingTrade), 'connected', 'reconnecting', 'error'
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';
import { decodeCalldata } from './calldataDecoder';
import { PendingTrade } from './types';

const EXCHANGES: Record<string, PendingTrade['exchange']> = {
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e': 'CTF',
  '0xc5d563a36ae78145c45a50134d48a1215220f80a': 'NEG_RISK',
  '0xe111180000d2663c0091e4f400237545b87b996b': 'CTF_V2',
  '0xe2222d279d744050d28e00520010520000310f59': 'NEG_RISK_V2',
};
const EXCHANGE_ADDRS = new Set(Object.keys(EXCHANGES));

export interface PendingTxDetectorConfig {
  wsUrl:    string;
  mongoUri: string;
  dbName:   string;
}

export class PendingTxDetector extends EventEmitter {
  private ws:             WebSocket | null = null;
  private stopped         = false;
  private reconnectMs     = 50;
  private keepalive:      NodeJS.Timeout | null = null;
  private walletRefresh:  NodeJS.Timeout | null = null;
  private lastWsMessageMs = 0;
  private warnedHashOnly  = false;

  private trackedWallets  = new Map<string, string>(); // address → label
  private recentGas:      number[] = [];               // rolling gas prices (gwei) for confidence scoring

  constructor(private readonly cfg: PendingTxDetectorConfig) { super(); }

  async start(): Promise<void> {
    await this.loadWallets();
    this.connect();
    this.walletRefresh = setInterval(() => this.loadWallets().catch(() => {}), 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.walletRefresh) { clearInterval(this.walletRefresh); this.walletRefresh = null; }
    if (this.keepalive)     { clearInterval(this.keepalive);     this.keepalive = null; }
    if (this.ws)            { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
  }

  get walletCount(): number { return this.trackedWallets.size; }

  // ── Wallet loading ────────────────────────────────────────────────────────────

  private async loadWallets(): Promise<void> {
    const client = new MongoClient(this.cfg.mongoUri);
    try {
      await client.connect();
      const rows = await client.db(this.cfg.dbName)
        .collection('ahf-copyTraders')
        .find({ active: true })
        .project({ wallet: 1, label: 1 })
        .toArray();
      this.trackedWallets.clear();
      for (const r of rows) this.trackedWallets.set((r.wallet as string).toLowerCase(), r.label as string);
    } finally {
      await client.close();
    }
  }

  // ── WebSocket connection ──────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    if (this.trackedWallets.size === 0) { setTimeout(() => this.connect(), 5_000); return; }

    const ws = new WebSocket(this.cfg.wsUrl);
    this.ws  = ws;
    const connectedAt = Date.now();

    ws.on('open', () => {
      this.lastWsMessageMs = Date.now();
      this.emit('connected');

      // Request full tx objects (not just hashes) — requires QuickNode Growth plan
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'eth_subscribe',
        params: ['newPendingTransactions', true] }));

      // JSON-RPC keepalive every 20s
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_blockNumber', params: [] }));
      }, 20_000);

      // Stall detector: reconnect if no WS activity for >30s
      const stallCheck = setInterval(() => {
        const silentMs = Date.now() - this.lastWsMessageMs;
        if (silentMs > 30_000 && ws.readyState === WebSocket.OPEN) {
          console.warn(`[v3-Pending] Stall: no activity for ${Math.round(silentMs / 1000)}s — reconnecting`);
          ws.close(4000, 'stall-timeout');
        }
      }, 5_000);

      ws.on('close', () => { clearInterval(stallCheck); });
    });

    ws.on('message', (raw: Buffer) => {
      this.lastWsMessageMs = Date.now();
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.id === 99) return; // keepalive response

      // Subscription confirmation
      if (msg.id === 10) {
        if (msg.error) {
          console.error('[v3-Pending] Subscribe error:', JSON.stringify(msg.error));
          this.emit('error', new Error(`Subscribe failed: ${msg.error.message}`));
          return;
        }
        console.log(`[v3-Pending] Subscribed (id=${String(msg.result).slice(0, 10)}...) — watching ${this.trackedWallets.size} wallets`);
        return;
      }

      if (msg.method !== 'eth_subscription') return;

      const tx = msg.params?.result;
      if (!tx) return;

      // Hash-only mode: QuickNode plan doesn't support full tx objects
      if (typeof tx === 'string') {
        if (!this.warnedHashOnly) {
          console.warn('[v3-Pending] ⚠  Receiving tx hashes only. Full tx objects require QuickNode Growth plan.');
          console.warn('[v3-Pending]    Upgrade plan to enable mempool detection. Stats will show 0 pending.');
          this.warnedHashOnly = true;
        }
        return;
      }

      // Full tx object — filter to Polymarket exchange addresses only
      if (!tx.to || !EXCHANGE_ADDRS.has(tx.to.toLowerCase())) return;

      this.handleTx(tx);
    });

    ws.on('error', (err) => this.emit('error', err));

    ws.on('close', (code) => {
      const aliveSec = ((Date.now() - connectedAt) / 1000).toFixed(1);
      if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
      if (this.stopped) return;
      const label = code === 1001 ? 'server-rotation' : code === 1006 ? 'network-drop' : code === 4000 ? 'stall-close' : 'unexpected';
      console.warn(`[v3-Pending] WS closed code=${code}(${label}) alive=${aliveSec}s → retry ${this.reconnectMs}ms`);
      this.emit('reconnecting');
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 5_000);
    });
  }

  // ── Tx processing ─────────────────────────────────────────────────────────────

  private handleTx(tx: any): void {
    const detectedAtMs = Date.now();
    const exchange     = EXCHANGES[tx.to.toLowerCase()];

    // Track gas prices for confidence scoring
    const gasBN  = ethers.BigNumber.from(tx.maxFeePerGas ?? tx.gasPrice ?? '0x1');
    const gasGwei = parseFloat(ethers.utils.formatUnits(gasBN, 'gwei'));
    this.recentGas.push(gasGwei);
    if (this.recentGas.length > 200) this.recentGas.shift();
    const confidence = this.scoreConfidence(gasGwei);

    // Decode order calldata
    const orders = decodeCalldata(tx.input ?? tx.data ?? '');
    if (orders.length === 0) return;

    for (const order of orders) {
      const label = this.trackedWallets.get(order.maker);
      if (!label) continue;

      const side: 'BUY' | 'SELL' = order.side === 0 ? 'BUY' : 'SELL';

      // Estimate USDC and token amounts from fillAmount (all 6-decimal on Polymarket)
      let usdcAmount: number, tokenAmount: number;
      const fillF  = parseFloat(ethers.utils.formatUnits(order.fillAmount,  6));
      const makerF = parseFloat(ethers.utils.formatUnits(order.makerAmount, 6));
      const takerF = parseFloat(ethers.utils.formatUnits(order.takerAmount, 6));
      const fillRatio = makerF > 0 ? fillF / makerF : 1;

      if (side === 'BUY') {
        // maker pays USDC (makerAmount), receives tokens (takerAmount)
        usdcAmount  = fillF;
        tokenAmount = takerF * fillRatio;
      } else {
        // maker pays tokens (makerAmount), receives USDC (takerAmount)
        tokenAmount = fillF;
        usdcAmount  = takerF * fillRatio;
      }

      const impliedPrice = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;

      this.emit('pending', {
        txHash: tx.hash, wallet: order.maker, label, side, exchange,
        tokenId: order.tokenId, usdcAmount, tokenAmount, impliedPrice,
        gasGwei, confidence, detectedAtMs,
      } as PendingTrade);
    }
  }

  // ── Gas confidence scoring ────────────────────────────────────────────────────

  private scoreConfidence(gasGwei: number): PendingTrade['confidence'] {
    if (this.recentGas.length < 10) return 'MEDIUM'; // not enough data yet
    const sorted = [...this.recentGas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (gasGwei >= median * 0.90) return 'HIGH';
    if (gasGwei >= median * 0.70) return 'MEDIUM';
    return 'LOW';
  }
}
