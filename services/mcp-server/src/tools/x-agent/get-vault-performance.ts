/**
 * get_vault_performance Tool
 * Pull live vault performance metrics from MongoDB
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

  const results = [];

  for (const vault of vaults) {
    const vaultId = vault._id?.toString() || vault.id || vault.name;

    // Get latest snapshot
    const snapshotsCol = db.collection('vault_daily_snapshots');
    const latestSnapshot = await snapshotsCol
      .findOne(
        { $or: [{ vaultId }, { vaultName: vault.name }] },
        { sort: { timestamp: -1 } }
      );

    // Get period snapshots for ROI calculation
    const periodDays = input.period === '1d' ? 1 : input.period === '7d' ? 7 : input.period === '30d' ? 30 : 365;
    const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    const periodSnapshots = await snapshotsCol
      .find({
        $or: [{ vaultId }, { vaultName: vault.name }],
        timestamp: { $gte: periodStart },
      })
      .sort({ timestamp: 1 })
      .toArray();

    // Get recent trades
    const tradesCol = db.collection('vault_trades');
    const recentTrades = await tradesCol
      .find({ $or: [{ vaultId }, { vaultName: vault.name }] })
      .sort({ timestamp: -1 })
      .limit(10)
      .toArray();

    // Get open positions
    const positionsCol = db.collection('vault_openPositions');
    const openPositions = await positionsCol
      .find({ $or: [{ vaultId }, { vaultName: vault.name }] })
      .toArray();

    // Calculate ROI
    let periodRoi = 0;
    if (periodSnapshots.length >= 2) {
      const startValue = periodSnapshots[0].totalValue || periodSnapshots[0].nav || 0;
      const endValue = periodSnapshots[periodSnapshots.length - 1].totalValue || periodSnapshots[periodSnapshots.length - 1].nav || 0;
      if (startValue > 0) {
        periodRoi = ((endValue - startValue) / startValue) * 100;
      }
    }

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
      },

      recentTrades: recentTrades.slice(0, 5).map(t => ({
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
        unrealizedPnl: p.cashPnl || p.unrealizedPnl,
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
  description: 'Get live performance metrics for Yieldr trading vaults (NBA Edge, Soccer Alpha, Geopolitics). Returns ROI, PnL, recent trades with agent reasoning, open positions, and subscriber stats.',
  inputSchema: getVaultPerformanceSchema,
  execute: executeGetVaultPerformance,
};
