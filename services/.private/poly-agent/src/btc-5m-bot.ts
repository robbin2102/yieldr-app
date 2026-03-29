/**
 * BTC 5-Minute Market Trading Bot v2
 *
 * Features:
 * - WebSocket BTC price feed from Polymarket Chainlink (1s updates)
 * - priceToBeat derived from WS data at cycle open
 * - Delta filter: skip cycles where |BTC - priceToBeat| < 30 points
 * - GTC limit orders with 10s fill window + retry
 * - Orderbook + BTC price logging to MongoDB
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/btc-5m-bot.ts
 */

import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { MongoClient, Db } from 'mongodb';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import path from 'path';

// ── Env Loading ───────────────────────────────────────────────
const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.local'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

// ── Config ────────────────────────────────────────────────────
const CONFIG = {
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,
  botWallet: process.env.BOT_WALLET_ADDRESS!,
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_PASSPHRASE!,
  mongoUri: process.env.MONGODB_URI!,
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  gammaApiBase: 'https://gamma-api.polymarket.com',
  wsLiveData: 'wss://ws-live-data.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
  pollIntervalMs: 500,       // Poll orderbook every 500ms for faster entry
  maxOrderRetries: 1,  // Place GTC once, let it sit until cycle ends
  orderRetryDelayMs: 500,
  gctFillTimeoutMs: 60000,  // GTC order stays alive until cycle end (up to 60s)
  minDeltaPoints: 30,       // Skip cycles with |BTC - strike| < 30
  dataOnlyMode: false,       // LIVE TRADING
};

const required = ['botPrivateKey', 'botWallet', 'apiKey', 'apiSecret', 'passphrase', 'mongoUri', 'polygonRpcUrl'];
for (const key of required) {
  if (!CONFIG[key as keyof typeof CONFIG]) { console.error(`Missing: ${key}`); process.exit(1); }
}

// ── Strategy Definitions ──────────────────────────────────────
interface StrategyConfig {
  name: string;
  entryPrice: number;
  triggerSpread: number;
  windowSecs: number;
  budgetUsdc: number;
  active: boolean;
}

const STRATEGIES: StrategyConfig[] = [
  { name: '90c_90s', entryPrice: 0.90, triggerSpread: 0.01, windowSecs: 90, budgetUsdc: 5, active: true },
  { name: '85c_90s', entryPrice: 0.85, triggerSpread: 0.01, windowSecs: 90, budgetUsdc: 5, active: false },
  { name: '95c_90s', entryPrice: 0.95, triggerSpread: 0.01, windowSecs: 90, budgetUsdc: 5, active: false },
];

// ── Types ─────────────────────────────────────────────────────
interface ActiveCycle {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  cycleOpen: number;
  cycleClose: number;
  priceToBeat: number;
  question: string;
}

interface StrategyPosition {
  strategyName: string;
  filled: boolean;
  filledSide: 'Up' | 'Down' | null;
  filledPrice: number;
  filledShares: number;
  filledUsdc: number;
  orderId: string;
  fillAttempts: number;
  pendingOrderId: string | null;  // GTC order ID that's still live in the book
  pendingTokenId: string;         // which token the pending order is for
  pendingSide: 'Up' | 'Down' | null;
}

// ── Globals ───────────────────────────────────────────────────
let clobClient: ClobClient;
let db: Db;
let currentCycle: ActiveCycle | null = null;
let positions: Map<string, StrategyPosition> = new Map();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// BTC price state from WebSocket
let currentBtcPrice = 0;
let btcPriceTimestamp = 0;
let lastWsUpdateTime = 0;  // Date.now() of last received update
let wsPriceConnected = false;
let activeWs: WebSocket | null = null;

// Store recent BTC prices for lookback (timestamp_ms → price)
const btcPriceHistory: Map<number, number> = new Map();
const MAX_PRICE_HISTORY = 600; // keep last 600 seconds

// Cycle stats
const stats = {
  cyclesSeen: 0, cyclesTriggered: 0, cyclesFilled: 0, cyclesSkippedDelta: 0,
  totalFills: 0, makerFills: 0, takerFills: 0, totalPnl: 0, wins: 0, losses: 0,
};

// ── WebSocket BTC Price Feed ──────────────────────────────────
function connectBtcPriceWs(): void {
  // Close existing connection if any
  if (activeWs) {
    try { activeWs.close(); } catch {}
    activeWs = null;
  }

  console.log('[WS] Connecting to BTC price feed...');
  const ws = new WebSocket(CONFIG.wsLiveData);
  activeWs = ws;

  ws.on('open', () => {
    console.log('[WS] Connected — subscribing to btc/usd');
    ws.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }]
    }));
    wsPriceConnected = true;
    lastWsUpdateTime = Date.now();
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      lastWsUpdateTime = Date.now(); // Track last message time

      // Initial snapshot (array of historical prices)
      if (msg.type === 'subscribe' && msg.payload?.data) {
        const prices = msg.payload.data;
        if (prices.length > 0) {
          for (const p of prices) {
            btcPriceHistory.set(Math.floor(p.timestamp / 1000), p.value);
          }
          if (btcPriceHistory.size > MAX_PRICE_HISTORY) {
            const keys = [...btcPriceHistory.keys()].sort();
            for (let i = 0; i < keys.length - MAX_PRICE_HISTORY; i++) btcPriceHistory.delete(keys[i]);
          }

          const last = prices[prices.length - 1];
          currentBtcPrice = last.value;
          btcPriceTimestamp = last.timestamp;
          console.log(`[WS] Initial snapshot: $${currentBtcPrice.toFixed(2)} (${prices.length} points, history: ${btcPriceHistory.size})`);

          db?.collection('btc5mPriceStream').insertOne({
            type: 'snapshot', price: currentBtcPrice,
            timestamp: new Date(btcPriceTimestamp), count: prices.length,
          }).catch(() => {});
        }
      }

      // Streaming update (single price)
      if (msg.type === 'update' && msg.payload?.value) {
        currentBtcPrice = msg.payload.value;
        btcPriceTimestamp = msg.payload.timestamp;
        btcPriceHistory.set(Math.floor(msg.payload.timestamp / 1000), msg.payload.value);
      }
    } catch { /* ignore parse errors */ }
  });

  ws.on('close', () => {
    console.log('[WS] Disconnected — reconnecting in 2s...');
    wsPriceConnected = false;
    activeWs = null;
    setTimeout(connectBtcPriceWs, 2000);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error: ${err.message}`);
  });
}

// Heartbeat: check if WS is still sending updates
// If no update in 5s, force reconnect
let wsReconnectCount = 0;
function startWsHeartbeat(): void {
  setInterval(() => {
    const staleSecs = (Date.now() - lastWsUpdateTime) / 1000;
    if (lastWsUpdateTime > 0 && staleSecs > 5) {
      wsReconnectCount++;
      console.log(`[WS] ⚠️ STALE: no update for ${staleSecs.toFixed(0)}s — force reconnecting (#${wsReconnectCount})`);

      db?.collection('btc5mPriceStream').insertOne({
        type: 'ws_reconnect', reason: 'stale', staleSecs: Math.round(staleSecs),
        reconnectCount: wsReconnectCount, lastPrice: currentBtcPrice,
        timestamp: new Date(),
      }).catch(() => {});

      wsPriceConnected = false;
      if (activeWs) {
        try { activeWs.terminate(); } catch {}
        activeWs = null;
      }
      connectBtcPriceWs();
    }
  }, 3000);
}

// Get BTC price at a specific unix timestamp (seconds) from history
// Looks for exact match or closest available within ±3 seconds
function getBtcPriceAt(unixSecs: number): number {
  // Exact match
  const exact = btcPriceHistory.get(unixSecs);
  if (exact) return exact;

  // Search ±3 seconds
  for (let offset = 1; offset <= 3; offset++) {
    const before = btcPriceHistory.get(unixSecs - offset);
    if (before) return before;
    const after = btcPriceHistory.get(unixSecs + offset);
    if (after) return after;
  }

  // Fallback: current price
  return currentBtcPrice;
}

// ── CLOB Client ───────────────────────────────────────────────
async function initClobClient(): Promise<ClobClient> {
  const network = { name: 'polygon', chainId: CONFIG.chainId };
  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, network);
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);
  console.log(`[Init] Wallet: ${wallet.address}`);
  return new ClobClient(CONFIG.clobApiBase, CONFIG.chainId, wallet,
    { key: CONFIG.apiKey, secret: CONFIG.apiSecret, passphrase: CONFIG.passphrase });
}

// ── Market Data ───────────────────────────────────────────────
function getCurrentSlug(): string {
  const now = Math.floor(Date.now() / 1000);
  return `btc-updown-5m-${Math.floor(now / 300) * 300}`;
}

async function fetchCycleData(slug: string): Promise<ActiveCycle | null> {
  try {
    const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${slug}`);
    if (!res.ok) return null;
    const events = await res.json() as any[];
    if (!events?.[0]?.markets?.[0]) return null;

    const event = events[0];
    const market = event.markets[0];
    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(market.clobTokenIds); }
    catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

    const cycleOpen = parseInt(slug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');

    // eventStartTime is the exact moment the strike price (priceToBeat) is captured
    const eventStartTime = event.eventStartTime || market.startDate || '';
    let eventStartUnix = 0;
    if (eventStartTime) {
      eventStartUnix = Math.floor(new Date(eventStartTime).getTime() / 1000);
    }

    // Look up BTC price at eventStartTime from WS history
    let ptb = 0;
    if (eventStartUnix > 0) {
      ptb = getBtcPriceAt(eventStartUnix);
      console.log(`  [Strike] eventStartTime=${eventStartTime} → unix=${eventStartUnix} → BTC=$${ptb.toFixed(2)}`);
    }
    // Fallback: use cycleOpen timestamp
    if (ptb === 0 || ptb === currentBtcPrice) {
      ptb = getBtcPriceAt(cycleOpen);
      console.log(`  [Strike] Fallback: cycleOpen=${cycleOpen} → BTC=$${ptb.toFixed(2)}`);
    }

    return {
      slug, conditionId: market.conditionId,
      upTokenId: tokenIds[0] || '', downTokenId: tokenIds[1] || '',
      cycleOpen, cycleClose: cycleOpen + 300,
      priceToBeat: ptb,
      question: market.question || slug,
    };
  } catch (err: any) {
    console.error(`[Market] Error: ${err.message}`);
    return null;
  }
}

// ── Orderbook ─────────────────────────────────────────────────
async function getBookSnapshot(tokenId: string, label: string) {
  const snap = { side: label, bestAsk: null as number | null, bestBid: null as number | null, askDepth: 0, totalAskLiq: 0, spread: null as number | null };
  try {
    const res = await fetch(`${CONFIG.clobApiBase}/book?token_id=${tokenId}`);
    if (!res.ok) return snap;
    const data = await res.json() as any;
    const asks = (data.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a: any, b: any) => a.price - b.price);
    const bids = (data.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a: any, b: any) => b.price - a.price);
    snap.bestAsk = asks.length > 0 ? asks[0].price : null;
    snap.bestBid = bids.length > 0 ? bids[0].price : null;
    snap.askDepth = asks.length > 0 ? asks[0].size : 0;
    snap.totalAskLiq = asks.reduce((s: number, a: any) => s + a.price * a.size, 0);
    snap.spread = (snap.bestAsk !== null && snap.bestBid !== null) ? snap.bestAsk - snap.bestBid : null;
  } catch { /* return defaults */ }
  return snap;
}

// ── Order Execution (GTC with 10s timeout) ────────────────────
async function placeLimitBuy(
  tokenId: string, budgetUsdc: number, limitPrice: number
): Promise<{ filled: boolean; filledShares: number; avgPrice: number; orderId: string; fillType: string; attempts: number }> {
  console.log(`  [Order] LIMIT BUY: limit=${(limitPrice*100).toFixed(0)}c budget=$${budgetUsdc.toFixed(2)}`);
  let totalFilled = 0, totalCost = 0, attempts = 0, lastOrderId = '', remainingBudget = budgetUsdc;
  let fillType = 'unknown';

  while (remainingBudget > 0.5 && attempts < CONFIG.maxOrderRetries) {
    attempts++;
    try {
      const MIN_SHARES = 5;
      let shares = remainingBudget / limitPrice;
      if (shares < MIN_SHARES) {
        shares = MIN_SHARES;
        console.log(`  [Order] Bumping to min ${MIN_SHARES} shares = $${(shares * limitPrice).toFixed(2)}`);
      }

      console.log(`  [Order] Attempt ${attempts}: ${shares.toFixed(1)} shares @ ${(limitPrice*100).toFixed(0)}c`);
      const order = await clobClient.createOrder({
        tokenID: tokenId, price: limitPrice, size: shares,
        side: Side.BUY, feeRateBps: 1000, nonce: 0,
      });

      const response = await clobClient.postOrder(order, OrderType.GTC);
      const ordId = response?.orderID || (response as any)?.orderid || null;

      if (!ordId) {
        console.log(`  [Order] Rejected by API — stopping`);
        break;
      }

      console.log(`  [Order] Live: ${ordId.slice(0, 16)}... polling for ${CONFIG.gctFillTimeoutMs / 1000}s`);
      lastOrderId = ordId;

      // Poll for fill for up to 10 seconds
      const pollEnd = Date.now() + CONFIG.gctFillTimeoutMs;
      let orderFilled = false;

      while (Date.now() < pollEnd) {
        await sleep(500);
        try {
          const statusRes = await fetch(`${CONFIG.clobApiBase}/order/${ordId}`, {
            headers: { 'POLY_API_KEY': CONFIG.apiKey, 'POLY_SIGNATURE': CONFIG.apiSecret, 'POLY_TIMESTAMP': Date.now().toString(), 'POLY_PASSPHRASE': CONFIG.passphrase },
          });
          if (statusRes.ok) {
            const os = await statusRes.json() as any;
            const filled = parseFloat(os.size_matched) || 0;
            const price = parseFloat(os.price) || limitPrice;

            if (filled > 0) {
              fillType = price <= limitPrice ? 'maker' : 'taker';
              totalFilled += filled;
              totalCost += filled * price;
              remainingBudget -= filled * price;
              orderFilled = true;
              console.log(`  [Fill] ✅ ${filled.toFixed(1)} shares @ ${(price*100).toFixed(1)}c [${fillType}]`);
              break;
            }
            if (os.status === 'CANCELED' || os.status === 'EXPIRED') break;
          }
        } catch { /* continue */ }
      }

      // Cancel if not filled
      if (!orderFilled) {
        try { await clobClient.cancelOrder({ orderID: ordId }); } catch {}
        console.log(`  [Order] Cancelled after ${CONFIG.gctFillTimeoutMs / 1000}s — no fill`);
      }
    } catch (err: any) {
      const msg = err.message || '';
      console.error(`  [Order] Error: ${msg}`);
      if (msg.includes('balance') || msg.includes('allowance') || msg.includes('minimum')) break;
    }

    if (remainingBudget > 0.5 && attempts < CONFIG.maxOrderRetries) await sleep(CONFIG.orderRetryDelayMs);
  }

  return { filled: totalFilled > 0, filledShares: totalFilled, avgPrice: totalFilled > 0 ? totalCost / totalFilled : 0, orderId: lastOrderId, fillType, attempts };
}

// ── Strategy Evaluation ───────────────────────────────────────
async function evaluateStrategies(cycle: ActiveCycle): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const secsLeft = cycle.cycleClose - now;
  if (secsLeft <= 0) return;

  const anyInWindow = STRATEGIES.some(s => s.active && secsLeft <= s.windowSecs);
  const anyPending = STRATEGIES.some(s => s.active && positions.get(s.name)?.pendingOrderId);

  if (!anyInWindow && !anyPending) {
    if (secsLeft % 10 < 3) {
      const delta = currentBtcPrice > 0 && cycle.priceToBeat > 0 ? (currentBtcPrice - cycle.priceToBeat).toFixed(1) : '?';
      console.log(`  [Poll] -${secsLeft}s | BTC=$${currentBtcPrice.toFixed(0)} strike=$${cycle.priceToBeat.toFixed(0)} delta=${delta} | waiting`);
    }
    return;
  }

  const delta = currentBtcPrice - cycle.priceToBeat;
  const absDelta = Math.abs(delta);
  const direction = delta > 0 ? 'Up' : 'Down';

  // Fetch orderbook
  const [upSnap, downSnap] = await Promise.all([
    getBookSnapshot(cycle.upTokenId, 'Up'),
    getBookSnapshot(cycle.downTokenId, 'Down'),
  ]);

  db.collection('btc5mOrderbook').insertOne({
    slug: cycle.slug, timestamp: new Date(), secsBeforeClose: secsLeft,
    btcPrice: currentBtcPrice, priceToBeat: cycle.priceToBeat, delta, absDelta,
    up: { bestAsk: upSnap.bestAsk, bestBid: upSnap.bestBid, askDepth: upSnap.askDepth },
    down: { bestAsk: downSnap.bestAsk, bestBid: downSnap.bestBid, askDepth: downSnap.askDepth },
  }).catch(() => {});

  console.log(`  [Poll] -${secsLeft}s | BTC=$${currentBtcPrice.toFixed(0)} strike=$${cycle.priceToBeat.toFixed(0)} delta=${delta.toFixed(0)}(${direction}) | Up=${upSnap.bestAsk?.toFixed(2) || '?'} Down=${downSnap.bestAsk?.toFixed(2) || '?'}`);

  for (const strategy of STRATEGIES) {
    if (!strategy.active) continue;
    const pos = positions.get(strategy.name);
    if (!pos || pos.filled) continue;

    // ── Step 1: Check if we have a pending GTC order — poll its fill status
    if (pos.pendingOrderId) {
      try {
        const statusRes = await fetch(`${CONFIG.clobApiBase}/order/${pos.pendingOrderId}`, {
          headers: { 'POLY_API_KEY': CONFIG.apiKey, 'POLY_SIGNATURE': CONFIG.apiSecret, 'POLY_TIMESTAMP': Date.now().toString(), 'POLY_PASSPHRASE': CONFIG.passphrase },
        });
        if (statusRes.ok) {
          const os = await statusRes.json() as any;
          const filled = parseFloat(os.size_matched) || 0;
          const price = parseFloat(os.price) || strategy.entryPrice;

          if (filled > 0) {
            const fillType = price <= strategy.entryPrice ? 'maker' : 'taker';
            stats.cyclesFilled++; stats.totalFills++;
            if (fillType === 'maker') stats.makerFills++; else stats.takerFills++;

            pos.filled = true;
            pos.filledSide = pos.pendingSide;
            pos.filledPrice = price;
            pos.filledShares = filled;
            pos.filledUsdc = filled * price;
            pos.orderId = pos.pendingOrderId;
            pos.pendingOrderId = null;

            console.log(`  ✅ [${strategy.name}] GTC FILLED! ${filled.toFixed(1)} ${pos.filledSide} @ ${(price*100).toFixed(1)}c [${fillType}] | -${secsLeft}s`);

            await db.collection('btc5mBotTrades').insertOne({
              slug: cycle.slug, conditionId: cycle.conditionId, strategy: strategy.name,
              side: pos.filledSide, entryPrice: strategy.entryPrice, triggerPrice: strategy.entryPrice,
              filledPrice: price, shares: filled, costUsdc: filled * price,
              fillType, fillAttempts: 1, btcPriceAtEntry: currentBtcPrice, delta,
              pnl: null, won: null, winner: null,
              cycleOpen: cycle.cycleOpen, cycleClose: cycle.cycleClose, secsBeforeClose: secsLeft,
              priceToBeat: cycle.priceToBeat, filledAt: new Date(), resolvedAt: null,
            });
            continue;
          }

          // Check if order was cancelled/expired externally
          if (os.status === 'CANCELED' || os.status === 'EXPIRED') {
            console.log(`  [${strategy.name}] Pending GTC ${os.status} — will re-place if conditions met`);
            pos.pendingOrderId = null;
            // Fall through to placement logic below
          } else {
            // Order is still live — check if market REVERSED to the other side
            const triggerLevel = strategy.entryPrice + strategy.triggerSpread;
            const upAsk = upSnap.bestAsk;
            const downAsk = downSnap.bestAsk;

            // Determine which side currently meets the trigger
            let currentTriggerSide: 'Up' | 'Down' | null = null;
            if (upAsk !== null && upAsk >= triggerLevel) currentTriggerSide = 'Up';
            else if (downAsk !== null && downAsk >= triggerLevel) currentTriggerSide = 'Down';

            // If the OTHER side now meets trigger (market reversed), cancel and re-place
            if (currentTriggerSide && currentTriggerSide !== pos.pendingSide) {
              console.log(`  [${strategy.name}] ⚠️ REVERSAL: was ${pos.pendingSide} now ${currentTriggerSide} — cancelling old GTC`);
              try { await clobClient.cancelOrder({ orderID: pos.pendingOrderId }); } catch {}
              pos.pendingOrderId = null;
              pos.pendingSide = null;
              // Fall through to placement logic below to place on new side
            } else {
              console.log(`  [${strategy.name}] Pending GTC ${pos.pendingSide} live — waiting for fill | -${secsLeft}s`);
              continue; // Keep waiting for fill
            }
          }
        }
      } catch { /* fall through to placement */ }
    }

    // If we still have a pending order after the check, don't place a new one
    if (pos.pendingOrderId) continue;

    // ── Step 2: Check window
    if (secsLeft > strategy.windowSecs) continue;

    // ── Step 3: Delta filter (only for FIRST entry, not retries)
    if (absDelta < CONFIG.minDeltaPoints) {
      if (secsLeft % 10 < 3) console.log(`  [Delta] ${absDelta.toFixed(0)} < ${CONFIG.minDeltaPoints} pts — SKIP`);
      continue;
    }

    // ── Step 4: Check trigger
    const triggerLevel = strategy.entryPrice + strategy.triggerSpread;
    const upAsk = upSnap.bestAsk;
    const downAsk = downSnap.bestAsk;

    let targetSide: 'Up' | 'Down' | null = null;
    let targetTokenId = '';

    if (upAsk !== null && upAsk >= triggerLevel) {
      targetSide = 'Up'; targetTokenId = cycle.upTokenId;
    } else if (downAsk !== null && downAsk >= triggerLevel) {
      targetSide = 'Down'; targetTokenId = cycle.downTokenId;
    }

    if (!targetSide) {
      if (secsLeft % 10 < 3) console.log(`  [${strategy.name}] No trigger (need >=${(triggerLevel*100).toFixed(0)}c)`);
      continue;
    }

    // ── Step 5: Place GTC at bestAsk - 1c (aggressive maker fill)
    const currentAsk = (targetSide === 'Up' ? upSnap.bestAsk : downSnap.bestAsk) || 0;
    const fillPrice = Math.round((currentAsk - 0.01) * 100) / 100; // bestAsk - 1c, rounded to 2dp
    const cappedFillPrice = Math.min(fillPrice, 0.97); // never pay more than 97c

    console.log(`\n  ⚡ [${strategy.name}] TRIGGER: ${targetSide} ask@${(currentAsk*100).toFixed(0)}c → GTC@${(cappedFillPrice*100).toFixed(0)}c | delta=${delta.toFixed(0)} | -${secsLeft}s`);
    stats.cyclesTriggered++;

    // Log trigger event to MongoDB
    db.collection('btc5mBotTriggers').insertOne({
      slug: cycle.slug, strategy: strategy.name, side: targetSide,
      entryPrice: cappedFillPrice, marketPrice: currentAsk,
      btcPrice: currentBtcPrice, priceToBeat: cycle.priceToBeat, delta, absDelta,
      secsBeforeClose: secsLeft, timestamp: new Date(),
      dataOnlyMode: CONFIG.dataOnlyMode,
    }).catch(() => {});

    if (CONFIG.dataOnlyMode) {
      console.log(`  [${strategy.name}] 📊 DATA ONLY — would place GTC ${targetSide}@${(cappedFillPrice*100).toFixed(0)}c (skipping order)`);
      continue;
    }

    try {
      const MIN_SHARES = 5;
      const shares = Math.max(strategy.budgetUsdc / cappedFillPrice, MIN_SHARES);

      const order = await clobClient.createOrder({
        tokenID: targetTokenId, price: cappedFillPrice, size: shares,
        side: Side.BUY, feeRateBps: 1000, nonce: 0,
      });
      const response = await clobClient.postOrder(order, OrderType.GTC);
      const ordId = response?.orderID || (response as any)?.orderid || null;

      if (ordId) {
        pos.pendingOrderId = ordId;
        pos.pendingTokenId = targetTokenId;
        pos.pendingSide = targetSide;
        console.log(`  [${strategy.name}] GTC LIVE: ${ordId.slice(0, 16)}... (${shares.toFixed(1)} shares @ ${(cappedFillPrice*100).toFixed(0)}c) — will check fill each poll`);
      } else {
        console.log(`  [${strategy.name}] Order rejected — check API errors above`);
      }
    } catch (err: any) {
      console.error(`  [${strategy.name}] Order error: ${err.message}`);
    }
  }
}

// ── Resolution ────────────────────────────────────────────────
async function resolvePositions(cycle: ActiveCycle): Promise<void> {
  // Cancel any pending GTC orders before resolution + log unfilled
  for (const [name, pos] of positions) {
    if (pos.pendingOrderId) {
      try {
        await clobClient.cancelOrder({ orderID: pos.pendingOrderId });
        console.log(`  [${name}] Cancelled pending GTC ${pos.pendingOrderId.slice(0, 12)}... (cycle ending — NOT filled)`);
      } catch {}

      // Log unfilled trigger to MongoDB
      db.collection('btc5mBotTrades').insertOne({
        slug: cycle.slug, conditionId: cycle.conditionId, strategy: name,
        side: pos.pendingSide, entryPrice: 0, triggerPrice: 0,
        filledPrice: 0, shares: 0, costUsdc: 0,
        fillType: 'unfilled', fillAttempts: 0,
        btcPriceAtEntry: currentBtcPrice, delta: currentBtcPrice - cycle.priceToBeat,
        pnl: 0, won: null, winner: null,
        cycleOpen: cycle.cycleOpen, cycleClose: cycle.cycleClose, secsBeforeClose: 0,
        priceToBeat: cycle.priceToBeat, filledAt: new Date(), resolvedAt: new Date(),
        status: 'triggered_not_filled',
      }).catch(() => {});

      pos.pendingOrderId = null;
    }
  }

  const filledPos = [...positions.values()].filter(p => p.filled);
  if (filledPos.length === 0) {
    console.log(`  [Resolve] No fills this cycle — skipping resolution`);
    return;
  }

  console.log(`\n  [Resolve] Waiting for resolution of ${cycle.slug}...`);
  await sleep(12000);

  // Determine winner: compare BTC close price vs priceToBeat
  // The WS gives us current BTC price which IS the close price right after resolution
  let winner: 'Up' | 'Down' | 'Unknown' = 'Unknown';

  // Use current BTC price as close price (we're checking right after resolution)
  if (currentBtcPrice > 0 && cycle.priceToBeat > 0) {
    winner = currentBtcPrice > cycle.priceToBeat ? 'Up' : 'Down';
    console.log(`  [Resolve] BTC=$${currentBtcPrice.toFixed(2)} vs strike=$${cycle.priceToBeat.toFixed(2)} → ${winner}`);
  }

  // Fallback: check Gamma API outcomePrices
  if (winner === 'Unknown') {
    try {
      const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${cycle.slug}`);
      if (res.ok) {
        const events = await res.json() as any[];
        const market = events?.[0]?.markets?.[0] || {};
        const op = market.outcomePrices;
        if (op?.includes('"1"') && op?.includes('"0"')) {
          winner = op.indexOf('"1"') < op.indexOf('"0"') ? 'Up' : 'Down';
        }
      }
    } catch {}
  }

  if (winner === 'Unknown') {
    await sleep(15000);
    // Try Gamma again
    try {
      const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${cycle.slug}`);
      if (res.ok) {
        const events = await res.json() as any[];
        const market = events?.[0]?.markets?.[0] || {};
        const op = market.outcomePrices;
        if (op?.includes('"1"') && op?.includes('"0"')) {
          winner = op.indexOf('"1"') < op.indexOf('"0"') ? 'Up' : 'Down';
        }
      }
    } catch {}
  }

  console.log(`  [Resolve] Winner: ${winner}`);

  for (const [name, pos] of positions) {
    if (!pos.filled) continue;
    const won = pos.filledSide === winner;
    const pnl = won ? pos.filledShares - pos.filledUsdc : -pos.filledUsdc;
    stats.totalPnl += pnl;
    if (won) stats.wins++; else stats.losses++;

    console.log(`  [${name}] ${pos.filledSide} @${(pos.filledPrice*100).toFixed(0)}c | ${won ? '✅ WIN' : '❌ LOSS'} | PnL: $${pnl.toFixed(2)}`);

    await db.collection('btc5mBotTrades').updateOne(
      { slug: cycle.slug, strategy: name },
      { $set: { pnl, won, winner, btcClosePrice: currentBtcPrice, resolvedAt: new Date() } }
    );
  }

  console.log(`\n  [Stats] Cycles: ${stats.cyclesSeen} | Triggered: ${stats.cyclesTriggered} | Filled: ${stats.cyclesFilled} | Skipped(delta): ${stats.cyclesSkippedDelta}`);
  console.log(`  [Stats] Fills: ${stats.totalFills} | Maker: ${stats.makerFills} (${stats.totalFills > 0 ? (stats.makerFills/stats.totalFills*100).toFixed(0) : 0}%) | Taker: ${stats.takerFills}`);
  console.log(`  [Stats] PnL: $${stats.totalPnl.toFixed(2)} | ${stats.wins}W / ${stats.losses}L`);
}

// ── Main Loop ─────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   BTC 5m Trading Bot v2 (WS Price + Delta Filter)     ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Wallet:     ${CONFIG.botWallet}`);
  console.log(`  Strategies: ${STRATEGIES.filter(s => s.active).map(s => s.name).join(', ')}`);
  console.log(`  Budget:     $${STRATEGIES.filter(s=>s.active).reduce((s, st) => s + st.budgetUsdc, 0)} total`);
  console.log(`  Min delta:  ${CONFIG.minDeltaPoints} pts`);
  console.log(`  Mode:       ${CONFIG.dataOnlyMode ? '📊 DATA COLLECTION ONLY (no orders)' : '🔴 LIVE TRADING'}`);
  console.log(`  GTC timeout: ${CONFIG.gctFillTimeoutMs / 1000}s`);

  // Init CLOB
  console.log('\n[Init] CLOB client...');
  clobClient = await initClobClient();
  console.log('[Init] ✅ CLOB ready');

  // Init MongoDB
  console.log('[Init] MongoDB...');
  const mongoClient = new MongoClient(CONFIG.mongoUri);
  await mongoClient.connect();
  const dbName = (() => { try { return new URL(CONFIG.mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  db = mongoClient.db(dbName);
  await db.collection('btc5mBotTrades').createIndex({ slug: 1, strategy: 1 });
  await db.collection('btc5mOrderbook').createIndex({ slug: 1, timestamp: 1 });
  await db.collection('btc5mPriceStream').createIndex({ timestamp: -1 });
  console.log(`[Init] ✅ MongoDB (${dbName})`);

  // Connect WS price feed + start heartbeat monitor
  connectBtcPriceWs();
  startWsHeartbeat();

  // Wait for first BTC price
  console.log('[Init] Waiting for BTC price from WS...');
  for (let i = 0; i < 30; i++) {
    if (currentBtcPrice > 0) break;
    await sleep(1000);
  }
  if (currentBtcPrice === 0) {
    console.error('[Init] ❌ No BTC price after 30s — check WS connection');
    process.exit(1);
  }
  console.log(`[Init] ✅ BTC price: $${currentBtcPrice.toFixed(2)}`);

  // History
  const pastTrades = await db.collection('btc5mBotTrades').find({ pnl: { $ne: null } }).toArray();
  const totalPnl = pastTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  console.log(`\n[History] ${pastTrades.length} trades | PnL: $${totalPnl.toFixed(2)}`);

  console.log('\n[Bot] Starting...\n');

  let lastCycleSlug = '';

  while (true) {
    try {
      const currentSlug = getCurrentSlug();
      const cycleOpen = parseInt(currentSlug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');
      const cycleClose = cycleOpen + 300;
      const now = Math.floor(Date.now() / 1000);
      const secsLeft = cycleClose - now;

      if (currentSlug !== lastCycleSlug) {
        stats.cyclesSeen++;

        // Resolve previous
        if (currentCycle) await resolvePositions(currentCycle);

        // Reset positions
        positions = new Map();
        for (const s of STRATEGIES) {
          positions.set(s.name, { strategyName: s.name, filled: false, filledSide: null, filledPrice: 0, filledShares: 0, filledUsdc: 0, orderId: '', fillAttempts: 0, pendingOrderId: null, pendingTokenId: '', pendingSide: null });
        }

        // Fetch market data — priceToBeat is now derived inside fetchCycleData
        // using eventStartTime from Gamma API + WS price history
        currentCycle = await fetchCycleData(currentSlug);
        if (currentCycle) {
          const ptb = currentCycle.priceToBeat;
          const ptbSource = ptb === currentBtcPrice ? '⚠️ fallback(now)' : 'eventStart';
          console.log(`\n═══ CYCLE ${currentSlug.slice(-10)} | -${secsLeft}s | strike=$${ptb.toFixed(2)} [${ptbSource}] now=$${currentBtcPrice.toFixed(2)} ═══`);
          console.log(`  ${currentCycle.question} | tokens: Up=${currentCycle.upTokenId.slice(0, 12)}... Down=${currentCycle.downTokenId.slice(0, 12)}...`);

          // Log cycle
          db.collection('btc5mBotCycles').updateOne(
            { slug: currentSlug },
            { $set: { slug: currentSlug, cycleOpen, cycleClose, priceToBeat: currentCycle.priceToBeat, btcPriceAtOpen: currentCycle.priceToBeat, btcPriceNow: currentBtcPrice, seenAt: new Date() } },
            { upsert: true }
          ).catch(() => {});
        }

        lastCycleSlug = currentSlug;
      }

      if (currentCycle && secsLeft > 0) {
        await evaluateStrategies(currentCycle);
      }

      await sleep(CONFIG.pollIntervalMs);
    } catch (err: any) {
      console.error(`[Error] ${err.message}`);
      await sleep(5000);
    }
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
