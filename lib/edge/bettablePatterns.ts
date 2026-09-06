import type { EntryCategoryResult, ExitCategoryResult, SizingCategoryResult, BettablePattern } from './types';

/**
 * Tier-1 composite patterns: named behavioral signatures built from
 * multiple independent metrics that all point the same direction. These
 * are the closest thing to "a pattern a user could bet on" that's safe to
 * surface today without a full walk-forward backtest - each one combines
 * signals that reinforce each other rather than relying on a single
 * searched bucket split.
 */
export function detectBettablePatterns(
  entry: EntryCategoryResult,
  exit: ExitCategoryResult,
  sizing: SizingCategoryResult
): BettablePattern[] {
  const patterns: BettablePattern[] = [];

  // Disciplined Scaler: sizes up on conviction, doesn't size erratically, and takes profit in pieces.
  const scaledOutBucket = exit.conditionBreakdown.find((b) => b.conditionLabel === 'scaled_out');
  const isDisciplinedScaler =
    sizing.convictionRatio > 1.3 &&
    sizing.sizeSpectrumLabel !== 'erratic' &&
    !!scaledOutBucket &&
    scaledOutBucket.frequencyPct > 50;
  patterns.push({
    name: 'disciplined_scaler',
    label: 'Disciplined Scaler',
    detected: isDisciplinedScaler,
    evidence: isDisciplinedScaler
      ? `Sizes ${sizing.convictionRatio.toFixed(1)}x bigger on winners, size pattern is ${sizing.sizeSpectrumLabel}, and scales out on ${scaledOutBucket!.frequencyPct.toFixed(0)}% of exits`
      : `Needs conviction ratio > 1.3x (has ${sizing.convictionRatio === Infinity ? '∞' : sizing.convictionRatio.toFixed(1)}x), non-erratic sizing (has ${sizing.sizeSpectrumLabel}), and scaled-out exits on >50% of trades (has ${scaledOutBucket ? scaledOutBucket.frequencyPct.toFixed(0) + '%' : 'none'})`,
    confidenceTier: scaledOutBucket?.confidence.tier ?? sizing.confidence.tier,
  });

  // Loss-Averse Exiter: cuts losers faster than they let winners run, and rarely gives back a big unrealized gain.
  const isLossAverseExiter =
    exit.lossSideExitSpeedSeconds > 0 &&
    exit.winnerHoldTimeSeconds > 0 &&
    exit.lossSideExitSpeedSeconds < exit.winnerHoldTimeSeconds &&
    exit.roundTripRatePct < 25;
  patterns.push({
    name: 'loss_averse_exiter',
    label: 'Loss-Averse Exiter',
    detected: isLossAverseExiter,
    evidence: isLossAverseExiter
      ? `Exits losers in ${(exit.lossSideExitSpeedSeconds / 60).toFixed(0)}min vs holds winners ${(exit.winnerHoldTimeSeconds / 60).toFixed(0)}min, round-trip rate only ${exit.roundTripRatePct.toFixed(0)}%`
      : `Loss-side exit speed (${(exit.lossSideExitSpeedSeconds / 60).toFixed(0)}min) isn't clearly faster than winner hold time (${(exit.winnerHoldTimeSeconds / 60).toFixed(0)}min), or round-trip rate (${exit.roundTripRatePct.toFixed(0)}%) is too high`,
    confidenceTier: exit.confidence.tier,
  });

  // Repeat-Conviction Trader: performs meaningfully better re-buying tokens they already know than on first-time buys.
  const repeatBucket = entry.conditionBreakdown.find((b) => b.conditionLabel === 'Re-bought a token traded before');
  const freshBucket = entry.conditionBreakdown.find((b) => b.conditionLabel === 'First time trading this token');
  const isRepeatConviction =
    !!repeatBucket &&
    !!freshBucket &&
    repeatBucket.confidence.tier !== 'insufficient' &&
    repeatBucket.expectancyUsd > freshBucket.expectancyUsd &&
    repeatBucket.winRate > freshBucket.winRate;
  patterns.push({
    name: 'repeat_conviction_trader',
    label: 'Repeat-Conviction Trader',
    detected: isRepeatConviction,
    evidence:
      repeatBucket && freshBucket
        ? `Re-buying known tokens: ${(repeatBucket.winRate * 100).toFixed(0)}% win rate, $${repeatBucket.expectancyUsd.toFixed(0)}/trade vs first-time buys: ${(freshBucket.winRate * 100).toFixed(0)}% win rate, $${freshBucket.expectancyUsd.toFixed(0)}/trade`
        : 'Not enough repeat-token and first-time-token trades to compare',
    confidenceTier: repeatBucket?.confidence.tier ?? 'insufficient',
  });

  return patterns;
}
