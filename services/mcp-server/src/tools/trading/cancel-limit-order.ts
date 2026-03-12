/**
 * cancel_limit_order Tool
 *
 * Cancels a pending limit order on Avantis.
 * Calls the Next.js execute/cancel-limit proxy which handles:
 *   - Python service → on-chain cancel tx
 *   - TradeSetup status → 'cancelled'
 *   - AgentTrade log entry (limit_cancel)
 *
 * To find pending limit orders the agent should call get_avantis_positions
 * and look for positions with status 'pending' or order type 'LIMIT'.
 * The trade_index for a limit order is the order index (0-based).
 */

import { z } from 'zod';

export const cancelLimitOrderSchema = z.object({
  agent_id: z.string().describe('The agent ID executing the cancellation.'),
  user_id: z.string().describe('The wallet address of the user who placed the order.'),
  pair_index: z.number().int().describe('On-chain pair index (e.g. 1 for BTC/USD).'),
  trade_index: z.number().int().describe('On-chain order/trade index for the limit order (0-based).'),
});

export type CancelLimitOrderInput = z.infer<typeof cancelLimitOrderSchema>;

export async function executeCancelLimitOrder(input: CancelLimitOrderInput) {
  // Read at call time, not module load time — dotenv loads after ESM imports resolve
  const NEXTJS_API_URL = process.env.NEXTJS_API_URL || 'http://localhost:3000';
  const INTERNAL_SECRET = process.env.YIELDR_INTERNAL_SECRET || '';

  const { agent_id, user_id, pair_index, trade_index } = input;

  let data: Record<string, any>;
  try {
    const res = await fetch(`${NEXTJS_API_URL}/api/avantis/execute/cancel-limit`, {
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
      }),
      signal: AbortSignal.timeout(60_000),
    });

    data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        success: false,
        error: data.error || `Cancel-limit failed with HTTP ${res.status}`,
        pair_index,
        trade_index,
      };
    }
  } catch (err: any) {
    return {
      success: false,
      error: `Network error calling execute/cancel-limit: ${err.message}`,
      pair_index,
      trade_index,
    };
  }

  return {
    success: true,
    tx_hash: data.trade?.tx_hash,
    trade_setup_id: data.tradeSetupId,
    pair_index,
    trade_index,
    message: 'Limit order cancelled successfully. Collateral will be returned to agent wallet.',
  };
}

export const cancelLimitOrderTool = {
  name: 'cancel_limit_order',
  description:
    'Cancel a pending limit order on Avantis. Submits an on-chain cancellation and marks the order as cancelled in the trade log. Call get_avantis_positions to find pending limit orders and get their pair_index and trade_index before calling this tool.',
  inputSchema: cancelLimitOrderSchema,
  execute: executeCancelLimitOrder,
};
