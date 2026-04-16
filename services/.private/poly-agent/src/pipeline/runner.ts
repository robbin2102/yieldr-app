/**
 * Pipeline Runner
 *
 * Orchestrates the 6-step trader ranking pipeline by spawning each script
 * sequentially via npx tsx. Scripts live in poly-agent/scripts/ and are
 * used as-is (no modification to the scripts themselves).
 *
 * Flow:
 *   1. fetch-leaderboard.ts       → polymarket-leaderboardSnapshots
 *   2. find-consistent-traders.ts → polymarket-consistentTraders
 *   3. bulk-profile-ahf.ts        → polymarket-traderProfiles + polymarket-traderPositions
 *      (--reset-progress ensures all wallets are re-profiled fresh every cycle)
 *   4. edge-ranked-traders.ts     → ahf-edgeRankedTraders
 *   5. snapshot                   → ahf-edgeRankedSnapshots (24h time-series archive)
 *   6. materialize                → x-agent-highConvictionTrades + polymarket-openPositions
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { createLogger } from './logger';
import { runMaterialization } from './materialize';
import { snapshotEdgeRankedTraders } from './snapshot';
import { getPipelineDB } from './db';

const log = createLogger('Pipeline');

// __dirname = dist/pipeline/ (compiled) or src/pipeline/ (tsx dev)
// ../../scripts = poly-agent/scripts/ in both cases
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

// CWD for spawned scripts = poly-agent root (one level above scripts/).
const SCRIPTS_CWD = path.resolve(SCRIPTS_DIR, '..');

const META_KEY = 'pipeline';

async function getLastPipelineRun(): Promise<Date | null> {
  try {
    const doc = await (await getPipelineDB())
      .collection('ahf-pipelineMeta')
      .findOne({ _id: META_KEY as any });
    return doc?.lastRun ? new Date(doc.lastRun) : null;
  } catch { return null; }
}

async function setLastPipelineRun(): Promise<void> {
  try {
    await (await getPipelineDB())
      .collection('ahf-pipelineMeta')
      .updateOne({ _id: META_KEY as any }, { $set: { lastRun: new Date() } }, { upsert: true });
  } catch (e: any) { log.warn(`Failed to persist last-run time: ${e.message}`); }
}

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

function runScript(name: string, args: string[] = []): Promise<{ durationMs: number }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, name);
    const startMs = Date.now();

    log.info(`Starting ${name}...`);

    const proc = spawn('npx', ['tsx', scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
      cwd: SCRIPTS_CWD,
      shell: true,
    });

    proc.on('close', (code) => {
      const durationMs = Date.now() - startMs;
      if (code === 0) {
        log.success(`${name} completed in ${(durationMs / 1000).toFixed(1)}s`);
        resolve({ durationMs });
      } else {
        log.error(`${name} exited with code ${code} after ${(durationMs / 1000).toFixed(1)}s`);
        reject(new Error(`Script ${name} exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      log.error(`${name} failed to start: ${err.message}`);
      reject(err);
    });
  });
}

export async function runFullPipeline(): Promise<void> {
  if (isRunning) {
    log.warn('Pipeline already running, skipping');
    return;
  }

  isRunning = true;
  const pipelineStart = Date.now();
  const timings: Record<string, number> = {};

  try {
    log.info('');
    log.info('================================================================');
    log.info('           FULL TRADER PIPELINE — START                         ');
    log.info('================================================================');

    const step1 = await runScript('fetch-leaderboard.ts');
    timings['fetch-leaderboard'] = step1.durationMs;

    const step2 = await runScript('find-consistent-traders.ts');
    timings['find-consistent-traders'] = step2.durationMs;

    // --reset-progress ensures all wallets are re-profiled fresh on every cycle
    const step3 = await runScript('bulk-profile-ahf.ts', ['--reset-progress']);
    timings['bulk-profile-ahf'] = step3.durationMs;

    const step4 = await runScript('edge-ranked-traders.ts');
    timings['edge-ranked-traders'] = step4.durationMs;

    // Step 5: snapshot — full funnel data per trader archived for trend analysis
    log.info('Running cycle snapshot...');
    const snapStart = Date.now();
    const snapCount = await snapshotEdgeRankedTraders();
    timings['snapshot'] = Date.now() - snapStart;
    log.success(`Snapshot: ${snapCount} traders archived to ahf-edgeRankedSnapshots`);

    // Step 6: materialize HC trades + open positions for MCP tools
    log.info('Running materialization...');
    const matStart = Date.now();
    await runMaterialization();
    timings['materialize'] = Date.now() - matStart;

    const totalMs = Date.now() - pipelineStart;

    log.info('');
    log.info('================================================================');
    log.info('           PIPELINE COMPLETE — TIMING REPORT                    ');
    log.info('================================================================');
    for (const [step, ms] of Object.entries(timings)) {
      const label = ms > 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`;
      log.info(`  ${step.padEnd(30)} ${label}`);
    }
    log.info(`  ${'TOTAL'.padEnd(30)} ${(totalMs / 60_000).toFixed(1)}m`);
    log.info('================================================================');
    log.info('');

    await setLastPipelineRun();

  } catch (error: any) {
    const totalMs = Date.now() - pipelineStart;
    log.error(`Pipeline failed after ${(totalMs / 60_000).toFixed(1)}m: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export async function startPipeline(intervalMs: number): Promise<void> {
  const lastRun = await getLastPipelineRun();
  const now = Date.now();

  const schedule = () => {
    runFullPipeline().catch(err => log.error(`Pipeline error: ${err.message}`));
  };

  if (lastRun) {
    const elapsed = now - lastRun.getTime();
    if (elapsed < intervalMs) {
      const delay = intervalMs - elapsed;
      log.info(`Pipeline ran ${(elapsed / 3_600_000).toFixed(1)}h ago — next run in ${(delay / 3_600_000).toFixed(1)}h`);
      setTimeout(() => {
        schedule();
        intervalId = setInterval(schedule, intervalMs);
      }, delay);
      return;
    }
  }

  log.info(`Starting pipeline (every ${(intervalMs / 3_600_000).toFixed(0)}h)`);
  schedule();
  intervalId = setInterval(schedule, intervalMs);
}

export function stopPipeline(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Pipeline scheduler stopped');
  }
}

export function getPipelineStatus() {
  return { isRunning };
}
