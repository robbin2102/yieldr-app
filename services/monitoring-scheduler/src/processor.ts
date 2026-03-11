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
import { tradeSignalEvaluator, TradeSignalResult } from './trade-signal-evaluator';
import { config } from './config';
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
 * Call the Next.js execute/close proxy to autonomously close a trade.
 * Returns true if the HTTP call succeeded (tx submitted), false otherwise.
 */
async function executeAutonomousClose(task: MonitoringTask): Promise<boolean> {
  if (task.linkedTradeIndex == null || task.linkedPairIndex == null) return false;
  try {
    const url = `${config.nextjsApiUrl}/api/avantis/execute/close`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.internalSecret ? { Authorization: `Bearer ${config.internalSecret}` } : {}),
      },
      body: JSON.stringify({
        agentId: task.agentId,
        userId: task.userId,
        pair_index: task.linkedPairIndex,
        trade_index: task.linkedTradeIndex,
        closeReason: 'signal_exit',
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('Processor', `execute-close returned ${res.status}: ${text}`);
    }
    return res.ok;
  } catch (err: any) {
    logger.error('Processor', `executeAutonomousClose failed: ${err.message}`);
    return false;
  }
}

/**
 * Inject signal state into the LLM evaluator prompt for 'confirm' mode exit triggers.
 * Tells the LLM that exit conditions fired so it can present a "Close / Hold?" message.
 */
function injectSignalContext(prompt: string, signalResult: import('./trade-signal-evaluator').TradeSignalResult): string {
  const triggered = signalResult.exitSignals
    .filter((s) => s.triggered)
    .map((s) => `  - ${s.label}: current=${s.currentValue} ${s.operator} ${s.threshold} ✓`)
    .join('\n');

  const signalBlock = `\nSIGNAL EVALUATOR — EXIT CONDITIONS TRIGGERED:\n${triggered}\n\nThe exit conditions above have been met. Format your response as an actionable "Close / Hold?" recommendation. Set alert:true, severity:"warning".`;
  return prompt + signalBlock;
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

  // Step 1b: Trade signal evaluator — runs before LLM, deterministic
  let signalResult: TradeSignalResult | null = null;
  if (task.signals && task.signals.length > 0) {
    signalResult = tradeSignalEvaluator.evaluate(task, strippedData);
    logger.info('Processor', `Signal eval for task ${taskId}: ${signalResult.summary}`);

    // Autonomous mode: exit triggered → close trade immediately, skip LLM eval
    if (
      signalResult.exitTriggered &&
      task.mode === 'autonomous' &&
      task.linkedTradeIndex != null &&
      task.linkedPairIndex != null
    ) {
      logger.info('Processor', `Autonomous EXIT for task ${taskId} — calling execute/close`);
      const closed = await executeAutonomousClose(task);

      const exitSummary = closed
        ? `Auto-closed: ${signalResult.summary}`
        : `Auto-close attempted (tx pending): ${signalResult.summary}`;

      await createAlert({
        userId: task.userId,
        taskId,
        agentId: task.agentId,
        title: closed ? 'Position auto-closed by signal' : 'Auto-close submitted',
        message: `${signalResult.summary}. Triggered signals: ${signalResult.exitSignals.filter((s) => s.triggered).map((s) => `${s.label}=${s.currentValue}`).join(', ')}`,
        severity: 'warning',
        isSignal: true,
        indicators: signalResult.exitSignals.map((s) => ({
          name: s.label,
          value: s.currentValue != null ? String(s.currentValue) : 'n/a',
          dot: s.triggered ? 'red' : 'green',
          note: `${s.operator} ${s.threshold} — ${s.triggered ? 'TRIGGERED' : 'nominal'}`,
        })),
        data: { ...strippedData, signalState: signalResult },
        cycleNumber: (task.cycleCount || 0) + 1,
        read: false,
        createdAt: new Date(),
      });

      await markTaskAlert(taskId, {
        lastAlertAt: new Date(),
        alertCount: (task.alertCount || 0) + 1,
      });

      // Still update cycleHistory and nextRunAt
      const exitCycle: CycleEntry = {
        timestamp: new Date(),
        data: strippedData,
        alerted: true,
        signaled: true,
        summary: exitSummary,
        exitTriggered: true,
      };
      await markTaskRun(taskId, {
        cycleHistory: [...(task.cycleHistory || []), exitCycle].slice(-5),
        nextRunAt: new Date(Date.now() + task.intervalSeconds * 1000),
        lastRunAt: new Date(),
        cycleCount: (task.cycleCount || 0) + 1,
      });

      logger.info('Processor', `Task ${taskId} autonomous exit complete`);
      return;
    }
  }

  // Step 2: Cooldown check — skip evaluator if we alerted within the last interval
  const cooldownActive =
    task.lastAlertAt != null &&
    Date.now() - new Date(task.lastAlertAt).getTime() < task.intervalSeconds * 1000;

  // Step 3: User positions for evaluator context
  const userPositions = await getUserPositions(task.userId).catch(() => []);

  // Step 4: Evaluate — inject signal state into prompt for 'confirm' mode exit triggers
  let evaluation: EvaluationResult;
  if (cooldownActive) {
    evaluation = { alert: false, signal: false, summary: 'Cooldown active — evaluator skipped' };
  } else {
    const basePrompt = buildEvaluatorPrompt(task, strippedData, userPositions);
    const prompt =
      signalResult?.exitTriggered && task.mode === 'confirm'
        ? injectSignalContext(basePrompt, signalResult)
        : basePrompt;
    evaluation = await callEvaluator(prompt);
  }

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
    entryTriggered: signalResult?.entryTriggered ?? false,
    exitTriggered: signalResult?.exitTriggered ?? false,
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
