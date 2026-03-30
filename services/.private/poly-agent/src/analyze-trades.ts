/**
 * Analyze Bot Trades — fetches actual trades from Polymarket API
 * and cross-references with MongoDB orderbook + trigger data.
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

// ── Fetch all closed BTC 5m positions from Polymarket API ──────
async function fetchClosedPositions(): Promise<any[]> {
  const results: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `${DATA_API}/v1/closed-positions?user=${WALLET.toLowerCase()}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`
    );
    if (!res.ok) { console.log(`Closed positions API: ${res.status}`); break; }
    const data = await res.json() as any[];
    if (!Array.isArray(data) || data.length === 0) break;

    // Filter BTC 5m positions only
    const btc5m = data.filter((p: any) =>
      p.title?.toLowerCase().includes('bitcoin up or down') ||
      p.conditionId?.startsWith('0x') // fallback — keep all if title unclear
    );
    results.push(...btc5m);
    if (data.length < limit) break;
    offset += limit;
    if (offset > 500) break; // safety cap
  }
  return results;
}

// ── Fetch activity (individual buys) for the wallet ──────────
async function fetchActivity(): Promise<any[]> {
  const results: any[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const res = await fetch(
      `${DATA_API}/activity?user=${WALLET.toLowerCase()}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`
    );
    if (!res.ok) break;
    const data = await res.json() as any[];
    if (!Array.isArray(data) || data.length === 0) break;

    // BTC 5m only + BUY type
    const btc5m = data.filter((a: any) =>
      a.type === 'BUY' &&
      (a.title?.toLowerCase().includes('bitcoin up or down') || a.slug?.includes('btc-updown-5m'))
    );
    results.push(...btc5m);
    if (data.length < limit) break;
    offset += limit;
    if (offset > 500) break;
  }
  return results;
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Bot Trade Analysis (Polymarket API + MongoDB)        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Wallet: ${WALLET}\n`);

  // ── Connect MongoDB ───────────────────────────────────────────
  const client = new MongoClient(process.env.MONGODB_URI!);
  await client.connect();
  const dbName = (() => { try { return new URL(process.env.MONGODB_URI!).pathname.replace('/', '') || 'yieldr'; } catch { return 'yieldr'; } })();
  const db = client.db(dbName);
  console.log(`  MongoDB: ${dbName}\n`);

  // ── Load MongoDB data ─────────────────────────────────────────
  const [obData, triggerData, tradeData] = await Promise.all([
    db.collection('btc5mOrderbook').find({}).toArray(),
    db.collection('btc5mBotTriggers').find({}).toArray(),
    db.collection('btc5mBotTrades').find({}).toArray(),
  ]);
  console.log(`  Orderbook snapshots: ${obData.length}`);
  console.log(`  Trigger events:      ${triggerData.length}`);
  console.log(`  Trade records (bot): ${tradeData.length}`);

  // ── Fetch from Polymarket API ─────────────────────────────────
  console.log('\n  Fetching closed positions from Polymarket API...');
  const closedPositions = await fetchClosedPositions();
  console.log(`  Closed BTC 5m positions: ${closedPositions.length}`);

  console.log('\n  Fetching buy activity...');
  const activity = await fetchActivity();
  console.log(`  BTC 5m buy events: ${activity.length}`);

  if (closedPositions.length === 0 && activity.length === 0) {
    console.log('\n  No data found from Polymarket API. Check wallet address.');
    await client.close();
    return;
  }

  // ── Build conditionId → slug map from bot's unfilled records ─
  const conditionToSlug = new Map<string, string>();
  for (const t of tradeData) {
    if (t.conditionId && t.slug) conditionToSlug.set(t.conditionId, t.slug);
  }

  // ── Build slug → orderbook snapshot map (at trigger window) ──
  // For each slug, find the orderbook snapshot closest to when the order was placed
  // (within 90s window = secsBeforeClose <= 90)
  const slugToOb = new Map<string, any>();
  for (const ob of obData) {
    if (!ob.slug || ob.secsBeforeClose > 90) continue;
    const existing = slugToOb.get(ob.slug);
    // Keep the snapshot with highest secsBeforeClose within window (= earliest in window)
    if (!existing || ob.secsBeforeClose > existing.secsBeforeClose) {
      slugToOb.set(ob.slug, ob);
    }
  }

  // ── Build conditionId → trigger data map ─────────────────────
  const conditionToTrigger = new Map<string, any>();
  for (const t of triggerData) {
    if (t.slug && !conditionToTrigger.has(t.slug)) {
      conditionToTrigger.set(t.slug, t);
    }
  }

  // ── Analyze closed positions ──────────────────────────────────
  console.log('\n═══ CLOSED POSITIONS ═══\n');

  const wins = closedPositions.filter(p => (p.realizedPnl || 0) > 0);
  const losses = closedPositions.filter(p => (p.realizedPnl || 0) <= 0);
  const totalPnl = closedPositions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
  const totalBought = closedPositions.reduce((s, p) => s + (p.totalBought || 0), 0);

  console.log(`  Total closed: ${closedPositions.length} | Wins: ${wins.length} | Losses: ${losses.length}`);
  console.log(`  Win rate:     ${closedPositions.length > 0 ? ((wins.length / closedPositions.length) * 100).toFixed(1) : 0}%`);
  console.log(`  Total PnL:    $${totalPnl.toFixed(2)}`);
  console.log(`  Total bought: $${totalBought.toFixed(2)}`);
  console.log(`  ROI:          ${totalBought > 0 ? ((totalPnl / totalBought) * 100).toFixed(1) : 0}%`);

  // ── Per-trade breakdown with delta cross-reference ────────────
  console.log('\n═══ TRADE BREAKDOWN (with delta context) ═══\n');
  console.log(`  ${'W/L'.padEnd(3)} | ${'PnL'.padEnd(8)} | ${'Bought'.padEnd(8)} | ${'Price'.padEnd(6)} | ${'Delta'.padEnd(8)} | ${'Secs'.padEnd(5)} | Outcome | Market`);
  console.log(`  ${'-'.repeat(90)}`);

  const enriched: any[] = [];
  for (const p of closedPositions) {
    const won = (p.realizedPnl || 0) > 0;
    const slug = conditionToSlug.get(p.conditionId) || null;
    const ob = slug ? slugToOb.get(slug) : null;
    const trigger = slug ? conditionToTrigger.get(slug) : null;

    const delta = trigger?.absDelta ?? ob?.absDelta ?? null;
    const secs = trigger?.secsBeforeClose ?? null;
    const fillPrice = p.avgPrice || 0;

    const icon = won ? '✅' : '❌';
    const pnlStr = `$${(p.realizedPnl || 0) >= 0 ? '+' : ''}${(p.realizedPnl || 0).toFixed(2)}`;
    const boughtStr = `$${(p.totalBought || 0).toFixed(2)}`;
    const priceStr = `${(fillPrice * 100).toFixed(0)}c`;
    const deltaStr = delta !== null ? delta.toFixed(0) : '?';
    const secsStr = secs !== null ? String(secs) : '?';
    const title = (p.title || '?').slice(-30);

    console.log(`  ${icon}  | ${pnlStr.padEnd(8)} | ${boughtStr.padEnd(8)} | ${priceStr.padEnd(6)} | Δ${deltaStr.padEnd(7)} | ${secsStr.padEnd(5)} | ${(p.outcome || '?').padEnd(7)} | ${title}`);
    enriched.push({ ...p, won, delta, secs, slug, ob });
  }

  // ── Price bracket analysis ────────────────────────────────────
  console.log('\n═══ FILL PRICE BREAKDOWN ═══');
  const priceBuckets = [
    { label: '85-89c', min: 0.85, max: 0.90 },
    { label: '90-94c', min: 0.90, max: 0.95 },
    { label: '95-97c', min: 0.95, max: 0.98 },
    { label: '97-99c', min: 0.98, max: 1.00 },
  ];
  for (const b of priceBuckets) {
    const bucket = enriched.filter(p => p.avgPrice >= b.min && p.avgPrice < b.max);
    if (bucket.length === 0) continue;
    const bWins = bucket.filter(p => p.won).length;
    const bPnl = bucket.reduce((s, p) => s + (p.realizedPnl || 0), 0);
    console.log(`  ${b.label}: ${bucket.length} trades | ${bWins}W/${bucket.length - bWins}L | WR=${((bWins/bucket.length)*100).toFixed(0)}% | PnL=$${bPnl.toFixed(2)}`);
  }

  // ── Delta analysis on matched trades ─────────────────────────
  const withDelta = enriched.filter(p => p.delta !== null);
  if (withDelta.length > 0) {
    console.log(`\n═══ DELTA ANALYSIS (${withDelta.length}/${enriched.length} trades matched to orderbook) ═══`);
    const deltaBuckets = [
      { label: '0-30', min: 0, max: 30 },
      { label: '30-60', min: 30, max: 60 },
      { label: '60-100', min: 60, max: 100 },
      { label: '100-200', min: 100, max: 200 },
      { label: '200+', min: 200, max: Infinity },
    ];
    for (const b of deltaBuckets) {
      const bucket = withDelta.filter(p => p.delta >= b.min && p.delta < b.max);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(p => p.won).length;
      const bPnl = bucket.reduce((s, p) => s + (p.realizedPnl || 0), 0);
      console.log(`  Δ${b.label.padEnd(8)}: ${bucket.length} trades | ${bWins}W/${bucket.length-bWins}L | WR=${((bWins/bucket.length)*100).toFixed(0)}% | PnL=$${bPnl.toFixed(2)}`);
    }
  }

  // ── Activity breakdown (individual buys) ─────────────────────
  if (activity.length > 0) {
    console.log(`\n═══ BUY ACTIVITY (${activity.length} events) ═══`);
    console.log(`  ${'Time (UTC)'.padEnd(20)} | ${'Price'.padEnd(6)} | ${'Shares'.padEnd(8)} | ${'USDC'.padEnd(8)} | Side | Market`);
    console.log(`  ${'-'.repeat(75)}`);
    for (const a of activity.slice(0, 30)) {
      const time = new Date((a.timestamp || 0) * 1000).toISOString().slice(11, 19);
      const price = `${((a.price || 0) * 100).toFixed(0)}c`;
      const shares = (a.size || 0).toFixed(2);
      const usdc = `$${(a.usdcSize || 0).toFixed(2)}`;
      const side = a.outcome || '?';
      const title = (a.title || '?').slice(-30);
      console.log(`  ${time.padEnd(20)} | ${price.padEnd(6)} | ${shares.padEnd(8)} | ${usdc.padEnd(8)} | ${side.padEnd(4)} | ${title}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                              ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Trades:  ${closedPositions.length} closed | ${wins.length}W / ${losses.length}L | WR: ${closedPositions.length > 0 ? ((wins.length/closedPositions.length)*100).toFixed(1) : 0}%`);
  console.log(`  PnL:     $${totalPnl.toFixed(2)} on $${totalBought.toFixed(2)} deployed`);
  if (wins.length > 0) console.log(`  Avg win PnL:   +$${(wins.reduce((s,p) => s+(p.realizedPnl||0), 0)/wins.length).toFixed(2)}`);
  if (losses.length > 0) console.log(`  Avg loss PnL:  -$${Math.abs(losses.reduce((s,p) => s+(p.realizedPnl||0), 0)/losses.length).toFixed(2)}`);
  if (withDelta.length > 0) {
    const avgDelta = withDelta.reduce((s,p) => s+p.delta, 0) / withDelta.length;
    console.log(`  Avg delta at entry: ${avgDelta.toFixed(0)} pts`);
  }
  console.log('');

  await client.close();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
