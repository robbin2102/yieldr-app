/**
 * get_strategy_template Tool
 *
 * Returns pre-built MonitoringTask configs for MEAN_REVERSION, TREND_FOLLOWING,
 * SCALP, or the available-signals catalog for CUSTOM strategies.
 *
 * Token optimisation: extractFields is derived from each template's signal fields
 * plus a minimal set of context fields. Only the data the strategy actually needs
 * is fetched and passed to the LLM evaluator — not all 30-50 indicators.
 *
 * Custom strategies: user defines their own signals; extractFields is built from
 * whatever signal fields they choose, so cost scales with strategy complexity.
 *
 * Default monitoring interval: 15 minutes (900s). Configurable by user.
 */

import { z } from 'zod';

// ─── Available Signals Catalog ───────────────────────────────────────────────

export const AVAILABLE_SIGNALS = {
  // ── Technical indicators (get_market_snapshot → indicators) ─────────────
  rsi: {
    signalId: 'rsi',
    label: 'RSI',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.rsi',
    description: 'Relative Strength Index (0–100). <30 = oversold, >70 = overbought.',
    commonThresholds: { entry_long: 30, entry_short: 70, exit_long: 65, exit_short: 35 },
  },
  ema_20: {
    signalId: 'ema_20',
    label: 'EMA 20',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.ema_20',
    description: '20-period EMA. Compare against price.close for trend direction.',
    commonThresholds: {},
  },
  ema_50: {
    signalId: 'ema_50',
    label: 'EMA 50',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.ema_50',
    description: '50-period EMA. Price above = bullish; below = bearish.',
    commonThresholds: {},
  },
  macd_histogram: {
    signalId: 'macd_histogram',
    label: 'MACD Histogram',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.macd_histogram',
    description: 'MACD histogram. >0 = bullish momentum, <0 = bearish momentum.',
    commonThresholds: { bullish: 0, bearish: 0 },
  },
  adx: {
    signalId: 'adx',
    label: 'ADX',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.adx',
    description: 'Average Directional Index. >25 = trending, <20 = ranging.',
    commonThresholds: { trending: 25, strong: 40 },
  },
  bb_pct_b: {
    signalId: 'bb_pct_b',
    label: 'BB %B',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.bb_pct_b',
    description: 'Bollinger Band %B. 0 = lower band (oversold), 1 = upper band (overbought).',
    commonThresholds: { oversold: 0.1, overbought: 0.9 },
  },
  stoch_rsi_k: {
    signalId: 'stoch_rsi_k',
    label: 'Stoch RSI K',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.stoch_rsi_k',
    description: 'Stochastic RSI K line. <20 = oversold, >80 = overbought.',
    commonThresholds: { oversold: 20, overbought: 80 },
  },
  // ── Derivatives (get_market_snapshot → derivatives) ──────────────────────
  funding_rate: {
    signalId: 'funding_rate',
    label: 'Funding Rate',
    sourceType: 'mongodb_snapshot' as const,
    field: 'derivatives.funding_rate',
    description: 'Perpetual funding rate. >0.05% = overheated longs. <−0.02% = crowded shorts.',
    commonThresholds: { extreme_long: 0.05, extreme_short: -0.02 },
  },
  long_short_ratio: {
    signalId: 'long_short_ratio',
    label: 'Long/Short Ratio',
    sourceType: 'mongodb_snapshot' as const,
    field: 'derivatives.long_short_ratio',
    description: 'Ratio of longs vs shorts. >2 = crowded longs (mean reversion risk).',
    commonThresholds: { crowded_long: 2.0, crowded_short: 0.5 },
  },
  // ── Price (get_market_snapshot → price) ──────────────────────────────────
  price_close: {
    signalId: 'price_close',
    label: 'Price',
    sourceType: 'mongodb_snapshot' as const,
    field: 'price.close',
    description: 'Current close price. Use with absolute levels for support/resistance signals.',
    commonThresholds: {},
  },
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build minimal extractFields from a signal set.
 * Always includes price.close. Optional context fields can be appended.
 */
function buildExtractFields(
  signals: Array<{ field: string }>,
  contextFields: string[] = []
): string[] {
  const fields = new Set<string>(signals.map((s) => s.field));
  fields.add('price.close');
  for (const f of contextFields) fields.add(f);
  return Array.from(fields);
}

function marketSnapshotTool(pair: string, extractFields: string[]) {
  return {
    toolName: 'get_market_snapshot',
    toolParams: { symbol: pair.replace('/USD', '').replace('/USDT', '') },
    extractFields,
  };
}

// ─── Strategy Templates ───────────────────────────────────────────────────────

const MEAN_REVERSION_SIGNALS = [
  { signalId: 'rsi_oversold',  label: 'RSI < 32 (oversold)',        sourceType: 'mongodb_snapshot', field: 'indicators.rsi',      operator: '<',  threshold: 32,  role: 'entry' },
  { signalId: 'bb_lower',      label: 'BB %B < 0.1 (lower band)',   sourceType: 'mongodb_snapshot', field: 'indicators.bb_pct_b', operator: '<',  threshold: 0.1, role: 'entry' },
  { signalId: 'rsi_recovered', label: 'RSI > 60 (mean recovery)',   sourceType: 'mongodb_snapshot', field: 'indicators.rsi',      operator: '>',  threshold: 60,  role: 'exit'  },
  { signalId: 'bb_upper',      label: 'BB %B > 0.85 (upper band)',  sourceType: 'mongodb_snapshot', field: 'indicators.bb_pct_b', operator: '>',  threshold: 0.85, role: 'exit'  },
] as const;

const TREND_FOLLOWING_SIGNALS = [
  { signalId: 'rsi_bullish',    label: 'RSI > 50 (bullish zone)',   sourceType: 'mongodb_snapshot', field: 'indicators.rsi',             operator: '>', threshold: 50, role: 'entry' },
  { signalId: 'macd_bullish',   label: 'MACD histogram > 0',        sourceType: 'mongodb_snapshot', field: 'indicators.macd_histogram',  operator: '>', threshold: 0,  role: 'entry' },
  { signalId: 'adx_trending',   label: 'ADX > 25 (trending)',       sourceType: 'mongodb_snapshot', field: 'indicators.adx',             operator: '>', threshold: 25, role: 'entry' },
  { signalId: 'rsi_weakening',  label: 'RSI < 42 (weakening)',      sourceType: 'mongodb_snapshot', field: 'indicators.rsi',             operator: '<', threshold: 42, role: 'exit'  },
  { signalId: 'macd_bearish',   label: 'MACD histogram < 0',        sourceType: 'mongodb_snapshot', field: 'indicators.macd_histogram',  operator: '<', threshold: 0,  role: 'exit'  },
] as const;

const SCALP_SIGNALS = [
  { signalId: 'rsi_dip',          label: 'RSI < 40 (dip entry)',       sourceType: 'mongodb_snapshot', field: 'indicators.rsi',          operator: '<', threshold: 40, role: 'entry' },
  { signalId: 'stoch_oversold',   label: 'Stoch RSI < 20 (oversold)',  sourceType: 'mongodb_snapshot', field: 'indicators.stoch_rsi_k',  operator: '<', threshold: 20, role: 'entry' },
  { signalId: 'rsi_scalp_exit',   label: 'RSI > 55 (scalp target)',    sourceType: 'mongodb_snapshot', field: 'indicators.rsi',          operator: '>', threshold: 55, role: 'exit'  },
  { signalId: 'stoch_overbought', label: 'Stoch RSI > 75 (exit)',      sourceType: 'mongodb_snapshot', field: 'indicators.stoch_rsi_k',  operator: '>', threshold: 75, role: 'exit'  },
] as const;

export const STRATEGY_TEMPLATES = {
  MEAN_REVERSION: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => {
    // extractFields: signal fields + adx as context (tells LLM if market is ranging)
    const extractFields = buildExtractFields(MEAN_REVERSION_SIGNALS as any, ['indicators.adx']);
    return {
      strategyType: 'MEAN_REVERSION',
      task: `${pair} Mean Reversion`,
      monitorInstruction: `Monitor ${pair} for mean reversion. Alert when RSI is oversold (<32) AND price is at the lower Bollinger Band. Exit when RSI recovers above 60 or price reaches the upper band. Note ADX — strategy works best in ranging markets (ADX < 25). Reference funding rate crowding if present.`,
      mode,
      tools: [marketSnapshotTool(pair, extractFields)],
      signals: MEAN_REVERSION_SIGNALS,
      entryLogic: 'AND',
      exitLogic: 'OR',
      intervalSeconds: 900,   // 15 minutes
      suggestedTrade: { tp_pct: 4, sl_pct: 2.5, order_type: 'MARKET' },
      fetchedFields: extractFields,
      notes: 'Entry requires BOTH RSI oversold AND lower BB touch. Exit on EITHER RSI recovery OR upper BB. Best when ADX < 25 (ranging). 4 fields fetched per cycle.',
    };
  },

  TREND_FOLLOWING: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => {
    // extractFields: all 3 signals are already different fields — no extra context needed
    const extractFields = buildExtractFields(TREND_FOLLOWING_SIGNALS as any);
    return {
      strategyType: 'TREND_FOLLOWING',
      task: `${pair} Trend Following`,
      monitorInstruction: `Monitor ${pair} for trend continuation. Entry when RSI > 50, MACD histogram positive, and ADX > 25 all align. Exit when RSI weakens below 42 or MACD flips negative. Do not enter if ADX < 20 (ranging).`,
      mode,
      tools: [marketSnapshotTool(pair, extractFields)],
      signals: TREND_FOLLOWING_SIGNALS,
      entryLogic: 'AND',
      exitLogic: 'OR',
      intervalSeconds: 900,
      suggestedTrade: { tp_pct: 8, sl_pct: 3, order_type: 'MARKET' },
      fetchedFields: extractFields,
      notes: 'All 3 entry signals must fire simultaneously. Exit on either RSI weakness or MACD flip. Higher TP:SL suits trend continuation. 4 fields fetched per cycle.',
    };
  },

  SCALP: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => {
    // extractFields: signal fields + bb_pct_b as context for LLM narrative
    const extractFields = buildExtractFields(SCALP_SIGNALS as any, ['indicators.bb_pct_b']);
    return {
      strategyType: 'SCALP',
      task: `${pair} Scalp`,
      monitorInstruction: `Monitor ${pair} for quick scalp opportunities on RSI or Stoch RSI dips. Either oversold signal qualifies for entry. Exit quickly on RSI > 55 or Stoch RSI > 75. Avoid scalping against the funded direction.`,
      mode,
      tools: [marketSnapshotTool(pair, extractFields)],
      signals: SCALP_SIGNALS,
      entryLogic: 'OR',
      exitLogic: 'OR',
      intervalSeconds: 900,
      suggestedTrade: { tp_pct: 1.5, sl_pct: 0.8, order_type: 'LIMIT' },
      fetchedFields: extractFields,
      notes: 'OR logic for both entry and exit — faster triggers, lower conviction. Tight TP/SL. Consider limit orders for better fills. 4 fields fetched per cycle.',
    };
  },
};

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const getStrategyTemplateSchema = z.object({
  strategy_type: z
    .enum(['MEAN_REVERSION', 'TREND_FOLLOWING', 'SCALP', 'CUSTOM', 'LIST'])
    .describe(
      'Strategy type. LIST = overview of all. CUSTOM = full signals catalog for bespoke strategies. Others = ready-to-use config.'
    ),
  pair: z
    .string()
    .optional()
    .describe('Trading pair, e.g. BTC/USD or ETH/USD. Required except for LIST and CUSTOM.'),
  mode: z
    .enum(['monitor', 'confirm', 'autonomous'])
    .optional()
    .default('confirm')
    .describe(
      'confirm = agent alerts user before acting (default). autonomous = agent auto-closes on exit signals. monitor = monitoring only, no trade execution.'
    ),
  interval_minutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .optional()
    .describe('Monitoring interval in minutes. Default: 15. Min: 5. Max: 1440 (24h).'),
});

export type GetStrategyTemplateInput = z.infer<typeof getStrategyTemplateSchema>;

export function executeGetStrategyTemplate(input: GetStrategyTemplateInput) {
  const { strategy_type, pair, mode = 'confirm', interval_minutes } = input;

  if (strategy_type === 'LIST') {
    return {
      available_strategies: [
        {
          type: 'MEAN_REVERSION',
          description: 'Buy oversold dips, sell into recoveries. Best for ranging markets (ADX < 25).',
          entry_logic: 'AND (RSI < 32 + BB lower band touch)',
          exit_logic: 'OR (RSI > 60 or BB upper band)',
          fields_fetched: 4,
          suggested_tp_sl: '4% / 2.5%',
        },
        {
          type: 'TREND_FOLLOWING',
          description: 'Ride momentum in trending markets. RSI + MACD + ADX must align.',
          entry_logic: 'AND (RSI > 50 + MACD positive + ADX > 25)',
          exit_logic: 'OR (RSI < 42 or MACD flip)',
          fields_fetched: 4,
          suggested_tp_sl: '8% / 3%',
        },
        {
          type: 'SCALP',
          description: 'Short-duration trades on RSI/Stoch RSI dips. Tight TP/SL, limit orders.',
          entry_logic: 'OR (RSI < 40 or Stoch RSI < 20)',
          exit_logic: 'OR (RSI > 55 or Stoch RSI > 75)',
          fields_fetched: 4,
          suggested_tp_sl: '1.5% / 0.8%',
        },
        {
          type: 'CUSTOM',
          description: 'Bespoke strategy. Pick any signals from the catalog — extractFields auto-derived.',
          entry_logic: 'User-defined AND/OR/ANY',
          exit_logic: 'User-defined AND/OR/ANY',
          fields_fetched: 'Scales with number of unique signal fields',
        },
      ],
      note: 'All templates default to 15-minute monitoring intervals. Pass interval_minutes to override.',
    };
  }

  if (strategy_type === 'CUSTOM') {
    return {
      strategyType: 'CUSTOM',
      description:
        'Build a custom strategy. Pick signals from the catalog. extractFields is auto-derived from your signal fields — only those indicators are fetched each cycle, keeping token costs minimal.',
      available_signals: Object.values(AVAILABLE_SIGNALS),
      how_to_build: {
        step1: 'Choose signals from available_signals for entry (role: "entry") and exit (role: "exit")',
        step2: 'Set entryLogic and exitLogic: AND (all must fire), OR/ANY (any one fires)',
        step3: 'tools[] = [{ toolName: "get_market_snapshot", toolParams: { symbol: "BTC" }, extractFields: [<unique signal fields> + "price.close"] }]',
        step4: 'Set monitorInstruction describing what the LLM evaluator should watch for',
        step5: 'intervalSeconds: 900 (15min) is recommended. Set mode: confirm for user approval before actions.',
      },
      example_signals: [
        { signalId: 'rsi_exit', label: 'RSI > 70 (overbought)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '>', threshold: 70, role: 'exit' },
        { signalId: 'funding_extreme', label: 'Funding > 0.05%', sourceType: 'mongodb_snapshot', field: 'derivatives.funding_rate', operator: '>', threshold: 0.05, role: 'exit' },
      ],
      logic_options: { AND: 'All signals must trigger', OR: 'Any one signal triggers', ANY: 'Same as OR' },
    };
  }

  if (!pair) {
    return { error: `pair is required for strategy_type=${strategy_type}` };
  }

  const normalizedPair = pair.toUpperCase().replace('USDT', 'USD');
  const template =
    strategy_type === 'MEAN_REVERSION'
      ? STRATEGY_TEMPLATES.MEAN_REVERSION(normalizedPair, mode)
      : strategy_type === 'TREND_FOLLOWING'
      ? STRATEGY_TEMPLATES.TREND_FOLLOWING(normalizedPair, mode)
      : STRATEGY_TEMPLATES.SCALP(normalizedPair, mode);

  // Allow user to override the interval
  const intervalSeconds = interval_minutes ? interval_minutes * 60 : template.intervalSeconds;

  return {
    ...template,
    intervalSeconds,
    interval_display: `${intervalSeconds / 60} minutes`,
    usage: {
      next_step: 'Present this strategy card to the user with the fetchedFields listed so they understand what data is monitored. Once approved, execute the trade and pass createMonitor:true with this config.',
      monitor_payload: {
        createMonitor: true,
        monitorMode: mode,
        monitorInstruction: template.monitorInstruction,
        signals: template.signals,
        entryLogic: template.entryLogic,
        exitLogic: template.exitLogic,
        monitorIntervalSeconds: intervalSeconds,
        monitorTools: template.tools,
      },
    },
  };
}

export const getStrategyTemplateTool = {
  name: 'get_strategy_template',
  description:
    'Get a pre-built trading strategy config (MEAN_REVERSION, TREND_FOLLOWING, SCALP) or signals catalog (CUSTOM). Returns tools[], signals[], entryLogic, exitLogic, monitorInstruction, and suggestedTrade ready for trade execution + monitoring. Each template fetches only the indicators it needs (4 fields typical) for token efficiency. Use LIST for overview. Pass interval_minutes to override the 15-minute default.',
  inputSchema: getStrategyTemplateSchema,
  execute: executeGetStrategyTemplate,
};
