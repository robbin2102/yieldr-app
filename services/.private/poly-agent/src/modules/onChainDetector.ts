/**
 * OnChainDetector — real-time trade detector via Polygon WebSocket.
 *
 * Subscribes to OrderFilled events on all 4 Polymarket exchange contracts
 * (v1 + v2) using client-side wallet filtering.
 *
 * During CLOBv2 transition (April 28 2026) both v1 and v2 contracts are
 * watched simultaneously. Drop the v1 entries after full cutover.
 *
 * Emits: 'trade' (DetectedTrade), 'connected', 'reconnecting', 'error'
 *
 * No DB writes. Caller decides what to do with each trade event.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';

// ── Constants ─────────────────────────────────────────────────────────────────
// v1 contracts (active until CLOBv2 cutover ~April 28 2026)
const CTF_EXCHANGE         = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE    = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
// v2 contracts
const CTF_V2_EXCHANGE      = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_V2_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';

const ORDER_FILLED_IFACE = new ethers.utils.Interface([
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
]);
const TOPIC0 = ORDER_FILLED_IFACE.getEventTopic('OrderFilled');

// Skip events older than this — handles reconnect backlog replay
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface DetectedTrade {
  wallet:           string;   // tracked wallet address (lowercase)
  label:            string;   // trader label from DB
  role:             'MAKER' | 'TAKER';
  side:             'BUY' | 'SELL';
  usdcAmount:       number;   // USDC spent or received (6-decimal adjusted)
  tokenAmount:      number;   // conditional tokens received or sent
  impliedPrice:     number;   // usdcAmount / tokenAmount
  tokenId:          string;   // ERC1155 token ID hex (encodes conditionId + outcome)
  txHash:           string;
  blockNumber:      string;   // hex
  blockTimestampMs: number;   // unix ms from block.timestamp
  receivedAtMs:     number;   // unix ms when WS event arrived
  lagMs:            number;   // receivedAtMs - blockTimestampMs (negative = validator forward-dating)
  exchange:         'CTF' | 'NEG_RISK' | 'CTF_V2' | 'NEG_RISK_V2';
  isStale:          boolean;  // true if older than STALE_THRESHOLD_MS (backlog replay)
}

export interface OnChainDetectorConfig {
  wsUrl:    string;
  httpUrl:  string;  // same QuickNode endpoint, https:// for block fetches
  mongoUri: string;
  dbName:   string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const EXCHANGE_MAP: Record<string, DetectedTrade['exchange']> = {
  [CTF_EXCHANGE.toLowerCase()]:         'CTF',
  [NEG_RISK_EXCHANGE.toLowerCase()]:    'NEG_RISK',
  [CTF_V2_EXCHANGE.toLowerCase()]:      'CTF_V2',
  [NEG_RISK_V2_EXCHANGE.toLowerCase()]: 'NEG_RISK_V2',
};
function resolveExchange(addr: string): DetectedTrade['exchange'] {
  return EXCHANGE_MAP[addr.toLowerCase()] ?? 'CTF';
}

// ── OnChainDetector ───────────────────────────────────────────────────────────
export class OnChainDetector extends EventEmitter {
  private ws:            WebSocket | null = null;
  private stopped        = false;
  private reconnectMs    = 50;   // backoff resets to 50ms on successful sub
  private keepalive:     NodeJS.Timeout | null = null;
  private walletRefresh: NodeJS.Timeout | null = null;

  // wallet (lowercase) → label
  private trackedWallets = new Map<string, string>();

  // block timestamp cache (blockHex → unix ms)
  private blockTsCache = new Map<string, number>();

  // Reconnect catch-up: replay fills from the block before disconnect
  private lastSeenBlockDec: number = 0;  // highest block number seen from live events
  private catchupFromBlock: number = 0;  // set on close, consumed once after reconnect

  constructor(private readonly cfg: OnChainDetectorConfig) {
    super();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.loadWallets();
    this.connect();
    // Refresh wallet list every 60s — picks up added/removed traders
    this.walletRefresh = setInterval(() => this.refreshWallets(), 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.walletRefresh) { clearInterval(this.walletRefresh); this.walletRefresh = null; }
    if (this.keepalive)     { clearInterval(this.keepalive);     this.keepalive     = null; }
    if (this.ws)            { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
  }

  // ── Wallet loading ──────────────────────────────────────────────────────────

  private async loadWallets(): Promise<void> {
    const client = new MongoClient(this.cfg.mongoUri);
    try {
      await client.connect();
      const traders = await client.db(this.cfg.dbName)
        .collection('ahf-copyTraders')
        .find({ active: true })
        .project({ wallet: 1, label: 1 })
        .toArray();
      this.trackedWallets.clear();
      for (const t of traders) {
        this.trackedWallets.set((t.wallet as string).toLowerCase(), t.label as string);
      }
    } finally {
      await client.close();
    }
  }

  private async refreshWallets(): Promise<void> {
    const prevSize = this.trackedWallets.size;
    const prevKeys = new Set(this.trackedWallets.keys());
    try {
      await this.loadWallets();
    } catch (err: any) {
      this.emit('error', new Error(`Wallet refresh failed: ${err.message}`));
      return;
    }
    const changed = this.trackedWallets.size !== prevSize
      || [...this.trackedWallets.keys()].some(k => !prevKeys.has(k));
    if (changed) {
      console.log(`[OnChainDetector] Wallet list changed (${prevSize} → ${this.trackedWallets.size}), reconnecting to update filters`);
      if (this.ws) { this.ws.close(); } // triggers reconnect with fresh subscriptions
    }
  }

  // ── WebSocket connection ────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;
    if (this.trackedWallets.size === 0) {
      console.warn('[OnChainDetector] No active traders — waiting for wallet list');
      setTimeout(() => this.connect(), 5_000);
      return;
    }

    const ws = new WebSocket(this.cfg.wsUrl);
    this.ws  = ws;
    const connectedAt = Date.now();

    ws.on('open', () => {
      this.emit('connected');
      this.subscribeAll(ws);
      // Keepalive: JSON-RPC request every 10s (WS ping frames not sufficient for QuickNode)
      this.keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_blockNumber', params: [] }));
        }
      }, 10_000);
    });

    ws.on('message', (raw: Buffer) => this.handleMessage(ws, raw));

    ws.on('error', (err) => {
      this.emit('error', err);
      // close event will handle reconnect
    });

    ws.on('close', (code, reason) => {
      const aliveSec = ((Date.now() - connectedAt) / 1000).toFixed(1);
      if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; }
      if (this.stopped) return;
      // Snapshot block for catch-up query after reconnect
      if (this.lastSeenBlockDec > 0) this.catchupFromBlock = this.lastSeenBlockDec;
      console.warn(`[OnChainDetector] WS closed code=${code} reason="${reason?.toString() || ''}" alive=${aliveSec}s → retry in ${this.reconnectMs}ms`);
      this.emit('reconnecting', { code, delayMs: this.reconnectMs });
      setTimeout(() => this.connect(), this.reconnectMs);
      // Exponential backoff: 50ms → 100ms → 500ms → 2s → 5s
      this.reconnectMs = Math.min(this.reconnectMs * 2, 5_000);
    });
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  private subscribeAll(ws: WebSocket): void {
    // 2 subscriptions: CTF group + NEG_RISK group, each with v1+v2 address arrays.
    // Using address arrays in the `address` field is standard EVM WS behavior and
    // works on QuickNode. The previous 4-subscription approach caused immediate
    // code=1006 disconnects (QuickNode sub limit).
    // Wallet filtering remains client-side in handleFill().
    const subs = [
      { id: 1, address: [CTF_EXCHANGE,      CTF_V2_EXCHANGE]      },
      { id: 2, address: [NEG_RISK_EXCHANGE, NEG_RISK_V2_EXCHANGE] },
    ];

    for (const s of subs) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: s.id, method: 'eth_subscribe', params: ['logs', { address: s.address, topics: [TOPIC0] }] }));
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private subsConfirmed = 0;

  private async handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Keepalive response
    if (msg.id === 99) return;

    // Subscription confirmations (id 1-4 = CTF v1, NEG_RISK v1, CTF v2, NEG_RISK v2)
    if (msg.id === 1 || msg.id === 2 || msg.id === 3 || msg.id === 4) {
      if (msg.error) {
        this.emit('error', new Error(`Subscribe error (sub ${msg.id}): ${msg.error.message}`));
        return;
      }
      this.subsConfirmed++;
      if (this.subsConfirmed >= 2) {
        this.subsConfirmed = 0;
        this.reconnectMs = 50; // reset backoff — connection is healthy
        console.log(`[OnChainDetector] Both subscriptions active (CTF+NEG_RISK, v1+v2) — watching ${this.trackedWallets.size} traders`);
        // Replay any fills that arrived during the reconnect gap
        this.catchUpMissedBlocks().catch(e => console.warn('[OnChainDetector] Catch-up error:', e.message));
      }
      return;
    }

    if (msg.method !== 'eth_subscription') return;

    const receivedAtMs = Date.now();
    const log          = msg.params?.result;
    if (!log?.topics) return;

    await this.handleFill(log, receivedAtMs);
  }

  private async handleFill(log: any, receivedAtMs: number): Promise<void> {
    // Track highest block for reconnect catch-up
    const blockDec = parseInt(log.blockNumber, 16);
    if (blockDec > this.lastSeenBlockDec) this.lastSeenBlockDec = blockDec;

    const maker = ('0x' + log.topics[2].slice(26)).toLowerCase();
    const taker = ('0x' + log.topics[3].slice(26)).toLowerCase();

    const makerIsTracked = this.trackedWallets.has(maker);
    const takerIsTracked = this.trackedWallets.has(taker);
    if (!makerIsTracked && !takerIsTracked) return; // client-side wallet filter (server-side topic arrays unreliable on QuickNode)

    // Decode non-indexed args
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = ORDER_FILLED_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch { return; }

    const makerAssetId:      ethers.BigNumber = parsed.args.makerAssetId;
    const takerAssetId:      ethers.BigNumber = parsed.args.takerAssetId;
    const makerAmountFilled: ethers.BigNumber = parsed.args.makerAmountFilled;
    const takerAmountFilled: ethers.BigNumber = parsed.args.takerAmountFilled;

    // Identify tracked wallet and their trade direction
    const wallet = makerIsTracked ? maker : taker;
    const label  = this.trackedWallets.get(wallet) ?? wallet.slice(0, 10);
    const role: 'MAKER' | 'TAKER' = makerIsTracked ? 'MAKER' : 'TAKER';

    let side: 'BUY' | 'SELL';
    let usdcRaw: ethers.BigNumber;
    let tokenRaw: ethers.BigNumber;
    let tokenId: string;

    if (role === 'MAKER') {
      // maker pays USDC (makerAssetId=0) → BUY; else SELL
      if (makerAssetId.isZero()) {
        side     = 'BUY';
        usdcRaw  = makerAmountFilled;
        tokenRaw = takerAmountFilled;
        tokenId  = takerAssetId.toHexString();
      } else {
        side     = 'SELL';
        usdcRaw  = takerAmountFilled;
        tokenRaw = makerAmountFilled;
        tokenId  = makerAssetId.toHexString();
      }
    } else {
      // taker pays USDC (takerAssetId=0) → BUY; else SELL
      if (takerAssetId.isZero()) {
        side     = 'BUY';
        usdcRaw  = takerAmountFilled;
        tokenRaw = makerAmountFilled;
        tokenId  = makerAssetId.toHexString();
      } else {
        side     = 'SELL';
        usdcRaw  = makerAmountFilled;
        tokenRaw = takerAmountFilled;
        tokenId  = takerAssetId.toHexString();
      }
    }

    const usdcAmount   = parseFloat(ethers.utils.formatUnits(usdcRaw, 6));
    const tokenAmount  = parseFloat(ethers.utils.formatUnits(tokenRaw, 6));
    const impliedPrice = tokenAmount > 0 ? usdcAmount / tokenAmount : 0;

    const blockTimestampMs = await this.fetchBlockTs(log.blockNumber) ?? receivedAtMs;
    const lagMs            = receivedAtMs - blockTimestampMs;
    const isStale          = (Date.now() - blockTimestampMs) > STALE_THRESHOLD_MS;

    const trade: DetectedTrade = {
      wallet, label, role, side,
      usdcAmount, tokenAmount, impliedPrice, tokenId,
      txHash:           log.transactionHash,
      blockNumber:      log.blockNumber,
      blockTimestampMs,
      receivedAtMs,
      lagMs,
      exchange:         resolveExchange(log.address),
      isStale,
    };

    this.emit('trade', trade);
  }

  // ── Reconnect catch-up ────────────────────────────────────────────────────────

  private async catchUpMissedBlocks(): Promise<void> {
    const fromBlock = this.catchupFromBlock;
    this.catchupFromBlock = 0;
    if (fromBlock === 0) return;

    // Get current tip
    const tipRes = await fetch(this.cfg.httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 97, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    const tipJson = await tipRes.json() as any;
    const toBlock = parseInt(tipJson.result, 16);
    if (isNaN(toBlock) || toBlock < fromBlock) return;

    // Cap to 150 blocks (~5min) to avoid oversized queries
    const cappedFrom = Math.max(fromBlock, toBlock - 150);
    const blockCount = toBlock - cappedFrom + 1;
    console.log(`[OnChainDetector] Catch-up: scanning ${blockCount} block(s) (${cappedFrom}→${toBlock}) for missed fills`);

    for (const addresses of [
      [CTF_EXCHANGE, CTF_V2_EXCHANGE],
      [NEG_RISK_EXCHANGE, NEG_RISK_V2_EXCHANGE],
    ]) {
      try {
        const logsRes = await fetch(this.cfg.httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 98, method: 'eth_getLogs',
            params: [{ fromBlock: `0x${cappedFrom.toString(16)}`, toBlock: `0x${toBlock.toString(16)}`, address: addresses, topics: [TOPIC0] }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const logsJson = await logsRes.json() as any;
        const logs: any[] = logsJson.result ?? [];
        if (logs.length > 0) {
          console.log(`[OnChainDetector] Catch-up: replaying ${logs.length} fill event(s) — duplicates will be deduped by DB`);
          for (const log of logs) {
            await this.handleFill(log, Date.now());
          }
        }
      } catch (e: any) {
        console.warn('[OnChainDetector] Catch-up eth_getLogs failed:', e.message);
      }
    }
  }

  // ── Block timestamp (HTTP, cached) ──────────────────────────────────────────

  private async fetchBlockTs(blockHex: string): Promise<number | null> {
    if (this.blockTsCache.has(blockHex)) return this.blockTsCache.get(blockHex)!;
    try {
      const res  = await fetch(this.cfg.httpUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [blockHex, false] }),
      });
      const json = await res.json() as any;
      const ts   = parseInt(json.result.timestamp, 16) * 1000;
      this.blockTsCache.set(blockHex, ts);
      if (this.blockTsCache.size > 30) this.blockTsCache.delete(this.blockTsCache.keys().next().value!);
      return ts;
    } catch { return null; }
  }
}
