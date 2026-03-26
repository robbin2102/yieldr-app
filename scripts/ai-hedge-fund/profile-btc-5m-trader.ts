/**
 * BTC 5-Minute Market Trader Profiler (v3)
 *
 * Analyzes strategy archetypes for traders in BTC 5-minute markets.
 * Detects: SNIPER, LATE_MOMENTUM, EARLY_MOMENTUM, CONTRARIAN, LOTTERY, SCALPER, HEDGER
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/profile-btc-5m-trader.ts <wallet> [days]
 *
 * Exports profileBtc5mTrader() for use by bulk-profile-btc-5m.ts
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, Db } from 'mongodb';

// ── Env loading (same as v2) ──────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (result.parsed && result.parsed.MONGODB_URI) break;
}

const API_BASE = 'https://data-api.polymarket.com';

// ── Types ─────────────────────────────────────────────────────
interface Activity {
  conditionId: string;
  type: string;       // TRADE | REDEEM
  side?: string;      // BUY | SELL
  usdcSize: number;
  price: number;      // 0-1
  timestamp: number;
  title: string;
}

interface ClosedPosition {
  conditionId: string;
  title: string;
  realizedPnl: number;
  avgPrice: number;
  totalBought: number;
  totalSold: number;
  timestamp: number;
}

interface Market5m {
  conditionId: string;
  endDate: Date;
  priceToBeat: number;
  slug: string;
}

interface EntryBucket {
  bucket: string;
  count: number;
  totalUsdc: number;
  avgPrice: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  usdcWeightedPnl: number;
}

interface TimeToResBucket {
  bucket: string;
  count: number;
  totalUsdc: number;
  winRate: number;
  avgPnl: number;
}

interface DailySession {
  date: string;
  pnl: number;
  trades: number;
  wins: number;
  losses: number;
}

// ── API Fetchers ──────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const periodStartTs = now - (days * 24 * 60 * 60);
  const LIMIT = 500;
  const MAX_OFFSET = 3000;

  let all: Activity[] = [];
  let currentEndTs = now;
  let cursorRound = 0;

  while (currentEndTs > periodStartTs && cursorRound < 20) {
    let offset = 0;
    let done = false;
    let batchCollected = 0;

    while (!done && offset <= MAX_OFFSET) {
      const url = `${API_BASE}/activity?user=${wallet}&limit=${LIMIT}&offset=${offset}&startTs=${periodStartTs}&endTs=${currentEndTs}&sortBy=TIMESTAMP&sortDirection=DESC`;
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 400 && batchCollected > 0) { done = true; break; }
        if (res.status === 400 && all.length > 0) return all;
        throw new Error(`API error: ${res.status}`);
      }
      const batch = await res.json() as Activity[];
      if (batch.length === 0) { done = true; break; }

      for (const a of batch) {
        if (a.timestamp >= periodStartTs) { all.push(a); batchCollected++; }
        else { done = true; break; }
      }
      if (batch.length < LIMIT) { done = true; break; }
      offset += LIMIT;
      await sleep(100);
    }

    if (!done && all.length > 0) {
      const oldestTs = all[all.length - 1].timestamp;
      if (oldestTs >= currentEndTs) break;
      currentEndTs = oldestTs - 1;
      cursorRound++;
    } else break;
  }
  return all;
}

async function fetchClosedPositions(wallet: string, limit: number = 1000): Promise<ClosedPosition[]> {
  const LIMIT = 50;
  let all: ClosedPosition[] = [];
  let offset = 0;

  while (all.length < limit) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 400 && all.length > 0) break;
      throw new Error(`API error: ${res.status}`);
    }
    const batch = await res.json() as ClosedPosition[];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < LIMIT || all.length >= limit) break;
    offset += LIMIT;
    await sleep(100);
  }
  return all.slice(0, limit);
}

// ── Analysis Functions ────────────────────────────────────────

function bucketPrice(price: number): string {
  if (price < 0.10) return '0_10c';
  if (price < 0.25) return '10_25c';
  if (price < 0.50) return '25_50c';
  if (price < 0.65) return '50_65c';
  if (price < 0.85) return '65_85c';
  return '85c_plus';
}

function bucketTimeToRes(seconds: number): string {
  if (seconds < 30) return '<30s';
  if (seconds < 60) return '30s-1m';
  if (seconds < 120) return '1-2m';
  if (seconds < 180) return '2-3m';
  return '3-5m';
}

function computeEntryBuckets(
  buyActivities: Activity[],
  closedByCondition: Map<string, ClosedPosition>
): EntryBucket[] {
  const buckets = new Map<string, {
    count: number; totalUsdc: number; priceSum: number;
    wins: number; losses: number; totalPnl: number; usdcWeightedPnl: number;
    seenConditions: Set<string>;
  }>();

  for (const a of buyActivities) {
    const b = bucketPrice(a.price);
    const entry = buckets.get(b) ?? { count: 0, totalUsdc: 0, priceSum: 0, wins: 0, losses: 0, totalPnl: 0, usdcWeightedPnl: 0, seenConditions: new Set() };
    entry.count++;
    entry.totalUsdc += a.usdcSize;
    entry.priceSum += a.price * a.usdcSize;

    // Only count PnL/win/loss ONCE per conditionId per bucket (avoid double-counting)
    const closed = closedByCondition.get(a.conditionId);
    if (closed && !entry.seenConditions.has(a.conditionId)) {
      entry.seenConditions.add(a.conditionId);
      if (closed.realizedPnl >= 0) entry.wins++;
      else entry.losses++;
      entry.totalPnl += closed.realizedPnl;
    }
    // USDC-weighted PnL is per-trade (not per-market) — intentional
    if (closed) {
      entry.usdcWeightedPnl += a.usdcSize * (closed.realizedPnl / Math.max(closed.totalBought, 1));
    }
    buckets.set(b, entry);
  }

  const order = ['0_10c', '10_25c', '25_50c', '50_65c', '65_85c', '85c_plus'];
  return order.map(bucket => {
    const e = buckets.get(bucket);
    if (!e) return { bucket, count: 0, totalUsdc: 0, avgPrice: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, usdcWeightedPnl: 0 };
    return {
      bucket,
      count: e.count,
      totalUsdc: e.totalUsdc,
      avgPrice: e.totalUsdc > 0 ? e.priceSum / e.totalUsdc : 0,
      wins: e.wins,
      losses: e.losses,
      winRate: (e.wins + e.losses) > 0 ? (e.wins / (e.wins + e.losses)) * 100 : 0,
      totalPnl: e.totalPnl,
      usdcWeightedPnl: e.usdcWeightedPnl,
    };
  });
}

function computeTimeToResBuckets(
  buyActivities: Activity[],
  marketLookup: Map<string, Market5m>,
  closedByCondition: Map<string, ClosedPosition>
): TimeToResBucket[] {
  const buckets = new Map<string, { count: number; totalUsdc: number; wins: number; losses: number; pnlSum: number; seenConditions: Set<string> }>();

  for (const a of buyActivities) {
    const market = marketLookup.get(a.conditionId);
    if (!market) continue;
    const resTime = market.endDate.getTime() / 1000;
    const secsBefore = resTime - a.timestamp;
    if (secsBefore < 0 || secsBefore > 600) continue;

    const b = bucketTimeToRes(secsBefore);
    const entry = buckets.get(b) ?? { count: 0, totalUsdc: 0, wins: 0, losses: 0, pnlSum: 0, seenConditions: new Set() };
    entry.count++;
    entry.totalUsdc += a.usdcSize;

    const closed = closedByCondition.get(a.conditionId);
    if (closed && !entry.seenConditions.has(a.conditionId)) {
      entry.seenConditions.add(a.conditionId);
      if (closed.realizedPnl >= 0) entry.wins++;
      else entry.losses++;
      entry.pnlSum += closed.realizedPnl;
    }
    buckets.set(b, entry);
  }

  const order = ['<30s', '30s-1m', '1-2m', '2-3m', '3-5m'];
  return order.map(bucket => {
    const e = buckets.get(bucket);
    if (!e) return { bucket, count: 0, totalUsdc: 0, winRate: 0, avgPnl: 0 };
    return {
      bucket,
      count: e.count,
      totalUsdc: e.totalUsdc,
      winRate: (e.wins + e.losses) > 0 ? (e.wins / (e.wins + e.losses)) * 100 : 0,
      avgPnl: e.count > 0 ? e.pnlSum / e.count : 0,
    };
  });
}

function computeSessionPnl(
  activities: Activity[],
  closedByCondition: Map<string, ClosedPosition>
): DailySession[] {
  const days = new Map<string, { pnl: number; trades: number; wins: number; losses: number }>();

  // Use closed positions grouped by day of activity
  const seenConditions = new Set<string>();
  for (const a of activities) {
    if (a.type !== 'TRADE' || a.side !== 'BUY') continue;
    if (seenConditions.has(a.conditionId)) continue;
    seenConditions.add(a.conditionId);

    const date = new Date(a.timestamp * 1000).toISOString().split('T')[0];
    const entry = days.get(date) ?? { pnl: 0, trades: 0, wins: 0, losses: 0 };
    entry.trades++;

    const closed = closedByCondition.get(a.conditionId);
    if (closed) {
      entry.pnl += closed.realizedPnl;
      if (closed.realizedPnl >= 0) entry.wins++;
      else entry.losses++;
    }
    days.set(date, entry);
  }

  return Array.from(days.entries())
    .map(([date, d]) => ({ date, ...d }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function detectHedgerPositions(activities: Activity[]): { count: number; avgCombinedCost: number } {
  // Group buys by conditionId, check if trader bought at both high and low prices
  // (proxy for buying both YES and NO outcomes)
  const byCondition = new Map<string, { prices: number[]; usdcSizes: number[] }>();

  for (const a of activities) {
    if (a.type !== 'TRADE' || a.side !== 'BUY') continue;
    const entry = byCondition.get(a.conditionId) ?? { prices: [], usdcSizes: [] };
    entry.prices.push(a.price);
    entry.usdcSizes.push(a.usdcSize);
    byCondition.set(a.conditionId, entry);
  }

  let hedgeCount = 0;
  let totalCombinedCost = 0;

  for (const [, data] of byCondition) {
    if (data.prices.length < 2) continue;
    const minPrice = Math.min(...data.prices);
    const maxPrice = Math.max(...data.prices);
    // If they bought at both a low price (<0.40) and high price (>0.60),
    // and combined cost < 0.85, it's likely a hedge/arb
    if (minPrice < 0.40 && maxPrice > 0.60) {
      const combinedCost = minPrice + (1 - maxPrice); // approximate both-sides cost
      if (combinedCost < 0.85) {
        hedgeCount++;
        totalCombinedCost += combinedCost;
      }
    }
  }

  return {
    count: hedgeCount,
    avgCombinedCost: hedgeCount > 0 ? totalCombinedCost / hedgeCount : 0,
  };
}

function detectAdverseMovement(activities: Activity[]): { count: number; rate: number; avgLoss: number } {
  // Trader buys then sells on same conditionId = price moved against them
  const buysByCondition = new Map<string, boolean>();
  const sellsAfterBuy: { conditionId: string; sellUsdc: number }[] = [];

  for (const a of activities) {
    if (a.type === 'TRADE' && a.side === 'BUY') {
      buysByCondition.set(a.conditionId, true);
    }
    if (a.type === 'TRADE' && a.side === 'SELL' && buysByCondition.has(a.conditionId)) {
      sellsAfterBuy.push({ conditionId: a.conditionId, sellUsdc: a.usdcSize });
    }
  }

  const totalPositions = buysByCondition.size;
  const adverseCount = new Set(sellsAfterBuy.map(s => s.conditionId)).size;

  return {
    count: adverseCount,
    rate: totalPositions > 0 ? (adverseCount / totalPositions) * 100 : 0,
    avgLoss: sellsAfterBuy.length > 0
      ? sellsAfterBuy.reduce((s, e) => s + e.sellUsdc, 0) / sellsAfterBuy.length
      : 0,
  };
}

function classifyArchetype(metrics: {
  avgEntryPrice: number;
  winRate: number;
  redeemRatio: number;
  sellRatio: number;
  tradesPerDay: number;
  avgPayoutOnWin: number;
  hedgerPositions: number;
  avgCombinedCost: number;
  avgHoldSeconds: number;
  bothSidesRatio: number;      // % of markets where trader bought both Up and Down
  directionalAccuracy: number; // % of markets where larger-USDC side won
  tradesPerCycle: number;      // avg trades per 5m market
}): { primary: string; secondary: string | null; confidence: number } {
  const scores: Record<string, number> = {
    SNIPER: 0, LATE_MOMENTUM: 0, EARLY_MOMENTUM: 0,
    CONTRARIAN: 0, LOTTERY: 0, SCALPER: 0, HEDGER: 0,
    MOMENTUM_HEDGER: 0,
  };

  // SNIPER: high entry, high WR, holds to resolution
  if (metrics.avgEntryPrice > 0.85) scores.SNIPER += 3;
  else if (metrics.avgEntryPrice > 0.80) scores.SNIPER += 1;
  if (metrics.winRate > 90) scores.SNIPER += 2;
  else if (metrics.winRate > 80) scores.SNIPER += 1;
  if (metrics.redeemRatio > 0.8) scores.SNIPER += 1;

  // LATE_MOMENTUM: 65-85c entry, mixed exit, active
  if (metrics.avgEntryPrice >= 0.65 && metrics.avgEntryPrice < 0.85) scores.LATE_MOMENTUM += 3;
  if (metrics.redeemRatio > 0.5 && metrics.redeemRatio < 0.8) scores.LATE_MOMENTUM += 1;
  if (metrics.tradesPerDay > 10) scores.LATE_MOMENTUM += 1;

  // EARLY_MOMENTUM: 50-65c entry
  if (metrics.avgEntryPrice >= 0.50 && metrics.avgEntryPrice < 0.65) scores.EARLY_MOMENTUM += 3;
  if (metrics.sellRatio > 0.2 && metrics.sellRatio < 0.5) scores.EARLY_MOMENTUM += 1;

  // CONTRARIAN: low entry, high payout when winning
  if (metrics.avgEntryPrice < 0.45) scores.CONTRARIAN += 2;
  if (metrics.avgEntryPrice < 0.30) scores.CONTRARIAN += 1;
  if (metrics.avgPayoutOnWin > 2) scores.CONTRARIAN += 2;
  if (metrics.redeemRatio > 0.7) scores.CONTRARIAN += 1;

  // LOTTERY: very low entry, low WR
  if (metrics.avgEntryPrice < 0.15) scores.LOTTERY += 3;
  if (metrics.winRate < 20) scores.LOTTERY += 2;

  // SCALPER: high sell ratio, short holds
  if (metrics.sellRatio > 0.5) scores.SCALPER += 3;
  if (metrics.avgHoldSeconds < 120 && metrics.avgHoldSeconds > 0) scores.SCALPER += 2;

  // HEDGER: pure arb — buys both sides below $1 combined
  if (metrics.hedgerPositions >= 3 && metrics.avgCombinedCost < 0.95) scores.HEDGER += 4;
  if (metrics.hedgerPositions >= 1 && metrics.avgCombinedCost < 0.90) scores.HEDGER += 2;

  // MOMENTUM_HEDGER: buys both sides but bets MORE on the directional side
  // Key signals: high both-sides ratio, directional accuracy >55%, combined cost ~100c+
  if (metrics.bothSidesRatio > 0.7) scores.MOMENTUM_HEDGER += 2;
  if (metrics.directionalAccuracy > 60) scores.MOMENTUM_HEDGER += 2;
  else if (metrics.directionalAccuracy > 55) scores.MOMENTUM_HEDGER += 1;
  if (metrics.avgCombinedCost > 0.95 && metrics.bothSidesRatio > 0.5) scores.MOMENTUM_HEDGER += 2; // paying ~$1 combined = not arb, directional
  if (metrics.tradesPerCycle > 10) scores.MOMENTUM_HEDGER += 1; // sweeps the book

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const primary = sorted[0][1] > 0 ? sorted[0][0] : 'MIXED';
  const secondary = sorted[1][1] >= 2 ? sorted[1][0] : null;
  const maxScore = Math.max(...Object.values(scores));
  const confidence = maxScore > 0 ? Math.min(maxScore / 6, 1) : 0;

  return { primary, secondary, confidence };
}

// ── Title Parser ──────────────────────────────────────────────
// Parses resolution time from titles like:
//   "Bitcoin Up or Down - March 25, 10:05AM-10:10AM ET"
//   "Bitcoin Up or Down - January 15, 5PM ET"
//   "Bitcoin Up or Down on March 25?"
function parseResolutionTimeFromTitle(title: string): Date | null {
  try {
    // Normalize time: "4:55AM" → "4:55 AM" (Node.js Date needs space before AM/PM)
    const normalize = (t: string) => t.replace(/(\d)(AM|PM)/i, '$1 $2');

    // Pattern: "Month DD, H:MMAM-H:MMAM ET" — use the end time
    const rangeMatch = title.match(/(\w+ \d+),?\s+(\d{1,2}(?::\d{2})?[AP]M)\s*-\s*(\d{1,2}(?::\d{2})?[AP]M)\s*ET/i);
    if (rangeMatch) {
      const [, datePart, , endTime] = rangeMatch;
      const year = new Date().getFullYear();
      const parsed = new Date(`${datePart} ${year} ${normalize(endTime)} EST`);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    // Pattern: "Month DD, HPM ET" — single time (hourly market)
    const singleMatch = title.match(/(\w+ \d+),?\s+(\d{1,2}(?::\d{2})?[AP]M)\s*ET/i);
    if (singleMatch) {
      const [, datePart, time] = singleMatch;
      const year = new Date().getFullYear();
      const parsed = new Date(`${datePart} ${year} ${normalize(time)} EST`);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Core Profiler ─────────────────────────────────────────────

export async function profileBtc5mTrader(
  wallet: string,
  options: { periodDays?: number; verbose?: boolean; db?: Db } = {}
): Promise<Record<string, unknown>> {
  const { periodDays = 14, verbose = true } = options;
  const cleanWallet = wallet.toLowerCase();
  const profiledAt = new Date();

  // Get DB connection
  let db = options.db;
  let localClient: MongoClient | null = null;
  if (!db) {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGODB_URI not set');
    const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'polymarket-test'; } catch { return 'polymarket-test'; } })();
    localClient = new MongoClient(mongoUri);
    await localClient.connect();
    db = localClient.db(dbName);
  }

  try {
    // Load BTC 5m market conditionIds from DB
    if (verbose) console.log('Loading BTC 5m market data...');
    const markets5m = await db.collection('polyMarket5m').find({}).toArray();
    const conditionIdSet = new Set(markets5m.map(m => m.conditionId as string));
    const marketLookup = new Map<string, Market5m>();
    for (const m of markets5m) {
      marketLookup.set(m.conditionId, {
        conditionId: m.conditionId,
        endDate: new Date(m.endDate),
        priceToBeat: m.priceToBeat ?? 0,
        slug: m.slug,
      });
    }
    if (verbose) console.log(`  ${markets5m.length} markets from DB`);

    // Fetch closed positions FIRST — they have titles we can use to detect BTC 5m markets
    if (verbose) console.log('\nFetching closed positions...');
    const allClosed = await fetchClosedPositions(cleanWallet, 2000);
    if (verbose) console.log(`  ${allClosed.length} total closed positions`);

    // Detect BTC 5m conditionIds from closed position titles
    const btc5mPattern = /bitcoin up or down/i;
    const closedPositions: ClosedPosition[] = [];
    let titleParseSuccess = 0;
    let titleParseFail = 0;
    const sampleTitles: string[] = [];
    for (const c of allClosed) {
      if (conditionIdSet.has(c.conditionId) || btc5mPattern.test(c.title)) {
        closedPositions.push(c);
        conditionIdSet.add(c.conditionId);
        if (sampleTitles.length < 5) sampleTitles.push(c.title);
        // Parse resolution time from title if not in DB
        if (!marketLookup.has(c.conditionId)) {
          const endDate = parseResolutionTimeFromTitle(c.title);
          if (endDate) {
            titleParseSuccess++;
            marketLookup.set(c.conditionId, {
              conditionId: c.conditionId, endDate, priceToBeat: 0, slug: '',
            });
          } else {
            titleParseFail++;
          }
        }
      }
    }
    if (verbose) {
      console.log(`  ${closedPositions.length} BTC 5m closed positions (${conditionIdSet.size} unique markets detected)`);
      console.log(`  Title parsing: ${titleParseSuccess} success, ${titleParseFail} failed, ${marketLookup.size} total in lookup`);
      if (sampleTitles.length > 0) {
        console.log(`  Sample titles:`);
        sampleTitles.forEach(t => console.log(`    "${t}"`));
      }
    }

    // Now fetch activities and filter using the conditionId set built from closed positions
    if (verbose) console.log(`\nFetching activities (${periodDays}d)...`);
    const allActivities = await fetchActivities(cleanWallet, periodDays);
    if (verbose) console.log(`  ${allActivities.length} total activities`);

    const activities = allActivities.filter(a => conditionIdSet.has(a.conditionId));
    if (verbose) console.log(`  ${activities.length} BTC 5m activities\n`);

    // Build lookups
    const closedByCondition = new Map<string, ClosedPosition>();
    for (const c of closedPositions) closedByCondition.set(c.conditionId, c);

    // Filter buy/sell/redeem activities
    const buyActivities = activities.filter(a => a.type === 'TRADE' && a.side === 'BUY');
    const sellActivities = activities.filter(a => a.type === 'TRADE' && a.side === 'SELL');
    const redeemActivities = activities.filter(a => a.type === 'REDEEM');

    // ── Overall Stats ──────────────────────────────────
    const totalTrades = buyActivities.length + sellActivities.length;
    const totalUsdc = buyActivities.reduce((s, a) => s + a.usdcSize, 0);
    const totalPnl = closedPositions.reduce((s, c) => s + c.realizedPnl, 0);
    const totalWinPnl = closedPositions.filter(c => c.realizedPnl > 0).reduce((s, c) => s + c.realizedPnl, 0);
    const totalLossPnl = closedPositions.filter(c => c.realizedPnl < 0).reduce((s, c) => s + Math.abs(c.realizedPnl), 0);
    const wins = closedPositions.filter(c => c.realizedPnl >= 0).length;
    const losses = closedPositions.filter(c => c.realizedPnl < 0).length;
    const winRate = (wins + losses) > 0 ? (wins / (wins + losses)) * 100 : 0;
    const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : 0;
    const tradeSizes = buyActivities.map(a => a.usdcSize).sort((a, b) => a - b);
    const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
    const medianTradeSize = tradeSizes.length > 0 ? tradeSizes[Math.floor(tradeSizes.length / 2)] : 0;
    const pnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const avgEntryPrice = buyActivities.length > 0
      ? buyActivities.reduce((s, a) => s + a.price * a.usdcSize, 0) / totalUsdc
      : 0;
    const avgPayoutOnWin = wins > 0 ? totalWinPnl / wins : 0;

    // ── Period info ────────────────────────────────────
    const timestamps = activities.map(a => a.timestamp);
    const periodStart = timestamps.length > 0 ? new Date(Math.min(...timestamps) * 1000) : null;
    const periodEnd = timestamps.length > 0 ? new Date(Math.max(...timestamps) * 1000) : null;
    const activeDays = periodStart && periodEnd
      ? Math.max(1, Math.ceil((periodEnd.getTime() - periodStart.getTime()) / 86400000))
      : 0;
    const tradesPerDay = activeDays > 0 ? totalTrades / activeDays : 0;

    // ── Entry Buckets (USDC-weighted) ──────────────────
    const entryBuckets = computeEntryBuckets(buyActivities, closedByCondition);

    // ── Exit Analysis ──────────────────────────────────
    const sellCount = sellActivities.length;
    const redeemCount = redeemActivities.length;
    const sellRatio = (sellCount + redeemCount) > 0 ? sellCount / (sellCount + redeemCount) : 0;
    const redeemRatio = 1 - sellRatio;
    const uniqueBuyConditions = new Set(buyActivities.map(a => a.conditionId)).size;
    const soldConditions = new Set(sellActivities.map(a => a.conditionId)).size;
    const earlyExitRate = uniqueBuyConditions > 0 ? (soldConditions / uniqueBuyConditions) * 100 : 0;

    // ── Time-to-Resolution ─────────────────────────────
    const timeToResBuckets = computeTimeToResBuckets(buyActivities, marketLookup, closedByCondition);

    // Average hold duration (buy → resolution)
    let holdSecondsSum = 0;
    let holdCount = 0;
    for (const a of buyActivities) {
      const m = marketLookup.get(a.conditionId);
      if (m) {
        const secs = (m.endDate.getTime() / 1000) - a.timestamp;
        if (secs > 0 && secs < 600) { holdSecondsSum += secs; holdCount++; }
      }
    }
    const avgHoldSeconds = holdCount > 0 ? holdSecondsSum / holdCount : 0;

    // ── Selectivity ────────────────────────────────────
    const cyclesTraded = new Set(activities.map(a => a.conditionId)).size;
    const cyclesAvailable = markets5m.length;
    const selectivityRatio = cyclesAvailable > 0 ? cyclesTraded / cyclesAvailable : 0;

    // ── Session PnL ────────────────────────────────────
    const dailySessions = computeSessionPnl(activities, closedByCondition);
    const profitableDays = dailySessions.filter(d => d.pnl > 0).length;
    const losingDays = dailySessions.filter(d => d.pnl < 0).length;
    const bestDay = dailySessions.length > 0 ? dailySessions.reduce((b, d) => d.pnl > b.pnl ? d : b) : { date: '', pnl: 0 };
    const worstDay = dailySessions.length > 0 ? dailySessions.reduce((w, d) => d.pnl < w.pnl ? d : w) : { date: '', pnl: 0 };

    // Max consecutive win/loss cycles
    let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
    const sortedConditions = [...closedByCondition.values()].sort((a, b) => a.timestamp - b.timestamp);
    for (const c of sortedConditions) {
      if (c.realizedPnl >= 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
      else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
    }

    // ── Hedger Detection ───────────────────────────────
    const hedger = detectHedgerPositions(activities);

    // ── Adverse Movement ───────────────────────────────
    const adverse = detectAdverseMovement(activities);

    // ── Both-Sides & Directional Analysis ───────────────
    // Group buys by conditionId+outcome to detect both-sides trading
    const marketSides = new Map<string, Map<string, number>>(); // conditionId → outcome → totalUsdc
    for (const a of buyActivities) {
      const sides = marketSides.get(a.conditionId) || new Map();
      sides.set(a.outcome || String(a.outcomeIndex), (sides.get(a.outcome || String(a.outcomeIndex)) || 0) + a.usdcSize);
      marketSides.set(a.conditionId, sides);
    }

    let bothSidesCount = 0;
    let directionalWins = 0;
    let directionalTotal = 0;
    let combinedCostSum = 0;
    let combinedCostCount = 0;

    for (const [cid, sides] of marketSides) {
      if (sides.size >= 2) {
        bothSidesCount++;
        // Find which side had more USDC
        const entries = [...sides.entries()].sort((a, b) => b[1] - a[1]);
        const favoredOutcome = entries[0][0];

        // Check if favored side won (from closed positions)
        const closedForMarket = closedPositions.filter(c => c.conditionId === cid);
        const favoredClosed = closedForMarket.find(c => (c.outcome || '') === favoredOutcome);
        if (favoredClosed) {
          directionalTotal++;
          if (favoredClosed.realizedPnl > 0) directionalWins++;
        }

        // Compute combined cost for this market
        const totalShares = new Map<string, number>();
        for (const a of buyActivities.filter(a2 => a2.conditionId === cid)) {
          const key = a.outcome || String(a.outcomeIndex);
          totalShares.set(key, (totalShares.get(key) || 0) + (a.usdcSize / Math.max(a.price, 0.001)));
        }
        const avgPrices = [...sides.entries()].map(([outcome, usdc]) => usdc / Math.max(totalShares.get(outcome) || 1, 0.001));
        if (avgPrices.length >= 2) {
          combinedCostSum += avgPrices.reduce((s, p) => s + p, 0);
          combinedCostCount++;
        }
      }
    }

    const uniqueMarkets = marketSides.size;
    const bothSidesRatio = uniqueMarkets > 0 ? bothSidesCount / uniqueMarkets : 0;
    const directionalAccuracy = directionalTotal > 0 ? (directionalWins / directionalTotal) * 100 : 0;
    const avgCombinedCostAll = combinedCostCount > 0 ? combinedCostSum / combinedCostCount : 0;
    const tradesPerCycle = uniqueMarkets > 0 ? buyActivities.length / uniqueMarkets : 0;

    // ── Strategy Classification ────────────────────────
    const archetype = classifyArchetype({
      avgEntryPrice, winRate, redeemRatio, sellRatio, tradesPerDay,
      avgPayoutOnWin, hedgerPositions: hedger.count, avgCombinedCost: hedger.avgCombinedCost,
      avgHoldSeconds, bothSidesRatio, directionalAccuracy, tradesPerCycle,
    });

    // ── Top Markets ────────────────────────────────────
    const sortedByPnl = [...closedByCondition.values()].sort((a, b) => b.realizedPnl - a.realizedPnl);
    const topWinning = sortedByPnl.slice(0, 5).map(c => ({
      conditionId: c.conditionId, title: c.title || '', pnl: c.realizedPnl, entryPrice: c.avgPrice,
    }));
    const topLosing = sortedByPnl.slice(-5).reverse().map(c => ({
      conditionId: c.conditionId, title: c.title || '', pnl: c.realizedPnl, entryPrice: c.avgPrice,
    }));

    // ── Console Output ─────────────────────────────────
    if (verbose) {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('              BTC 5m TRADER PROFILER v3                        ');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log(`Wallet:     ${cleanWallet}`);
      console.log(`Period:     ${periodStart?.toISOString().split('T')[0] ?? '?'} to ${periodEnd?.toISOString().split('T')[0] ?? '?'} (${activeDays}d)`);
      console.log(`Archetype:  ${archetype.primary}${archetype.secondary ? ' / ' + archetype.secondary : ''} (${(archetype.confidence * 100).toFixed(0)}% confidence)`);
      console.log('');
      console.log(`Total Trades:    ${totalTrades} (${tradesPerDay.toFixed(1)}/day)`);
      console.log(`Total USDC:      $${totalUsdc.toFixed(0)}`);
      console.log(`Total PnL:       $${totalPnl.toFixed(2)}`);
      console.log(`Win Rate:        ${winRate.toFixed(1)}% (${wins}W / ${losses}L)`);
      console.log(`Profit Factor:   ${profitFactor.toFixed(2)}`);
      console.log(`Avg Entry Price: ${(avgEntryPrice * 100).toFixed(1)}c`);
      console.log(`PnL/Trade:       $${pnlPerTrade.toFixed(2)}`);
      console.log(`Avg Hold:        ${avgHoldSeconds.toFixed(0)}s`);
      console.log('');
      console.log('── Entry Price Buckets (USDC-weighted) ──');
      for (const b of entryBuckets) {
        if (b.count === 0) continue;
        console.log(`  ${b.bucket.padEnd(10)} ${b.count.toString().padStart(5)} trades | $${b.totalUsdc.toFixed(0).padStart(10)} | WR ${b.winRate.toFixed(0).padStart(3)}% | PnL $${b.totalPnl.toFixed(0).padStart(10)}`);
      }
      console.log('');
      console.log('── Time-to-Resolution ──');
      for (const b of timeToResBuckets) {
        if (b.count === 0) continue;
        console.log(`  ${b.bucket.padEnd(8)} ${b.count.toString().padStart(5)} trades | $${b.totalUsdc.toFixed(0).padStart(10)} | WR ${b.winRate.toFixed(0).padStart(3)}% | avgPnl $${b.avgPnl.toFixed(2)}`);
      }
      console.log('');
      console.log(`── Exit: sell ${sellCount} / redeem ${redeemCount} (sellRatio: ${(sellRatio * 100).toFixed(0)}%) | earlyExit: ${earlyExitRate.toFixed(0)}%`);
      console.log(`── Selectivity: ${cyclesTraded}/${cyclesAvailable} cycles (${(selectivityRatio * 100).toFixed(1)}%)`);
      console.log(`── Streaks: ${maxWinStreak} max wins / ${maxLossStreak} max losses`);
      console.log(`── Days: ${profitableDays} profitable / ${losingDays} losing | best $${bestDay.pnl.toFixed(0)} | worst $${worstDay.pnl.toFixed(0)}`);
      console.log(`── Both sides: ${bothSidesCount}/${uniqueMarkets} markets (${(bothSidesRatio * 100).toFixed(0)}%) | combined cost avg ${(avgCombinedCostAll * 100).toFixed(1)}c`);
      console.log(`── Directional accuracy: ${directionalWins}/${directionalTotal} (${directionalAccuracy.toFixed(0)}%) — larger-USDC side won`);
      console.log(`── Trades/cycle: ${tradesPerCycle.toFixed(0)} avg`);
      console.log(`── Hedger: ${hedger.count} positions (avg cost ${hedger.avgCombinedCost.toFixed(2)})`);
      console.log(`── Adverse exits: ${adverse.count} (${adverse.rate.toFixed(0)}%)`);
      console.log('═══════════════════════════════════════════════════════════════\n');
    }

    // ── Build Profile Document ─────────────────────────
    const profile = {
      wallet: cleanWallet,
      profiledAt,
      periodStart,
      periodEnd,
      periodDays,
      activeDays,

      totalTrades, totalUsdc, totalPnl, winRate, profitFactor,
      avgTradeSize, medianTradeSize, pnlPerTrade, avgEntryPrice,

      primaryArchetype: archetype.primary,
      secondaryArchetype: archetype.secondary,
      archetypeConfidence: archetype.confidence,

      entryBuckets,

      sellCount, redeemCount, sellRatio, redeemRatio, earlyExitRate,

      timeToResBuckets,
      avgHoldSeconds,

      cyclesTraded, cyclesAvailable, selectivityRatio, tradesPerDay,

      dailySessions,
      maxConsecutiveWinCycles: maxWinStreak,
      maxConsecutiveLossCycles: maxLossStreak,
      bestDay: { date: bestDay.date, pnl: bestDay.pnl },
      worstDay: { date: worstDay.date, pnl: worstDay.pnl },
      profitableDays, losingDays,

      hedgerPositions: hedger.count,
      avgCombinedCost: hedger.avgCombinedCost,

      adverseExitCount: adverse.count,
      adverseExitRate: adverse.rate,
      avgAdverseLoss: adverse.avgLoss,

      bothSidesRatio,
      directionalAccuracy,
      avgCombinedCost: avgCombinedCostAll,
      tradesPerCycle,

      topWinningMarkets: topWinning,
      topLosingMarkets: topLosing,
    };

    return profile;
  } finally {
    if (localClient) await localClient.close();
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const wallet = process.argv[2];
  const periodDays = parseInt(process.argv[3] || '14');

  if (!wallet) {
    console.log('Usage: npx tsx scripts/ai-hedge-fund/profile-btc-5m-trader.ts <wallet> [days]');
    process.exit(1);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('ERROR: MONGODB_URI not set'); process.exit(1); }

  const dbName = (() => { try { return new URL(mongoUri).pathname.replace('/', '') || 'polymarket-test'; } catch { return 'polymarket-test'; } })();
  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);
  console.log(`Connected → db: ${dbName}`);

  const profile = await profileBtc5mTrader(wallet, { periodDays, verbose: true, db });

  const collection = db.collection('polyMarket5mTraderProfiles');
  await collection.createIndex({ wallet: 1 }, { unique: true });
  await collection.updateOne(
    { wallet: wallet.toLowerCase() },
    { $set: profile },
    { upsert: true }
  );
  console.log('Saved to polyMarket5mTraderProfiles');

  await client.close();
  console.log('Done.');
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
