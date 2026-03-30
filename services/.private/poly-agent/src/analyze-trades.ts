/**
 * Analyze Bot Trades
 *
 * Logic:
 * 1. Load all 54 triggered trades from MongoDB (btc5mBotTrades + btc5mBotTriggers)
 * 2. For each conditionId, fetch position from Polymarket API to determine win/loss
 * 3. Cross-reference with btc5mOrderbook for delta/price at entry
 * 4. Show win vs loss breakdown to identify what to change
 *
 * Usage (from project root):
 *   npx tsx services/.private/poly-agent/src/analyze-trades.ts
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

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

const WALLET = process.env.BOT_WALLET_ADDRESS!;
const DATA_API = process.env.DATA_API_BASE || 'https://data-api.polymarket.com';

if (!WALLET) { console.error('Fatal: BOT_WALLET_ADDRESS not set'); process.exit(1); }
if (!process.env.MONGODB_URI) { console.error('Fatal: MONGODB_URI not set'); process.exit(1); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Fetch all positions for wallet (including zero-value = losses)
async function fetchAllPositions(): Promise<Map<string, any>> {
  const map = new Map<string, any>(); // conditionId -> position
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `${DATA_API}/positions?user=${WALLET.toLowerCase()}&sizeThreshold=0&limit=${limit}&offset=${offset}`
    );
    if (!res.ok) { console.log(`  Positions API: ${res.status}`); break; }
    const data = await res.json() as any[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) {
      if (p.conditionId) map.set(p.conditionId, p);
    }
    if (data.length < limit) break;
    offset += limit;
    if (offset > 1000) break;
  }
  return map;
}

// Fetch closed positions (wins with PnL)
async function fetchClosedPositions(): Promise<Map<string, any>> {
  const map = new Map<string, any>(); // conditionId -> closed position
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `${DATA_API}/v1/closed-positions?user=${WALLET.toLowerCase()}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`
    );
    if (!res.ok) break;
    const data = await res.json() as any[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) {
      if (p.conditionId) map.set(p.conditionId, p);
    }
    if (data.length < limit) break;
    offset += limit;
    if (offset > 500) break;
  }
  return map;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Bot Trade Analysis — Wins + Losses                   ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Wallet: ${WALLET}\n`);

  // ── MongoDB ───────────────────────────────────────────────────
  const mongoUri = process.env.MONGODB_URI!;
  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);

  // Load all triggered trades (the 54 unfilled records = every trade the bot placed)
  const triggeredTrades = await db.collection('btc5mBotTrades').find({}).toArray();

  // Load trigger events for delta/price/timing at moment of order placement
  const triggerEvents = await db.collection('btc5mBotTriggers').find({}).toArray();
  const triggerBySlug = new Map<string, any>();
  for (const t of triggerEvents) {
    if (t.slug && !triggerBySlug.has(t.slug)) triggerBySlug.set(t.slug, t);
  }

  // Load orderbook snapshots — for each slug, find the earliest snapshot within 90s window
  const obRaw = await db.collection('btc5mOrderbook').find({ secsBeforeClose: { $lte: 90 } }).toArray();
  const obBySlug = new Map<string, any>();
  for (const ob of obRaw) {
    if (!ob.slug) continue;
    const existing = obBySlug.get(ob.slug);
    if (!existing || ob.secsBeforeClose > existing.secsBeforeClose) {
      obBySlug.set(ob.slug, ob);
    }
  }

  console.log(`  Triggered trades in DB: ${triggeredTrades.length}`);
  console.log(`  Trigger events:         ${triggerEvents.length}`);
  console.log(`  Orderbook slugs:        ${obBySlug.size}\n`);

  // ── Fetch from Polymarket API ─────────────────────────────────
  console.log('  Fetching all positions from Polymarket API (including losses)...');
  const allPositions = await fetchAllPositions();
  console.log(`  All positions: ${allPositions.size}`);

  console.log('  Fetching closed positions (wins with PnL)...');
  const closedPositions = await fetchClosedPositions();
  console.log(`  Closed positions: ${closedPositions.size}\n`);

  // ── Enrich each triggered trade ───────────────────────────────
  type TradeResult = {
    slug: string;
    conditionId: string;
    side: string;
    trigger: any;
    ob: any;
    position: any;    // open positions API
    closed: any;      // closed positions API
    won: boolean | null;
    filledPrice: number;
    shares: number;
    costUsdc: number;
    pnl: number;
    delta: number | null;
    secsBeforeClose: number | null;
    btcPrice: number | null;
    priceToBeat: number | null;
  };

  const results: TradeResult[] = [];

  for (const trade of triggeredTrades) {
    const slug = trade.slug;
    const conditionId = trade.conditionId;
    const trigger = triggerBySlug.get(slug);
    const ob = obBySlug.get(slug);
    const position = allPositions.get(conditionId);
    const closed = closedPositions.get(conditionId);

    // Determine win/loss from closed positions API
    // closed positions = redeemed wins
    // if not in closed but in allPositions with curPrice < 0.1 = loss
    // if not anywhere = could not determine
    let won: boolean | null = null;
    let filledPrice = 0;
    let shares = 0;
    let costUsdc = 0;
    let pnl = 0;

    if (closed) {
      won = true;
      filledPrice = closed.avgPrice || 0;
      shares = (closed.totalBought || 0) / (filledPrice || 1);
      costUsdc = closed.totalBought || 0;
      pnl = closed.realizedPnl || 0;
    } else if (position && position.curPrice !== undefined) {
      // Position still visible — check if it's a loss (near-zero value)
      won = position.curPrice > 0.5;
      filledPrice = position.avgPrice || trigger?.entryPrice || 0;
      shares = position.size || 0;
      costUsdc = shares * filledPrice;
      pnl = won ? (shares - costUsdc) : (-costUsdc);
    } else {
      // Not in either API — unknown (order may genuinely not have filled)
      won = null;
    }

    const delta = trigger?.absDelta ?? ob?.absDelta ?? null;
    const secsBeforeClose = trigger?.secsBeforeClose ?? null;
    const btcPrice = trigger?.btcPrice ?? ob?.btcPrice ?? null;
    const priceToBeat = trigger?.priceToBeat ?? ob?.priceToBeat ?? null;
    const side = trigger?.side ?? trade.side ?? '?';

    results.push({ slug, conditionId, side, trigger, ob, position, closed, won, filledPrice, shares, costUsdc, pnl, delta, secsBeforeClose, btcPrice, priceToBeat });
  }

  const resolved = results.filter(r => r.won !== null);
  const wins = results.filter(r => r.won === true);
  const losses = results.filter(r => r.won === false);
  const unknown = results.filter(r => r.won === null);

  // ── Overview ──────────────────────────────────────────────────
  console.log('═══ OVERVIEW ═══');
  console.log(`  Triggered trades:  ${results.length}`);
  console.log(`  Resolved:          ${resolved.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`  Unknown (no fill): ${unknown.length}`);
  console.log(`  Win rate:          ${resolved.length > 0 ? ((wins.length / resolved.length) * 100).toFixed(1) : '?'}%`);

  const totalPnl = resolved.reduce((s, r) => s + r.pnl, 0);
  const totalCost = resolved.filter(r => r.costUsdc > 0).reduce((s, r) => s + r.costUsdc, 0);
  console.log(`  Total PnL:         $${totalPnl.toFixed(2)}`);
  console.log(`  Total deployed:    $${totalCost.toFixed(2)}`);

  // ── Winning trades ────────────────────────────────────────────
  console.log('\n═══ WINNING TRADES ═══');
  console.log(`  ${'Side'.padEnd(5)} | ${'Price'.padEnd(6)} | ${'Cost'.padEnd(7)} | ${'PnL'.padEnd(7)} | ${'Delta'.padEnd(7)} | ${'Secs'.padEnd(5)} | Market`);
  console.log(`  ${'-'.repeat(75)}`);
  for (const r of wins) {
    const title = (r.closed?.title || r.position?.title || r.slug)?.slice(-35) || '?';
    console.log(`  ${r.side.padEnd(5)} | ${((r.filledPrice * 100).toFixed(0) + 'c').padEnd(6)} | $${r.costUsdc.toFixed(2).padEnd(6)} | +$${r.pnl.toFixed(2).padEnd(5)} | Δ${(r.delta ?? '?').toString().slice(0,5).padEnd(6)} | ${(r.secsBeforeClose ?? '?').toString().padEnd(5)} | ${title}`);
  }

  // ── Losing trades ─────────────────────────────────────────────
  console.log('\n═══ LOSING TRADES ═══');
  if (losses.length === 0) {
    console.log('  None found in API (losing positions may have expired/not visible)');
  } else {
    console.log(`  ${'Side'.padEnd(5)} | ${'Price'.padEnd(6)} | ${'Cost'.padEnd(7)} | ${'PnL'.padEnd(8)} | ${'Delta'.padEnd(7)} | ${'Secs'.padEnd(5)} | Market`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const r of losses) {
      const title = (r.position?.title || r.slug)?.slice(-35) || '?';
      console.log(`  ${r.side.padEnd(5)} | ${((r.filledPrice * 100).toFixed(0) + 'c').padEnd(6)} | $${r.costUsdc.toFixed(2).padEnd(6)} | -$${Math.abs(r.pnl).toFixed(2).padEnd(5)} | Δ${(r.delta ?? '?').toString().slice(0,5).padEnd(6)} | ${(r.secsBeforeClose ?? '?').toString().padEnd(5)} | ${title}`);
    }
  }

  // ── Unknown (order may not have filled) ──────────────────────
  if (unknown.length > 0) {
    console.log(`\n═══ UNKNOWN — NOT FOUND IN API (${unknown.length} trades) ═══`);
    console.log('  These triggered but cannot be verified — may be genuine non-fills');
    console.log(`  ${'Side'.padEnd(5)} | ${'Delta'.padEnd(7)} | ${'Secs'.padEnd(5)} | Market`);
    console.log(`  ${'-'.repeat(50)}`);
    for (const r of unknown) {
      const title = r.slug?.slice(-35) || '?';
      console.log(`  ${r.side.padEnd(5)} | Δ${(r.delta ?? '?').toString().slice(0,5).padEnd(6)} | ${(r.secsBeforeClose ?? '?').toString().padEnd(5)} | ${title}`);
    }
  }

  // ── Delta comparison: wins vs losses ─────────────────────────
  console.log('\n═══ DELTA: WINS vs LOSSES ═══');
  const deltaBuckets = [
    { label: '0-30', min: 0, max: 30 },
    { label: '30-60', min: 30, max: 60 },
    { label: '60-100', min: 60, max: 100 },
    { label: '100-200', min: 100, max: 200 },
    { label: '200+', min: 200, max: Infinity },
  ];
  console.log(`  ${'Δ Range'.padEnd(10)} | ${'Total'.padEnd(7)} | ${'Wins'.padEnd(6)} | ${'Losses'.padEnd(7)} | WR`);
  console.log(`  ${'-'.repeat(45)}`);
  for (const b of deltaBuckets) {
    const bucket = resolved.filter(r => r.delta !== null && r.delta >= b.min && r.delta < b.max);
    if (bucket.length === 0) continue;
    const bW = bucket.filter(r => r.won).length;
    const bL = bucket.length - bW;
    console.log(`  ${b.label.padEnd(10)} | ${bucket.length.toString().padEnd(7)} | ${bW.toString().padEnd(6)} | ${bL.toString().padEnd(7)} | ${((bW/bucket.length)*100).toFixed(0)}%`);
  }

  // ── Timing comparison ─────────────────────────────────────────
  console.log('\n═══ TIMING: WINS vs LOSSES (secs before close at trigger) ═══');
  const timeBuckets = [
    { label: '0-15s', min: 0, max: 15 },
    { label: '15-30s', min: 15, max: 30 },
    { label: '30-60s', min: 30, max: 60 },
    { label: '60-90s', min: 60, max: 90 },
    { label: '90s (start)', min: 89, max: 100 },
  ];
  console.log(`  ${'Window'.padEnd(12)} | ${'Total'.padEnd(7)} | ${'Wins'.padEnd(6)} | ${'Losses'.padEnd(7)} | WR`);
  console.log(`  ${'-'.repeat(47)}`);
  for (const b of timeBuckets) {
    const bucket = resolved.filter(r => r.secsBeforeClose !== null && r.secsBeforeClose >= b.min && r.secsBeforeClose < b.max);
    if (bucket.length === 0) continue;
    const bW = bucket.filter(r => r.won).length;
    const bL = bucket.length - bW;
    console.log(`  ${b.label.padEnd(12)} | ${bucket.length.toString().padEnd(7)} | ${bW.toString().padEnd(6)} | ${bL.toString().padEnd(7)} | ${((bW/bucket.length)*100).toFixed(0)}%`);
  }

  // ── Price comparison ──────────────────────────────────────────
  console.log('\n═══ FILL PRICE: WINS vs LOSSES ═══');
  const priceBuckets = [
    { label: '85-90c', min: 0.85, max: 0.90 },
    { label: '90-92c', min: 0.90, max: 0.92 },
    { label: '92-94c', min: 0.92, max: 0.94 },
    { label: '94-96c', min: 0.94, max: 0.96 },
    { label: '96-99c', min: 0.96, max: 0.99 },
  ];
  console.log(`  ${'Price'.padEnd(10)} | ${'Total'.padEnd(7)} | ${'Wins'.padEnd(6)} | ${'Losses'.padEnd(7)} | WR`);
  console.log(`  ${'-'.repeat(45)}`);
  for (const b of priceBuckets) {
    const bucket = resolved.filter(r => r.filledPrice >= b.min && r.filledPrice < b.max);
    if (bucket.length === 0) continue;
    const bW = bucket.filter(r => r.won).length;
    const bL = bucket.length - bW;
    console.log(`  ${b.label.padEnd(10)} | ${bucket.length.toString().padEnd(7)} | ${bW.toString().padEnd(6)} | ${bL.toString().padEnd(7)} | ${((bW/bucket.length)*100).toFixed(0)}%`);
  }

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
