/**
 * get_copy_trade_activity Tool
 * Fetch recent copy trades executed by vault agents (FILLED status)
 * with conviction ratio calculated from trade size vs trader's average
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getCopyTradeActivitySchema = z.object({
  vaultName: z.string().optional().describe('Filter by vault name'),
  hours: z.number().optional().default(72).describe('Lookback window in hours (default: 72)'),
  limit: z.number().optional().default(10).describe('Number of trades to return (default: 10)'),
  minConvictionRatio: z.number().optional().describe('Minimum conviction ratio (traderBetUsdc / avgBet)'),
});

export type GetCopyTradeActivityInput = z.infer<typeof getCopyTradeActivitySchema>;

export async function executeGetCopyTradeActivity(input: GetCopyTradeActivityInput) {
  const db = await getDB();
  const cutoff = new Date(Date.now() - (input.hours || 72) * 60 * 60 * 1000);

  // Try ahf-copyTrades first, then poly-agent-trades as fallback
  const collectionsToTry = ['ahf-copyTrades', 'poly-agent-trades'];
  let allTrades: any[] = [];
  let sourceCollection = '';

  for (const colName of collectionsToTry) {
    const col = db.collection(colName);
    const count = await col.estimatedDocumentCount();
    if (count === 0) continue;

    sourceCollection = colName;

    const filter: any = {
      status: 'FILLED',
      $or: [
        { createdAt: { $gte: cutoff } },
        { confirmedAt: { $gte: cutoff } },
        { executedAt: { $gte: cutoff } },
        { detectedAt: { $gte: cutoff } },
      ],
    };

    if (input.vaultName) {
      filter.$and = [
        { $or: filter.$or },
        { $or: [
          { vaultName: { $regex: new RegExp(input.vaultName, 'i') } },
          { vault: { $regex: new RegExp(input.vaultName, 'i') } },
          { botWallet: { $exists: true } },
        ]},
      ];
      delete filter.$or;
    }

    const trades = await col
      .find(filter)
      .sort({ confirmedAt: -1, executedAt: -1, createdAt: -1 })
      .limit(input.limit || 10)
      .toArray();

    allTrades = trades;
    if (allTrades.length > 0) break;
  }

  if (allTrades.length === 0) {
    return {
      trades: [],
      totalFound: 0,
      source: sourceCollection || 'none',
      message: 'No filled copy trades found in the lookback window.',
    };
  }

  // Get unique trader wallets to fetch their avg trade size from edge-ranked data
  const traderWallets = [...new Set(allTrades.map(t =>
    t.original?.walletAddress || t.targetWallet || t.traderWallet
  ).filter(Boolean))];

  // Fetch trader profiles for avg trade size
  const traderProfiles = new Map<string, any>();
  if (traderWallets.length > 0) {
    // Try ahf-copyTraders first, then edgeRankedTraders, then traderProfiles
    for (const profileCol of ['ahf-copyTraders', 'ahf-edgeRankedTraders', 'polymarket-traderProfiles']) {
      const col = db.collection(profileCol);
      const profiles = await col.find({
        $or: [
          { wallet: { $in: traderWallets } },
          { wallet: { $in: traderWallets.map(w => w.toLowerCase()) } },
        ]
      }).toArray();

      for (const p of profiles) {
        const wallet = (p.wallet || '').toLowerCase();
        if (!traderProfiles.has(wallet)) {
          traderProfiles.set(wallet, p);
        }
      }
      if (traderProfiles.size > 0) break;
    }
  }

  const enrichedTrades = allTrades.map(t => {
    const traderWallet = (t.original?.walletAddress || t.targetWallet || t.traderWallet || '').toLowerCase();
    const profile = traderProfiles.get(traderWallet);

    // Calculate conviction ratio
    const traderBetUsdc = t.original?.usdcSize || t.traderBetUsdc || t.copy?.executedUsdcSize || 0;
    const avgBet = profile?.avgBet || profile?.avgTradeSize || profile?.medianTradeSize || 0;
    const convictionRatio = avgBet > 0 ? traderBetUsdc / avgBet : 0;

    return {
      traderWallet,
      traderLabel: profile?.display_name || profile?.label || `Trader-${traderWallet.slice(0, 8)}`,
      traderWinRate: profile?.win_rate || profile?.winRate,
      traderProfitFactor: profile?.pf || profile?.profitFactor,
      traderSpecialty: profile?.specialty,

      market: t.original?.title || t.market || t.title,
      outcome: t.original?.outcome || t.outcome,
      side: t.original?.side || t.side,
      traderBetUsdc,
      traderPrice: t.original?.price || t.price,
      avgBet,
      convictionRatio: Math.round(convictionRatio * 10) / 10,

      ourExecutedSize: t.copy?.executedUsdcSize || t.executedUsdcSize,
      ourPrice: t.copy?.executedPrice || t.executedPrice,
      slippageBps: t.slippage?.slippageBps,
      latencyMs: t.latencyMs,

      status: t.status,
      executedAt: t.executedAt || t.confirmedAt,
      conditionId: t.original?.conditionId || t.conditionId,
    };
  });

  // Filter by minimum conviction ratio if specified
  const filtered = input.minConvictionRatio
    ? enrichedTrades.filter(t => t.convictionRatio >= input.minConvictionRatio!)
    : enrichedTrades;

  // Sort by conviction ratio descending
  filtered.sort((a, b) => b.convictionRatio - a.convictionRatio);

  return {
    trades: filtered,
    totalFound: filtered.length,
    source: sourceCollection,
    queryParams: input,
  };
}

export const getCopyTradeActivityTool = {
  name: 'get_copy_trade_activity',
  description: 'Get recent copy trades executed by Yieldr vault agents. Returns FILLED trades with conviction ratio (trader bet size vs their average). Higher conviction ratio = trader is sizing up significantly on this market.',
  inputSchema: getCopyTradeActivitySchema,
  execute: executeGetCopyTradeActivity,
};
