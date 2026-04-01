/**
 * Trader management — pause, resume, top-up, list, inspect.
 *
 * What is "pause a trader"?
 *   Sets active=false in ahf-copyTraders. The multiDetector's per-trader
 *   polling chain checks this flag at the end of each cycle and stops itself.
 *   Takes effect within one poll interval (≤60s). The trader's allocation and
 *   history are fully preserved — you can resume at any time.
 *   Use when: you want to stop copying someone mid-experiment without losing
 *   the allocation data, or when you want to compare results with/without.
 *
 * What is "top up alloc"?
 *   Increments allocationUsdc by a given amount. spentUsdc is NOT reset —
 *   only the ceiling increases. The trader immediately resumes copying if it
 *   was paused by ALLOCATION_FULL skips (the executor re-checks DB on every
 *   trade, so it picks up the new limit automatically without restart).
 *   Use when: a trader's allocation ran out mid-experiment and they're still
 *   performing well, so you want to add more capital.
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --list
 *
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --pause=T2-BuyHold-869%
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --resume=T2-BuyHold-869%
 *
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --topup=T2-BuyHold-869% --amount=20
 *
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --reset-spent=T2-BuyHold-869%
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --inspect=T2-BuyHold-869%
 *
 *   # Use wallet address instead of label for any command:
 *   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --pause=0x2d4bf8f8...
 */

import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';

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
  console.error('MONGODB_URI not set.'); process.exit(1);
}

function parseArg(flag: string): string | null {
  for (const a of process.argv.slice(2)) {
    const m = a.match(new RegExp(`^--${flag}=(.+)$`));
    if (m) return m[1];
  }
  return null;
}

function fmtUsdc(n: number) { return `$${n.toFixed(2)}`; }

async function resolve(col: mongoose.Collection, query: string): Promise<any | null> {
  // Match by label prefix or wallet prefix (case-insensitive)
  return col.findOne({
    $or: [
      { label: { $regex: `^${query}`, $options: 'i' } },
      { wallet: { $regex: `^${query.toLowerCase()}` } },
    ],
  });
}

async function main() {
  const col = mongoose.connection.collection('ahf-copyTrades');
  await mongoose.connect(process.env.MONGODB_URI!);
  const traders = mongoose.connection.collection('ahf-copyTraders');

  const listFlag     = process.argv.includes('--list');
  const pauseQuery   = parseArg('pause');
  const resumeQuery  = parseArg('resume');
  const topupQuery   = parseArg('topup');
  const inspectQuery = parseArg('inspect');
  const resetQuery   = parseArg('reset-spent');
  const amount       = parseFloat(parseArg('amount') ?? '0');

  // ── LIST ──────────────────────────────────────────────────────────────────
  if (listFlag || process.argv.length === 2) {
    const all = await traders.find({}).toArray();
    const h = [
      'Label'.padEnd(26), 'Status'.padEnd(8), 'Alloc'.padEnd(8),
      'Spent'.padEnd(8), 'Remain'.padEnd(8), 'AvgBet'.padEnd(10),
      'Executed'.padEnd(10), 'Skipped'.padEnd(10), 'Skip reasons',
    ].join('');
    console.log('\n' + '─'.repeat(h.length));
    console.log(h);
    console.log('─'.repeat(h.length));

    for (const t of all) {
      const remaining = t.allocationUsdc - t.spentUsdc;
      const skipMap = t.skipReasonCounts instanceof Map
        ? Object.fromEntries(t.skipReasonCounts)
        : (t.skipReasonCounts ?? {});
      const skipStr = Object.entries(skipMap)
        .filter(([, v]) => (v as number) > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');

      console.log([
        (t.label as string).padEnd(26),
        (t.active ? '✅ ON' : '⏸  OFF').padEnd(8),
        fmtUsdc(t.allocationUsdc).padEnd(8),
        fmtUsdc(t.spentUsdc).padEnd(8),
        fmtUsdc(remaining).padEnd(8),
        `$${t.avgBet}`.padEnd(10),
        String(t.tradesExecuted ?? 0).padEnd(10),
        String(t.tradesSkipped ?? 0).padEnd(10),
        skipStr || '—',
      ].join(''));
    }
    console.log('─'.repeat(h.length));
    const totalAlloc = all.reduce((s, t) => s + t.allocationUsdc, 0);
    const totalSpent = all.reduce((s, t) => s + t.spentUsdc, 0);
    console.log(`\nTotal: $${totalAlloc} allocated | $${totalSpent.toFixed(2)} spent | $${(totalAlloc - totalSpent).toFixed(2)} remaining\n`);
    await mongoose.disconnect(); return;
  }

  // ── PAUSE ─────────────────────────────────────────────────────────────────
  if (pauseQuery) {
    const t = await resolve(traders, pauseQuery);
    if (!t) { console.error(`No trader matching "${pauseQuery}"`); await mongoose.disconnect(); return; }
    await traders.updateOne({ _id: t._id }, { $set: { active: false } });
    console.log(`⏸  Paused ${t.label} (${t.wallet.slice(0, 10)}...)`);
    console.log(`   Takes effect within one poll cycle (≤${60}s)`);
    console.log(`   Resume: npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --resume=${t.label}`);
    await mongoose.disconnect(); return;
  }

  // ── RESUME ────────────────────────────────────────────────────────────────
  if (resumeQuery) {
    const t = await resolve(traders, resumeQuery);
    if (!t) { console.error(`No trader matching "${resumeQuery}"`); await mongoose.disconnect(); return; }
    await traders.updateOne({ _id: t._id }, { $set: { active: true } });
    console.log(`✅ Resumed ${t.label} (${t.wallet.slice(0, 10)}...)`);
    const remaining = t.allocationUsdc - t.spentUsdc;
    if (remaining <= 0) {
      console.log(`   ⚠️  Allocation is $0 remaining — top up first:`);
      console.log(`   npx tsx scripts/ai-hedge-fund/manage-copy-traders.ts --topup=${t.label} --amount=20`);
    } else {
      console.log(`   Allocation: $${remaining.toFixed(2)} remaining. Watchdog will start polling within 60s.`);
    }
    await mongoose.disconnect(); return;
  }

  // ── TOP UP ────────────────────────────────────────────────────────────────
  if (topupQuery) {
    if (!amount || amount <= 0) {
      console.error('--amount=N required for --topup (e.g. --amount=20)');
      await mongoose.disconnect(); return;
    }
    const t = await resolve(traders, topupQuery);
    if (!t) { console.error(`No trader matching "${topupQuery}"`); await mongoose.disconnect(); return; }
    await traders.updateOne({ _id: t._id }, { $inc: { allocationUsdc: amount } });
    const newAlloc = t.allocationUsdc + amount;
    const newRemaining = newAlloc - t.spentUsdc;
    console.log(`💰 Topped up ${t.label}`);
    console.log(`   Allocation: $${t.allocationUsdc} → $${newAlloc} (+$${amount})`);
    console.log(`   Spent: $${t.spentUsdc.toFixed(2)} | New remaining: $${newRemaining.toFixed(2)}`);
    if (!t.active) {
      console.log(`   Trader is paused. Resume: --resume=${t.label}`);
    } else {
      console.log(`   Executor picks up new ceiling automatically — no restart needed.`);
    }
    await mongoose.disconnect(); return;
  }

  // ── RESET SPENT (for re-runs / fresh experiments) ─────────────────────────
  if (resetQuery) {
    const t = await resolve(traders, resetQuery);
    if (!t) { console.error(`No trader matching "${resetQuery}"`); await mongoose.disconnect(); return; }
    await traders.updateOne({ _id: t._id }, { $set: { spentUsdc: 0, tradesExecuted: 0, tradesSkipped: 0, skipReasonCounts: {} } });
    console.log(`🔄 Reset spent/counters for ${t.label}`);
    console.log(`   spentUsdc → $0 | allocation still $${t.allocationUsdc}`);
    await mongoose.disconnect(); return;
  }

  // ── INSPECT ───────────────────────────────────────────────────────────────
  if (inspectQuery) {
    const t = await resolve(traders, inspectQuery);
    if (!t) { console.error(`No trader matching "${inspectQuery}"`); await mongoose.disconnect(); return; }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const trades = await col.find({ sourceWallet: t.wallet, createdAt: { $gte: since24h } }).toArray();
    const filled  = trades.filter(x => x.status === 'FILLED' || x.status === 'PARTIAL');
    const skipped = trades.filter(x => x.status === 'SKIPPED');
    const failed  = trades.filter(x => x.status === 'FAILED');

    const skipBreakdown = skipped.reduce((acc: Record<string, number>, x) => {
      const r = x.skipReason ?? 'UNKNOWN';
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  ${t.label}  (${t.wallet})`);
    console.log(`  Status: ${t.active ? 'ACTIVE' : 'PAUSED'}  |  ${t.specialty}  |  ${t.strategyLabel}`);
    console.log(`  ROCE: ${t.roce}%  |  avgBet: $${t.avgBet}  |  actsPerDay: ${t.actsPerDay}`);
    console.log('─'.repeat(55));
    console.log(`  Allocation: $${t.allocationUsdc} | Spent: $${t.spentUsdc.toFixed(2)} | Remaining: $${(t.allocationUsdc - t.spentUsdc).toFixed(2)}`);
    console.log(`  All-time:  detected=${t.tradesDetected}  aboveAvg=${t.tradesAboveAvg}  executed=${t.tradesExecuted}  skipped=${t.tradesSkipped}`);
    console.log('─'.repeat(55));
    console.log(`  Last 24h trades: ${trades.length}  filled=${filled.length}  skipped=${skipped.length}  failed=${failed.length}`);
    if (Object.keys(skipBreakdown).length > 0) {
      console.log(`  Skip reasons: ${Object.entries(skipBreakdown).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }
    if (t.lastPolledAt) {
      console.log(`  Last polled: ${new Date(t.lastPolledAt).toISOString()}`);
    }

    // Show last 5 trades
    const recent = await col.find({ sourceWallet: t.wallet }).sort({ createdAt: -1 }).limit(5).toArray();
    if (recent.length > 0) {
      console.log('\n  Recent trades:');
      for (const x of recent) {
        const ts = new Date(x.createdAt).toISOString().slice(11, 19);
        const icon = x.status === 'FILLED' ? '✅' : x.status === 'SKIPPED' ? '⏭ ' : x.status === 'FAILED' ? '❌' : '⏳';
        const detail = x.status === 'FILLED'
          ? `$${(x.filledUsdc ?? 0).toFixed(2)} filled @ $${(x.avgFillPrice ?? 0).toFixed(4)} | drift ${x.priceDrift != null ? (x.priceDrift >= 0 ? '+' : '') + x.priceDrift.toFixed(2) + '%' : '?'}`
          : x.skipReason ?? x.failReason ?? '';
        console.log(`    [${ts}] ${icon} [${String(x._id).slice(-8)}]  ${x.side} $${x.traderBetUsdc?.toFixed(0)}  ${detail}`);
      }
    }
    console.log();
    await mongoose.disconnect(); return;
  }

  console.log('Usage: --list | --pause=<label> | --resume=<label> | --topup=<label> --amount=N | --inspect=<label> | --reset-spent=<label>');
  await mongoose.disconnect();
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
