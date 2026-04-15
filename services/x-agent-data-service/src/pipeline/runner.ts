/**
 * Pipeline Runner
 *
 * Orchestrates the 4-step trader profiling pipeline by spawning
 * each script sequentially via tsx. Scripts are used as-is from
 * the ai-hedge-fund branch.
 *
 * Flow:
 *   1. fetch-leaderboard.ts       → polymarket-leaderboardSnapshots
 *   2. find-consistent-traders.ts → polymarket-consistentTraders
 *   3. bulk-profile-ahf.ts        → polymarket-traderProfiles + polymarket-traderPositions
 *   4. edge-ranked-traders.ts     → ahf-edgeRankedTraders
 *
 * After the pipeline, materialize.ts extracts high conviction trades
 * and open positions into tool-accessible collections.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { createLogger } from '../utils/logger';
import { runMaterialization } from './materialize';

const log = createLogger('Pipeline');

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

let isRunning = false;
let intervalId: NodeJS.Timeout | null = null;

/**
 * Run a single script via tsx, streaming stdout/stderr
 */
function runScript(name: string, args: string[] = []): Promise<{ durationMs: number }> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCRIPTS_DIR, name);
    const startMs = Date.now();

    log.info(`Starting ${name}...`);

    const proc = spawn('npx', ['tsx', scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
      cwd: process.cwd(),
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
      const durationMs = Date.now() - startMs;
      log.error(`${name} failed to start: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Run the full 4-step pipeline + materialization
 */
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

    // Step 1: Fetch leaderboard snapshots
    const step1 = await runScript('fetch-leaderboard.ts');
    timings['fetch-leaderboard'] = step1.durationMs;

    // Step 2: Find consistent traders
    const step2 = await runScript('find-consistent-traders.ts');
    timings['find-consistent-traders'] = step2.durationMs;

    // Step 3: Bulk profile using v3 profiler
    const step3 = await runScript('bulk-profile-ahf.ts');
    timings['bulk-profile-ahf'] = step3.durationMs;

    // Step 4: Compute edge rankings
    const step4 = await runScript('edge-ranked-traders.ts');
    timings['edge-ranked-traders'] = step4.durationMs;

    // Step 5: Materialize data for MCP tools
    log.info('Running materialization...');
    const matStart = Date.now();
    await runMaterialization();
    timings['materialize'] = Date.now() - matStart;
    log.success(`Materialization completed in ${((Date.now() - matStart) / 1000).toFixed(1)}s`);

    const totalMs = Date.now() - pipelineStart;

    log.info('');
    log.info('================================================================');
    log.info('           PIPELINE COMPLETE — TIMING REPORT                    ');
    log.info('================================================================');
    for (const [step, ms] of Object.entries(timings)) {
      const mins = (ms / 60000).toFixed(1);
      const secs = (ms / 1000).toFixed(1);
      log.info(`  ${step.padEnd(30)} ${ms > 60000 ? mins + 'm' : secs + 's'}`);
    }
    log.info(`  ${'TOTAL'.padEnd(30)} ${(totalMs / 60000).toFixed(1)}m`);
    log.info('================================================================');
    log.info('');

  } catch (error: any) {
    const totalMs = Date.now() - pipelineStart;
    log.error(`Pipeline failed after ${(totalMs / 60000).toFixed(1)}m: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startPipeline(intervalMs: number): void {
  log.info(`Starting pipeline (every ${(intervalMs / 3600000).toFixed(0)}h)`);

  // Run immediately on startup
  runFullPipeline();

  // Then on interval
  intervalId = setInterval(runFullPipeline, intervalMs);
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
