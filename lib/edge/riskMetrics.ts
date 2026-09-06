/**
 * Risk-adjusted, size-normalized trade returns - expectancy, median return,
 * and per-trade Sharpe/Sortino. Normalized by position size (% return per
 * trade, not raw $) so a wallet's biggest bets don't dominate the shape of
 * the distribution the way raw-dollar stats can.
 *
 * Explicitly NOT regime-normalized: these ratios say nothing about whether
 * the wallet was skilled or just present during a market that lifted
 * everything (that needs a market/regime benchmark series, which is
 * coin/market data we don't fetch in wallet-only mode). And these are
 * per-trade ratios, not time-annualized like a textbook Sharpe - trades
 * are event-driven and irregular, so annualizing would imply false
 * precision.
 */
import type { RiskAdjustedStats } from './types';
export type { RiskAdjustedStats };

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeRiskAdjustedStats(
  positions: { realizedPnlUsd: number; totalSizeUsd: number }[]
): RiskAdjustedStats {
  const returns = positions.filter((p) => p.totalSizeUsd > 0).map((p) => (p.realizedPnlUsd / p.totalSizeUsd) * 100);
  const n = returns.length;

  if (n === 0) {
    return {
      n: 0,
      meanReturnPct: 0,
      medianReturnPct: 0,
      stdDevReturnPct: 0,
      downsideDeviationPct: 0,
      sharpeRatio: null,
      sortinoRatio: null,
      bestTradeReturnPct: null,
      worstTradeReturnPct: null,
    };
  }

  const meanReturnPct = returns.reduce((s, v) => s + v, 0) / n;
  const medianReturnPct = median(returns);
  const variance = returns.reduce((s, v) => s + (v - meanReturnPct) ** 2, 0) / n;
  const stdDevReturnPct = Math.sqrt(variance);

  const downside = returns.filter((v) => v < 0);
  const downsideVariance = downside.length > 0 ? downside.reduce((s, v) => s + v ** 2, 0) / downside.length : 0;
  const downsideDeviationPct = Math.sqrt(downsideVariance);

  return {
    n,
    meanReturnPct,
    medianReturnPct,
    stdDevReturnPct,
    downsideDeviationPct,
    sharpeRatio: n >= 2 && stdDevReturnPct > 0 ? meanReturnPct / stdDevReturnPct : null,
    sortinoRatio: n >= 2 && downsideDeviationPct > 0 ? meanReturnPct / downsideDeviationPct : null,
    bestTradeReturnPct: Math.max(...returns),
    worstTradeReturnPct: Math.min(...returns),
  };
}
