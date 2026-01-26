/**
 * compare_traders Tool
 * Side-by-side comparison of multiple traders
 */

import { z } from 'zod';
import { comparePMTraders, comparePerpTraders } from '../../db/index.js';

export const compareTradersSchema = z.object({
  wallets: z.array(z.string()).describe('Array of wallet addresses to compare'),
  protocol: z.enum(['polymarket', 'hyperliquid', 'avantis']).optional().describe('Protocol to compare traders from'),
});

export type CompareTradersInput = z.infer<typeof compareTradersSchema>;

export interface TraderComparison {
  wallet: string;
  label?: string;
  metrics: {
    winRate: number;
    pnl: number;
    profitFactor?: number;
    sharpeRatio?: number;
    totalTrades: number;
  };
}

export interface CompareTradersOutput {
  comparison: TraderComparison[];
  rankings: {
    byWinRate: string[];
    byPnl: string[];
    byRiskAdjusted: string[];
  };
  recommendation: string;
}

export async function executeCompareTraders(
  input: CompareTradersInput
): Promise<CompareTradersOutput> {
  const protocol = input.protocol || 'polymarket';

  let comparison: TraderComparison[];

  if (protocol === 'polymarket') {
    const traders = await comparePMTraders(input.wallets);
    comparison = traders.map(t => ({
      wallet: t.wallet,
      label: t.label,
      metrics: {
        winRate: t.winRate,
        pnl: t.netPnl,
        profitFactor: t.profitFactor,
        totalTrades: t.buyCount + t.sellCount,
      },
    }));
  } else {
    const traders = await comparePerpTraders(
      input.wallets,
      protocol as 'hyperliquid' | 'avantis'
    );
    comparison = traders.map(t => ({
      wallet: t.walletAddress,
      metrics: {
        winRate: t.winRate,
        pnl: t.pnl_allTime,
        sharpeRatio: t.sharpeRatio,
        totalTrades: t.totalTrades,
      },
    }));
  }

  // Sort for rankings
  const byWinRate = [...comparison]
    .sort((a, b) => b.metrics.winRate - a.metrics.winRate)
    .map(t => t.wallet);

  const byPnl = [...comparison]
    .sort((a, b) => b.metrics.pnl - a.metrics.pnl)
    .map(t => t.wallet);

  const byRiskAdjusted = [...comparison]
    .sort((a, b) => {
      const aScore = (a.metrics.sharpeRatio || a.metrics.profitFactor || 0);
      const bScore = (b.metrics.sharpeRatio || b.metrics.profitFactor || 0);
      return bScore - aScore;
    })
    .map(t => t.wallet);

  // Generate recommendation
  const bestOverall = comparison.reduce((best, current) => {
    const currentScore = current.metrics.winRate * 0.3 +
      (current.metrics.pnl > 0 ? 0.4 : 0) +
      ((current.metrics.sharpeRatio || current.metrics.profitFactor || 0) > 1 ? 0.3 : 0);
    const bestScore = best.metrics.winRate * 0.3 +
      (best.metrics.pnl > 0 ? 0.4 : 0) +
      ((best.metrics.sharpeRatio || best.metrics.profitFactor || 0) > 1 ? 0.3 : 0);
    return currentScore > bestScore ? current : best;
  }, comparison[0]);

  const recommendation = bestOverall
    ? `${bestOverall.wallet.slice(0, 8)}... shows the best risk-adjusted performance with ${(bestOverall.metrics.winRate * 100).toFixed(1)}% win rate and $${bestOverall.metrics.pnl.toLocaleString()} PnL.`
    : 'Unable to determine recommendation - insufficient data.';

  return {
    comparison,
    rankings: {
      byWinRate,
      byPnl,
      byRiskAdjusted,
    },
    recommendation,
  };
}

export const compareTradersTool = {
  name: 'compare_traders',
  description: 'Compare multiple traders side-by-side. Returns metrics comparison and rankings by different criteria.',
  inputSchema: compareTradersSchema,
  execute: executeCompareTraders,
};
