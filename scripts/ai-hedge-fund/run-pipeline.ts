/**
 * AI Hedge Fund — Pipeline Orchestrator (Part 6)
 *
 * Sequential orchestrator: filter → LLM edge discovery → generate signals
 *
 * Flags:
 *   --skip-filter      Skip Step 1 (filter-alpha-traders)
 *   --skip-llm         Skip Step 2 (edge-discovery-batch)
 *   --skip-signals     Skip Step 3 (generate-signals)
 *   --llm-limit=N      Max traders to analyze with LLM (default: 50)
 *
 * Usage:
 *   npx tsx scripts/ai-hedge-fund/run-pipeline.ts
 *   npx tsx scripts/ai-hedge-fund/run-pipeline.ts --skip-llm
 *   npx tsx scripts/ai-hedge-fund/run-pipeline.ts --llm-limit=20
 */

import dotenv from 'dotenv';
import path from 'path';
import { MongoClient } from 'mongodb';

import { filterAlphaTraders } from './filter-alpha-traders.js';
import { runEdgeDiscovery }   from './edge-discovery-batch.js';
import { generateSignals }    from './generate-signals.js';

// ── Env loading ───────────────────────────────────────────────────────────────
const envLocations = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
];
for (const envPath of envLocations) {
  const result = dotenv.config({ path: envPath });
  if (!result.error && process.env.MONGODB_URI) break;
}

// ── CLI flag parsing ──────────────────────────────────────────────────────────
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseLlmLimit(): number {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--llm-limit=(\d+)$/);
    if (m) return parseInt(m[1], 10);
  }
  return 50;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractDbName(uri: string): string {
  try {
    const url = new URL(uri);
    return url.pathname.replace('/', '') || 'polymarket-test';
  } catch {
    return uri.match(/\/([^/?]+)(\?|$)/)?.[1] ?? 'polymarket-test';
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not set');
    process.exit(1);
  }

  const skipFilter  = hasFlag('--skip-filter');
  const skipLlm     = hasFlag('--skip-llm');
  const skipSignals = hasFlag('--skip-signals');
  const llmLimit    = parseLlmLimit();

  const pipelineStart = Date.now();

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           Yieldr AI Hedge Fund Pipeline                       ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Steps: filter=${!skipFilter} llm=${!skipLlm}(limit=${llmLimit}) signals=${!skipSignals}`);

  const client = new MongoClient(mongoUri);
  await client.connect();
  const dbName = extractDbName(mongoUri);
  const db = client.db(dbName);
  console.log(`Connected → db: ${dbName}\n`);

  try {
    // ── STEP 1: Filter Alpha Traders ────────────────────────────────────────
    if (!skipFilter) {
      console.log('[1/3] Running trader filter...');
      const t0 = Date.now();

      const result = await filterAlphaTraders(db);

      const elapsed = Date.now() - t0;
      console.log(`\n  ✓ Filter complete in ${formatMs(elapsed)}`);
      console.log(`  Passed: ${result.passed} / ${result.scanned} profiles\n`);
    } else {
      console.log('[1/3] Skipped (--skip-filter)\n');
    }

    // ── STEP 2: LLM Edge Discovery ───────────────────────────────────────────
    if (!skipLlm) {
      console.log('[2/3] Running LLM edge discovery...');
      const t0 = Date.now();

      const result = await runEdgeDiscovery(db, llmLimit);

      const elapsed = Date.now() - t0;
      console.log(`\n  ✓ LLM analysis complete in ${formatMs(elapsed)}`);
      console.log(`  Analyzed: ${result.processed} | OK: ${result.succeeded} | Failed: ${result.failed}\n`);
    } else {
      console.log('[2/3] Skipped (--skip-llm)\n');
    }

    // ── STEP 3: Generate Signals ─────────────────────────────────────────────
    if (!skipSignals) {
      console.log('[3/3] Generating signals...');
      const t0 = Date.now();

      const result = await generateSignals(db);

      const elapsed = Date.now() - t0;
      console.log(`\n  ✓ Signals generated in ${formatMs(elapsed)}`);
      console.log(`  Signals: ${result.generated} from ${result.traders} traders\n`);
    } else {
      console.log('[3/3] Skipped (--skip-signals)\n');
    }

    // ── FINAL SUMMARY ────────────────────────────────────────────────────────
    const totalMs = Date.now() - pipelineStart;

    const alphaCount  = await db.collection('ahf-alphaTraders').countDocuments();
    const llmCount    = await db.collection('ahf-alphaTraders').countDocuments({ llm_analyzed_at: { $ne: null } });
    const signalCount = await db.collection('ahf-signals').countDocuments({ status: 'active' });

    // Top 5 signals by rank_score * entry_count
    const topSignals = await db
      .collection('ahf-signals')
      .aggregate([
        { $match: { status: 'active' } },
        {
          $addFields: {
            score: { $multiply: ['$trader_rank_score', '$entry_count'] },
          },
        },
        { $sort: { score: -1 } },
        { $limit: 5 },
      ])
      .toArray();

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    Pipeline Complete                          ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Total time: ${formatMs(totalMs)}`);
    console.log(`Alpha traders in DB:  ${alphaCount}`);
    console.log(`LLM analyzed:         ${llmCount}`);
    console.log(`Active signals:       ${signalCount}`);

    if (topSignals.length > 0) {
      console.log('\nTop 5 signals (by rank_score × entry_count):');
      topSignals.forEach((s, i) => {
        const rec = s as Record<string, unknown>;
        const name   = (rec.trader_name as string) ?? 'Unknown';
        const market = (rec.market_title as string).slice(0, 45);
        const outcome = rec.outcome as string;
        const count   = rec.entry_count as number;
        console.log(`  ${i + 1}. ${name} → ${market} | ${outcome} | ${count} entries`);
      });
    }

    console.log('═══════════════════════════════════════════════════════════════\n');

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('Pipeline error:', err.message);
  process.exit(1);
});
