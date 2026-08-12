import type { ConfidenceBlock, ConfidenceTier } from './types';

/** Standard normal CDF via the Abramowitz-Stegun approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Wilson score interval - a proportion CI that behaves sanely at small n, unlike a naive normal approximation. */
export function wilsonScoreInterval(wins: number, n: number, z = 1.95996398454): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = phat + (z * z) / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n);
  return { low: Math.max(0, (center - margin) / denom), high: Math.min(1, (center + margin) / denom) };
}

/** Two-proportion z-test, two-sided. Null below a minimum sample per side - not enough data to say anything. */
export function twoProportionPValue(wins1: number, n1: number, wins2: number, n2: number): number | null {
  if (n1 < 5 || n2 < 5) return null;
  const p1 = wins1 / n1;
  const p2 = wins2 / n2;
  const pPool = (wins1 + wins2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (p1 - p2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

export function confidenceTier(n: number): ConfidenceTier {
  if (n < 30) return 'insufficient';
  if (n < 75) return 'provisional';
  return 'high';
}

/**
 * Practical stand-in for the doc's "out-of-sample split" requirement: does
 * the metric's direction relative to baseline hold in the most recent
 * ~25% of trades, not just in-sample overall? Null when there isn't
 * enough data to split meaningfully - we never fabricate a verdict.
 */
export function recencyConsistent(
  chronologicalWins: boolean[],
  baselineWinRate: number
): boolean | null {
  const n = chronologicalWins.length;
  if (n < 8) return null;

  const splitAt = Math.floor(n * 0.75);
  const earlier = chronologicalWins.slice(0, splitAt);
  const recent = chronologicalWins.slice(splitAt);
  if (recent.length < 2) return null;

  const earlierRate = earlier.filter(Boolean).length / earlier.length;
  const recentRate = recent.filter(Boolean).length / recent.length;

  const earlierDirection = earlierRate >= baselineWinRate;
  const recentDirection = recentRate >= baselineWinRate;
  return earlierDirection === recentDirection;
}

export function buildConfidenceBlock(
  wins: number,
  n: number,
  baselineWins: number,
  baselineN: number,
  chronologicalWins: boolean[],
  baselineWinRate: number
): ConfidenceBlock {
  const ci = wilsonScoreInterval(wins, n);
  return {
    tier: confidenceTier(n),
    trades: n,
    winRateCiLow: n > 0 ? ci.low : null,
    winRateCiHigh: n > 0 ? ci.high : null,
    pValueVsBaseline: twoProportionPValue(wins, n, baselineWins, baselineN),
    recencyConsistent: recencyConsistent(chronologicalWins, baselineWinRate),
  };
}
