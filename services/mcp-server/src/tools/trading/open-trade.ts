/**
 * open_trade Tool
 *
 * Opens a new perpetual position (market or limit) on Avantis.
 * Calls the Next.js execute/open proxy which handles:
 *   - Python service → on-chain tx
 *   - TradeSetup creation in MongoDB
 *   - AgentTrade log entry (market_open or limit_open)
 *   - Optional MonitoringTask creation (when create_monitor: true)
 *
 * Usage:
 *   1. Call get_strategy_template to get tp_pct / sl_pct / monitorInstruction
 *   2. Call get_market_snapshot or fetch_live_indicator to validate entry signals
 *   3. Call open_trade with confirmed params
 *   4. Pass create_monitor: true to auto-start monitoring after open
 */

import { z } from 'zod';

const NEXTJS_API_URL  = process.env.NEXTJS_API_URL    || 'http://localhost:3000';
const INTERNAL_SECRET = process.env.YIELDR_INTERNAL_SECRET || '';

export const openTradeSchema = z.object({
  // ── Identity ────────────────────────────────────────────────────────────────
  agent_id: z.string().describe('The agent ID executing the trade.'),
  user_id:  z.string().describe('The wallet address of the user this trade belongs to.'),
  agent_name: z.string().optional().describe('Human-readable agent name. Used in monitoring task label.'),

  // ── Trade params ─────────────────────────────────────────────────────────────
  pair:       z.string().describe('Trading pair symbol, e.g. "BTC/USD" or "ETH/USD".'),
  pair_index: z.number().int().describe('On-chain pair index (e.g. 1 = BTC/USD, 2 = ETH/USD). Required by Avantis.'),
  direction:  z.enum(['LONG', 'SHORT']).describe('Trade direction.'),
  collateral: z.number().positive().describe('Collateral amount in USDC.'),
  leverage:   z.number().positive().describe('Leverage multiplier (e.g. 5 for 5x).'),
  tp_pct:     z.number().positive().describe('Take-profit percentage (e.g. 4 for 4%). Get from strategy template.'),
  sl_pct:     z.number().positive().describe('Stop-loss percentage (e.g. 2.5 for 2.5%). Get from strategy template.'),

  // ── Order type ───────────────────────────────────────────────────────────────
  order_type: z
    .enum(['MARKET', 'LIMIT'])
    .default('MARKET')
    .describe('MARKET executes immediately at current price. LIMIT queues at open_price.'),
  open_price: z
    .number()
    .positive()
    .optional()
    .describe('Required for LIMIT orders: the price at which the order should fill.'),

  // ── Auto-monitoring ───────────────────────────────────────────────────────────
  create_monitor: z
    .boolean()
    .default(true)
    .describe(
      'Auto-create a MonitoringTask linked to this trade after open. ' +
      'Strongly recommended — enables the scheduler to track TP/SL and signal exits. ' +
      'Default: true.'
    ),
  monitor_interval_seconds: z
    .number()
    .int()
    .positive()
    .default(300)
    .describe('How often the scheduler checks this trade in seconds. Default: 300 (5 min).'),
  monitor_instruction: z
    .string()
    .optional()
    .describe(
      'Natural language instruction for the monitoring agent. ' +
      'Example: "Monitor BTC/USD LONG. Exit if RSI > 65 or price drops below SL. Alert on MACD flip."'
    ),
});

export type OpenTradeInput = z.infer<typeof openTradeSchema>;

export async function executeOpenTrade(input: OpenTradeInput) {
  const {
    agent_id,
    user_id,
    agent_name,
    pair,
    pair_index,
    direction,
    collateral,
    leverage,
    tp_pct,
    sl_pct,
    order_type = 'MARKET',
    open_price,
    create_monitor = true,
    monitor_interval_seconds = 300,
    monitor_instruction,
  } = input;

  // Validate limit order has a price
  if (order_type === 'LIMIT' && open_price == null) {
    return {
      success: false,
      error: 'open_price is required for LIMIT orders.',
    };
  }

  const body: Record<string, any> = {
    agentId:   agent_id,
    userId:    user_id,
    pair,
    pair_index,
    direction,
    collateral,
    leverage,
    order_type,
    tp_pct,
    sl_pct,
    ...(open_price != null ? { open_price } : {}),
    createMonitor: create_monitor,
    ...(create_monitor
      ? {
          monitorIntervalSeconds: monitor_interval_seconds,
          agentName:              agent_name || agent_id,
          monitorInstruction:
            monitor_instruction ||
            `Monitor ${pair} ${direction} trade opened by ${agent_name || agent_id}. ` +
            `TP at ${tp_pct}%, SL at ${sl_pct}%. Alert if exit conditions are met.`,
        }
      : {}),
  };

  let data: Record<string, any>;
  try {
    const res = await fetch(`${NEXTJS_API_URL}/api/avantis/execute/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SECRET ? { Authorization: `Bearer ${INTERNAL_SECRET}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Execute-open failed with HTTP ${res.status}`,
        pair,
        direction,
        order_type,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Network error calling execute/open: ${err.message}`,
      pair,
      direction,
      order_type,
    };
  }

  const trade = data.trade || {};

  return {
    success: true,
    order_type,
    pair,
    direction,
    collateral,
    leverage,
    // On-chain result
    tx_hash:      trade.tx_hash,
    entry_price:  trade.entry_price,
    pair_index:   trade.pair_index,
    trade_index:  trade.trade_index ?? null,
    tp_price:     trade.tp_price,
    sl_price:     trade.sl_price,
    opening_fee:  trade.opening_fee_usdc,
    // MongoDB IDs for follow-up calls
    trade_setup_id:     data.tradeSetupId,
    monitoring_task_id: data.monitoringTaskId ?? null,
    // Monitoring status
    monitoring_active: !!data.monitoringTaskId,
    monitor_interval_seconds: create_monitor ? monitor_interval_seconds : null,
    // For limit orders: no entry_price until filled
    note: order_type === 'LIMIT'
      ? `Limit order queued at ${open_price}. It will fill when the market reaches this price. trade_index will be available once filled.`
      : undefined,
  };
}

export const openTradeTool = {
  name: 'open_trade',
  description:
    'Open a new perpetual position (MARKET or LIMIT) on Avantis. ' +
    'Before calling: use get_strategy_template for tp_pct/sl_pct and get_market_snapshot to validate entry signals. ' +
    'Returns tx_hash, entry_price, trade_index, and monitoring_task_id. ' +
    'Set create_monitor: true (default) to auto-start monitoring via the scheduler.',
  inputSchema: openTradeSchema,
  execute: executeOpenTrade,
};
