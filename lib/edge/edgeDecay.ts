import type { EdgeSnapshotPoint, EdgeDecayResult } from './types';

/** How many trailing prior snapshots to average against - smooths a single noisy run without going stale. */
const DECAY_LOOKBACK_SNAPSHOTS = 3;
const DECAY_EDGE_SCORE_THRESHOLD = 10;
const DECAY_WIN_RATE_THRESHOLD_PCT = 10;

function avg(nums: number[]): number {
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

/**
 * Compares the wallet's current edge snapshot against the trailing average
 * of its own prior runs (pulled from EdgeScore.history, already persisted
 * on every analysis) - "is this trader's edge holding up over time", not
 * a prediction about the next trade. Needs at least 2 prior snapshots to
 * say anything; below that it's honestly 'insufficient_history' rather
 * than a guess from one data point.
 */
export function computeEdgeDecay(
  priorHistory: EdgeSnapshotPoint[],
  current: EdgeSnapshotPoint
): EdgeDecayResult {
  const chronological = [...priorHistory].sort((a, b) => a.computedAt.getTime() - b.computedAt.getTime());
  const snapshots = [...chronological, current];

  if (chronological.length < 2) {
    return {
      status: 'insufficient_history',
      edgeScoreDelta: null,
      winRateDeltaPct: null,
      expectancyDeltaUsd: null,
      priorSnapshotCount: chronological.length,
      snapshots,
    };
  }

  const trailing = chronological.slice(-DECAY_LOOKBACK_SNAPSHOTS);
  const avgEdgeScore = avg(trailing.map((s) => s.edgeScore));
  const avgWinRate = avg(trailing.map((s) => s.winRate));
  const avgExpectancy = avg(trailing.map((s) => s.expectancyUsd));

  const edgeScoreDelta = current.edgeScore - avgEdgeScore;
  const winRateDeltaPct = (current.winRate - avgWinRate) * 100;
  const expectancyDeltaUsd = current.expectancyUsd - avgExpectancy;

  let status: EdgeDecayResult['status'] = 'stable';
  if (
    edgeScoreDelta <= -DECAY_EDGE_SCORE_THRESHOLD ||
    (winRateDeltaPct <= -DECAY_WIN_RATE_THRESHOLD_PCT && expectancyDeltaUsd < 0)
  ) {
    status = 'decaying';
  } else if (
    edgeScoreDelta >= DECAY_EDGE_SCORE_THRESHOLD ||
    (winRateDeltaPct >= DECAY_WIN_RATE_THRESHOLD_PCT && expectancyDeltaUsd > 0)
  ) {
    status = 'improving';
  }

  return {
    status,
    edgeScoreDelta,
    winRateDeltaPct,
    expectancyDeltaUsd,
    priorSnapshotCount: chronological.length,
    snapshots,
  };
}
