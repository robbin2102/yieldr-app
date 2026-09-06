import { buildConfidenceBlock } from './stats';
import { computePostLossBehavior } from './postLossBehavior';
import type { ReconstructedPosition, SizingCategoryResult, Verdict } from './types';

type ClosedPosition = ReconstructedPosition & { realizedPnlUsd: number };

function isWin(p: ClosedPosition) {
  return p.realizedPnlUsd > 0;
}
function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((s, v) => s + v, 0) / nums.length;
}
function expectancyUsd(g: ClosedPosition[]) {
  return g.length === 0 ? 0 : g.reduce((s, p) => s + p.realizedPnlUsd, 0) / g.length;
}

/** Coefficient of variation of position sizing - the prototype's "erratic <-> disciplined" spectrum. */
function coefficientOfVariation(sizes: number[]): number {
  if (sizes.length < 2) return 0;
  const mean = avg(sizes);
  if (mean === 0) return 0;
  const variance = sizes.reduce((s, v) => s + (v - mean) ** 2, 0) / sizes.length;
  return Math.sqrt(variance) / mean;
}

/** True if any buy leg after the first was priced below the running avg-entry-price at that point - genuine averaging-down, not just adding on strength. */
function addedAfterDrawdown(p: ClosedPosition): boolean {
  const buys = p.legs.filter((l) => l.side === 'buy');
  if (buys.length < 2) return false;

  let runningQty = buys[0].qty;
  let runningCost = buys[0].usd;
  for (let i = 1; i < buys.length; i++) {
    const runningAvgPrice = runningCost / runningQty;
    if (buys[i].priceUsd < runningAvgPrice) return true;
    runningQty += buys[i].qty;
    runningCost += buys[i].usd;
  }
  return false;
}

export function computeSizingCategory(allClosedPositions: ReconstructedPosition[]): SizingCategoryResult {
  const positions = allClosedPositions.filter((p) => !p.isOpen && !p.isDust && p.realizedPnlUsd !== null) as ClosedPosition[];
  const baselineWinRate = positions.length === 0 ? 0 : positions.filter(isWin).length / positions.length;
  const walletExpectancy = expectancyUsd(positions);

  const winners = positions.filter(isWin);
  const losers = positions.filter((p) => !isWin(p));

  const avgSizeWinnersUsd = avg(winners.map((p) => p.totalSizeUsd));
  const avgSizeLosersUsd = avg(losers.map((p) => p.totalSizeUsd));
  const convictionRatio = avgSizeLosersUsd > 0 ? avgSizeWinnersUsd / avgSizeLosersUsd : avgSizeWinnersUsd > 0 ? Infinity : 0;

  const sizeCoV = coefficientOfVariation(positions.map((p) => p.totalSizeUsd));
  const sizeSpectrumLabel: 'erratic' | 'mixed' | 'disciplined' = sizeCoV > 0.8 ? 'erratic' : sizeCoV > 0.4 ? 'mixed' : 'disciplined';

  const winnersWithAddOn = winners.filter((p) => p.legs.filter((l) => l.side === 'buy').length >= 2);
  const winnerAddOnRatePct = winners.length > 0 ? (winnersWithAddOn.length / winners.length) * 100 : 0;

  const losersWithSells = losers.filter((p) => p.legs.some((l) => l.side === 'sell'));
  const lossSideSizeCutSpeedSeconds =
    losersWithSells.length > 0
      ? avg(
          losersWithSells.map((p) => {
            const firstSell = p.legs.find((l) => l.side === 'sell')!;
            return (firstSell.ts.getTime() - p.entryTs.getTime()) / 1000;
          })
        )
      : null;

  const multiLegPositions = positions.filter((p) => p.legs.filter((l) => l.side === 'buy').length >= 2);
  const addedAfterLossCount = multiLegPositions.filter(addedAfterDrawdown).length;
  const addAfterLossRatioPct = multiLegPositions.length > 0 ? (addedAfterLossCount / multiLegPositions.length) * 100 : 0;

  const singleShotCount = positions.filter((p) => p.legs.filter((l) => l.side === 'buy').length === 1).length;
  const scaledInCount = positions.length - singleShotCount;
  const scaleInShapeLabel: 'single_shot' | 'scaled_in' | 'mixed' =
    positions.length === 0
      ? 'mixed'
      : singleShotCount / positions.length > 0.6
        ? 'single_shot'
        : scaledInCount / positions.length > 0.6
          ? 'scaled_in'
          : 'mixed';

  const postLossBehavior = computePostLossBehavior(positions);

  const negativeFindings: string[] = [];
  if (addAfterLossRatioPct > 40 && multiLegPositions.length >= 3) {
    negativeFindings.push(`Averaging down: ${addAfterLossRatioPct.toFixed(0)}% of multi-buy positions added size below the running average entry price`);
  }
  if (convictionRatio < 1 && losers.length >= 3 && winners.length >= 3) {
    negativeFindings.push(`Sizing is inverted: avg size on losers ($${avgSizeLosersUsd.toFixed(0)}) exceeds avg size on winners ($${avgSizeWinnersUsd.toFixed(0)})`);
  }
  if (postLossBehavior.label === 'revenge_sizing') {
    negativeFindings.push(
      `Revenge sizing: bets ${(postLossBehavior.avgSizeRatioPostLoss ?? 0).toFixed(1)}x bigger than usual in the ${postLossBehavior.windowTradesAnalyzed} trades right after a big loss`
    );
  }

  let verdict: Verdict = 'no_edge';
  if (convictionRatio > 1.3 && sizeSpectrumLabel !== 'erratic' && postLossBehavior.label !== 'revenge_sizing') verdict = 'strong_edge';
  else if (convictionRatio > 1) verdict = 'possible_edge';
  else if (negativeFindings.length > 0) verdict = 'negative_edge';

  const chronological = [...positions].sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime()).map(isWin);
  const primaryDriver =
    convictionRatio > 1
      ? `You size up on conviction (${convictionRatio === Infinity ? '∞' : convictionRatio.toFixed(1)}x more on winners)`
      : 'Sizing does not yet track with which trades win';

  return {
    verdict,
    primaryDriver,
    transferable: positions.length >= 30,
    expectancyUsd: walletExpectancy,
    avgSizeWinnersUsd,
    avgSizeLosersUsd,
    convictionRatio,
    sizeCoV,
    sizeSpectrumLabel,
    winnerAddOnRatePct,
    lossSideSizeCutSpeedSeconds,
    addAfterLossRatioPct,
    scaleInShapeLabel,
    postLossBehavior,
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
