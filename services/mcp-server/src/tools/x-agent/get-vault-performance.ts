/**
 * get_vault_performance Tool
 * Pull live vault performance metrics from MongoDB
 *
 * The `vaults` collection stores tracker configs — each tracked trader IS a vault.
 * Trades come from `ahf-copyTrades` filtered by sourceWallet.
 * Positions come from `poly-agent-positions` filtered by targetWallet.
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getVaultPerformanceSchema = z.object({
  vaultName: z.string().optional().describe('Filter by vault name or specialty: "NBA Edge", "Soccer Alpha", "Geopolitics", or omit for all'),
  period: z.enum(['1d', '7d', '30d', 'all']).optional().default('30d').describe('Performance period (default: 30d)'),
});

export type GetVaultPerformanceInput = z.infer<typeof getVaultPerformanceSchema>;

const VAULT_NAME_MAP: Record<string, string> = {
  'NBA': 'NBA Edge Vault',
  'Soccer': 'Soccer Alpha Vault',
  'Politics': 'Geopolitics Vault',
  'Geopolitics': 'Geopolitics Vault',
  'Crypto': 'Crypto Alpha Vault',
  'Finance': 'Finance Vault',
};

function resolveVaultName(doc: any): string {
  if (doc.name && !doc.name.includes('|')) return doc.name;
  if (doc.vaultName) return doc.vaultName;

  const specialty = doc.specialty || '';
  for (const [key, name] of Object.entries(VAULT_NAME_MAP)) {
    if (specialty.toLowerCase().includes(key.toLowerCase())) return name;
  }

  const label = doc.label || doc.traderLabel || '';
  for (const [key, name] of Object.entries(VAULT_NAME_MAP)) {
    if (label.toLowerCase().includes(key.toLowerCase())) return name;
  }

  const displayName = doc.display_name || doc.pseudonym;
  if (displayName) return `${displayName} Vault`;

  return `Vault-${(doc._id?.toString() || 'unknown').slice(0, 6)}`;
}

export async function executeGetVaultPerformance(input: GetVaultPerformanceInput) {
  const db = await getDB();

  const vaultsCol = db.collection('vaults');
  const vaultFilter: any = {};
  if (input.vaultName) {
    vaultFilter.$or = [
      { name: { $regex: new RegExp(input.vaultName, 'i') } },
      { vaultName: { $regex: new RegExp(input.vaultName, 'i') } },
      { specialty: { $regex: new RegExp(input.vaultName, 'i') } },
      { label: { $regex: new RegExp(input.vaultName, 'i') } },
      { display_name: { $regex: new RegExp(input.vaultName, 'i') } },
    ];
  }

  const vaults = await vaultsCol.find(vaultFilter).toArray();

  if (vaults.length === 0) {
    return { vaults: [], message: 'No vaults found.' };
  }

  const periodDays = input.period === '1d' ? 1 : input.period === '7d' ? 7 : input.period === '30d' ? 30 : 365;
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const results = [];

  for (const vault of vaults) {
    const vaultName = resolveVaultName(vault);
    const traderWallet = (vault.wallet || vault.sourceWallet || '').toLowerCase();

    // --- Trades from ahf-copyTrades (primary) ---
    let recentTrades: any[] = [];
    if (traderWallet) {
      const copyTradesCol = db.collection('ahf-copyTrades');
      const copyTrades = await copyTradesCol
        .find({
          sourceWallet: { $regex: new RegExp(`^${traderWallet}$`, 'i') },
          status: 'FILLED',
        })
        .sort({ filledAt: -1, createdAt: -1 })
        .limit(10)
        .toArray();

      recentTrades = copyTrades.map(t => ({
        market: t.title || t.market,
        outcome: t.outcome,
        side: t.side,
        size: t.filledUsdc || t.copyBetUsdc || t.traderBetUsdc,
        traderSize: t.traderBetUsdc,
        price: t.avgFillPrice || t.traderPrice,
        pnl: null,
        latencyMs: t.totalLatencyMs,
        timestamp: t.filledAt || t.createdAt,
        _source: 'ahf-copyTrades',
      }));
    }

    // Fallback to poly-agent-trades
    if (recentTrades.length === 0) {
      const polyTradesCol = db.collection('poly-agent-trades');
      const polyTrades = await polyTradesCol
        .find({ status: 'FILLED' })
        .sort({ confirmedAt: -1 })
        .limit(10)
        .toArray();

      recentTrades = polyTrades.map(t => ({
        market: t.original?.title || t.title,
        outcome: t.original?.outcome || t.outcome,
        side: t.original?.side || t.side,
        size: t.copy?.executedUsdcSize || t.original?.usdcSize,
        price: t.copy?.executedPrice || t.original?.price,
        pnl: null,
        timestamp: t.confirmedAt || t.executedAt || t.createdAt,
        _source: 'poly-agent-trades',
      }));
    }

    // --- Open positions from poly-agent-positions ---
    let openPositions: any[] = [];
    if (traderWallet) {
      const polyPosCol = db.collection('poly-agent-positions');
      const polyPositions = await polyPosCol
        .find({
          targetWallet: { $regex: new RegExp(`^${traderWallet}$`, 'i') },
          status: { $in: ['SYNCED', 'PENDING', 'PARTIAL'] },
        })
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
        status: p.status,
        _source: 'poly-agent-positions',
      }));
    }

    // Also try vault_openPositions as fallback
    if (openPositions.length === 0) {
      const vaultPosCol = db.collection('vault_openPositions');
      const vaultPositions = await vaultPosCol.find({}).limit(20).toArray();
      openPositions = vaultPositions.map(p => ({
        market: p.market || p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        unrealizedPnl: p.cashPnl || p.unrealizedPnl,
        pnlPercent: p.percentPnl,
      }));
    }

    // --- 24h activity ---
    const trades24h = recentTrades.filter(t => {
      const ts = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
      return ts >= last24h;
    });

    // --- Performance metrics from vault doc ---
    const totalPnl = vault.totalPnlAllTime || vault.totalRealizedPnl || 0;
    const unrealizedPnl = vault.totalUnrealizedPnl || 0;
    const capitalDeployed = vault.totalCapitalDeployed || vault.initial_capital_usdc || 0;
    const vaultSize = vault.vault_size_usdc || capitalDeployed;
    const winRate = vault.win_rate || vault.winRate;
    const profitFactor = vault.profitFactor;

    // Calculate period ROI from vault's timeframePnL if available
    let periodRoi = 0;
    if (vault.timeframePnL && capitalDeployed > 0) {
      const periodPnl = vault.timeframePnL[`${periodDays}d`] || vault.timeframePnL.allTime || 0;
      periodRoi = (periodPnl / capitalDeployed) * 100;
    } else if (vault.roce_trend && capitalDeployed > 0) {
      periodRoi = vault.roce_trend[`${periodDays}d`] || 0;
    }

    // Winning/losing position counts
    const winningPositions = openPositions.filter(p => (p.unrealizedPnl || 0) > 0);
    const losingPositions = openPositions.filter(p => (p.unrealizedPnl || 0) < 0);
    const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    results.push({
      name: vaultName,
      description: vault.edge_hypothesis || vault.description,
      specialty: vault.specialty,
      status: vault.status || 'active',

      performance: {
        period: input.period,
        roi: periodRoi,
        totalPnl,
        unrealizedPnl,
        capitalDeployed,
        vaultSize,
      },

      stats: {
        totalTrades: vault.totalActivities || vault.buyCount || recentTrades.length,
        winRate,
        profitFactor,
        winsClosed: vault.wins_closed,
        lossesClosed: vault.losses_closed,
        openPositionCount: openPositions.length,
        winningPositionCount: winningPositions.length,
        losingPositionCount: losingPositions.length,
        totalUnrealizedPnl,
      },

      activity24h: {
        tradesExecuted: trades24h.length,
        trades: trades24h.slice(0, 3).map(t => ({
          market: t.market,
          outcome: t.outcome,
          side: t.side,
          size: t.size,
          price: t.price,
        })),
      },

      recentTrades: recentTrades.slice(0, 10).map(t => ({
        market: t.market,
        outcome: t.outcome,
        side: t.side,
        size: t.size,
        price: t.price,
        pnl: t.pnl,
        timestamp: t.timestamp,
      })),

      openPositions: openPositions.map(p => ({
        market: p.market,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        unrealizedPnl: p.unrealizedPnl,
        pnlPercent: p.pnlPercent,
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
  description: 'Get live performance metrics for Yieldr trading vaults (NBA Edge, Soccer Alpha, Geopolitics). Returns ROI, PnL, recent trades, open positions from poly-agent, and 24h activity. Each vault tracks a top edge-ranked trader.',
  inputSchema: getVaultPerformanceSchema,
  execute: executeGetVaultPerformance,
};
