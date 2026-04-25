/**
 * get_vault_performance Tool
 * Pull live vault performance metrics from MongoDB
 * Uses vault_* collections primarily, poly-agent-* as fallback
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getVaultPerformanceSchema = z.object({
  vaultName: z.string().optional().describe('Filter by vault name: "NBA Edge", "Soccer Alpha", "Geopolitics", or omit for all'),
  period: z.enum(['1d', '7d', '30d', 'all']).optional().default('30d').describe('Performance period (default: 30d)'),
});

export type GetVaultPerformanceInput = z.infer<typeof getVaultPerformanceSchema>;

export async function executeGetVaultPerformance(input: GetVaultPerformanceInput) {
  const db = await getDB();

  // Get vault configs
  const vaultsCol = db.collection('vaults');
  const vaultFilter: any = {};
  if (input.vaultName) {
    vaultFilter.name = { $regex: new RegExp(input.vaultName, 'i') };
  }

  const vaults = await vaultsCol.find(vaultFilter).toArray();

  if (vaults.length === 0) {
    return { vaults: [], message: 'No vaults found. Vault data may not be populated yet.' };
  }

  const periodDays = input.period === '1d' ? 1 : input.period === '7d' ? 7 : input.period === '30d' ? 30 : 365;
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const results = [];

  for (const vault of vaults) {
    const vaultId = vault._id?.toString() || vault.id || vault.name;

    // --- Snapshots ---
    const snapshotsCol = db.collection('vault_daily_snapshots');
    const latestSnapshot = await snapshotsCol
      .findOne(
        { $or: [{ vaultId }, { vaultName: vault.name }] },
        { sort: { timestamp: -1 } }
      );

    const periodSnapshots = await snapshotsCol
      .find({
        $or: [{ vaultId }, { vaultName: vault.name }],
        timestamp: { $gte: periodStart },
      })
      .sort({ timestamp: 1 })
      .toArray();

    // --- Trades: vault_trades + poly-agent-trades fallback ---
    let recentTrades: any[] = [];
    const vaultTradesCol = db.collection('vault_trades');
    recentTrades = await vaultTradesCol
      .find({ $or: [{ vaultId }, { vaultName: vault.name }] })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    if (recentTrades.length === 0) {
      const polyTradesCol = db.collection('poly-agent-trades');
      const polyTrades = await polyTradesCol
        .find({ status: 'FILLED' })
        .sort({ confirmedAt: -1, executedAt: -1 })
        .limit(10)
        .toArray();

      recentTrades = polyTrades.map(t => ({
        market: t.original?.title || t.market,
        outcome: t.original?.outcome || t.outcome,
        side: t.original?.side || t.side,
        size: t.copy?.executedUsdcSize || t.original?.usdcSize,
        price: t.copy?.executedPrice || t.original?.price,
        pnl: null,
        reasoning: null,
        timestamp: t.confirmedAt || t.executedAt || t.createdAt,
        _source: 'poly-agent-trades',
      }));
    }

    // --- Open positions: vault_openPositions + poly-agent-positions fallback ---
    let openPositions: any[] = [];
    const vaultPosCol = db.collection('vault_openPositions');
    openPositions = await vaultPosCol
      .find({ $or: [{ vaultId }, { vaultName: vault.name }] })
      .toArray();

    if (openPositions.length === 0) {
      const polyPosCol = db.collection('poly-agent-positions');
      const polyPositions = await polyPosCol
        .find({ status: { $in: ['SYNCED', 'PENDING', 'PARTIAL'] } })
        .sort({ lastSyncedAt: -1 })
        .limit(20)
        .toArray();

      openPositions = polyPositions.map(p => ({
        market: p.marketQuestion || p.title,
        outcome: p.outcome,
        size: p.ourSize || p.traderSize,
        avgPrice: p.ourAvgPrice || p.traderAvgPrice,
        curPrice: p.traderCurrentPrice,
        unrealizedPnl: p.ourPnL || p.traderPnL,
        pnlPercent: p.ourPnLPercent || p.traderPnLPercent,
        traderWallet: p.targetWallet,
        status: p.status,
        _source: 'poly-agent-positions',
      }));
    }

    // --- 24h activity summary ---
    const trades24h = recentTrades.filter(t => {
      const ts = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
      return ts >= last24h;
    });

    // Calculate ROI
    let periodRoi = 0;
    if (periodSnapshots.length >= 2) {
      const startValue = periodSnapshots[0].totalValue || periodSnapshots[0].nav || 0;
      const endValue = periodSnapshots[periodSnapshots.length - 1].totalValue || periodSnapshots[periodSnapshots.length - 1].nav || 0;
      if (startValue > 0) {
        periodRoi = ((endValue - startValue) / startValue) * 100;
      }
    }

    // Winning/losing position counts
    const winningPositions = openPositions.filter(p =>
      (p.unrealizedPnl || p.cashPnl || 0) > 0
    );
    const totalUnrealizedPnl = openPositions.reduce((sum, p) =>
      sum + (p.unrealizedPnl || p.cashPnl || 0), 0
    );

    results.push({
      name: vault.name,
      description: vault.description,
      status: vault.status || 'active',

      performance: {
        period: input.period,
        roi: periodRoi,
        latestNav: latestSnapshot?.nav || latestSnapshot?.totalValue,
        totalPnl: latestSnapshot?.totalPnl || latestSnapshot?.pnl,
        snapshotCount: periodSnapshots.length,
      },

      stats: {
        totalTrades: vault.totalTrades || recentTrades.length,
        winRate: vault.winRate,
        subscribers: vault.subscribers,
        aum: vault.aum || latestSnapshot?.totalValue,
        openPositionCount: openPositions.length,
        winningPositionCount: winningPositions.length,
        totalUnrealizedPnl,
      },

      activity24h: {
        tradesExecuted: trades24h.length,
        trades: trades24h.slice(0, 3).map(t => ({
          market: t.market || t.title,
          outcome: t.outcome,
          side: t.side,
          size: t.size || t.usdcValue,
          price: t.price,
        })),
      },

      recentTrades: recentTrades.slice(0, 10).map(t => ({
        market: t.market || t.title,
        outcome: t.outcome,
        side: t.side,
        size: t.size || t.usdcValue,
        price: t.price,
        pnl: t.pnl || t.realizedPnl,
        reasoning: t.reasoning || t.agentReasoning,
        timestamp: t.timestamp,
      })),

      openPositions: openPositions.map(p => ({
        market: p.market || p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        unrealizedPnl: p.unrealizedPnl || p.cashPnl,
        pnlPercent: p.pnlPercent || p.percentPnl,
      })),
    });
  }

  return {
    vaults: results,
    totalVaults: results.length,
    queryParams: input,
  };
}

export const getVaultPerformanceTool = {
  name: 'get_vault_performance',
  description: 'Get live performance metrics for Yieldr trading vaults (NBA Edge, Soccer Alpha, Geopolitics). Returns ROI, PnL, recent trades with agent reasoning, open positions, 24h activity summary, and subscriber stats. Uses poly-agent data as fallback when vault-specific collections are empty.',
  inputSchema: getVaultPerformanceSchema,
  execute: executeGetVaultPerformance,
};
