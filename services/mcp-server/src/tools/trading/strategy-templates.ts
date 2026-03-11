/**
 * get_strategy_template Tool
 *
 * Returns pre-built MonitoringTask configs for standard trading strategies
 * (MEAN_REVERSION, TREND_FOLLOWING, SCALP) or the full available-signals
 * catalog for building a CUSTOM strategy.
 *
 * Each template includes:
 *   - tools[]         → tool configs with toolName, toolParams, extractFields
 *   - signals[]       → pre-configured signal conditions
 *   - entryLogic      → AND | OR | ANY
 *   - exitLogic       → AND | OR | ANY
 *   - monitorInstruction → LLM instruction for this strategy type
 *   - suggestedTrade  → recommended tp_pct, sl_pct, order_type
 *
 * Claude uses this to present a strategy card to the user, confirm parameters,
 * and then create a MonitoringTask + TradeSetup.
 *
 * Signal field paths correspond to extractFields returned by get_market_snapshot.
 * Fields are stored in strippedData as flat keys: { "indicators.rsi": 45.2 }
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
    description: '20-period Exponential Moving Average. Compare against price.close for trend.',
    commonThresholds: {},
  },
  ema_50: {
    signalId: 'ema_50',
    label: 'EMA 50',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.ema_50',
    description: '50-period EMA. Price above = bullish; price below = bearish.',
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
    description: 'Average Directional Index. >25 = trending market, <20 = ranging.',
    commonThresholds: { trending: 25, strong: 40 },
  },
  bb_pct_b: {
    signalId: 'bb_pct_b',
    label: 'BB %B',
    sourceType: 'mongodb_snapshot' as const,
    field: 'indicators.bb_pct_b',
    description: 'Bollinger Band %B. 0 = at lower band (oversold), 1 = at upper band (overbought).',
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
    description: 'Current perpetual funding rate. >0.05% = overheated longs. <-0.02% = crowded shorts.',
    commonThresholds: { extreme_long: 0.05, extreme_short: -0.02 },
  },
  long_short_ratio: {
    signalId: 'long_short_ratio',
    label: 'Long/Short Ratio',
    sourceType: 'mongodb_snapshot' as const,
    field: 'derivatives.long_short_ratio',
    description: 'Ratio of long vs short positions. >2 = crowded longs (mean reversion risk).',
    commonThresholds: { crowded_long: 2.0, crowded_short: 0.5 },
  },
  // ── Price (get_market_snapshot → price) ──────────────────────────────────
  price_close: {
    signalId: 'price_close',
    label: 'Price',
    sourceType: 'mongodb_snapshot' as const,
    field: 'price.close',
    description: 'Current close price. Use with absolute price levels for support/resistance.',
    commonThresholds: {},
  },
} as const;

// ─── Strategy Templates ───────────────────────────────────────────────────────

const MARKET_SNAPSHOT_TOOL = (pair: string) => ({
  toolName: 'get_market_snapshot',
  toolParams: { symbol: pair.replace('/USD', '').replace('/USDT', '') },
  extractFields: [
    'indicators.rsi',
    'indicators.ema_20',
    'indicators.ema_50',
    'indicators.macd_histogram',
    'indicators.adx',
    'indicators.bb_pct_b',
    'indicators.stoch_rsi_k',
    'derivatives.funding_rate',
    'derivatives.long_short_ratio',
    'price.close',
  ],
});

export const STRATEGY_TEMPLATES = {
  MEAN_REVERSION: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => ({
    strategyType: 'MEAN_REVERSION',
    task: `${pair} Mean Reversion`,
    monitorInstruction: `Monitor ${pair} for mean reversion opportunities. Look for extreme RSI readings, price touching Bollinger Bands, and oversold/overbought conditions. Alert when the market is stretched and a snap-back to the mean is likely. Reference funding rate — crowded positioning amplifies the signal.`,
    mode,
    tools: [MARKET_SNAPSHOT_TOOL(pair)],
    signals: [
      // Entry: RSI oversold AND BB %B touching lower band
      { signalId: 'rsi_oversold', label: 'RSI < 32 (oversold)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '<', threshold: 32, role: 'entry' },
      { signalId: 'bb_lower', label: 'BB %B < 0.1 (lower band)', sourceType: 'mongodb_snapshot', field: 'indicators.bb_pct_b', operator: '<', threshold: 0.1, role: 'entry' },
      // Exit: RSI recovered OR BB %B upper band
      { signalId: 'rsi_recovered', label: 'RSI > 60 (mean recovery)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '>', threshold: 60, role: 'exit' },
      { signalId: 'bb_upper', label: 'BB %B > 0.85 (upper band)', sourceType: 'mongodb_snapshot', field: 'indicators.bb_pct_b', operator: '>', threshold: 0.85, role: 'exit' },
    ],
    entryLogic: 'AND',
    exitLogic: 'OR',
    intervalSeconds: 300,
    suggestedTrade: { tp_pct: 4, sl_pct: 2.5, order_type: 'MARKET' },
    notes: 'Entry requires BOTH RSI oversold AND lower BB touch. Exit triggers on EITHER RSI recovery OR upper BB touch. Suitable for range-bound markets with ADX < 25.',
  }),

  TREND_FOLLOWING: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => ({
    strategyType: 'TREND_FOLLOWING',
    task: `${pair} Trend Following`,
    monitorInstruction: `Monitor ${pair} for trend continuation signals. Track EMA alignment, MACD momentum, and ADX trend strength. Enter when momentum is building and trend is confirmed by multiple timeframe indicators. Exit when momentum starts reversing.`,
    mode,
    tools: [MARKET_SNAPSHOT_TOOL(pair)],
    signals: [
      // Entry: RSI bullish zone + MACD positive + strong trend
      { signalId: 'rsi_bullish', label: 'RSI > 50 (bullish zone)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '>', threshold: 50, role: 'entry' },
      { signalId: 'macd_bullish', label: 'MACD histogram > 0', sourceType: 'mongodb_snapshot', field: 'indicators.macd_histogram', operator: '>', threshold: 0, role: 'entry' },
      { signalId: 'adx_trending', label: 'ADX > 25 (trending)', sourceType: 'mongodb_snapshot', field: 'indicators.adx', operator: '>', threshold: 25, role: 'entry' },
      // Exit: RSI weakening OR MACD turning negative
      { signalId: 'rsi_weakening', label: 'RSI < 42 (weakening)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '<', threshold: 42, role: 'exit' },
      { signalId: 'macd_bearish', label: 'MACD histogram < 0', sourceType: 'mongodb_snapshot', field: 'indicators.macd_histogram', operator: '<', threshold: 0, role: 'exit' },
    ],
    entryLogic: 'AND',
    exitLogic: 'OR',
    intervalSeconds: 300,
    suggestedTrade: { tp_pct: 8, sl_pct: 3, order_type: 'MARKET' },
    notes: 'All three entry signals must align. Exit on either RSI weakness or MACD flip. Best in trending markets (ADX > 25). Higher TP:SL ratio suits trend continuation.',
  }),

  SCALP: (pair: string, mode: 'monitor' | 'confirm' | 'autonomous' = 'confirm') => ({
    strategyType: 'SCALP',
    task: `${pair} Scalp`,
    monitorInstruction: `Monitor ${pair} for short-term scalping opportunities. Focus on rapid RSI oversold dips and Stoch RSI crossovers. Quick entries on momentum bursts, tight stops. Watch funding rate — avoid scalping against heavily funded direction.`,
    mode,
    tools: [MARKET_SNAPSHOT_TOOL(pair)],
    signals: [
      // Entry: either RSI dip OR Stoch RSI oversold
      { signalId: 'rsi_dip', label: 'RSI < 40 (dip entry)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '<', threshold: 40, role: 'entry' },
      { signalId: 'stoch_oversold', label: 'Stoch RSI < 20 (oversold)', sourceType: 'mongodb_snapshot', field: 'indicators.stoch_rsi_k', operator: '<', threshold: 20, role: 'entry' },
      // Exit: quick recovery
      { signalId: 'rsi_scalp_exit', label: 'RSI > 55 (scalp target)', sourceType: 'mongodb_snapshot', field: 'indicators.rsi', operator: '>', threshold: 55, role: 'exit' },
      { signalId: 'stoch_overbought', label: 'Stoch RSI > 75 (exit)', sourceType: 'mongodb_snapshot', field: 'indicators.stoch_rsi_k', operator: '>', threshold: 75, role: 'exit' },
    ],
    entryLogic: 'OR',
    exitLogic: 'OR',
    intervalSeconds: 300,
    suggestedTrade: { tp_pct: 1.5, sl_pct: 0.8, order_type: 'LIMIT' },
    notes: 'OR logic means either oversold signal triggers entry — lower conviction but faster. Tight TP/SL. Consider limit orders to get better fill prices on scalps.',
  }),
};

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const getStrategyTemplateSchema = z.object({
  strategy_type: z
    .enum(['MEAN_REVERSION', 'TREND_FOLLOWING', 'SCALP', 'CUSTOM', 'LIST'])
    .describe(
      'Strategy type to retrieve. Use LIST to see all strategies. Use CUSTOM to get the full signals catalog for building a bespoke strategy.'
    ),
  pair: z
    .string()
    .optional()
    .describe('Trading pair, e.g. BTC/USD or ETH/USD. Required for all types except LIST and CUSTOM.'),
  mode: z
    .enum(['monitor', 'confirm', 'autonomous'])
    .optional()
    .default('confirm')
    .describe(
      'Monitoring mode. confirm = agent alerts user before acting. autonomous = agent auto-closes when exit signals trigger. monitor = no trade execution, signals only.'
    ),
});

export type GetStrategyTemplateInput = z.infer<typeof getStrategyTemplateSchema>;

export function executeGetStrategyTemplate(input: GetStrategyTemplateInput) {
  const { strategy_type, pair, mode = 'confirm' } = input;

  if (strategy_type === 'LIST') {
    return {
      available_strategies: [
        {
          type: 'MEAN_REVERSION',
          description: 'Buy oversold dips, sell into recoveries. Best for ranging markets (ADX < 25).',
          entry_logic: 'AND (RSI oversold + BB lower band touch)',
          exit_logic: 'OR (RSI recovery or BB upper band)',
          typical_leverage: '5–15x',
        },
        {
          type: 'TREND_FOLLOWING',
          description: 'Ride momentum in trending markets. RSI + MACD + ADX alignment required.',
          entry_logic: 'AND (RSI bullish + MACD positive + ADX trending)',
          exit_logic: 'OR (RSI weakening or MACD flip)',
          typical_leverage: '5–20x',
        },
        {
          type: 'SCALP',
          description: 'Short-duration trades on RSI/Stoch RSI dips. Tight TP/SL.',
          entry_logic: 'OR (RSI dip or Stoch RSI oversold)',
          exit_logic: 'OR (RSI recovery or Stoch RSI overbought)',
          typical_leverage: '10–25x',
        },
        {
          type: 'CUSTOM',
          description: 'Build a bespoke strategy from the available signals catalog.',
          entry_logic: 'User-defined AND/OR/ANY',
          exit_logic: 'User-defined AND/OR/ANY',
          typical_leverage: 'User-defined',
        },
      ],
      hint: 'Call get_strategy_template with a specific strategy_type and pair to get the full config.',
    };
  }

  if (strategy_type === 'CUSTOM') {
    return {
      strategyType: 'CUSTOM',
      description:
        'Build a custom strategy using any combination of signals from the catalog below. Specify signals[], entryLogic (AND|OR|ANY), exitLogic (AND|OR|ANY), tools[], and monitorInstruction.',
      available_signals: Object.values(AVAILABLE_SIGNALS),
      example_signal: {
        signalId: 'rsi_exit',
        label: 'RSI > 70 (overbought)',
        sourceType: 'mongodb_snapshot',
        field: 'indicators.rsi',
        operator: '>',
        threshold: 70,
        role: 'exit',
      },
      logic_options: {
        AND: 'All signals in the group must trigger',
        OR: 'At least one signal must trigger',
        ANY: 'Same as OR — at least one signal',
      },
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

  return {
    ...template,
    usage: {
      next_step:
        'Present this strategy card to the user. Once approved, call execute-open with the trade params, then create a monitoring task using the tools/signals/mode config above.',
      create_monitor_on_open:
        'Pass createMonitor:true, monitorMode, monitorInstruction, and signals in the execute-open payload to auto-create the monitoring task on trade open.',
    },
  };
}

export const getStrategyTemplateTool = {
  name: 'get_strategy_template',
  description:
    'Get a pre-built strategy config (MEAN_REVERSION, TREND_FOLLOWING, SCALP) or the available signals catalog (CUSTOM). Returns tools[], signals[], entryLogic, exitLogic, monitorInstruction, and suggestedTrade params ready to use for trade execution and monitoring setup. Use LIST to see all strategies.',
  inputSchema: getStrategyTemplateSchema,
  execute: executeGetStrategyTemplate,
};
