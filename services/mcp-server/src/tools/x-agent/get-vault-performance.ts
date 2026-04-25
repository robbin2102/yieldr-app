/**
 * get_vault_performance Tool
 * Pull live vault performance metrics from MongoDB
 *
 * The `vaults` collection stores tracker configs — each tracked trader IS a vault.
 * Trades come from `ahf-copyTrades` filtered by sourceWallet.
 * Positions come from `polymarket-openPositions` filtered by walletAddress.
 *
 * The 3 live vaults are identified by traderLabel:
 *   'NBA Edge Vault', 'Soccer Alpha Vault', 'Geopolitics Vault'
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

export const getVaultPerformanceSchema = z.object({
  vaultName: z.string().optional().describe('Filter by vault name: "NBA Edge Vault", "Soccer Alpha Vault", "Geopolitics Vault", or omit for all 3'),
  period: z.enum(['1d', '7d', '30d', 'all']).optional().default('30d').describe('Performance period (default: 30d)'),
});

export type GetVaultPerformanceInput = z.infer<typeof getVaultPerformanceSchema>;

const LIVE_VAULT_LABELS = ['NBA Edge Vault', 'Soccer Alpha Vault', 'Geopolitics Vault'];

export async function executeGetVaultPerformance(input: GetVaultPerformanceInput) {
  const db = await getDB();

  const vaultsCol = db.collection('vaults');
  const vaultFilter: any = {};

  if (input.vaultName) {
    vaultFilter.traderLabel = { $regex: new RegExp(input.vaultName, 'i') };
  } else {
    vaultFilter.traderLabel = { $in: LIVE_VAULT_LABELS };
  }

  const vaults = await vaultsCol.find(vaultFilter).toArray();

  if (vaults.length === 0) {
    return { vaults: [], message: 'No vaults found.' };
  }

  const periodDays = input.period === '1d' ? 1 : input.period === '7d' ? 7 : input.period === '30d' ? 30 : 365;
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const results = [];

  for (const vault of vaults) {
    const traderWallet = (vault.wallet || vault.sourceWallet || '').toLowerCase();

    // --- Trades from ahf-copyTrades ---
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
        price: t.avgFillPrice || t.traderPrice,
        timestamp: t.filledAt || t.createdAt,
      }));
    }

    // --- Open positions from polymarket-openPositions (walletAddress field) ---
    let openPositions: any[] = [];
    if (traderWallet) {
      // Primary: poly-agent-positions (our mirrored positions)
      const polyPosCol = db.collection('poly-agent-positions');
      const polyPositions = await polyPosCol
        .find({
          targetWallet: { $regex: new RegExp(`^${traderWallet}$`, 'i') },
          status: { $in: ['SYNCED', 'PENDING', 'PARTIAL', 'UNDERWATER'] },
        })
        .sort({ lastSyncedAt: -1 })
        .limit(20)
        .toArray();

      if (polyPositions.length > 0) {
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
      } else {
        // Fallback: polymarket-openPositions — field is walletAddress (not wallet)
        const pmPosCol = db.collection('polymarket-openPositions');
        const pmPositions = await pmPosCol
          .find({
            walletAddress: { $regex: new RegExp(`^${traderWallet}$`, 'i') },
            curPrice: { $gte: 0.001 },
          })
          .sort({ currentValue: -1 })
          .limit(20)
          .toArray();

        openPositions = pmPositions.map(p => ({
          market: p.title,
          outcome: p.outcome,
          size: p.size,
          avgPrice: p.avgPrice,
          curPrice: p.curPrice,
          unrealizedPnl: p.cashPnl,
          pnlPercent: p.percentPnl,
          currentValue: p.currentValue,
          _source: 'polymarket-openPositions',
        }));
      }
    }

    // --- 24h activity ---
    const trades24h = recentTrades.filter(t => {
      const ts = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
      return ts >= last24h;
    });

    // --- Vault ROI from stored capital fields ---
    const vaultCapital = vault.initial_capital_usdc || 0;
    const vaultCurrentSize = vault.vault_size_usdc || vaultCapital;
    const vaultROI = vaultCapital > 0
      ? ((vaultCurrentSize - vaultCapital) / vaultCapital) * 100
      : null;

    // --- Period PnL/ROCE from timeframePnL ---
    const tf = vault.timeframePnL?.[`${periodDays}d`];

    // --- Winning/losing position summary ---
    const winningPositions = openPositions.filter(p => (p.unrealizedPnl || 0) > 0);
    const losingPositions = openPositions.filter(p => (p.unrealizedPnl || 0) < 0);
    const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);

    // Serialize the full vault document (converts Dates/ObjectIds to JSON-safe values)
    const fullVaultDoc = JSON.parse(JSON.stringify(vault));

    results.push({
      // Vault identity
      name: vault.traderLabel || vault.label || `Vault-${vault._id?.toString().slice(0, 6)}`,
      specialty: vault.specialty,
      status: vault.status || 'active',

      // Computed performance (not in vault doc)
      performance: {
        period: input.period,
        vaultCapital,
        vaultCurrentSize,
        vaultROI,
        periodPnl: tf?.pnl ?? null,
        periodROCE: tf?.roce ?? null,
        periodWinRate: tf?.winRate ?? null,
      },

      // Position summary
      positionSummary: {
        openCount: openPositions.length,
        winningCount: winningPositions.length,
        losingCount: losingPositions.length,
        totalUnrealizedPnl,
      },

      // Activity
      activity24h: {
        tradesExecuted: trades24h.length,
        trades: trades24h.slice(0, 5),
      },

      // Raw fetched data
      recentTrades: recentTrades.slice(0, 10),
      openPositions,

      // Full vault document — every field from MongoDB
      vaultDoc: fullVaultDoc,
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
  description: 'Get live performance metrics for the 3 Yieldr trading vaults (NBA Edge, Soccer Alpha, Geopolitics). Returns full vault profile, ROI, open positions from polymarket-openPositions, and 24h activity.',
  inputSchema: getVaultPerformanceSchema,
  execute: executeGetVaultPerformance,
};
