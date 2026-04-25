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

function extractBetSize(doc: any): number {
  return doc.traderBetUsdc
    || doc.original?.usdcSize
    || doc.usdcSize
    || doc.copy?.executedUsdcSize
    || doc.size
    || doc.amount
    || 0;
}

function extractTraderWallet(doc: any): string {
  return (
    doc.traderWallet
    || doc.original?.walletAddress
    || doc.targetWallet
    || doc.wallet
    || doc.trader
    || ''
  ).toLowerCase();
}

function extractMarket(doc: any): string {
  return doc.original?.title
    || doc.market
    || doc.title
    || doc.marketQuestion
    || doc.conditionId
    || 'Unknown market';
}

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
        { timestamp: { $gte: cutoff } },
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

  // Self-calculate avgBet per trader from their recent trades in the same collection
  const traderWallets = [...new Set(allTrades.map(extractTraderWallet).filter(Boolean))];
  const traderAvgBets = new Map<string, number>();

  if (traderWallets.length > 0 && sourceCollection) {
    const col = db.collection(sourceCollection);
    for (const wallet of traderWallets) {
      const walletFilter: any = {
        status: 'FILLED',
        $or: [
          { 'original.walletAddress': wallet },
          { 'original.walletAddress': wallet.toLowerCase() },
          { traderWallet: wallet },
          { targetWallet: wallet },
          { wallet: wallet },
          { trader: wallet },
        ],
      };
      const traderTrades = await col.find(walletFilter)
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      if (traderTrades.length > 1) {
        const sizes = traderTrades.map(extractBetSize).filter(s => s > 0);
        if (sizes.length > 0) {
          traderAvgBets.set(wallet, sizes.reduce((a, b) => a + b, 0) / sizes.length);
        }
      }
    }
  }

  // Also try to get edge data from profiles for win rate / specialty
  const traderProfiles = new Map<string, any>();
  if (traderWallets.length > 0) {
    for (const profileCol of ['ahf-copyTraders', 'ahf-edgeRankedTraders', 'polymarket-traderProfiles']) {
      try {
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
      } catch { /* collection might not exist */ }
      if (traderProfiles.size >= traderWallets.length) break;
    }
  }

  const enrichedTrades = allTrades.map(t => {
    const traderWallet = extractTraderWallet(t);
    const profile = traderProfiles.get(traderWallet);
    const traderBetUsdc = extractBetSize(t);

    // Use self-calculated avgBet first, then profile avgBet
    const selfAvgBet = traderAvgBets.get(traderWallet) || 0;
    const profileAvgBet = profile?.avgBet || profile?.avgTradeSize || profile?.medianTradeSize || 0;
    const avgBet = selfAvgBet || profileAvgBet;
    const convictionRatio = avgBet > 0 ? Math.round((traderBetUsdc / avgBet) * 10) / 10 : null;

    return {
      traderWallet,
      traderLabel: profile?.display_name || profile?.label || `Trader-${traderWallet.slice(0, 8)}`,
      traderWinRate: profile?.win_rate || profile?.winRate,
      traderProfitFactor: profile?.pf || profile?.profitFactor,
      traderSpecialty: profile?.specialty,

      market: extractMarket(t),
      outcome: t.original?.outcome || t.outcome,
      side: t.original?.side || t.side,
      traderBetUsdc,
      traderPrice: t.original?.price || t.price,
      avgBet: Math.round(avgBet),
      convictionRatio,

      ourExecutedSize: t.copy?.executedUsdcSize || t.executedUsdcSize,
      ourPrice: t.copy?.executedPrice || t.executedPrice,
      slippageBps: t.slippage?.slippageBps,
      latencyMs: t.latencyMs,

      status: t.status,
      executedAt: t.executedAt || t.confirmedAt,
      conditionId: t.original?.conditionId || t.conditionId,

      _rawFields: Object.keys(t).filter(k => k !== '_id'),
    };
  });

  // Filter by minimum conviction ratio if specified
  const filtered = input.minConvictionRatio
    ? enrichedTrades.filter(t => t.convictionRatio != null && t.convictionRatio >= input.minConvictionRatio!)
    : enrichedTrades;

  // Sort by conviction ratio (nulls last) then by bet size
  filtered.sort((a, b) => {
    if (a.convictionRatio != null && b.convictionRatio != null) return b.convictionRatio - a.convictionRatio;
    if (a.convictionRatio != null) return -1;
    if (b.convictionRatio != null) return 1;
    return b.traderBetUsdc - a.traderBetUsdc;
  });

  return {
    trades: filtered,
    totalFound: filtered.length,
    source: sourceCollection,
    queryParams: input,
  };
}

export const getCopyTradeActivityTool = {
  name: 'get_copy_trade_activity',
  description: 'Get recent copy trades executed by Yieldr vault agents. Returns FILLED trades with conviction ratio (trader bet size vs their average). Higher conviction ratio = trader is sizing up significantly on this market. Self-calculates avgBet from trader history when profile data unavailable.',
  inputSchema: getCopyTradeActivitySchema,
  execute: executeGetCopyTradeActivity,
};
