/**
 * The luck-vs-skill test: does an apparent pattern survive losing its best
 * trade, and does it hold up across resampled versions of its own trade
 * history? This is the single highest-leverage addition for turning a
 * "descriptive" bucket (this is what happened) into something closer to
 * "predictive" (this would probably still be true on a different sample of
 * the same behavior) - see the edge-detection first-principles review this
 * module answers.
 *
 * Deliberately NOT a full walk-forward/out-of-sample backtest (that needs
 * chronological train/test splitting at the bucket-discovery level, a
 * bigger change) - this is the cheaper, still-meaningful check: is the
 * apparent edge dominated by one trade or one token, and does its sign
 * survive resampling.
 */
import type { LuckTestResult } from './types';
export type { LuckTestResult };

const BOOTSTRAP_ITERATIONS = 500;
/** Fixed seed - deterministic across runs of the same trade set so a report doesn't flicker between re-analyses, not a security property. */
const BOOTSTRAP_SEED = 20260906;

/** Minimum bar for "robust": at least this many trades, spanning at least this many distinct tokens. */
const MIN_TRADES_FOR_ROBUST = 5;
const MIN_TOKENS_FOR_ROBUST = 3;
/** Bootstrap resamples must show positive expectancy at least this often. */
const MIN_BOOTSTRAP_POSITIVE_PCT = 75;
/** No single trade may account for more than this share of total profit. */
const MAX_BEST_TRADE_PNL_SHARE_PCT = 60;

function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeLuckTest(positions: { realizedPnlUsd: number; tokenAddress: string }[]): LuckTestResult {
  const n = positions.length;
  const pnls = positions.map((p) => p.realizedPnlUsd);
  const distinctTokenCount = new Set(positions.map((p) => p.tokenAddress)).size;
  const totalPnl = pnls.reduce((s, v) => s + v, 0);
  const expectancyAllUsd = n > 0 ? totalPnl / n : 0;

  let bestTradePnlUsd: number | null = null;
  let expectancyExcludingBestUsd = expectancyAllUsd;
  let pctOfTotalPnlFromBestTrade: number | null = null;
  if (n >= 2) {
    bestTradePnlUsd = Math.max(...pnls);
    expectancyExcludingBestUsd = (totalPnl - bestTradePnlUsd) / (n - 1);
    pctOfTotalPnlFromBestTrade = totalPnl > 0 ? (bestTradePnlUsd / totalPnl) * 100 : null;
  }

  let bootstrapPositiveExpectancyPct: number;
  if (n === 0) {
    bootstrapPositiveExpectancyPct = 0;
  } else if (n === 1) {
    bootstrapPositiveExpectancyPct = pnls[0] > 0 ? 100 : 0;
  } else {
    const rand = mulberry32(BOOTSTRAP_SEED + n);
    let positiveCount = 0;
    for (let b = 0; b < BOOTSTRAP_ITERATIONS; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += pnls[Math.floor(rand() * n)];
      if (sum > 0) positiveCount++;
    }
    bootstrapPositiveExpectancyPct = (positiveCount / BOOTSTRAP_ITERATIONS) * 100;
  }

  const robust =
    n >= MIN_TRADES_FOR_ROBUST &&
    distinctTokenCount >= MIN_TOKENS_FOR_ROBUST &&
    expectancyExcludingBestUsd > 0 &&
    bootstrapPositiveExpectancyPct >= MIN_BOOTSTRAP_POSITIVE_PCT &&
    (pctOfTotalPnlFromBestTrade === null || pctOfTotalPnlFromBestTrade < MAX_BEST_TRADE_PNL_SHARE_PCT);

  return {
    n,
    distinctTokenCount,
    expectancyAllUsd,
    expectancyExcludingBestUsd,
    bestTradePnlUsd,
    pctOfTotalPnlFromBestTrade,
    bootstrapPositiveExpectancyPct,
    robust,
  };
}
