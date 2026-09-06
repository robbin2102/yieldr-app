import { buildConfidenceBlock } from './stats';
import { computeLuckTest } from './luckTest';
import type { ReconstructedPosition, ExitCategoryResult, ExitConditionBucket, ExitStyleLabel, Verdict } from './types';

const MIN_BUCKET = 2;
const RUNUP_THRESHOLD_PCT = 10; // peak needs to be at least this far above entry to count as "was up"

type ClosedPosition = ReconstructedPosition & { realizedPnlUsd: number; exitTs: Date; avgExitPriceUsd: number };

function isWin(p: ClosedPosition) {
  return p.realizedPnlUsd > 0;
}
function winRate(g: ClosedPosition[]) {
  return g.length === 0 ? 0 : g.filter(isWin).length / g.length;
}
function expectancyUsd(g: ClosedPosition[]) {
  return g.length === 0 ? 0 : g.reduce((s, p) => s + p.realizedPnlUsd, 0) / g.length;
}

/**
 * Wallet-only proxy for the token's peak price between entry and exit: the
 * highest individual sell-leg price actually seen. MVP runs without OHLC
 * (analyze.ts no longer calls enrichExitContext), so p.peakPriceUsd is
 * always null here in practice - this proxy is the real signal source.
 * Needs 2+ sell legs to mean anything: a single-sell exit reveals nothing
 * about what price did in between, so this returns null rather than
 * fabricating a peak, and that position is simply excluded from
 * peak-capture / round-trip analysis (same "degrade to null" convention
 * as the rest of the pipeline). If coin-context enrichment is re-enabled
 * post-MVP, the real OHLC-derived peakPriceUsd takes priority.
 */
function effectivePeakPriceUsd(p: ClosedPosition): number | null {
  if (p.peakPriceUsd !== null) return p.peakPriceUsd;
  const sellPrices = p.legs.filter((l) => l.side === 'sell').map((l) => l.priceUsd);
  if (sellPrices.length < 2) return null;
  return Math.max(...sellPrices);
}

/** (exit - entry) / (peak - entry), clamped to [0,1]. Null if the price never meaningfully rose above entry - there was no run to capture. */
function peakCapturePct(p: ClosedPosition): number | null {
  const peak = effectivePeakPriceUsd(p);
  if (peak === null) return null;
  const runUp = peak - p.avgEntryPriceUsd;
  if (runUp <= 0 || p.avgEntryPriceUsd === 0 || (peak / p.avgEntryPriceUsd - 1) * 100 < RUNUP_THRESHOLD_PCT / 2) return null;
  const captured = (p.avgExitPriceUsd - p.avgEntryPriceUsd) / runUp;
  return Math.max(0, Math.min(1, captured));
}

function wasUpMeaningfully(p: ClosedPosition): boolean {
  const peak = effectivePeakPriceUsd(p);
  if (peak === null || p.avgEntryPriceUsd === 0) return false;
  return (peak / p.avgEntryPriceUsd - 1) * 100 >= RUNUP_THRESHOLD_PCT;
}

function classifyExitStyle(p: ClosedPosition): ExitStyleLabel {
  const sellLegs = p.legs.filter((l) => l.side === 'sell').length;
  if (wasUpMeaningfully(p) && !isWin(p)) return 'held_into_loss_after_being_up';
  return sellLegs >= 2 ? 'scaled_out' : 'sold_all_at_once';
}

export function computeExitCategory(allClosedPositions: ReconstructedPosition[]): ExitCategoryResult {
  const positions = allClosedPositions.filter(
    (p) => !p.isOpen && !p.isDust && p.realizedPnlUsd !== null && p.exitTs !== null && p.avgExitPriceUsd !== null
  ) as ClosedPosition[];

  const baselineWinRate = winRate(positions);
  const walletExpectancy = expectancyUsd(positions);

  const captures = positions.map(peakCapturePct).filter((v): v is number => v !== null);
  const peakCapturePctAvg = captures.length > 0 ? (captures.reduce((s, v) => s + v, 0) / captures.length) * 100 : 0;

  const wasUp = positions.filter(wasUpMeaningfully);
  const roundTrips = wasUp.filter((p) => !isWin(p));
  const roundTripRatePct = wasUp.length > 0 ? (roundTrips.length / wasUp.length) * 100 : 0;

  const winners = positions.filter(isWin);
  const losers = positions.filter((p) => !isWin(p));
  const winnerHoldTimeSeconds = avg(winners.map((p) => p.holdSeconds ?? 0));
  const lossSideExitSpeedSeconds = avg(losers.map((p) => p.holdSeconds ?? 0));

  const byStyle = new Map<ExitStyleLabel, ClosedPosition[]>();
  for (const p of positions) {
    const style = classifyExitStyle(p);
    const arr = byStyle.get(style) ?? [];
    arr.push(p);
    byStyle.set(style, arr);
  }

  const conditionBreakdown: ExitConditionBucket[] = [];
  for (const [style, group] of byStyle) {
    if (group.length < MIN_BUCKET) continue;
    const groupCaptures = group.map(peakCapturePct).filter((v): v is number => v !== null);
    const chronological = [...group].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime()).map(isWin);
    conditionBreakdown.push({
      conditionLabel: style,
      trades: group.length,
      frequencyPct: (group.length / positions.length) * 100,
      peakCaptureAvg: groupCaptures.length > 0 ? (groupCaptures.reduce((s, v) => s + v, 0) / groupCaptures.length) * 100 : 0,
      expectancyUsd: expectancyUsd(group),
      confidence: buildConfidenceBlock(
        group.filter(isWin).length,
        group.length,
        positions.filter(isWin).length,
        positions.length,
        chronological,
        baselineWinRate
      ),
      luckTest: computeLuckTest(group),
    });
  }
  conditionBreakdown.sort((a, b) => b.frequencyPct - a.frequencyPct);

  const negativeFindings: string[] = [];
  for (const b of conditionBreakdown) {
    if (b.expectancyUsd < 0 && b.confidence.tier !== 'insufficient') {
      negativeFindings.push(`${b.conditionLabel}: ${b.trades} trades, avg peak capture ${b.peakCaptureAvg.toFixed(0)}%, ${b.expectancyUsd.toFixed(0)} USD expectancy/trade`);
    }
  }
  if (roundTripRatePct > 40 && wasUp.length >= MIN_BUCKET) {
    negativeFindings.push(`Round-trip rate ${roundTripRatePct.toFixed(0)}%: trades that were up ${RUNUP_THRESHOLD_PCT}%+ still ended up closing at a loss`);
  }

  const scaledOut = conditionBreakdown.find((b) => b.conditionLabel === 'scaled_out');
  const soldAllAtOnce = conditionBreakdown.find((b) => b.conditionLabel === 'sold_all_at_once');
  const primary = [...conditionBreakdown].sort((a, b) => b.frequencyPct - a.frequencyPct)[0];

  let verdict: Verdict = 'no_edge';
  if (peakCapturePctAvg > 35 && (scaledOut?.confidence.tier ?? 'insufficient') !== 'insufficient') verdict = 'strong_edge';
  else if (walletExpectancy > 0) verdict = 'possible_edge';
  else if (walletExpectancy < 0 && negativeFindings.length > 0) verdict = 'negative_edge';

  const chronological = [...positions].sort((a, b) => a.exitTs.getTime() - b.exitTs.getTime()).map(isWin);

  return {
    verdict,
    primaryDriver: primary
      ? `${describeStyle(primary.conditionLabel)} (${primary.frequencyPct.toFixed(0)}% of exits)`
      : 'Not enough closed trades to characterize exit style',
    transferable: (scaledOut?.confidence.tier ?? soldAllAtOnce?.confidence.tier ?? 'insufficient') !== 'insufficient',
    expectancyUsd: walletExpectancy,
    peakCapturePct: peakCapturePctAvg,
    roundTripRatePct,
    lossSideExitSpeedSeconds,
    winnerHoldTimeSeconds,
    conditionBreakdown,
    negativeFindings,
    confidence: buildConfidenceBlock(
      positions.filter(isWin).length,
      positions.length,
      positions.filter(isWin).length,
      positions.length,
      chronological,
      baselineWinRate
    ),
  };
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((s, v) => s + v, 0) / nums.length;
}

function describeStyle(style: ExitStyleLabel): string {
  switch (style) {
    case 'scaled_out':
      return 'You sell in pieces';
    case 'sold_all_at_once':
      return 'You sell all at once';
    case 'held_into_loss_after_being_up':
      return 'You hold winners into losses';
  }
}
