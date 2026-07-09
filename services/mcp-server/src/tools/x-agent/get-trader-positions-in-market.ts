/**
 * get_trader_positions_in_market Tool
 *
 * Find which top edge-ranked traders hold positions in a specific market.
 * Reads from polymarket-openPositions (materialized from v3 profiler)
 * and enriches with edge data from ahf-edgeRankedTraders.
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getTraderPositionsInMarketSchema = z.object({
  conditionId: z.string().optional().describe('Market condition ID to search positions for'),
  marketSlug: z.string().optional().describe('Market slug (alternative to conditionId)'),
  keyword: z.string().optional().describe('Search positions by market title keyword'),
  edgeTradersOnly: z.boolean().optional().default(true).describe('Only show positions from edge-ranked traders (default: true)'),
  limit: z.number().optional().default(20).describe('Number of positions to return'),
});

export type GetTraderPositionsInMarketInput = z.infer<typeof getTraderPositionsInMarketSchema>;

export async function executeGetTraderPositionsInMarket(input: GetTraderPositionsInMarketInput) {
  const db = await getDB();
  const positionsCol = db.collection('polymarket-openPositions');

  if (!input.conditionId && !input.marketSlug && !input.keyword) {
    return { error: 'Provide at least one of: conditionId, marketSlug, or keyword' };
  }

  // Build position filter
  const filter: any = {};

  if (input.conditionId) {
    filter.conditionId = input.conditionId;
  } else if (input.marketSlug) {
    filter.slug = input.marketSlug;
  } else if (input.keyword) {
    filter.title = { $regex: new RegExp(input.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  }

  // If edge traders only, get their wallets first
  if (input.edgeTradersOnly) {
    const edgeCol = db.collection('ahf-edgeRankedTraders');
    const edgeTraders = await edgeCol
      .find({})
      .project({ wallet: 1 })
      .toArray();

    const edgeWallets = edgeTraders.map(t => t.wallet?.toLowerCase()).filter(Boolean);

    if (edgeWallets.length > 0) {
      filter.wallet = { $in: edgeWallets };
    }
  }

  const positions = await positionsCol
    .find(filter)
    .sort({ currentValue: -1 })
    .limit(input.limit || 20)
    .toArray();

  // Enrich with edge-ranked trader data (v3 field names)
  const wallets = [...new Set(positions.map(p => p.wallet))];
  const edgeCol = db.collection('ahf-edgeRankedTraders');
  const edgeData = await edgeCol
    .find({ wallet: { $in: wallets } })
    .project({ wallet: 1, display_name: 1, win_rate: 1, pf: 1, pnl_30d: 1, specialty: 1, confidence: 1, edge: 1, overall_rank: 1 })
    .toArray();

  const edgeMap = new Map(edgeData.map(p => [p.wallet, p]));

  return {
    positions: positions.map(p => {
      const edge = edgeMap.get(p.wallet);
      return {
        wallet: p.wallet,
        traderLabel: edge?.display_name || `Trader-${(p.wallet || '').slice(0, 6)}`,
        market: p.title,
        conditionId: p.conditionId,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        currentValue: p.currentValue,
        cashPnl: p.cashPnl,
        percentPnl: p.percentPnl,
        traderEdge: edge ? {
          rank: edge.overall_rank,
          winRate: edge.win_rate,
          profitFactor: edge.pf,
          pnl30d: edge.pnl_30d,
          specialty: edge.specialty,
          confidence: edge.confidence,
          edgeMagnitude: edge.edge,
        } : undefined,
      };
    }),
    totalFound: positions.length,
    uniqueTraders: wallets.length,
    queryParams: input,
  };
}

export const getTraderPositionsInMarketTool = {
  name: 'get_trader_positions_in_market',
  description: 'Find which top edge-ranked traders hold positions in a specific Polymarket market. Search by conditionId, market slug, or keyword. Returns trader positions enriched with their statistical edge metrics.',
  inputSchema: getTraderPositionsInMarketSchema,
  execute: executeGetTraderPositionsInMarket,
};
