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
import { CopyTrader } from '../db/models/CopyTrader';

// ── Constants ─────────────────────────────────────────────────────────────────
// v1 contracts deprecated April 28 2026 at CLOBv2 cutover
// const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
// const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const CTF_V2_EXCHANGE      = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_V2_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';

// v2 event — makerAssetId/takerAssetId replaced by side+tokenId; builder+metadata added
const ORDER_FILLED_IFACE = new ethers.utils.Interface([
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)',
]);
const TOPIC0 = ORDER_FILLED_IFACE.getEventTopic('OrderFilled');

// Skip events older than this — handles reconnect backlog replay
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

const ALL_EXCHANGE_ADDRESSES = [CTF_V2_EXCHANGE, NEG_RISK_V2_EXCHANGE];

// Pad a 20-byte address to 32 bytes for use in topic filter arrays
function padAddress(addr: string): string {
  return '0x' + '000000000000000000000000' + addr.replace(/^0x/, '').toLowerCase();
}

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

  // Stall detection: if no WS message arrives for >30s, force reconnect.
  // Catches QuickNode silent stalls where the socket stays open but stops
  // delivering events (seen before some code=1001 rotations).
  private lastWsMessageMs = 0;

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
    // Reuse the mongoose connection established at startup — no second connection pool needed.
    const traders = await CopyTrader.find({ active: true }, { wallet: 1, label: 1 }).lean();
    this.trackedWallets.clear();
    for (const t of traders) {
      this.trackedWallets.set(t.wallet.toLowerCase(), t.label);
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
      // Dual keepalive: JSON-RPC every 20s + WS ping every 25s.
      // QuickNode idle-timeout is ~30s and only counts JSON-RPC messages (not WS pings).
      // 20s keeps us safely under that threshold at half the credit burn of 10s.
      this.keepalive = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'eth_blockNumber', params: [] }));
      }, 20_000);
      this.lastWsMessageMs = Date.now(); // connection itself counts as activity

      // WS-level ping — triggers pong from QuickNode, catches 1006 network-level drops faster
      const wsPing = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(wsPing);
      }, 25_000);

      // Stall detector: proactively reconnect if no WS activity for 30s.
      // Catches cases where QuickNode's backend is alive but not delivering events.
      const stallCheck = setInterval(() => {
        const silentMs = Date.now() - this.lastWsMessageMs;
        if (silentMs > 30_000 && ws.readyState === WebSocket.OPEN) {
          console.warn(`[OnChainDetector] Stall detected: no WS activity for ${Math.round(silentMs / 1000)}s — forcing reconnect`);
          ws.close(4000, 'stall-timeout');
        }
      }, 5_000);

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
      if (this.lastSeenBlockDec > 0) this.catchupFromBlock = this.lastSeenBlockDec;
      // code=1001 = server rotation (normal), code=1006 = network drop, other = unexpected
      const codeLabel = code === 1001 ? 'server-rotation' : code === 1006 ? 'network-drop' : code === 4000 ? 'stall-close' : 'unexpected';
      console.warn(`[OnChainDetector] WS closed code=${code}(${codeLabel}) reason="${reason?.toString() || ''}" alive=${aliveSec}s subsConfirmed=${this.subsConfirmed}/${this.subsExpected} lastBlock=${this.lastSeenBlockDec} → retry in ${this.reconnectMs}ms`);
      this.emit('reconnecting', { code, delayMs: this.reconnectMs });
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 5_000);
    });
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  // QuickNode silently stops delivering events when too many log-filter subscriptions
  // are open on a single connection. Confirmed working threshold: ≤2 subs (1 maker + 1 taker).
  // Above this wallet count, fall back to a single TOPIC0 subscription and filter client-side.
  private static readonly MAX_SERVER_SIDE_WALLETS = 15;
  private static readonly SUB_ID_BASE = 10; // subscription IDs start here (1-9 reserved)
  private subsExpected = 0;
  private subIdMin = 0;
  private subIdMax = -1;

  private subscribeAll(ws: WebSocket): void {
    this.subsConfirmed = 0;
    const wallets = [...this.trackedWallets.keys()];
    const walletTopics = wallets.map(padAddress);
    const useServerFilter = wallets.length <= OnChainDetector.MAX_SERVER_SIDE_WALLETS;

    let subId = OnChainDetector.SUB_ID_BASE;

    if (useServerFilter) {
      const sub1 = JSON.stringify({ jsonrpc: '2.0', id: subId++, method: 'eth_subscribe', params: ['logs', {
        address: ALL_EXCHANGE_ADDRESSES,
        topics:  [TOPIC0, null, walletTopics],       // maker is our wallet
      }]});
      const sub2 = JSON.stringify({ jsonrpc: '2.0', id: subId++, method: 'eth_subscribe', params: ['logs', {
        address: ALL_EXCHANGE_ADDRESSES,
        topics:  [TOPIC0, null, null, walletTopics], // taker is our wallet
      }]});
      this.subIdMin     = OnChainDetector.SUB_ID_BASE;
      this.subIdMax     = OnChainDetector.SUB_ID_BASE + 1;
      this.subsExpected = 2;
      console.log(`[OnChainDetector] Subscribing: server-side filter, ${wallets.length} wallet(s), payload=${sub1.length + sub2.length}B`);
      ws.send(sub1);
      ws.send(sub2);
    } else {
      const sub1 = JSON.stringify({ jsonrpc: '2.0', id: subId++, method: 'eth_subscribe', params: ['logs', {
        address: ALL_EXCHANGE_ADDRESSES,
        topics:  [TOPIC0],                           // client-side wallet filter in handleFill()
      }]});
      this.subIdMin     = OnChainDetector.SUB_ID_BASE;
      this.subIdMax     = OnChainDetector.SUB_ID_BASE;
      this.subsExpected = 1;
      console.log(`[OnChainDetector] Subscribing: client-side filter (${wallets.length} wallets > limit ${OnChainDetector.MAX_SERVER_SIDE_WALLETS}), payload=${sub1.length}B`);
      ws.send(sub1);
    }
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private subsConfirmed = 0;

  private async handleMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    this.lastWsMessageMs = Date.now(); // any WS activity (event, keepalive, pong) resets stall timer

    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Keepalive response
    if (msg.id === 99) return;

    // Subscription confirmations (IDs in [subIdMin..subIdMax])
    if (msg.id >= this.subIdMin && msg.id <= this.subIdMax) {
      if (msg.error) {
        // Log the full error object so we know exactly what QuickNode rejected and why
        console.error(`[OnChainDetector] Sub ${msg.id} rejected by node:`, JSON.stringify(msg.error));
        console.error(`[OnChainDetector] Sub ${msg.id} context: wallets=${this.trackedWallets.size} subsExpected=${this.subsExpected} subIdRange=${this.subIdMin}–${this.subIdMax}`);
        this.emit('error', new Error(`Subscribe error (sub ${msg.id}): ${msg.error.message ?? JSON.stringify(msg.error)}`));
        return;
      }
      this.subsConfirmed++;
      console.log(`[OnChainDetector] Sub ${msg.id} confirmed (result=${msg.result?.slice(0, 10)}...) [${this.subsConfirmed}/${this.subsExpected}]`);
      if (this.subsConfirmed >= this.subsExpected) {
        this.reconnectMs = 50; // reset backoff — connection is healthy
        console.log(`[OnChainDetector] All ${this.subsExpected} subscription(s) active — watching ${this.trackedWallets.size} wallet(s)`);
        this.catchUpMissedBlocks().catch(e => console.warn('[OnChainDetector] Catch-up error:', e.message));
      }
      return;
    }

    // Unexpected response ID — log it so we can diagnose unknown messages
    if (msg.id !== undefined && msg.method === undefined) {
      console.warn(`[OnChainDetector] Unexpected response id=${msg.id}:`, JSON.stringify(msg).slice(0, 200));
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
    if (!makerIsTracked && !takerIsTracked) return; // safety guard for stale events or cross-chunk overlap

    // Decode non-indexed args
    let parsed: ethers.utils.LogDescription;
    try {
      parsed = ORDER_FILLED_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch { return; }

    const makerAmountFilled: ethers.BigNumber = parsed.args.makerAmountFilled;
    const takerAmountFilled: ethers.BigNumber = parsed.args.takerAmountFilled;
    const makerSide:         number           = parsed.args.side; // 0=BUY, 1=SELL (maker's perspective)
    const tokenId:           string           = parsed.args.tokenId.toHexString();

    // Identify tracked wallet and their trade direction
    const wallet = makerIsTracked ? maker : taker;
    const label  = this.trackedWallets.get(wallet) ?? wallet.slice(0, 10);
    const role: 'MAKER' | 'TAKER' = makerIsTracked ? 'MAKER' : 'TAKER';

    let side: 'BUY' | 'SELL';
    let usdcRaw: ethers.BigNumber;
    let tokenRaw: ethers.BigNumber;

    if (role === 'MAKER') {
      side = makerSide === 0 ? 'BUY' : 'SELL';
      if (side === 'BUY') {
        usdcRaw  = makerAmountFilled; // maker pays pUSD
        tokenRaw = takerAmountFilled; // maker receives tokens
      } else {
        tokenRaw = makerAmountFilled; // maker pays tokens
        usdcRaw  = takerAmountFilled; // maker receives pUSD
      }
    } else {
      // taker direction is opposite of maker
      side = makerSide === 0 ? 'SELL' : 'BUY';
      if (side === 'SELL') {
        tokenRaw = takerAmountFilled; // taker pays tokens
        usdcRaw  = makerAmountFilled; // taker receives pUSD
      } else {
        usdcRaw  = takerAmountFilled; // taker pays pUSD
        tokenRaw = makerAmountFilled; // taker receives tokens
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

    // Mirror the live subscription strategy for catch-up
    const wallets = [...this.trackedWallets.keys()];
    const useServerFilter = wallets.length <= OnChainDetector.MAX_SERVER_SIDE_WALLETS;
    const walletTopics = wallets.map(padAddress);

    const topicFilters: (string | null | string[])[][] = useServerFilter
      ? [
          [TOPIC0, null, walletTopics],        // maker is our wallet
          [TOPIC0, null, null, walletTopics],  // taker is our wallet
        ]
      : [[TOPIC0]];                            // client-side filter: handleFill() filters

    const fromBlockHex = `0x${cappedFrom.toString(16)}`;
    const toBlockHex   = `0x${toBlock.toString(16)}`;
    const seenTxHashes = new Set<string>(); // dedup within catch-up (maker+taker overlap)

    for (const topics of topicFilters) {
      try {
        const logsRes = await fetch(this.cfg.httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 98, method: 'eth_getLogs',
            params: [{ fromBlock: fromBlockHex, toBlock: toBlockHex, address: ALL_EXCHANGE_ADDRESSES, topics }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const logsJson = await logsRes.json() as any;
        if (logsJson.error) {
          console.warn(`[OnChainDetector] Catch-up eth_getLogs node error: code=${logsJson.error.code} msg=${logsJson.error.message}`);
          continue;
        }
        const logs: any[] = logsJson.result ?? [];
        const fresh = logs.filter(l => !seenTxHashes.has(l.transactionHash));
        console.log(`[OnChainDetector] Catch-up: ${logs.length} raw fill(s), ${fresh.length} new (blocks ${cappedFrom}→${toBlock})`);
        for (const log of fresh) {
          seenTxHashes.add(log.transactionHash);
          await this.handleFill(log, Date.now());
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
