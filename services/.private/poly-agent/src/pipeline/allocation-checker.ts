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
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { createLogger } from './logger';

const log = createLogger('AllocChecker');

// __dirname = dist/pipeline/ (compiled) or src/pipeline/ (tsx dev)
// ../../analyze-allocations.ts = poly-agent/analyze-allocations.ts
const SCRIPT_PATH = path.resolve(__dirname, '../../analyze-allocations.ts');
const SCRIPT_CWD  = path.resolve(__dirname, '../../');

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

export function startAllocationChecker(intervalMs: number): void {
  log.info(`Starting allocation checker (every ${(intervalMs / 3_600_000).toFixed(0)}h)`);
  runAllocationCheck();
  intervalId = setInterval(runAllocationCheck, intervalMs);
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
