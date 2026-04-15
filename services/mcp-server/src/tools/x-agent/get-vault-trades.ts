/**
 * get_vault_trades Tool
 * Fetch recent trades taken by vault agents
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getVaultTradesSchema = z.object({
  vaultName: z.string().optional().describe('Filter by vault name: "NBA Edge", "Soccer Alpha", "Geopolitics"'),
  hours: z.number().optional().default(24).describe('Lookback window in hours (default: 24)'),
  limit: z.number().optional().default(20).describe('Number of trades to return (default: 20)'),
});

export type GetVaultTradesInput = z.infer<typeof getVaultTradesSchema>;

export async function executeGetVaultTrades(input: GetVaultTradesInput) {
  const db = await getDB();

  // Try vault_trades first, then poly-agent-trades as fallback
  const collections = ['vault_trades', 'poly-agent-trades'];

  const cutoff = new Date(Date.now() - (input.hours || 24) * 60 * 60 * 1000);
  let allTrades: any[] = [];

  for (const colName of collections) {
    const col = db.collection(colName);
    const filter: any = {};

    // Time filter - handle both Date and number timestamps
    filter.$or = [
      { timestamp: { $gte: cutoff } },
      { timestamp: { $gte: Math.floor(cutoff.getTime() / 1000) } },
      { createdAt: { $gte: cutoff } },
    ];

    if (input.vaultName) {
      filter.$and = [
        { $or: filter.$or },
        { $or: [
          { vaultName: { $regex: new RegExp(input.vaultName, 'i') } },
          { vault: { $regex: new RegExp(input.vaultName, 'i') } },
        ]},
      ];
      delete filter.$or;
    }

    const trades = await col
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(input.limit || 20)
      .toArray();

    allTrades.push(...trades.map(t => ({ ...t, _source: colName })));
  }

  // Sort combined and limit
  allTrades.sort((a, b) => {
    const tsA = a.timestamp instanceof Date ? a.timestamp.getTime() : (a.timestamp > 1e12 ? a.timestamp : a.timestamp * 1000);
    const tsB = b.timestamp instanceof Date ? b.timestamp.getTime() : (b.timestamp > 1e12 ? b.timestamp : b.timestamp * 1000);
    return tsB - tsA;
  });

  allTrades = allTrades.slice(0, input.limit || 20);

  return {
    trades: allTrades.map(t => ({
      vaultName: t.vaultName || t.vault,
      market: t.market || t.title,
      outcome: t.outcome,
      side: t.side,
      size: t.size || t.usdcValue,
      price: t.price,
      pnl: t.pnl || t.realizedPnl,
      reasoning: t.reasoning || t.agentReasoning,
      conditionId: t.conditionId,
      timestamp: t.timestamp,
      source: t._source,
    })),
    totalFound: allTrades.length,
    queryParams: input,
  };
}

export const getVaultTradesTool = {
  name: 'get_vault_trades',
  description: 'Get recent trades executed by Yieldr vault agents. Returns trade details including market, outcome, size, PnL, and agent reasoning for each trade.',
  inputSchema: getVaultTradesSchema,
  execute: executeGetVaultTrades,
};
