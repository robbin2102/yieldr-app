import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { logger } from './utils/logger';
import { MonitoringTask, CycleEntry } from './db/monitoring';
import { PositionEntry } from './db/positions';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface EvaluationResult {
  alert: boolean;
  // Alert fields (when alert: true)
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'critical';
  // No-alert field (when alert: false)
  summary?: string;
}

/**
 * Build a short, focused evaluator prompt.
 * This is NOT the agent's system prompt — it's a standalone per-cycle prompt
 * targeting ~200 token base + data + history.
 */
export function buildEvaluatorPrompt(
  task: MonitoringTask,
  currentData: Record<string, any>,
  userPositions: PositionEntry[]
): string {
  const cycleNumber = (task.cycleCount || 0) + 1;
  const isFirstCycle = !task.cycleHistory || task.cycleHistory.length === 0;

  const cycleHistoryStr = isFirstCycle
    ? '  No previous cycles (first run — record baseline, do NOT alert)'
    : (task.cycleHistory as CycleEntry[])
        .map((c, i, arr) => {
          const n = arr.length - i;
          return `  Cycle -${n} (${new Date(c.timestamp).toISOString()}): ${JSON.stringify(c.data)} | ${c.alerted ? 'ALERTED' : 'No alert'} | ${c.summary}`;
        })
        .join('\n');

  const positionsStr =
    userPositions.length > 0
      ? JSON.stringify(
          userPositions.map((p) => ({
            asset: p.asset,
            direction: p.direction,
            size: p.size,
            pnl: p.pnl,
            platform: p.platform,
          }))
        )
      : 'No open positions';

  return `You are a DeFi monitoring agent for Yieldr. Evaluate the data and decide if an alert should be sent.

TASK: ${task.monitorInstruction}

CURRENT DATA (Cycle #${cycleNumber}, ${new Date().toISOString()}):
${JSON.stringify(currentData)}

PREVIOUS CYCLES:
${cycleHistoryStr}

USER POSITIONS:
${positionsStr}

RULES:
- FIRST cycle (no previous data): NEVER alert. Just summarize current values.
- Compare current to previous cycles to detect changes and trends.
- Only alert when the task's conditions are clearly met.
- Consider user's positions when explaining relevance.
- Be direct with specific numbers.

Respond ONLY valid JSON, no markdown, no backticks:
Alert:    {"alert":true,"title":"<title with numbers>","message":"<2-3 sentence insight>","severity":"info|warning|critical"}
No alert: {"alert":false,"summary":"<10-15 word status>"}`;
}

/**
 * Call the evaluator LLM and parse its JSON response.
 * Returns a safe default on parse failure — never throws.
 */
export async function callEvaluator(prompt: string): Promise<EvaluationResult> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (response.content[0] as any)?.text?.trim() ?? '';
    logger.debug('Evaluator', 'Raw response', raw);

    // Strip markdown code fences if the model wraps its output (e.g. ```json ... ```)
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    try {
      const parsed = JSON.parse(text);
      // Validate shape
      if (typeof parsed.alert !== 'boolean') throw new Error('Missing alert field');
      return parsed as EvaluationResult;
    } catch {
      logger.warn('Evaluator', 'Failed to parse JSON response', text);
      return { alert: false, summary: 'Evaluation parse error' };
    }
  } catch (err: any) {
    logger.error('Evaluator', `LLM call failed: ${err.message}`);
    return { alert: false, summary: 'Evaluator error — skipped' };
  }
}
