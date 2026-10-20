/**
 * get_vault_performance Tool
 * Pull live vault performance metrics from MongoDB
 *
 * Data sources:
 *   `vaults` — full vault/trader profile (stats, categories, insider signals, etc.)
 *   `vault_openPositions` — live open positions, recent closed trades, HC trades, strengths/weaknesses
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

  // --- Fetch vault profile docs ---
  const vaultFilter: any = {};
  if (input.vaultName) {
    vaultFilter.traderLabel = { $regex: new RegExp(input.vaultName, 'i') };
  } else {
    vaultFilter.traderLabel = { $in: LIVE_VAULT_LABELS };
  }

  const vaults = await db.collection('vaults').find(vaultFilter).toArray();
  if (vaults.length === 0) {
    return { vaults: [], message: 'No vaults found.' };
  }

  // --- Fetch vault_openPositions for all vault wallets in one query ---
  const wallets = vaults.map(v => (v.wallet || v.sourceWallet || '').toLowerCase()).filter(Boolean);
  const vaultPosDocs = await db.collection('vault_openPositions')
    .find({ wallet: { $in: wallets } })
    .toArray();
  const posDocMap = new Map(vaultPosDocs.map(d => [d.wallet?.toLowerCase(), d]));

  const periodDays = input.period === '1d' ? 1 : input.period === '7d' ? 7 : input.period === '30d' ? 30 : 365;

  const results = [];

  for (const vault of vaults) {
    const traderWallet = (vault.wallet || vault.sourceWallet || '').toLowerCase();
    const posDoc = posDocMap.get(traderWallet);

    // Open positions from vault_openPositions.topOpenPositions
    const openPositions = (posDoc?.topOpenPositions || []).map((p: any) => ({
      market: p.title,
      outcome: p.outcome,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      currentValue: p.currentValue,
      unrealizedPnl: p.cashPnl,
      pnlPercent: p.percentPnl,
    }));

    // Recent closed trades from vault_openPositions.recentClosedPositions
    const recentTrades = (posDoc?.recentClosedPositions || []).slice(0, 15).map((t: any) => ({
      market: t.title,
      outcome: t.outcome,
      size: t.size,
      avgPrice: t.avgPrice,
      realizedPnl: t.realizedPnl,
      status: t.status,
      timestamp: t.timestamp,
    }));

    // Vault ROI from stored capital fields
    const vaultCapital = vault.initial_capital_usdc || 0;
    const vaultCurrentSize = vault.vault_size_usdc || vaultCapital;
    const vaultROI = vaultCapital > 0
      ? ((vaultCurrentSize - vaultCapital) / vaultCapital) * 100
      : null;

    // Period PnL/ROCE from timeframePnL
    const tf = vault.timeframePnL?.[`${periodDays}d`];

    // Position summary
    const winningPositions = openPositions.filter((p: any) => (p.unrealizedPnl || 0) > 0);
    const losingPositions = openPositions.filter((p: any) => (p.unrealizedPnl || 0) < 0);
    const totalUnrealizedPnl = openPositions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);

    // Serialize full documents — JSON-safe (converts Dates/ObjectIds)
    const fullVaultDoc = JSON.parse(JSON.stringify(vault));
    const fullPositionsDoc = posDoc ? JSON.parse(JSON.stringify(posDoc)) : null;

    results.push({
      name: vault.traderLabel || vault.label || `Vault-${vault._id?.toString().slice(0, 6)}`,
      specialty: vault.specialty,
      status: vault.status || 'active',

      performance: {
        period: input.period,
        vaultCapital,
        vaultCurrentSize,
        vaultROI,
        periodPnl: tf?.pnl ?? null,
        periodROCE: tf?.roce ?? null,
        periodWinRate: tf?.winRate ?? null,
      },

      positionSummary: {
        openCount: openPositions.length,
        winningCount: winningPositions.length,
        losingCount: losingPositions.length,
        totalUnrealizedPnl,
      },

      openPositions,
      recentTrades,

      // Full raw documents — the LLM gets everything
      vaultDoc: fullVaultDoc,
      positionsDoc: fullPositionsDoc,
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
  description: 'Get live performance metrics for the 3 Yieldr trading vaults (NBA Edge, Soccer Alpha, Geopolitics). Returns full vault profile, ROI, open positions, recent closed trades, HC trades, strengths/weaknesses from vault_openPositions.',
  inputSchema: getVaultPerformanceSchema,
  execute: executeGetVaultPerformance,
};
