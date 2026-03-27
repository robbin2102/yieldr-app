/**
 * BTC 5-Minute Market Trading Bot
 *
 * Runs 3 naked tail strategies on live BTC 5m markets:
 *   Strategy 1: Buy at 85c, last 90s before resolution
 *   Strategy 2: Buy at 90c, last 90s before resolution
 *   Strategy 3: Buy at 95c, last 60s before resolution
 *
 * Places limit buy orders on BOTH sides (Up/Down) via FAK.
 * First side to reach target price gets filled, other is not placed.
 * Holds to resolution — no sells.
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/btc-5m-bot.ts
 *
 * Required: .env.polyagent with BOT_PRIVATE_KEY, POLYMARKET_API_KEY, etc.
 */

import { ethers } from 'ethers';
import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { MongoClient, Db } from 'mongodb';
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
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  gammaApiBase: 'https://gamma-api.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
  pollIntervalMs: 2000,       // Poll orderbook every 2s
  cycleCheckMs: 5000,         // Check for new cycle every 5s
  maxOrderRetries: 5,
  orderRetryDelayMs: 500,
};

// Validate required config
const required = ['botPrivateKey', 'botWallet', 'apiKey', 'apiSecret', 'passphrase', 'mongoUri', 'polygonRpcUrl'];
for (const key of required) {
  if (!CONFIG[key as keyof typeof CONFIG]) {
    console.error(`Missing required config: ${key}`);
    process.exit(1);
  }
}

// ── Strategy Definitions ──────────────────────────────────────
interface StrategyConfig {
  name: string;
  entryPrice: number;     // limit order price (e.g., 0.85)
  triggerSpread: number;  // place order when market is this much ABOVE entry (e.g., 0.01 = 1c)
  windowSecs: number;     // seconds before resolution to start
  budgetUsdc: number;     // USDC per trade
  active: boolean;
}

const STRATEGIES: StrategyConfig[] = [
  { name: '85c_90s', entryPrice: 0.85, triggerSpread: 0.01, windowSecs: 90, budgetUsdc: 3, active: true },
  { name: '90c_90s', entryPrice: 0.90, triggerSpread: 0.01, windowSecs: 90, budgetUsdc: 3, active: false },
  { name: '95c_60s', entryPrice: 0.95, triggerSpread: 0.01, windowSecs: 60, budgetUsdc: 3, active: false },
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
}

interface TradeLog {
  slug: string;
  conditionId: string;
  strategy: string;
  side: string;
  entryPrice: number;       // limit order price
  triggerPrice: number;     // market price when order was placed
  filledPrice: number;
  shares: number;
  costUsdc: number;
  fillType: 'maker' | 'taker' | 'unknown';
  fillAttempts: number;
  pnl: number | null;
  won: boolean | null;
  winner: string | null;
  cycleOpen: number;
  cycleClose: number;
  secsBeforeClose: number;
  priceToBeat: number;
  filledAt: Date;
  resolvedAt: Date | null;
}

// ── Globals ───────────────────────────────────────────────────
let clobClient: ClobClient;
let db: Db;
let currentCycle: ActiveCycle | null = null;
let positions: Map<string, StrategyPosition> = new Map();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Cycle stats (per session)
const stats = {
  cyclesSeen: 0,
  cyclesWithWindow: 0,     // cycles where at least 1 strategy window was active
  cyclesTriggered: 0,      // cycles where at least 1 strategy placed an order
  cyclesFilled: 0,         // cycles where at least 1 order filled
  totalFills: 0,
  makerFills: 0,
  takerFills: 0,
  totalPnl: 0,
  wins: 0,
  losses: 0,
};

// ── CLOB Client Setup ─────────────────────────────────────────
async function initClobClient(): Promise<ClobClient> {
  const network = { name: 'polygon', chainId: CONFIG.chainId };
  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, network);
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);

  console.log(`[Init] Wallet: ${wallet.address}`);
  console.log(`[Init] Chain: ${CONFIG.chainId}`);

  const client = new ClobClient(
    CONFIG.clobApiBase,
    CONFIG.chainId,
    wallet,
    { key: CONFIG.apiKey, secret: CONFIG.apiSecret, passphrase: CONFIG.passphrase }
  );

  return client;
}

// ── Market Data ───────────────────────────────────────────────
function getCurrentSlug(): string {
  const now = Math.floor(Date.now() / 1000);
  const rounded = Math.floor(now / 300) * 300;
  return `btc-updown-5m-${rounded}`;
}

function getNextSlug(): string {
  const now = Math.floor(Date.now() / 1000);
  const rounded = Math.floor(now / 300) * 300 + 300;
  return `btc-updown-5m-${rounded}`;
}

async function fetchCycleData(slug: string): Promise<ActiveCycle | null> {
  try {
    const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${slug}`);
    if (!res.ok) return null;
    const events = await res.json() as any[];
    if (!events?.[0]?.markets?.[0]) return null;

    const event = events[0];
    const market = event.markets[0];
    const meta = event.eventMetadata || event.metadata || {};
    // priceToBeat can be nested in different places
    const ptb = meta.priceToBeat || market.priceToBeat || event.priceToBeat || 0;

    let tokenIds: string[] = [];
    try { tokenIds = JSON.parse(market.clobTokenIds); }
    catch { tokenIds = (market.clobTokenIds || '').split(',').map((s: string) => s.trim()); }

    const cycleOpen = parseInt(slug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');

    return {
      slug,
      conditionId: market.conditionId,
      upTokenId: tokenIds[0] || '',
      downTokenId: tokenIds[1] || '',
      cycleOpen,
      cycleClose: cycleOpen + 300,
      priceToBeat: ptb,
      question: market.question || slug,
    };
  } catch (err: any) {
    console.error(`[Market] Error fetching ${slug}: ${err.message}`);
    return null;
  }
}

// ── Orderbook ─────────────────────────────────────────────────
interface BookSnapshot {
  tokenId: string;
  side: string;        // 'Up' or 'Down'
  bestAsk: number | null;
  bestBid: number | null;
  askDepth: number;     // total size at best ask
  totalAskLiquidity: number; // total USDC across all asks
  spread: number | null;
  timestamp: Date;
}

async function getBookSnapshot(tokenId: string, label: string): Promise<BookSnapshot> {
  const snapshot: BookSnapshot = {
    tokenId, side: label, bestAsk: null, bestBid: null,
    askDepth: 0, totalAskLiquidity: 0, spread: null, timestamp: new Date(),
  };

  try {
    const url = `${CONFIG.clobApiBase}/book?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) return snapshot;
    const data = await res.json() as any;

    const asks = (data.asks || [])
      .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a: any, b: any) => a.price - b.price);

    const bids = (data.bids || [])
      .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .sort((a: any, b: any) => b.price - a.price);

    snapshot.bestAsk = asks.length > 0 ? asks[0].price : null;
    snapshot.bestBid = bids.length > 0 ? bids[0].price : null;
    snapshot.askDepth = asks.length > 0 ? asks[0].size : 0;
    snapshot.totalAskLiquidity = asks.reduce((s: number, a: any) => s + a.price * a.size, 0);
    snapshot.spread = (snapshot.bestAsk !== null && snapshot.bestBid !== null)
      ? snapshot.bestAsk - snapshot.bestBid : null;

    return snapshot;
  } catch {
    return snapshot;
  }
}

async function logOrderbook(slug: string, cycleClose: number, upSnap: BookSnapshot, downSnap: BookSnapshot): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const secsLeft = cycleClose - now;

  try {
    await db.collection('btc5mOrderbook').insertOne({
      slug,
      timestamp: new Date(),
      secsBeforeClose: secsLeft,
      up: {
        bestAsk: upSnap.bestAsk,
        bestBid: upSnap.bestBid,
        askDepth: upSnap.askDepth,
        totalAskLiquidity: upSnap.totalAskLiquidity,
        spread: upSnap.spread,
      },
      down: {
        bestAsk: downSnap.bestAsk,
        bestBid: downSnap.bestBid,
        askDepth: downSnap.askDepth,
        totalAskLiquidity: downSnap.totalAskLiquidity,
        spread: downSnap.spread,
      },
    });
  } catch { /* non-critical, don't crash */ }
}

// ── Order Execution ───────────────────────────────────────────
async function placeLimitBuy(
  tokenId: string,
  budgetUsdc: number,
  limitPrice: number
): Promise<{ filled: boolean; filledShares: number; avgPrice: number; orderId: string; fillType: 'maker' | 'taker' | 'unknown'; attempts: number }> {
  console.log(`  [Order] Placing LIMIT BUY: token=${tokenId.slice(0, 16)}... budget=$${budgetUsdc} limit=${limitPrice}`);
  let totalFilled = 0;
  let totalCost = 0;
  let attempts = 0;
  let lastOrderId = '';
  let remainingBudget = budgetUsdc;
  let fillType: 'maker' | 'taker' | 'unknown' = 'unknown';

  while (remainingBudget > 0.5 && attempts < CONFIG.maxOrderRetries) {
    attempts++;

    try {
      // Use createOrder with BUY side at limit price (maker order)
      const targetShares = remainingBudget / limitPrice;
      console.log(`  [Order] Attempt ${attempts}: creating order for ${targetShares.toFixed(2)} shares @ ${limitPrice} ($${remainingBudget.toFixed(2)} budget)`);

      const order = await clobClient.createOrder({
        tokenID: tokenId,
        price: limitPrice,
        size: targetShares,
        side: Side.BUY,
        feeRateBps: 1000, // BTC 5m markets require 1000 bps maker fee
        nonce: 0,
      });
      console.log(`  [Order] Order created, signing and posting as GTC...`);

      // Post as GTC — sits in book as maker order
      // We poll for fills and cancel remainder after timeout
      const response = await clobClient.postOrder(order, OrderType.GTC);
      console.log(`  [Order] Posted → orderID: ${response?.orderID?.slice(0, 20) || 'null'}... status: ${response?.status || '?'}`);

      if (response && response.orderID) {
        lastOrderId = response.orderID;

        // Poll for fill status — GTC order sits in book for up to 2s
        console.log(`  [Fill] Polling order ${response.orderID.slice(0, 16)}...`);
        let orderFilled = false;
        for (let i = 0; i < 10; i++) {
          await sleep(200);
          try {
            const statusRes = await fetch(`${CONFIG.clobApiBase}/order/${response.orderID}`, {
              headers: {
                'POLY_API_KEY': CONFIG.apiKey,
                'POLY_SIGNATURE': CONFIG.apiSecret,
                'POLY_TIMESTAMP': Date.now().toString(),
                'POLY_PASSPHRASE': CONFIG.passphrase,
              },
            });

            if (statusRes.ok) {
              const orderStatus = await statusRes.json() as any;
              const filled = parseFloat(orderStatus.size_matched) || 0;
              const price = parseFloat(orderStatus.price) || limitPrice;
              const status = orderStatus.status || '?';

              console.log(`  [Fill] Poll ${i + 1}/10: status=${status} filled=${filled.toFixed(2)} price=${price.toFixed(4)}`);

              // Detect maker/taker
              if (filled > 0 && price <= limitPrice) fillType = 'maker';
              else if (filled > 0) fillType = 'taker';

              if (filled > 0) {
                const cost = filled * price;
                totalFilled += filled;
                totalCost += cost;
                remainingBudget -= cost;
                orderFilled = true;
                console.log(`  [Order] Filled ${filled.toFixed(2)} shares @ ${price.toFixed(4)} [${fillType}] (attempt ${attempts})`);
                break;
              }

              if (orderStatus.status === 'MATCHED' || orderStatus.status === 'FILLED') {
                orderFilled = true;
                break;
              }
              if (orderStatus.status === 'CANCELED' || orderStatus.status === 'EXPIRED') break;
            }
          } catch { /* continue polling */ }
        }

        // Cancel unfilled GTC order to avoid stale orders
        if (!orderFilled) {
          try {
            await clobClient.cancelOrder({ orderID: response.orderID });
            console.log(`  [Order] Cancelled unfilled GTC order ${response.orderID.slice(0, 12)}...`);
          } catch { /* ok if already cancelled */ }
        }
      }
    } catch (err: any) {
      console.error(`  [Order] Attempt ${attempts} error: ${err.message}`);
    }

    if (remainingBudget > 0.5 && attempts < CONFIG.maxOrderRetries) {
      await sleep(CONFIG.orderRetryDelayMs);
    }
  }

  return {
    filled: totalFilled > 0,
    filledShares: totalFilled,
    avgPrice: totalFilled > 0 ? totalCost / totalFilled : 0,
    orderId: lastOrderId,
    fillType,
    attempts,
  };
}

// ── Strategy Evaluation ───────────────────────────────────────
async function evaluateStrategies(cycle: ActiveCycle): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const secsLeft = cycle.cycleClose - now;

  // Log every poll regardless of window
  const anyInWindow = STRATEGIES.some(s => s.active && secsLeft <= s.windowSecs);

  if (secsLeft <= 0) {
    console.log(`  [Poll] Cycle expired (secsLeft=${secsLeft}), skipping`);
    return;
  }

  if (!anyInWindow) {
    // Log waiting status every 10s
    if (secsLeft % 10 < 3) {
      const nextWindow = Math.min(...STRATEGIES.filter(s => s.active).map(s => s.windowSecs));
      console.log(`  [Poll] -${secsLeft}s | Waiting for window (starts at -${nextWindow}s)`);
    }
    return;
  }

  console.log(`  [Poll] -${secsLeft}s | IN WINDOW — fetching orderbook...`);

  // Fetch orderbook snapshots for both sides
  const fetchStart = Date.now();
  const [upSnap, downSnap] = await Promise.all([
    getBookSnapshot(cycle.upTokenId, 'Up'),
    getBookSnapshot(cycle.downTokenId, 'Down'),
  ]);
  const fetchMs = Date.now() - fetchStart;

  console.log(`  [Book] Up: ask=${upSnap.bestAsk?.toFixed(3) || 'null'} bid=${upSnap.bestBid?.toFixed(3) || 'null'} depth=${upSnap.askDepth.toFixed(0)} | Down: ask=${downSnap.bestAsk?.toFixed(3) || 'null'} bid=${downSnap.bestBid?.toFixed(3) || 'null'} depth=${downSnap.askDepth.toFixed(0)} | ${fetchMs}ms`);

  // Log orderbook to MongoDB
  await logOrderbook(cycle.slug, cycle.cycleClose, upSnap, downSnap);

  const upAsk = upSnap.bestAsk;
  const downAsk = downSnap.bestAsk;

  for (const strategy of STRATEGIES) {
    if (!strategy.active) continue;

    const pos = positions.get(strategy.name);
    if (pos?.filled) continue;

    if (secsLeft > strategy.windowSecs) continue;

    if (upAsk === null && downAsk === null) {
      console.log(`  [${strategy.name}] ⚠️ No orderbook data (both null), skipping`);
      continue;
    }

    // Check if either side is at least triggerSpread above entry price
    // This ensures our limit order sits in the book as a MAKER order
    const triggerLevel = strategy.entryPrice + strategy.triggerSpread;
    console.log(`  [${strategy.name}] Checking: Up=${upAsk?.toFixed(3) || 'null'} Down=${downAsk?.toFixed(3) || 'null'} | trigger>=${(triggerLevel*100).toFixed(0)}c | limit=${(strategy.entryPrice*100).toFixed(0)}c`);
    let targetSide: 'Up' | 'Down' | null = null;
    let targetTokenId = '';
    let currentPrice = 0;

    if (upAsk !== null && upAsk >= triggerLevel) {
      targetSide = 'Up';
      targetTokenId = cycle.upTokenId;
      currentPrice = upAsk;
    } else if (downAsk !== null && downAsk >= triggerLevel) {
      targetSide = 'Down';
      targetTokenId = cycle.downTokenId;
      currentPrice = downAsk;
    }

    if (!targetSide) {
      if (secsLeft % 10 < 3) {
        console.log(`  [${strategy.name}] Waiting... Up=${upAsk?.toFixed(2) || '?'}(depth:${upSnap.askDepth.toFixed(0)}) Down=${downAsk?.toFixed(2) || '?'}(depth:${downSnap.askDepth.toFixed(0)}) | trigger>=${(triggerLevel*100).toFixed(0)}c | -${secsLeft}s`);
      }
      continue;
    }

    // Entry condition met — place LIMIT order at entry price (below market = maker)
    console.log(`\n  ⚡ [${strategy.name}] ENTRY: ${targetSide} market@${(currentPrice*100).toFixed(0)}c → limit@${(strategy.entryPrice*100).toFixed(0)}c | -${secsLeft}s`);
    stats.cyclesTriggered++;

    const result = await placeLimitBuy(targetTokenId, strategy.budgetUsdc, strategy.entryPrice);

    if (result.filled) {
      stats.cyclesFilled++;
      stats.totalFills++;
      if (result.fillType === 'maker') stats.makerFills++;
      else if (result.fillType === 'taker') stats.takerFills++;

      const posState: StrategyPosition = {
        strategyName: strategy.name,
        filled: true,
        filledSide: targetSide,
        filledPrice: result.avgPrice,
        filledShares: result.filledShares,
        filledUsdc: result.filledShares * result.avgPrice,
        orderId: result.orderId,
        fillAttempts: result.attempts,
      };
      positions.set(strategy.name, posState);

      console.log(`  ✅ [${strategy.name}] FILLED: ${result.filledShares.toFixed(2)} ${targetSide} shares @ ${result.avgPrice.toFixed(4)} [${result.fillType}] (${result.attempts} attempts)`);

      // Log to MongoDB
      const trade: TradeLog = {
        slug: cycle.slug,
        conditionId: cycle.conditionId,
        strategy: strategy.name,
        side: targetSide,
        entryPrice: strategy.entryPrice,
        triggerPrice: currentPrice,
        filledPrice: result.avgPrice,
        shares: result.filledShares,
        costUsdc: result.filledShares * result.avgPrice,
        fillType: result.fillType,
        fillAttempts: result.attempts,
        pnl: null,
        won: null,
        winner: null,
        cycleOpen: cycle.cycleOpen,
        cycleClose: cycle.cycleClose,
        secsBeforeClose: secsLeft,
        priceToBeat: cycle.priceToBeat,
        filledAt: new Date(),
        resolvedAt: null,
      };

      await db.collection('btc5mBotTrades').insertOne(trade);
    } else {
      console.log(`  ❌ [${strategy.name}] No fill — retrying next poll`);
    }
  }
}

// ── Resolution Tracking ───────────────────────────────────────
async function resolvePositions(cycle: ActiveCycle): Promise<void> {
  console.log(`\n  [Resolve] Waiting 10s for ${cycle.slug} to resolve...`);
  await sleep(10000);

  // Fetch resolution from Gamma API
  const data = await fetchCycleData(cycle.slug);
  if (!data) {
    console.log('[Resolve] Could not fetch resolution data');
    return;
  }

  // Determine winner from Gamma API
  let winner: 'Up' | 'Down' | 'Unknown' = 'Unknown';
  try {
    const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${cycle.slug}`);
    if (res.ok) {
      const events = await res.json() as any[];
      const meta = events?.[0]?.eventMetadata || {};
      const market = events?.[0]?.markets?.[0] || {};
      if (meta.finalPrice && meta.priceToBeat) {
        winner = meta.finalPrice > meta.priceToBeat ? 'Up' : 'Down';
      } else {
        const op = market.outcomePrices;
        if (op === '["1", "0"]' || op === '[1, 0]') winner = 'Up';
        else if (op === '["0", "1"]' || op === '[0, 1]') winner = 'Down';
      }
    }
  } catch { /* keep Unknown */ }

  if (winner === 'Unknown') {
    // Retry after more time
    await sleep(15000);
    try {
      const res = await fetch(`${CONFIG.gammaApiBase}/events?slug=${cycle.slug}`);
      if (res.ok) {
        const events = await res.json() as any[];
        const meta = events?.[0]?.eventMetadata || {};
        if (meta.finalPrice && meta.priceToBeat) {
          winner = meta.finalPrice > meta.priceToBeat ? 'Up' : 'Down';
        }
      }
    } catch { /* keep Unknown */ }
  }

  console.log(`\n[Resolve] ${cycle.slug} → Winner: ${winner}`);

  // Update each position
  for (const [stratName, pos] of positions) {
    if (!pos.filled) continue;

    const won = pos.filledSide === winner;
    const pnl = won ? pos.filledShares - pos.filledUsdc : -pos.filledUsdc;

    // Update session stats
    stats.totalPnl += pnl;
    if (won) stats.wins++;
    else stats.losses++;

    console.log(`  [${stratName}] ${pos.filledSide} @ ${pos.filledPrice.toFixed(4)} | ${won ? '✅ WIN' : '❌ LOSS'} | PnL: $${pnl.toFixed(2)}`);

    // Update MongoDB
    await db.collection('btc5mBotTrades').updateOne(
      { slug: cycle.slug, strategy: stratName },
      {
        $set: {
          pnl,
          won,
          winner,
          resolvedAt: new Date(),
        },
      }
    );
  }

  // Print session stats
  console.log(`\n  [Stats] Cycles: ${stats.cyclesSeen} seen | ${stats.cyclesTriggered} triggered | ${stats.cyclesFilled} filled`);
  console.log(`  [Stats] Fills: ${stats.totalFills} total | ${stats.makerFills} maker (${stats.totalFills > 0 ? (stats.makerFills / stats.totalFills * 100).toFixed(0) : 0}%) | ${stats.takerFills} taker`);
  console.log(`  [Stats] Session PnL: $${stats.totalPnl.toFixed(2)} | ${stats.wins}W / ${stats.losses}L`);
}

// ── Main Loop ─────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   BTC 5-Minute Market Trading Bot                     ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Wallet:     ${CONFIG.botWallet}`);
  console.log(`  Strategies: ${STRATEGIES.filter(s => s.active).map(s => s.name).join(', ')}`);
  console.log(`  Budget:     $${STRATEGIES.reduce((s, st) => s + st.budgetUsdc, 0)} total ($${STRATEGIES.map(s => s.budgetUsdc).join('/$')} per strategy)`);
  console.log(`  Poll:       ${CONFIG.pollIntervalMs}ms`);

  // Init CLOB client
  console.log('\n[Init] Setting up CLOB client...');
  clobClient = await initClobClient();
  console.log('[Init] ✅ CLOB client ready');

  // Init MongoDB
  console.log('[Init] Connecting to MongoDB...');
  const mongoClient = new MongoClient(CONFIG.mongoUri);
  await mongoClient.connect();
  const dbName = (() => { try { return new URL(CONFIG.mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  db = mongoClient.db(dbName);
  await db.collection('btc5mBotTrades').createIndex({ slug: 1, strategy: 1 });
  await db.collection('btc5mBotTrades').createIndex({ filledAt: -1 });
  await db.collection('btc5mOrderbook').createIndex({ slug: 1, timestamp: 1 });
  await db.collection('btc5mOrderbook').createIndex({ timestamp: -1 });
  console.log(`[Init] ✅ MongoDB ready (${dbName})`);

  // Print cumulative PnL from past trades
  const pastTrades = await db.collection('btc5mBotTrades').find({ pnl: { $ne: null } }).toArray();
  const totalPnl = pastTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const wins = pastTrades.filter((t: any) => t.won).length;
  console.log(`\n[History] ${pastTrades.length} past trades | ${wins} wins | PnL: $${totalPnl.toFixed(2)}`);

  console.log('\n[Bot] Starting main loop...\n');

  let lastCycleSlug = '';

  while (true) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const currentSlug = getCurrentSlug();
      const cycleOpen = parseInt(currentSlug.match(/btc-updown-5m-(\d+)/)?.[1] || '0');
      const cycleClose = cycleOpen + 300;
      const secsLeft = cycleClose - now;

      // New cycle detected
      if (currentSlug !== lastCycleSlug) {
        stats.cyclesSeen++;
        // Resolve previous cycle
        if (currentCycle && positions.size > 0) {
          const filledPositions = [...positions.values()].filter(p => p.filled);
          if (filledPositions.length > 0) {
            await resolvePositions(currentCycle);
          }
        }

        // Reset for new cycle
        positions = new Map();
        for (const s of STRATEGIES) {
          positions.set(s.name, {
            strategyName: s.name, filled: false, filledSide: null,
            filledPrice: 0, filledShares: 0, filledUsdc: 0, orderId: '', fillAttempts: 0,
          });
        }

        console.log(`\n═══ NEW CYCLE: ${currentSlug} | ${secsLeft}s remaining ═══`);

        // Fetch market data
        currentCycle = await fetchCycleData(currentSlug);
        if (currentCycle) {
          console.log(`  Market: ${currentCycle.question}`);
          console.log(`  Strike: $${currentCycle.priceToBeat.toFixed(2)}`);
          console.log(`  TokenIds: Up=${currentCycle.upTokenId.slice(0, 16)}... Down=${currentCycle.downTokenId.slice(0, 16)}...`);

          // Log cycle to MongoDB
          await db.collection('btc5mBotCycles').updateOne(
            { slug: currentSlug },
            { $set: { slug: currentSlug, cycleOpen, cycleClose, priceToBeat: currentCycle.priceToBeat, question: currentCycle.question, seenAt: new Date(), triggered: false, filled: false } },
            { upsert: true }
          );
        } else {
          console.log('  ⚠️ Could not fetch market data — waiting for next cycle');
        }

        lastCycleSlug = currentSlug;
      }

      // Evaluate strategies if we have an active cycle
      if (currentCycle && secsLeft > 0) {
        await evaluateStrategies(currentCycle);
      }

      // Wait before next poll
      await sleep(CONFIG.pollIntervalMs);

    } catch (err: any) {
      console.error(`[Error] ${err.message}`);
      await sleep(5000);
    }
  }
}

// ── Entry Point ───────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
