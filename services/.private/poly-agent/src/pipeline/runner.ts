/**
 * Pipeline Runner
 *
 * Orchestrates the 5-step trader ranking pipeline by spawning each script
 * sequentially via npx tsx. Scripts live in poly-agent/scripts/ and are
 * used as-is (no modification to the scripts themselves).
 *
 * Flow:
 *   1. fetch-leaderboard.ts       → polymarket-leaderboardSnapshots
 *   2. find-consistent-traders.ts → polymarket-consistentTraders
 *   3. bulk-profile-ahf.ts        → polymarket-traderProfiles + polymarket-traderPositions
 *   4. edge-ranked-traders.ts     → ahf-edgeRankedTraders
 *   5. materialize                → x-agent-highConvictionTrades + polymarket-openPositions
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { createLogger } from './logger';
import { runMaterialization } from './materialize';

const log = createLogger('Pipeline');

// __dirname = dist/pipeline/ (compiled) or src/pipeline/ (tsx dev)
// ../../scripts = poly-agent/scripts/ in both cases
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

// Scripts use  path.resolve(process.cwd(), 'services/.private/poly-agent/env.polyagent')
// for env loading — that path is only valid from the project root.
// PROJECT_ROOT = yieldr-app/  (4 levels up from scripts/)
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '../../../..');

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
      cwd: PROJECT_ROOT,  // scripts resolve env.polyagent relative to project root
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

    const step3 = await runScript('bulk-profile-ahf.ts');
    timings['bulk-profile-ahf'] = step3.durationMs;

    const step4 = await runScript('edge-ranked-traders.ts');
    timings['edge-ranked-traders'] = step4.durationMs;

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

  } catch (error: any) {
    const totalMs = Date.now() - pipelineStart;
    log.error(`Pipeline failed after ${(totalMs / 60_000).toFixed(1)}m: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

export function startPipeline(intervalMs: number): void {
  log.info(`Starting pipeline (every ${(intervalMs / 3_600_000).toFixed(0)}h)`);
  runFullPipeline();
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
