/**
 * close_trade Tool
 *
 * Closes an open market position on Avantis.
 * Calls the Next.js execute/close proxy which handles:
 *   - Python service → on-chain tx
 *   - TradeSetup status → 'closed'
 *   - AgentTrade log entry (market_close)
 *
 * The agent should call get_avantis_positions first to get
 * the current pair_index and trade_index for the position to close.
 */

import { z } from 'zod';

export const closeTradeSchema = z.object({
  agent_id: z.string().describe('The agent ID executing the close.'),
  user_id: z.string().describe('The wallet address of the user who owns the position.'),
  pair_index: z.number().int().describe('On-chain pair index (e.g. 1 for BTC/USD). Get from get_avantis_positions.'),
  trade_index: z.number().int().describe('On-chain trade index for the position. Get from get_avantis_positions.'),
  collateral_to_close: z
    .number()
    .positive()
    .describe('Collateral amount to close in USDC. Use open_collateral from get_avantis_positions to close the full position.'),
  close_reason: z
    .enum(['manual', 'agent_decision', 'signal_exit', 'tp_hit', 'sl_hit'])
    .optional()
    .default('agent_decision')
    .describe('Reason for closing. Logged in TradeSetup and AgentTrade.'),
});

export type CloseTradeInput = z.infer<typeof closeTradeSchema>;

export async function executeCloseTrade(input: CloseTradeInput) {
  // Read at call time, not module load time — dotenv loads after ESM imports resolve
  const NEXTJS_API_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';
  const INTERNAL_SECRET = process.env.YIELDR_INTERNAL_SECRET || '';

  const { agent_id, user_id, pair_index, trade_index, collateral_to_close, close_reason = 'agent_decision' } = input;

  let data: Record<string, any>;
  try {
    const res = await fetch(`${NEXTJS_API_URL}/api/avantis/execute/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SECRET ? { Authorization: `Bearer ${INTERNAL_SECRET}` } : {}),
      },
      body: JSON.stringify({
        agentId: agent_id,
        userId: user_id,
        pair_index,
        trade_index,
        collateral_to_close,
        closeReason: close_reason,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    data = await res.json().catch(() => ({})) as Record<string, any>;

    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Execute-close failed with HTTP ${res.status}`,
        pair_index,
        trade_index,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Network error calling execute/close: ${err.message}`,
      pair_index,
      trade_index,
    };
  }

  return {
    success: true,
    tx_hash: data.trade?.tx_hash,
    exit_price: data.trade?.exit_price,
    pnl: data.trade?.pnl,
    collateral_returned: data.trade?.collateral_closed,
    trade_setup_id: data.tradeSetupId,
    pair_index,
    trade_index,
    close_reason,
  };
}

export const closeTradeTool = {
  name: 'close_trade',
  description:
    'Close an open perpetual position on Avantis. Submits a market close transaction on-chain and logs the closure. Call get_avantis_positions first to get pair_index and trade_index. Returns tx_hash, exit_price, and PnL.',
  inputSchema: closeTradeSchema,
  execute: executeCloseTrade,
};
