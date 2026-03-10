import { ObjectId, WithId } from 'mongodb';
import { getDB, COLLECTIONS } from './db/connection';
import {
  MonitoringTask,
  CycleEntry,
  createAlert,
  createLog,
  markTaskRun,
  markTaskAlert,
  markTaskError,
} from './db/monitoring';
import { getUserPositions } from './db/positions';
import { callToolsAndExtract } from './tool-caller';
import { buildEvaluatorPrompt, callEvaluator, callAlphaDefiner, EvaluationResult } from './evaluator';
import { logger } from './utils/logger';

/** Extract top 3 news article links from get_news_headlines tool output in strippedData */
function extractNewsLinks(data: Record<string, any>): Array<{ title: string; url: string; source: string; publishedAt: string; age?: string }> {
  // Search recursively for an 'articles' array that looks like RSS articles
  function findArticles(obj: any): any[] | null {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj.articles) && obj.articles.length > 0 && obj.articles[0]?.url && obj.articles[0]?.title) {
      return obj.articles;
    }
    for (const v of Object.values(obj)) {
      const found = findArticles(v);
      if (found) return found;
    }
    return null;
  }
  const articles = findArticles(data);
  if (!articles) return [];
  return articles.slice(0, 3).map((a: any) => ({
    title: String(a.title || ''),
    url: String(a.url || ''),
    source: String(a.source || ''),
    publishedAt: String(a.publishedAt || new Date().toISOString()),
    ...(a.age ? { age: String(a.age) } : {}),
  })).filter(a => a.title && a.url);
}

/**
 * Process a single monitoring task for one cycle:
 * 1. Call tools and extract fields
 * 2. Check cooldown (skip evaluator if alert was sent within last interval)
 * 3. Fetch user positions for evaluator context
 * 4. Call evaluator LLM
 * 5. Write log (every cycle)
 * 6. Create alert + update agent stats (if alerted)
 * 7. Update task: cycleHistory, nextRunAt, cycleCount
 */
export async function processTask(task: WithId<MonitoringTask>): Promise<void> {
  const taskId = task._id as ObjectId;
  logger.info('Processor', `Processing task ${taskId} — "${task.task}"`);

  // Step 1: Call tools
  let strippedData: Record<string, any>;
  try {
    strippedData = await callToolsAndExtract(task.tools);
  } catch (err: any) {
    logger.error('Processor', `Tool call failed for task ${taskId}: ${err.message}`);
    await markTaskError(taskId, err.message);
    await createLog({
      taskId,
      agentId: task.agentId,
      timestamp: new Date(),
      data: {},
      alerted: false,
      summary: `Tool error: ${err.message}`,
      error: err.message,
    });
    return;
  }

  // Step 2: Cooldown check — skip evaluator if we alerted within the last interval
  const cooldownActive =
    task.lastAlertAt != null &&
    Date.now() - new Date(task.lastAlertAt).getTime() < task.intervalSeconds * 1000;

  // Step 3: User positions for evaluator context
  const userPositions = await getUserPositions(task.userId).catch(() => []);

  // Step 4: Evaluate
  const evaluation: EvaluationResult = cooldownActive
    ? { alert: false, signal: false, summary: 'Cooldown active — evaluator skipped' }
    : await callEvaluator(buildEvaluatorPrompt(task, strippedData, userPositions));

  logger.info(
    'Processor',
    `Task ${taskId} evaluated — alert=${evaluation.alert}${cooldownActive ? ' (cooldown)' : ''}`,
    evaluation.alert ? { title: evaluation.title, severity: evaluation.severity } : { summary: evaluation.summary }
  );

  // Step 5: Write log (every cycle, regardless of alert)
  const logEntry: Parameters<typeof createLog>[0] = {
    taskId,
    agentId: task.agentId,
    timestamp: new Date(),
    data: strippedData,
    alerted: evaluation.alert,
    summary: evaluation.alert
      ? (evaluation.title ?? 'Alert triggered')
      : (evaluation.summary ?? 'No alert'),
  };

  // Step 6: Create alert/signal record + update agent stats
  if (evaluation.alert || evaluation.signal) {
    const newCycleCount = (task.cycleCount || 0) + 1;

    // Extract newsLinks from get_news_headlines tool output if present
    const alertData: Record<string, any> = { ...strippedData };
    const newsArticles = extractNewsLinks(strippedData);
    if (newsArticles.length > 0) alertData.newsLinks = newsArticles;

    const alert = await createAlert({
      userId: task.userId,
      taskId,
      agentId: task.agentId,
      title: evaluation.title!,
      message: evaluation.message!,
      severity: evaluation.severity ?? 'info',
      isSignal: evaluation.signal,
      indicators: evaluation.indicators,
      data: alertData,
      cycleNumber: newCycleCount,
      read: false,
      createdAt: new Date(),
    });

    logEntry.alertId = alert._id as ObjectId;

    if (evaluation.alert) {
      await markTaskAlert(taskId, {
        lastAlertAt: new Date(),
        alertCount: (task.alertCount || 0) + 1,
      });
    }

    // Increment agent counters: alertsSent for alerts, insightsGenerated for signals
    try {
      const db = await getDB();
      await db.collection(COLLECTIONS.AGENTS).updateOne(
        { agentId: task.agentId },
        {
          $inc: {
            alertsSent: evaluation.alert ? 1 : 0,
            insightsGenerated: 1,
          },
          $set: { lastActiveAt: new Date() },
        }
      );
    } catch (err: any) {
      logger.warn('Processor', `Failed to update agent stats: ${err.message}`);
    }
  }

  await createLog(logEntry);

  // Step 7: Update task — rolling 5-cycle history, nextRunAt, cycleCount
  const newCycle: CycleEntry = {
    timestamp: new Date(),
    data: strippedData,
    alerted: evaluation.alert,
    signaled: evaluation.signal,
    summary: evaluation.alert
      ? (evaluation.title ?? 'Alert')
      : (evaluation.summary ?? 'No alert'),
    indicators: evaluation.indicators,
  };

  const updatedHistory: CycleEntry[] = [
    ...(task.cycleHistory || []),
    newCycle,
  ].slice(-5);

  await markTaskRun(taskId, {
    cycleHistory: updatedHistory,
    nextRunAt: new Date(Date.now() + task.intervalSeconds * 1000),
    lastRunAt: new Date(),
    cycleCount: (task.cycleCount || 0) + 1,
  });

  // Define alpha thesis on first completed cycle (or backfill for existing monitors)
  if (!task.alphaTitle) {
    const alpha = await callAlphaDefiner(task);
    if (alpha) {
      try {
        const db = await getDB();
        await db.collection(COLLECTIONS.MONITORING_TASKS).updateOne(
          { _id: taskId },
          { $set: { alphaTitle: alpha.alphaTitle, alphaDescription: alpha.alphaDescription } }
        );
        logger.info('Processor', `Alpha defined for task ${taskId}: "${alpha.alphaTitle}"`);
      } catch (err: any) {
        logger.warn('Processor', `Failed to persist alpha definition: ${err.message}`);
      }
    }
  }

  logger.info('Processor', `Task ${taskId} complete — next run at ${new Date(Date.now() + task.intervalSeconds * 1000).toISOString()}`);
}
