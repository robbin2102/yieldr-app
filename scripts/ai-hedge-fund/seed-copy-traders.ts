/**
 * Seed ahf-copyTraders with the 6 shortlisted traders.
 *
 * Allocation: $200 total
 *   T2  $50  — 869% ROCE, BUY_AND_HOLD, 9 acts/d,   avg $185
 *   T4  $45  — 448% ROCE, BUY_AND_HOLD, 1.1 acts/d, avg $5700
 *   T1  $40  — 665% ROCE, SWING_TRADER, 34 acts/d,  avg $23
 *   T7  $30  — 352% ROCE, BUY_AND_HOLD, 8 acts/d,   avg $429
 *   T6  $25  — 267% ROCE, SWING_TRADER, 4.6 acts/d, avg $3200
 *   T5  $10  — 241% ROCE, SWING_TRADER, 18.8 acts/d,avg $173
 *
 * Bet sizing rule (all traders):
 *   - Skip if trader bet < avgBet
 *   - Copy bet = baseBetUsdc × (traderBet / avgBet), capped at maxBetUsdc
 *
 * Safe to re-run: uses upsert, never resets spentUsdc or lastSeenTs.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts
 *   npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts --dry-run
 *   npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts --reset-cursors   # restart from NOW
 *   npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts --pause-all
 *   npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts --resume-all
 */

import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';

// Load env
const envLocations = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const e of envLocations) {
  const r = dotenv.config({ path: e });
  if (!r.error && process.env.MONGODB_URI) break;
}

if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI not set. Check .env.polyagent or .env.local');
  process.exit(1);
}

function parseArg(flag: string): string | null {
  for (const a of process.argv.slice(2)) {
    const m = a.match(new RegExp(`^--${flag}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}
function hasFlag(flag: string) { return process.argv.slice(2).includes(`--${flag}`); }

// ── Trader definitions ──────────────────────────────────────────────────────

const TRADERS = [
  {
    wallet:        '0x2d4bf8f846bf68f43b9157bf30810d334ac6ca7a',
    label:         'T2-BuyHold-869%',
    specialty:     'Other',
    strategyLabel: 'BUY_AND_HOLD',
    roce:          869,
    actsPerDay:    9,
    avgBet:        185,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:50,
  },
  {
    wallet:        '0x1ba1bb6aa2490adbbbbb314bc07ff21a8cc71ce4',
    label:         'T4-BuyHold-448%',
    specialty:     'Soccer',
    strategyLabel: 'BUY_AND_HOLD',
    roce:          448,
    actsPerDay:    1.1,
    avgBet:        5700,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:45,
  },
  {
    wallet:        '0xbb0bd109b9f0c2a59b8819c466f064cf65ab3790',
    label:         'T1-Swing-665%',
    specialty:     'Soccer',
    strategyLabel: 'SWING_TRADER',
    roce:          665,
    actsPerDay:    34,
    avgBet:        23,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:40,
  },
  {
    wallet:        '0x843630d1b37be01868022d153ef1959dfcef4c19',
    label:         'T7-BuyHold-352%',
    specialty:     'NBA',
    strategyLabel: 'BUY_AND_HOLD',
    roce:          352,
    actsPerDay:    8,
    avgBet:        429,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:30,
  },
  {
    wallet:        '0x25e28169faea17421fcd4cc361f6436d1e449a09',
    label:         'T6-Swing-267%',
    specialty:     'Other',
    strategyLabel: 'SWING_TRADER',
    roce:          267,
    actsPerDay:    4.6,
    avgBet:        3200,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:25,
  },
  {
    wallet:        '0xcca90a5d3c8f2d6663817e3650d6adbe9ab44c9f',
    label:         'T5-Swing-241%',
    specialty:     'Other',
    strategyLabel: 'SWING_TRADER',
    roce:          241,
    actsPerDay:    18.8,
    avgBet:        173,
    baseBetUsdc:   5,
    maxBetUsdc:    20,
    allocationUsdc:10,
  },
];

async function main() {
  const isDryRun      = hasFlag('dry-run');
  const resetCursors  = hasFlag('reset-cursors');
  const pauseAll      = hasFlag('pause-all');
  const resumeAll     = hasFlag('resume-all');

  const mongoUri = process.env.MONGODB_URI!;
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB\n');

  const collection = mongoose.connection.collection('ahf-copyTraders');

  // ── Mass pause / resume ───────────────────────────────────────────────────
  if (pauseAll || resumeAll) {
    const active = resumeAll;
    if (!isDryRun) {
      await collection.updateMany({}, { $set: { active } });
    }
    console.log(`${isDryRun ? '[DRY RUN] Would set' : 'Set'} all traders active=${active}`);
    await mongoose.disconnect();
    return;
  }

  const nowTs = Math.floor(Date.now() / 1000);
  const totalAlloc = TRADERS.reduce((s, t) => s + t.allocationUsdc, 0);

  console.log(`Seeding ${TRADERS.length} traders | total allocation $${totalAlloc}`);
  if (isDryRun) console.log('DRY RUN — no writes\n');
  if (resetCursors) console.log('--reset-cursors: lastSeenTs will be set to NOW for all traders\n');

  const h = ['Label'.padEnd(26), 'Wallet'.padEnd(44), 'Alloc'.padEnd(8), 'AvgBet'.padEnd(10), 'Acts/d'.padEnd(8), 'ROCE%'].join('');
  console.log('─'.repeat(h.length));
  console.log(h);
  console.log('─'.repeat(h.length));

  for (const t of TRADERS) {
    console.log([
      t.label.padEnd(26),
      t.wallet.padEnd(44),
      `$${t.allocationUsdc}`.padEnd(8),
      `$${t.avgBet}`.padEnd(10),
      `${t.actsPerDay}`.padEnd(8),
      `${t.roce}%`,
    ].join(''));

    if (isDryRun) continue;

    // Upsert: set static config fields, but never overwrite spentUsdc or lastSeenTs
    // (so re-runs don't wipe runtime state).
    const setOnInsert: Record<string, unknown> = {
      spentUsdc:    0,
      tradesDetected: 0, tradesAboveAvg: 0, tradesExecuted: 0, tradesSkipped: 0,
      skipReasonCounts: {},
      lastSeenTs:   nowTs,
    };

    const setAlways: Record<string, unknown> = {
      label:          t.label,
      specialty:      t.specialty,
      strategyLabel:  t.strategyLabel,
      roce:           t.roce,
      actsPerDay:     t.actsPerDay,
      avgBet:         t.avgBet,
      baseBetUsdc:    t.baseBetUsdc,
      maxBetUsdc:     t.maxBetUsdc,
      allocationUsdc: t.allocationUsdc,
      active:         true,
    };

    if (resetCursors) {
      setAlways['lastSeenTs'] = nowTs;
      delete setOnInsert['lastSeenTs'];
    }

    await collection.updateOne(
      { wallet: t.wallet.toLowerCase() },
      {
        $set:         setAlways,
        $setOnInsert: setOnInsert,
      },
      { upsert: true }
    );
  }

  console.log('─'.repeat(h.length));
  console.log(`\n${isDryRun ? '[DRY RUN] ' : ''}✅ Seeded ${TRADERS.length} traders | $${totalAlloc} total allocation`);
  console.log('\nNext steps:');
  console.log('  1. Start the agent:  npx ts-node services/.private/poly-agent/src/index.ts');
  console.log('  2. Check reports:    execution tracker prints every 5m to console');
  console.log('  3. Pause a trader:   db.ahf-copyTraders.updateOne({wallet:"0x..."},{$set:{active:false}})');
  console.log('  4. Top up alloc:     db.ahf-copyTraders.updateOne({wallet:"0x..."},{$inc:{allocationUsdc:20}})');

  await mongoose.disconnect();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
