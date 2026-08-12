import type { ConfidenceBlock, ConfidenceTier, EntryCategoryResult, ExitCategoryResult, SizingCategoryResult, Verdict } from './types';

// Doc-specified formula: verdict -> value, weighted by category, rescaled to 0-100, gated by confidence.
const VERDICT_VALUE: Record<Verdict, number> = {
  strong_edge: 1.0,
  possible_edge: 0.5,
  no_edge: 0,
  negative_edge: -0.5,
};

const WEIGHTS = { entry: 0.25, exit: 0.4, sizing: 0.35 };

const CONFIDENCE_MULTIPLIER: Record<ConfidenceTier, number> = {
  insufficient: 0.3,
  provisional: 0.7,
  high: 1.0,
};

export function computeCompositeScore(
  entry: EntryCategoryResult,
  exit: ExitCategoryResult,
  sizing: SizingCategoryResult,
  walletConfidence: ConfidenceBlock
): { edgeScore: number; rawWeightedSum: number } {
  const rawWeightedSum =
    VERDICT_VALUE[entry.verdict] * WEIGHTS.entry +
    VERDICT_VALUE[exit.verdict] * WEIGHTS.exit +
    VERDICT_VALUE[sizing.verdict] * WEIGHTS.sizing;

  const rescaled = ((rawWeightedSum + 1) / 2) * 100;
  const edgeScore = Math.round(rescaled * CONFIDENCE_MULTIPLIER[walletConfidence.tier]);

  return { edgeScore: Math.max(0, Math.min(100, edgeScore)), rawWeightedSum };
}
