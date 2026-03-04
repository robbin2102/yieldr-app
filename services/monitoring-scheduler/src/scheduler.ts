import { getDueTasks, markTaskError } from './db/monitoring';
import { processTask } from './processor';
import { logger } from './utils/logger';
import { config } from './config';

let isRunning = false;
let cyclesCompleted = 0;
let lastCycleAt: Date | null = null;
let tasksProcessedTotal = 0;

/**
 * One scheduler cycle:
 * - Fetch all due tasks
 * - Process each sequentially (not parallel — avoids hammering MCP + Anthropic)
 * - Log any failures but continue to next task
 */
async function runCycle(): Promise<void> {
  if (isRunning) {
    logger.warn('Scheduler', 'Previous cycle still running — skipping this tick');
    return;
  }

  isRunning = true;
  const cycleStart = Date.now();

  try {
    const dueTasks = await getDueTasks();

    if (dueTasks.length === 0) {
      logger.debug('Scheduler', 'No due tasks');
      return;
    }

    logger.info('Scheduler', `Cycle ${cyclesCompleted + 1}: ${dueTasks.length} due task(s)`);

    for (const task of dueTasks) {
      try {
        await processTask(task);
        tasksProcessedTotal++;
      } catch (err: any) {
        logger.error('Scheduler', `Unhandled error processing task ${task._id}: ${err.message}`);
        await markTaskError(task._id, err.message).catch(() => {});
      }
    }

    cyclesCompleted++;
    lastCycleAt = new Date();
    logger.info('Scheduler', `Cycle complete in ${Date.now() - cycleStart}ms`);
  } catch (err: any) {
    logger.error('Scheduler', `Cycle failed: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

export function startScheduler(): void {
  logger.info('Scheduler', `Starting — loop every ${config.schedulerLoopMs / 1000}s`);

  // Run immediately on startup, then on interval
  runCycle();
  setInterval(runCycle, config.schedulerLoopMs);
}

export function getSchedulerStatus() {
  return {
    running: isRunning,
    cyclesCompleted,
    tasksProcessedTotal,
    lastCycleAt: lastCycleAt?.toISOString() ?? null,
    loopIntervalMs: config.schedulerLoopMs,
  };
}
