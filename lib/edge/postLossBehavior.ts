import { confidenceTier } from './stats';
import type { ReconstructedPosition, PostLossBehaviorResult, PostLossLabel } from './types';
export type { PostLossBehaviorResult, PostLossLabel };

/** How many trades immediately following a big loss count as the "post-loss window". */
const POST_LOSS_WINDOW = 3;
/** Losses in the worst quartile (by $ magnitude) count as "big" - not just any red trade. */
const BIG_LOSS_PERCENTILE = 0.75;
/** Window avg size at or above this multiple of baseline avg size reads as tilt/revenge-sizing. */
const REVENGE_SIZE_RATIO = 1.3;
/** Window avg size at or below this multiple of baseline, with win rate not badly degraded, reads as staying disciplined. */
const DISCIPLINED_SIZE_RATIO = 1.1;
const DISCIPLINED_WIN_RATE_FLOOR = 0.8; // win rate post-loss must be at least 80% of baseline to count as "disciplined", not just small

type ClosedPosition = ReconstructedPosition & { realizedPnlUsd: number; exitTs: Date };

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((s, v) => s + v, 0) / nums.length;
}

export function computePostLossBehavior(allClosedPositions: ReconstructedPosition[]): PostLossBehaviorResult {
  const positions = allClosedPositions.filter(
    (p) => !p.isOpen && !p.isDust && p.realizedPnlUsd !== null && p.exitTs !== null
  ) as ClosedPosition[];

  const chronological = [...positions].sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime());
  const baselineAvgSize = avg(chronological.map((p) => p.totalSizeUsd));
  const winRateBaseline =
    chronological.length > 0 ? chronological.filter((p) => p.realizedPnlUsd > 0).length / chronological.length : 0;

  const empty = (bigLossEventCount: number): PostLossBehaviorResult => ({
    bigLossEventCount,
    windowTradesAnalyzed: 0,
    avgSizeRatioPostLoss: null,
    winRatePostLoss: null,
    winRateBaseline,
    label: 'no_signal',
    confidenceTier: confidenceTier(0),
  });

  const losses = chronological.filter((p) => p.realizedPnlUsd < 0);
  if (losses.length < 3) return empty(0);

  const lossMagnitudes = losses.map((p) => Math.abs(p.realizedPnlUsd)).sort((a, b) => a - b);
  const thresholdIdx = Math.min(Math.floor(lossMagnitudes.length * BIG_LOSS_PERCENTILE), lossMagnitudes.length - 1);
  const bigLossThreshold = lossMagnitudes[thresholdIdx];
  const bigLosses = losses.filter((p) => Math.abs(p.realizedPnlUsd) >= bigLossThreshold);

  // Pooled across every qualifying big-loss event - windows can overlap when big losses cluster close together;
  // trades then get counted once per triggering loss, which is fine for "how do you behave right after a big loss" in aggregate.
  const windowPositions: ClosedPosition[] = [];
  for (const bigLoss of bigLosses) {
    const after = chronological.filter((p) => p.entryTs.getTime() > bigLoss.exitTs.getTime()).slice(0, POST_LOSS_WINDOW);
    windowPositions.push(...after);
  }

  if (windowPositions.length === 0) return empty(bigLosses.length);

  const windowAvgSize = avg(windowPositions.map((p) => p.totalSizeUsd));
  const avgSizeRatioPostLoss = baselineAvgSize > 0 ? windowAvgSize / baselineAvgSize : null;
  const winRatePostLoss = windowPositions.filter((p) => p.realizedPnlUsd > 0).length / windowPositions.length;

  let label: PostLossLabel = 'no_signal';
  if (avgSizeRatioPostLoss !== null) {
    if (avgSizeRatioPostLoss >= REVENGE_SIZE_RATIO) label = 'revenge_sizing';
    else if (avgSizeRatioPostLoss <= DISCIPLINED_SIZE_RATIO && winRatePostLoss >= winRateBaseline * DISCIPLINED_WIN_RATE_FLOOR) {
      label = 'disciplined_after_loss';
    }
  }

  return {
    bigLossEventCount: bigLosses.length,
    windowTradesAnalyzed: windowPositions.length,
    avgSizeRatioPostLoss,
    winRatePostLoss,
    winRateBaseline,
    label,
    confidenceTier: confidenceTier(windowPositions.length),
  };
}
