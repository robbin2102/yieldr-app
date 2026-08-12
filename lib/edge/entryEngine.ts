import { twoProportionPValue, buildConfidenceBlock } from './stats';
import type { ReconstructedPosition, EntryCategoryResult, EntryConditionBucket, Verdict } from './types';

const MIN_SPLIT_SIZE = 2; // smallest side a sweep will consider - smaller buckets still get reported, just tagged "insufficient"
const AGE_CUTOFFS_MIN = [5, 10, 15, 30, 60];
const LIQUIDITY_CUTOFFS_USD = [10_000, 25_000, 50_000, 100_000];

type ClosedPosition = ReconstructedPosition & { realizedPnlUsd: number };

function isWin(p: ClosedPosition) {
  return p.realizedPnlUsd > 0;
}

function winRate(group: ClosedPosition[]) {
  return group.length === 0 ? 0 : group.filter(isWin).length / group.length;
}

/** mean(pnl) == winRate*avgWin - lossRate*avgLoss algebraically - one formula covers both. */
function expectancyUsd(group: ClosedPosition[]) {
  return group.length === 0 ? 0 : group.reduce((s, p) => s + p.realizedPnlUsd, 0) / group.length;
}

interface Split {
  thresholdLabel: string;
  below: ClosedPosition[];
  above: ClosedPosition[];
  belowLabel: string;
  aboveLabel: string;
}

/** Sweeps candidate cutoffs on a continuous feature, keeps the one that best separates win rate. */
function sweepBestSplit(
  positions: ClosedPosition[],
  feature: (p: ClosedPosition) => number | null,
  cutoffs: number[],
  labelFn: (cutoff: number, side: 'below' | 'above') => string
): Split | null {
  const withFeature = positions
    .map((p) => ({ p, v: feature(p) }))
    .filter((x) => x.v !== null) as { p: ClosedPosition; v: number }[];
  if (withFeature.length < MIN_SPLIT_SIZE * 2) return null;

  let best: { cutoff: number; below: ClosedPosition[]; above: ClosedPosition[]; score: number } | null = null;

  for (const cutoff of cutoffs) {
    const below = withFeature.filter((x) => x.v <= cutoff).map((x) => x.p);
    const above = withFeature.filter((x) => x.v > cutoff).map((x) => x.p);
    if (below.length < MIN_SPLIT_SIZE || above.length < MIN_SPLIT_SIZE) continue;

    const score = Math.abs(winRate(below) - winRate(above));
    if (!best || score > best.score) best = { cutoff, below, above, score };
  }
  if (!best) return null;

  return {
    thresholdLabel: String(best.cutoff),
    below: best.below,
    above: best.above,
    belowLabel: labelFn(best.cutoff, 'below'),
    aboveLabel: labelFn(best.cutoff, 'above'),
  };
}

interface Tag {
  label: string;
  dimension: 'age' | 'liquidity' | 'momentum' | 'percentile';
  positions: ClosedPosition[];
}

function discoverPrimitiveTags(positions: ClosedPosition[]): Tag[] {
  const tags: Tag[] = [];

  const ageSplit = sweepBestSplit(
    positions,
    (p) => (p.ageAtEntrySeconds !== null ? p.ageAtEntrySeconds / 60 : null),
    AGE_CUTOFFS_MIN,
    (cutoff, side) => (side === 'below' ? `Sniped (bought within ${cutoff}m of launch)` : `Bought ${cutoff}m+ after launch`)
  );
  if (ageSplit) {
    tags.push({ label: ageSplit.belowLabel, dimension: 'age', positions: ageSplit.below });
    tags.push({ label: ageSplit.aboveLabel, dimension: 'age', positions: ageSplit.above });
  }

  const liqSplit = sweepBestSplit(
    positions,
    (p) => p.liquidityUsdAtEntry,
    LIQUIDITY_CUTOFFS_USD,
    (cutoff, side) => (side === 'below' ? `Thin liquidity (<$${cutoff.toLocaleString()})` : `Deep liquidity ($${cutoff.toLocaleString()}+)`)
  );
  if (liqSplit) {
    tags.push({ label: liqSplit.belowLabel, dimension: 'liquidity', positions: liqSplit.below });
    tags.push({ label: liqSplit.aboveLabel, dimension: 'liquidity', positions: liqSplit.above });
  }

  const withMomentum = positions.filter((p) => p.momentumAtEntryPct !== null);
  if (withMomentum.length >= MIN_SPLIT_SIZE) {
    const breakout = withMomentum.filter((p) => p.momentumAtEntryPct! > 10);
    const pullback = withMomentum.filter((p) => p.momentumAtEntryPct! < -10);
    const flat = withMomentum.filter((p) => p.momentumAtEntryPct! >= -10 && p.momentumAtEntryPct! <= 10);
    if (breakout.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Chased a breakout', dimension: 'momentum', positions: breakout });
    if (pullback.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Bought a pullback/dip', dimension: 'momentum', positions: pullback });
    if (flat.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Bought while flat/choppy', dimension: 'momentum', positions: flat });
  }

  const withPct = positions.filter((p) => p.pricePercentileAtEntry !== null);
  if (withPct.length >= MIN_SPLIT_SIZE) {
    const nearHigh = withPct.filter((p) => p.pricePercentileAtEntry! > 0.66);
    const nearLow = withPct.filter((p) => p.pricePercentileAtEntry! < 0.33);
    const mid = withPct.filter((p) => p.pricePercentileAtEntry! >= 0.33 && p.pricePercentileAtEntry! <= 0.66);
    if (nearHigh.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Bought near the local high', dimension: 'percentile', positions: nearHigh });
    if (nearLow.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Bought near the local low', dimension: 'percentile', positions: nearLow });
    if (mid.length >= MIN_SPLIT_SIZE) tags.push({ label: 'Bought mid-range', dimension: 'percentile', positions: mid });
  }

  return tags;
}

/** Stable identity for a position - there's no persisted _id at this stage, so token+entryTs stands in for one. */
function positionKey(p: ClosedPosition): string {
  return `${p.tokenAddress}|${p.entryTs.toISOString()}`;
}

/** Joint (2-dimension) combinations that separate further than either parent tag alone. */
function discoverJointTags(primitives: Tag[]): Tag[] {
  const joint: Tag[] = [];
  for (let i = 0; i < primitives.length; i++) {
    for (let j = i + 1; j < primitives.length; j++) {
      const a = primitives[i];
      const b = primitives[j];
      if (a.dimension === b.dimension) continue; // combine across dimensions only

      const aSet = new Set(a.positions.map(positionKey));
      const combo = b.positions.filter((p) => aSet.has(positionKey(p)));
      if (combo.length < MIN_SPLIT_SIZE) continue;

      const comboExpectancy = Math.abs(expectancyUsd(combo));
      const parentMax = Math.max(Math.abs(expectancyUsd(a.positions)), Math.abs(expectancyUsd(b.positions)));
      if (comboExpectancy > parentMax * 1.15) {
        joint.push({ label: `${a.label} + ${b.label}`, dimension: a.dimension, positions: combo });
      }
    }
  }
  return joint;
}

/** Greedily assigns every trade to exactly one bucket (joint tags take priority over single-dimension ones) so the breakdown partitions cleanly. */
function assignBuckets(
  positions: ClosedPosition[],
  candidates: Tag[],
  baselineWinRate: number
): EntryConditionBucket[] {
  const claimed = new Set<string>();
  const ranked = [...candidates].sort((a, b) => Math.abs(expectancyUsd(b.positions)) - Math.abs(expectancyUsd(a.positions)));

  const buckets: EntryConditionBucket[] = [];
  for (const tag of ranked) {
    const group = tag.positions.filter((p) => !claimed.has(positionKey(p)));
    if (group.length < MIN_SPLIT_SIZE) continue;

    group.forEach((p) => claimed.add(positionKey(p)));

    const chronological = [...group].sort((x, y) => x.entryTs.getTime() - y.entryTs.getTime()).map(isWin);
    buckets.push({
      conditionLabel: tag.label,
      trades: group.length,
      winRate: winRate(group),
      expectancyUsd: expectancyUsd(group),
      totalPnlUsd: group.reduce((s, p) => s + p.realizedPnlUsd, 0),
      confidence: buildConfidenceBlock(
        group.filter(isWin).length,
        group.length,
        Math.round(baselineWinRate * positions.length),
        positions.length,
        chronological,
        baselineWinRate
      ),
    });
  }

  const remaining = positions.filter((p) => !claimed.has(positionKey(p)));
  if (remaining.length > 0) {
    const chronological = [...remaining].sort((x, y) => x.entryTs.getTime() - y.entryTs.getTime()).map(isWin);
    buckets.push({
      conditionLabel: 'Other entries (no distinguishing setup found)',
      trades: remaining.length,
      winRate: winRate(remaining),
      expectancyUsd: expectancyUsd(remaining),
      totalPnlUsd: remaining.reduce((s, p) => s + p.realizedPnlUsd, 0),
      confidence: buildConfidenceBlock(
        remaining.filter(isWin).length,
        remaining.length,
        Math.round(baselineWinRate * positions.length),
        positions.length,
        chronological,
        baselineWinRate
      ),
    });
  }

  return buckets.sort((a, b) => Math.abs(b.expectancyUsd) - Math.abs(a.expectancyUsd));
}

export function computeEntryCategory(allClosedPositions: ReconstructedPosition[]): EntryCategoryResult {
  const positions = allClosedPositions.filter((p) => !p.isOpen && !p.isDust && p.realizedPnlUsd !== null) as ClosedPosition[];
  const baselineWinRate = winRate(positions);
  const walletExpectancy = expectancyUsd(positions);

  const primitives = discoverPrimitiveTags(positions);
  const jointTags = discoverJointTags(primitives);
  const conditionBreakdown = assignBuckets(positions, [...jointTags, ...primitives], baselineWinRate);

  const best = conditionBreakdown.find((b) => b.conditionLabel !== 'Other entries (no distinguishing setup found)');
  const worst = [...conditionBreakdown].reverse().find((b) => b.expectancyUsd < 0);

  const negativeFindings: string[] = [];
  for (const b of conditionBreakdown) {
    if (b.expectancyUsd < 0 && b.confidence.tier !== 'insufficient') {
      negativeFindings.push(
        `${b.conditionLabel}: ${b.trades} trades, ${(b.winRate * 100).toFixed(0)}% win rate, ${b.expectancyUsd.toFixed(0)} USD expectancy/trade`
      );
    }
  }

  let verdict: Verdict = 'no_edge';
  if (best && best.expectancyUsd > 0 && best.confidence.tier !== 'insufficient') verdict = 'strong_edge';
  else if (walletExpectancy > 0) verdict = 'possible_edge';
  else if (walletExpectancy < 0 && negativeFindings.length > 0) verdict = 'negative_edge';

  const chronological = [...positions].sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime()).map(isWin);

  return {
    verdict,
    primaryDriver: best?.conditionLabel ?? 'No single entry setup stands out yet',
    transferable: (best?.confidence.tier ?? 'insufficient') !== 'insufficient',
    expectancyUsd: walletExpectancy,
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
