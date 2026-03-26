/**
 * Bulk BTC 5m Trader Profiler
 *
 * Runs the v3 profiler on top traders from BTC 5-minute markets.
 * Source: polyMarket5mTopTraders collection (populated by fetch-btc-5m-markets.ts)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/bulk-profile-btc-5m.ts [options]
 *
 * Options:
 *   --concurrency N   Parallel profiles (default: 5)
 *   --limit N         Max traders to profile (default: 0 = all)
 *   --offset N        Skip first N traders (default: 0)
 *   --days N          Period in days (default: 14)
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import { profileBtc5mTrader } from './profile-btc-5m-trader.js';

// Load environment — .env.local first so AI hedge fund scripts use the same
// MONGODB_URI as Next.js API routes (which always resolve to the yieldr db).
// The polyagent env points to a different cluster and is only a fallback.
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const ARGS = process.argv.slice(2);
const FLAG = (name: string) => ARGS.includes(`--${name}`);
const OPT = (name: string, fallback: string): string => {
  const idx = ARGS.indexOf(`--${name}`);
  return idx !== -1 && ARGS[idx + 1] ? ARGS[idx + 1] : fallback;
};

const CONCURRENCY  = parseInt(OPT('concurrency', '5'));
const LIMIT        = parseInt(OPT('limit', '0'));      // 0 = all
const START_OFFSET = parseInt(OPT('offset', '0'));
const PERIOD_DAYS  = parseInt(OPT('days', '14'));

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    const name = url.pathname.replace('/', '');
    return name || 'polymarket-test';
  } catch {
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    return match?.[1] || 'polymarket-test';
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function eta(doneCount: number, total: number, elapsedMs: number): string {
  if (doneCount === 0) return 'calculating...';
  const msPerItem = elapsedMs / doneCount;
  const remaining = (total - doneCount) * msPerItem;
  const h = Math.floor(remaining / 3_600_000);
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const dbName = extractDbName(mongoUri);
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('        BULK BTC 5m TRADER PROFILER                        ');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Offset:      ${START_OFFSET}`);
  console.log(`  Limit:       ${LIMIT > 0 ? LIMIT : 'all'}`);
  console.log(`  Period:      ${PERIOD_DAYS}d`);
  console.log(`  DB:          ${dbName}`);
  console.log('════════════════════════════════════════════════════════════\n');

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db(dbName);

  // ── Collect wallets from polyMarket5mTopTraders ─────────────
  let wallets = await db
    .collection('polyMarket5mTopTraders')
    .find({}, { projection: { wallet: 1 } })
    .sort({ totalUsdcVolume: -1 })
    .toArray()
    .then(docs => docs.map(d => d.wallet as string));

  // Apply offset
  if (START_OFFSET > 0) {
    console.log(`Resuming from offset ${START_OFFSET} (skipping first ${START_OFFSET} wallets)`);
    wallets = wallets.slice(START_OFFSET);
  }

  // Apply limit
  if (LIMIT > 0) {
    console.log(`Limiting to ${LIMIT} wallets`);
    wallets = wallets.slice(0, LIMIT);
  }

  const total = wallets.length;
  if (total === 0) {
    console.log('No wallets to process.');
    await client.close();
    return;
  }

  console.log(`Processing ${total} wallets at concurrency=${CONCURRENCY}...\n`);

  const profilesCol = db.collection('polyMarket5mTraderProfiles');

  // ── Stats tracking ────────────────────────────────────────
  let done = 0;
  let errors = 0;
  const archetypeCounts: Record<string, number> = {};
  const startMs = Date.now();

  // ── Process wallets ───────────────────────────────────────
  await runWithConcurrency(wallets, CONCURRENCY, async (wallet, i) => {
    const globalIdx = START_OFFSET + i + 1;
    const totalGlobal = START_OFFSET + total;

    try {
      process.stdout.write(`[${globalIdx}/${totalGlobal}] ${wallet} ... `);

      const profile = await profileBtc5mTrader(wallet, {
        periodDays: PERIOD_DAYS,
        verbose: false,
      });

      // Save to MongoDB
      await profilesCol.updateOne(
        { wallet: wallet.toLowerCase() },
        { $set: { ...profile, wallet: wallet.toLowerCase(), updatedAt: new Date() } },
        { upsert: true },
      );

      done++;

      // Track archetype
      const archetype = (profile as Record<string, unknown>).archetype as string | undefined;
      if (archetype) {
        archetypeCounts[archetype] = (archetypeCounts[archetype] || 0) + 1;
      }

      const elapsedMs = Date.now() - startMs;
      const etaStr = eta(done, total, elapsedMs);
      const elapsed = `${Math.floor(elapsedMs / 60_000)}m`;

      const p = profile as Record<string, unknown>;
      const arch = archetype || '?';
      const wr = typeof p.winRate === 'number' ? `${(p.winRate as number).toFixed(0)}%` : '?';
      const pnl = typeof p.totalPnl === 'number' ? `$${Math.round(p.totalPnl as number)}` : '?';
      const trades = typeof p.totalTrades === 'number' ? p.totalTrades : '?';

      console.log(
        `OK (archetype:${arch} wr:${wr} pnl:${pnl} trades:${trades}) | elapsed:${elapsed} eta:${etaStr}`,
      );
    } catch (err: unknown) {
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${message}`);
    }
  });

  // ── Summary ───────────────────────────────────────────────
  const totalMs = Date.now() - startMs;
  const totalMin = Math.floor(totalMs / 60_000);
  const perTrader = (totalMs / Math.max(done, 1) / 1000).toFixed(1);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('                       DONE                                 ');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  Profiled:    ${done}`);
  console.log(`  Errors:      ${errors}`);
  console.log(`  Total time:  ${totalMin}m`);
  console.log(`  Per trader:  ${perTrader}s avg`);

  if (Object.keys(archetypeCounts).length > 0) {
    console.log('\n  Archetype Distribution:');
    const sorted = Object.entries(archetypeCounts).sort((a, b) => b[1] - a[1]);
    for (const [arch, count] of sorted) {
      console.log(`    ${arch.padEnd(20)}${count}`);
    }
  }

  console.log('════════════════════════════════════════════════════════════\n');

  await client.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
