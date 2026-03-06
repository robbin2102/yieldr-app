import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { logger } from './utils/logger';
import { MonitoringTask, CycleEntry } from './db/monitoring';
import { PositionEntry } from './db/positions';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface IndicatorRead {
  name: string;
  value: string;
  dot: 'green' | 'yellow' | 'red' | 'blue' | 'purple';
  note: string;
}

export interface EvaluationResult {
  alert: boolean;
  signal: boolean;
  // Present when alert or signal is true
  title?: string;
  message?: string;
  severity?: 'info' | 'warning' | 'critical';
  // Per-indicator analysis — always present (powers Current Market Read)
  indicators?: IndicatorRead[];
  // One-line summary — always present
  summary?: string;
}

export function buildEvaluatorPrompt(
  task: MonitoringTask,
  currentData: Record<string, any>,
  userPositions: PositionEntry[]
): string {
  const cycleNumber = (task.cycleCount || 0) + 1;
  const isFirstCycle = !task.cycleHistory || task.cycleHistory.length === 0;

  const cycleHistoryStr = isFirstCycle
    ? '  No previous cycles (first run — baseline only, do NOT alert or signal)'
    : (task.cycleHistory as CycleEntry[])
        .map((c, i, arr) => {
          const n = arr.length - i;
          return `  Cycle -${n} (${new Date(c.timestamp).toISOString()}): ${JSON.stringify(c.data)} | ${c.alerted ? 'ALERTED' : c.signaled ? 'SIGNAL' : 'Nominal'} | ${c.summary}`;
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

  return `You are a DeFi quant monitoring agent. Analyze current market data and return structured JSON.

TASK: ${task.monitorInstruction}

CURRENT DATA (Cycle #${cycleNumber}, ${new Date().toISOString()}):
${JSON.stringify(currentData)}

PREVIOUS CYCLES:
${cycleHistoryStr}

USER POSITIONS:
${positionsStr}

RULES:
- FIRST cycle: set alert:false, signal:false. Baseline only.
- "signal":true when something notable is happening — worth surfacing to the user but not urgent.
- "alert":true only for actionable/urgent conditions requiring immediate attention. If alert:true then signal must also be true.
- For EVERY key data point, write one entry in "indicators" with your read. Use specific numbers.
- dot colors: "green"=positive/bullish, "yellow"=caution/elevated, "red"=danger/bearish, "blue"=neutral/informational
- Works for perps (funding, OI, RSI, EMA) and prediction markets (odds, volume, trader positioning).
- note: 1-3 sentences of reasoning with specific numbers. Reference context from prior cycles if relevant.

Respond ONLY with valid JSON, no markdown, no backticks.

When no signal or alert:
{"alert":false,"signal":false,"indicators":[{"name":"Funding Rate","value":"+0.048%/8h","dot":"yellow","note":"3.2× above 30d avg. OI deleveraging offsets risk."},...],"summary":"<one concise sentence read of overall market state>"}

When signal (notable but not urgent):
{"alert":false,"signal":true,"title":"<title with numbers>","message":"<2-3 sentence insight>","severity":"info","indicators":[...],"summary":"..."}

When alert (actionable/urgent):
{"alert":true,"signal":true,"title":"<title with numbers>","message":"<2-3 sentence actionable insight>","severity":"warning|critical","indicators":[...],"summary":"..."}`;
}

export async function callEvaluator(prompt: string): Promise<EvaluationResult> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (response.content[0] as any)?.text?.trim() ?? '';
    logger.debug('Evaluator', 'Raw response', raw);

    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.alert !== 'boolean') throw new Error('Missing alert field');
      // Ensure signal is always present
      if (typeof parsed.signal !== 'boolean') parsed.signal = parsed.alert;
      return parsed as EvaluationResult;
    } catch {
      logger.warn('Evaluator', 'Failed to parse JSON response', text);
      return { alert: false, signal: false, summary: 'Evaluation parse error' };
    }
  } catch (err: any) {
    logger.error('Evaluator', `LLM call failed: ${err.message}`);
    return { alert: false, signal: false, summary: 'Evaluator error — skipped' };
  }
}
