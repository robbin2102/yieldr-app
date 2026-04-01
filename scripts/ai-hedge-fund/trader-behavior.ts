/**
 * AI Hedge Fund — Trader Behavior Analysis
 *
 * Pulls behavioral metrics from polymarket-traderProfiles for a target set of wallets.
 * Designed to inform copy trade system design decisions.
 *
 * Shows per-trader:
 *   - Activity breakdown (buy/sell/redeem/other %)
 *   - Bet sizing (avg/median/max)
 *   - Strategy label + volume label
 *   - Hold behavior (sellRatio — do they exit early or hold to resolution?)
 *   - Avg daily bet count (buys only, not all activities)
 *
 * Usage:
 *   # All traders in ahf-edgeRankedTraders (most recent save)
 *   npx tsx scripts/ai-hedge-fund/trader-behavior.ts
 *
 *   # Specific wallets
 *   npx tsx scripts/ai-hedge-fund/trader-behavior.ts \
 *     --wallets=0xabc...,0xdef...
 *
 *   # Read wallets from ahf-edgeRankedTraders with same filters used in edge-ranked run
 *   npx tsx scripts/ai-hedge-fund/trader-behavior.ts --from-edge-pool
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent'),
];
for (const e of envLocations) {
  const r = dotenv.config({ path: e });
  if (!r.error && process.env.MONGODB_URI) break;
}

function extractDbName(uri: string): string {
  try { return new URL(uri).pathname.replace('/', '') || 'polymarket-test'; }
  catch { return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test'; }
}
function parseArg(flag: string): string | null {
  for (const a of process.argv.slice(2)) {
    const m = a.match(new RegExp(`^--${flag}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}
function hasFlag(flag: string) { return process.argv.slice(2).includes(`--${flag}`); }
function pct(n: number, total: number) {
  return total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0%';
}
function fmtUsdc(n: number | null | undefined) {
  if (n == null) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const fromEdgePool = hasFlag('from-edge-pool');
  const walletArg    = parseArg('wallets');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) { console.error('MONGODB_URI not set'); process.exit(1); }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(extractDbName(mongoUri));

  // ── Determine which wallets to analyse ────────────────────────────────────
  let wallets: string[] = [];

  if (walletArg) {
    wallets = walletArg.split(',').map(w => w.trim().toLowerCase());
    console.log(`Wallets from --wallets flag: ${wallets.length}`);
  } else if (fromEdgePool) {
    const docs = await db.collection('ahf-edgeRankedTraders').find({}, { projection: { wallet: 1 } }).toArray();
    wallets = docs.map(d => d.wallet as string);
    console.log(`Wallets from ahf-edgeRankedTraders: ${wallets.length}`);
  } else {
    // Default: use the last saved edge-ranked set (all of them)
    const docs = await db.collection('ahf-edgeRankedTraders').find({}, { projection: { wallet: 1 } }).toArray();
    wallets = docs.map(d => d.wallet as string);
    if (wallets.length === 0) {
      console.log('No wallets found. Run edge-ranked-traders.ts first, or pass --wallets=...');
      await client.close(); return;
    }
    console.log(`Loaded ${wallets.length} wallets from ahf-edgeRankedTraders`);
  }

  // ── Load profiles ──────────────────────────────────────────────────────────
  const profiles = await db.collection('polymarket-traderProfiles')
    .find({ wallet: { $in: wallets } })
    .toArray();

  // Also load edge ranks for context
  const edgeDocs = await db.collection('ahf-edgeRankedTraders')
    .find({ wallet: { $in: wallets } }, {
      projection: { wallet: 1, overall_rank: 1, edge: 1, roce_30d: 1, specialty: 1, confidence: 1 }
    }).toArray();
  const edgeMap = new Map(edgeDocs.map(d => [d.wallet as string, d]));

  await client.close();

  console.log(`Profiles loaded: ${profiles.length}\n`);

  // ── Sort by edge rank ──────────────────────────────────────────────────────
  profiles.sort((a, b) => {
    const ra = (edgeMap.get(a.wallet as string)?.overall_rank as number) ?? 999;
    const rb = (edgeMap.get(b.wallet as string)?.overall_rank as number) ?? 999;
    return ra - rb;
  });

  // ── Print activity breakdown table ────────────────────────────────────────
  const h1 = [
    'Rank'.padEnd(5), 'Wallet'.padEnd(44), 'Strategy'.padEnd(16),
    'Volume'.padEnd(8), 'Buys'.padEnd(6), 'Sells'.padEnd(6),
    'Redeem'.padEnd(8), 'Merge'.padEnd(7), 'Split'.padEnd(7), 'Other'.padEnd(7), 'Total'.padEnd(7),
    'Buy%'.padEnd(7), 'Sell%'.padEnd(7), 'Rdm%'.padEnd(7), 'Mrg%'.padEnd(7), 'Spl%'.padEnd(7),
    'Specialty',
  ].join('');
  const div = '─'.repeat(h1.length);

  console.log(div);
  console.log('  ACTIVITY BREAKDOWN (buy/sell/redeem/merge/split as % of total activities in 30d window)');
  console.log(div);
  console.log(h1);
  console.log(div);

  for (const p of profiles) {
    const edge = edgeMap.get(p.wallet as string);
    const rank = (edge?.overall_rank as number) ?? '?';
    const buys    = (p.buyCount    as number) ?? 0;
    const sells   = (p.sellCount   as number) ?? 0;
    const redeems = (p.redeemCount as number) ?? 0;
    const merges  = (p.mergeCount  as number) ?? 0;
    const splits  = (p.splitCount  as number) ?? 0;
    const other   = (p.otherCount  as number) ?? 0;
    const total   = (p.totalActivities as number) ?? (buys + sells + redeems + merges + splits + other);
    const strategy = ((p.strategyLabel as string) ?? '—').replace(/_/g, ' ');
    const volume   = (p.volumeLabel as string) ?? '—';

    // Flag if mergeCount/splitCount not yet profiled (old profiles have otherCount only)
    const hasBreakdown = p.mergeCount != null || p.splitCount != null;
    const mergeDisplay = hasBreakdown ? String(merges) : '?';
    const splitDisplay = hasBreakdown ? String(splits) : '?';

    console.log([
      String(rank).padEnd(5),
      (p.wallet as string).padEnd(44),
      strategy.padEnd(16),
      volume.padEnd(8),
      String(buys).padEnd(6),
      String(sells).padEnd(6),
      String(redeems).padEnd(8),
      mergeDisplay.padEnd(7),
      splitDisplay.padEnd(7),
      String(other).padEnd(7),
      String(total).padEnd(7),
      pct(buys, total).padEnd(7),
      pct(sells, total).padEnd(7),
      pct(redeems, total).padEnd(7),
      (hasBreakdown ? pct(merges, total) : '?').padEnd(7),
      (hasBreakdown ? pct(splits, total) : '?').padEnd(7),
      (edge?.specialty as string) ?? (p.specialty as string) ?? '—',
    ].join(''));
  }
  console.log(div);
  console.log('  NOTE: Merge/Split show ? for traders not yet re-profiled. Run profile-trader-v3.ts --wallets=... to update.');

  // ── Print bet sizing table ─────────────────────────────────────────────────
  const h2 = [
    'Rank'.padEnd(5), 'Wallet'.padEnd(44), 'AvgBet'.padEnd(10),
    'MedianBet'.padEnd(11), 'MaxBet'.padEnd(10), 'AvgBetUsdc'.padEnd(12),
    'AvgTrdSz'.padEnd(10), 'Asym%'.padEnd(7), 'Specialty',
  ].join('');

  console.log('\n' + div);
  console.log('  BET SIZING  (avgBet/medianBet from closed positions, avgBetUsdc from 30d activities)');
  console.log(div);
  console.log(h2);
  console.log(div);

  for (const p of profiles) {
    const edge = edgeMap.get(p.wallet as string);
    const rank = (edge?.overall_rank as number) ?? '?';
    const avgTrd    = p.avgTradeSize    as number | null;
    const medTrd    = p.medianTradeSize as number | null;
    const maxTrd    = p.maxTradeSize    as number | null;
    const avgUsdc   = p.avg_bet_size_usdc as number | null;
    const asymPct   = p.asymmetricVolumePercent as number | null;

    console.log([
      String(rank).padEnd(5),
      (p.wallet as string).padEnd(44),
      fmtUsdc(avgTrd).padEnd(10),
      fmtUsdc(medTrd).padEnd(11),
      fmtUsdc(maxTrd).padEnd(10),
      fmtUsdc(avgUsdc).padEnd(12),
      fmtUsdc(avgTrd).padEnd(10),  // same source, kept for readability
      (asymPct != null ? asymPct.toFixed(1) + '%' : '0%').padEnd(7),
      (edge?.specialty as string) ?? (p.specialty as string) ?? '—',
    ].join(''));
  }
  console.log(div);

  // ── Per-trader narrative summary ──────────────────────────────────────────
  console.log('\n── Copy Trade Implications ─────────────────────────────────────────────────────\n');

  for (const p of profiles) {
    const edge  = edgeMap.get(p.wallet as string);
    const rank  = (edge?.overall_rank as number) ?? '?';
    const buys   = (p.buyCount    as number) ?? 0;
    const sells  = (p.sellCount   as number) ?? 0;
    const merges = (p.mergeCount  as number) ?? 0;
    const splits = (p.splitCount  as number) ?? 0;
    const total  = (p.totalActivities as number) ?? 0;
    const hasBreakdown = p.mergeCount != null || p.splitCount != null;

    const sellRatio  = total > 0 ? (sells / total) * 100 : 0;
    const mergeRatio = total > 0 ? (merges / total) * 100 : 0;
    const splitRatio = total > 0 ? (splits / total) * 100 : 0;
    const exitRatio  = total > 0 ? ((sells + merges) / total) * 100 : 0; // combined exits
    const strategy   = (p.strategyLabel as string) ?? '';
    const avgBet     = p.avgTradeSize as number | null;
    const specialty  = (edge?.specialty ?? p.specialty) as string;
    const roce       = (edge?.roce_30d as number) ?? 0;

    const holdBehavior = exitRatio < 5
      ? 'BUY & HOLD to resolution'
      : exitRatio < 20
        ? 'Mostly holds, occasional early exits'
        : exitRatio < 40
          ? 'Active exits — must track sells+merges to copy correctly'
          : 'Heavy exiting — complex to copy (follow every sell+merge)';

    const sizeNote = avgBet != null
      ? avgBet > 10000
        ? `Large bets (~${fmtUsdc(avgBet)} avg) — size-down when copying`
        : avgBet > 3000
          ? `Medium bets (~${fmtUsdc(avgBet)} avg)`
          : `Small bets (~${fmtUsdc(avgBet)} avg) — may copy 1:1`
      : 'Bet size unknown';

    const mergeNote = hasBreakdown && merges > 0
      ? `  ⚠️  MERGE exits: ${merges} (${mergeRatio.toFixed(1)}%) — implicit exits not visible as SELLs`
      : '';
    const splitNote = hasBreakdown && splits > 0
      ? `  ⚠️  SPLIT entries: ${splits} (${splitRatio.toFixed(1)}%) — implicit buys not visible as BUYs (must watch splits)`
      : '';

    console.log(`  [${rank}] ${(p.wallet as string).slice(0, 10)}...  ${specialty}  |  ROCE: ${roce.toFixed(0)}%`);
    console.log(`      Strategy : ${strategy.replace(/_/g, ' ')}`);
    console.log(`      Exits    : ${holdBehavior}  (sell: ${sellRatio.toFixed(1)}%, merge: ${hasBreakdown ? mergeRatio.toFixed(1) : '?'}%)`);
    console.log(`      Entries  : Buys=${buys}/30d${hasBreakdown && splits > 0 ? `, Splits=${splits}` : ''}`);
    console.log(`      Sizing   : ${sizeNote}`);
    if (mergeNote) console.log(`     ${mergeNote}`);
    if (splitNote) console.log(`     ${splitNote}`);
    console.log('');
  }

  console.log('── Copy system design notes ────────────────────────────────────────────────────');
  console.log('  BUY (TRADE):  primary entry — copy immediately');
  console.log('  SELL (TRADE): active exit — copy if you hold the same position');
  console.log('  MERGE:        exit via YES+NO pair — same as SELL for copy purposes, must track');
  console.log('  SPLIT:        creates YES+NO from USDC — followed by SELL of unwanted side');
  console.log('                → held side = implicit BUY. Must watch splits to catch these entries');
  console.log('  REDEEM:       position resolves to $1 — no copy action needed (market settled)');
  console.log('  REWARD/OTHER: airdrop/incentive — ignore');
  console.log('  Sizing: scale copy bet proportionally to your capital vs trader avg bet size\n');
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
