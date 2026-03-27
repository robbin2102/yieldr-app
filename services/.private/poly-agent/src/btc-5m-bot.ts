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
  entryPrice: number;     // e.g., 0.85
  windowSecs: number;     // seconds before resolution to start
  budgetUsdc: number;     // USDC per trade
  active: boolean;
}

const STRATEGIES: StrategyConfig[] = [
  { name: '85c_90s', entryPrice: 0.85, windowSecs: 90, budgetUsdc: 30, active: true },
  { name: '90c_90s', entryPrice: 0.90, windowSecs: 90, budgetUsdc: 30, active: true },
  { name: '95c_60s', entryPrice: 0.95, windowSecs: 60, budgetUsdc: 30, active: true },
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
  entryPrice: number;
  filledPrice: number;
  shares: number;
  costUsdc: number;
  pnl: number | null;        // null until resolved
  won: boolean | null;
  winner: string | null;
  cycleOpen: number;
  cycleClose: number;
  priceToBeat: number;
  filledAt: Date;
  resolvedAt: Date | null;
}

// ── Globals ───────────────────────────────────────────────────
let clobClient: ClobClient;
let db: Db;
let currentCycle: ActiveCycle | null = null;
let positions: Map<string, StrategyPosition> = new Map(); // strategyName → position
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
    const meta = event.eventMetadata || {};

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
      priceToBeat: meta.priceToBeat || 0,
      question: market.question || slug,
    };
  } catch (err: any) {
    console.error(`[Market] Error fetching ${slug}: ${err.message}`);
    return null;
  }
}

// ── Orderbook ─────────────────────────────────────────────────
async function getBookPrice(tokenId: string, side: 'BUY'): Promise<number | null> {
  try {
    const url = `${CONFIG.clobApiBase}/book?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;

    // For BUY: we look at asks (what sellers are offering)
    // Best ask = lowest price someone will sell at
    const asks = (data.asks || [])
      .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .sort((a: any, b: any) => a.price - b.price);

    return asks.length > 0 ? asks[0].price : null;
  } catch {
    return null;
  }
}

// ── Order Execution ───────────────────────────────────────────
async function placeFAKBuy(
  tokenId: string,
  budgetUsdc: number,
  limitPrice: number
): Promise<{ filled: boolean; filledShares: number; avgPrice: number; orderId: string }> {
  let totalFilled = 0;
  let totalCost = 0;
  let attempts = 0;
  let lastOrderId = '';
  let remainingBudget = budgetUsdc;

  while (remainingBudget > 0.5 && attempts < CONFIG.maxOrderRetries) {
    attempts++;

    try {
      const order = await clobClient.createMarketBuyOrder({
        tokenID: tokenId,
        amount: Math.max(remainingBudget, 1),
        price: limitPrice,
        feeRateBps: 0,
        nonce: 0,
      });

      const response = await clobClient.postOrder(order, OrderType.FAK);

      if (response && response.orderID) {
        lastOrderId = response.orderID;

        // Poll for fill status
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

              if (filled > 0) {
                const cost = filled * price;
                totalFilled += filled;
                totalCost += cost;
                remainingBudget -= cost;
                console.log(`  [Order] Filled ${filled.toFixed(2)} shares @ ${price.toFixed(4)} (attempt ${attempts})`);
                break;
              }

              if (orderStatus.status === 'CANCELED' || orderStatus.status === 'EXPIRED') break;
            }
          } catch { /* continue polling */ }
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
  };
}

// ── Strategy Evaluation ───────────────────────────────────────
async function evaluateStrategies(cycle: ActiveCycle): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const secsLeft = cycle.cycleClose - now;

  for (const strategy of STRATEGIES) {
    if (!strategy.active) continue;

    const pos = positions.get(strategy.name);
    if (pos?.filled) continue; // Already positioned this cycle

    // Check if we're within the entry window
    if (secsLeft > strategy.windowSecs) continue;

    // Fetch orderbook prices for both sides
    const [upAsk, downAsk] = await Promise.all([
      getBookPrice(cycle.upTokenId, 'BUY'),
      getBookPrice(cycle.downTokenId, 'BUY'),
    ]);

    if (upAsk === null && downAsk === null) {
      console.log(`  [${strategy.name}] No orderbook data, skipping`);
      continue;
    }

    // Check if either side has reached the entry price
    let targetSide: 'Up' | 'Down' | null = null;
    let targetTokenId = '';
    let currentPrice = 0;

    if (upAsk !== null && upAsk >= strategy.entryPrice) {
      targetSide = 'Up';
      targetTokenId = cycle.upTokenId;
      currentPrice = upAsk;
    } else if (downAsk !== null && downAsk >= strategy.entryPrice) {
      targetSide = 'Down';
      targetTokenId = cycle.downTokenId;
      currentPrice = downAsk;
    }

    if (!targetSide) {
      // Neither side at entry price yet
      if (secsLeft <= strategy.windowSecs && secsLeft % 10 < 3) {
        console.log(`  [${strategy.name}] Waiting... Up=${upAsk?.toFixed(2) || '?'} Down=${downAsk?.toFixed(2) || '?'} (-${secsLeft}s)`);
      }
      continue;
    }

    // Entry condition met — place FAK order
    console.log(`\n  ⚡ [${strategy.name}] ENTRY: ${targetSide} @ ${currentPrice.toFixed(2)} (limit ${strategy.entryPrice}) | -${secsLeft}s`);

    const result = await placeFAKBuy(targetTokenId, strategy.budgetUsdc, strategy.entryPrice);

    if (result.filled) {
      const posState: StrategyPosition = {
        strategyName: strategy.name,
        filled: true,
        filledSide: targetSide,
        filledPrice: result.avgPrice,
        filledShares: result.filledShares,
        filledUsdc: result.filledShares * result.avgPrice,
        orderId: result.orderId,
        fillAttempts: 1,
      };
      positions.set(strategy.name, posState);

      console.log(`  ✅ [${strategy.name}] FILLED: ${result.filledShares.toFixed(2)} ${targetSide} shares @ ${result.avgPrice.toFixed(4)}`);

      // Log to MongoDB
      const trade: TradeLog = {
        slug: cycle.slug,
        conditionId: cycle.conditionId,
        strategy: strategy.name,
        side: targetSide,
        entryPrice: strategy.entryPrice,
        filledPrice: result.avgPrice,
        shares: result.filledShares,
        costUsdc: result.filledShares * result.avgPrice,
        pnl: null,
        won: null,
        winner: null,
        cycleOpen: cycle.cycleOpen,
        cycleClose: cycle.cycleClose,
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
  // Wait a bit for resolution
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
