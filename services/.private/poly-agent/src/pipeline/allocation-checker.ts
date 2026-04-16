/**
 * Allocation Checker
 *
 * Runs analyze-allocations.ts on a scheduled interval.
 * Spawns the script via npx tsx (same pattern as pipeline runner).
 *
 * Writes per-trader allocation decisions to ahf-allocationEvents and
 * updates current-state fields on ahf-copyTraders for fast UI lookup.
 *
 * Runs every 4h, independent of the 24h trader ranking pipeline.
 * Last-run time persisted in MongoDB so restarts don't reset the interval.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { createLogger } from './logger';
import { getPipelineDB } from './db';

const log = createLogger('AllocChecker');

// __dirname = dist/pipeline/ (compiled) or src/pipeline/ (tsx dev)
// ../../analyze-allocations.ts = poly-agent/analyze-allocations.ts
const SCRIPT_PATH = path.resolve(__dirname, '../../analyze-allocations.ts');
const SCRIPT_CWD  = path.resolve(__dirname, '../../');

const META_KEY = 'allocationChecker';

async function getLastRun(): Promise<Date | null> {
  try {
    const doc = await (await getPipelineDB())
      .collection('ahf-pipelineMeta')
      .findOne({ _id: META_KEY as any });
    return doc?.lastRun ? new Date(doc.lastRun) : null;
  } catch { return null; }
}

async function setLastRun(): Promise<void> {
  try {
    await (await getPipelineDB())
      .collection('ahf-pipelineMeta')
      .updateOne({ _id: META_KEY as any }, { $set: { lastRun: new Date() } }, { upsert: true });
  } catch (e: any) { log.warn(`Failed to persist last-run time: ${e.message}`); }
}

let isRunning   = false;
let intervalId: NodeJS.Timeout | null = null;

export async function runAllocationCheck(): Promise<void> {
  if (isRunning) {
    log.warn('Allocation check already running, skipping');
    return;
  }

  isRunning = true;
  const startMs = Date.now();

  log.info('');
  log.info('────────────────────────────────────────');
  log.info('  ALLOCATION CHECK — START              ');
  log.info('────────────────────────────────────────');

  await new Promise<void>((resolve) => {
    const proc = spawn('npx', ['tsx', SCRIPT_PATH], {
      stdio:  'inherit',
      env:    process.env,
      cwd:    SCRIPT_CWD,
      shell:  true,
    });

    proc.on('close', (code) => {
      const durationMs = Date.now() - startMs;
      if (code === 0) {
        log.success(`Allocation check completed in ${(durationMs / 1000).toFixed(1)}s`);
        setLastRun().catch(() => {});
      } else {
        log.error(`Allocation check exited with code ${code} after ${(durationMs / 1000).toFixed(1)}s`);
      }
      resolve();   // never reject — a failed check should not crash the service
    });

    proc.on('error', (err) => {
      log.error(`Allocation check failed to start: ${err.message}`);
      resolve();
    });
  });

  isRunning = false;
}

export async function startAllocationChecker(intervalMs: number): Promise<void> {
  const lastRun = await getLastRun();
  const now = Date.now();

  const schedule = () => {
    runAllocationCheck().catch(err => log.error(`Alloc check error: ${err.message}`));
  };

  if (lastRun) {
    const elapsed = now - lastRun.getTime();
    if (elapsed < intervalMs) {
      const delay = intervalMs - elapsed;
      log.info(`Alloc check ran ${(elapsed / 3_600_000).toFixed(1)}h ago — next run in ${(delay / 3_600_000).toFixed(1)}h`);
      setTimeout(() => {
        schedule();
        intervalId = setInterval(schedule, intervalMs);
      }, delay);
      return;
    }
  }

  log.info(`Starting allocation checker (every ${(intervalMs / 3_600_000).toFixed(0)}h)`);
  schedule();
  intervalId = setInterval(schedule, intervalMs);
}

export function stopAllocationChecker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Allocation checker stopped');
  }
}

export function getAllocationCheckerStatus() {
  return { isRunning };
}
