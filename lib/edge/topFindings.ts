import type {
  EntryCategoryResult,
  ExitCategoryResult,
  SizingCategoryResult,
  ExitStyleLabel,
  TopFinding,
  TopFindingsResult,
} from './types';

const EXIT_STYLE_LABEL: Record<ExitStyleLabel, string> = {
  scaled_out: 'Sells in pieces (scales out)',
  sold_all_at_once: 'Sells all at once',
  held_into_loss_after_being_up: 'Holds winners into losses',
};

/** Confidence-weighted absolute impact - a huge number from 2 trades shouldn't outrank a modest one backed by 40. */
function rank(f: TopFinding): number {
  const confWeight = f.confidenceTier === 'high' ? 1 : f.confidenceTier === 'provisional' ? 0.7 : 0.4;
  return Math.abs(f.impactUsd) * confWeight;
}

function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : ''}$${n.toFixed(0)}`;
}

/**
 * Combines entry/exit/sizing category results into the top 3 strengths and
 * top 3 weaknesses across all of them - the "if you only read 6 lines"
 * summary stored alongside every EdgeReport.
 */
export function computeTopFindings(
  entry: EntryCategoryResult,
  exit: ExitCategoryResult,
  sizing: SizingCategoryResult
): TopFindingsResult {
  const candidates: TopFinding[] = [];

  for (const b of entry.conditionBreakdown) {
    if (b.conditionLabel.startsWith('Other entries')) continue;
    if (b.confidence.tier === 'insufficient') continue; // too few trades to call this a pattern, not just an anecdote
    candidates.push({
      category: 'entry',
      label: b.conditionLabel,
      impactUsd: b.totalPnlUsd,
      detail: `${b.trades} trades across ${b.luckTest.distinctTokenCount} token(s), ${(b.winRate * 100).toFixed(0)}% win rate, ${fmtUsd(b.expectancyUsd)}/trade`,
      confidenceTier: b.confidence.tier,
      robust: b.luckTest.robust,
    });
  }

  for (const b of exit.conditionBreakdown) {
    if (b.confidence.tier === 'insufficient') continue;
    candidates.push({
      category: 'exit',
      label: EXIT_STYLE_LABEL[b.conditionLabel],
      impactUsd: b.expectancyUsd * b.trades,
      detail: `${b.trades} trades (${b.frequencyPct.toFixed(0)}% of exits) across ${b.luckTest.distinctTokenCount} token(s), ${fmtUsd(b.expectancyUsd)}/trade`,
      confidenceTier: b.confidence.tier,
      robust: b.luckTest.robust,
    });
  }

  // Sizing findings are computed over ALL closed trades, not a searched/split bucket - inherently lower
  // overfit risk than entry/exit buckets, so no per-bucket luck test exists for them yet. Treated as
  // robust by default; still gated on the wallet having a non-insufficient sample.
  if (sizing.confidence.trades >= 3 && sizing.confidence.tier !== 'insufficient') {
    const capitalTilt = sizing.avgSizeWinnersUsd - sizing.avgSizeLosersUsd;
    if (Number.isFinite(capitalTilt) && capitalTilt !== 0) {
      candidates.push({
        category: 'sizing',
        label: capitalTilt > 0 ? 'Sizes up on winners' : 'Sizes up on losers (inverted)',
        impactUsd: capitalTilt,
        detail: `avg $${sizing.avgSizeWinnersUsd.toFixed(0)} on winners vs $${sizing.avgSizeLosersUsd.toFixed(0)} on losers`,
        confidenceTier: sizing.confidence.tier,
        robust: true,
      });
    }

    if (sizing.addAfterLossRatioPct > 40) {
      candidates.push({
        category: 'sizing',
        label: 'Averages down into losers',
        impactUsd: -(sizing.addAfterLossRatioPct / 100) * sizing.avgSizeLosersUsd,
        detail: `${sizing.addAfterLossRatioPct.toFixed(0)}% of multi-buy positions added size below their running average entry price`,
        confidenceTier: sizing.confidence.tier,
        robust: true,
      });
    }

    if (sizing.postLossBehavior.label === 'revenge_sizing') {
      candidates.push({
        category: 'sizing',
        label: 'Revenge-sizes after big losses',
        impactUsd: -(sizing.postLossBehavior.avgSizeRatioPostLoss ?? 1) * sizing.avgSizeLosersUsd,
        detail: `sizes ${(sizing.postLossBehavior.avgSizeRatioPostLoss ?? 0).toFixed(1)}x bigger than usual in the ${sizing.postLossBehavior.windowTradesAnalyzed} trades right after a big loss`,
        confidenceTier: sizing.postLossBehavior.confidenceTier,
        robust: true,
      });
    } else if (sizing.postLossBehavior.label === 'disciplined_after_loss') {
      candidates.push({
        category: 'sizing',
        label: 'Stays disciplined after big losses',
        impactUsd: sizing.avgSizeLosersUsd * 0.1,
        detail: `keeps normal size and a ${((sizing.postLossBehavior.winRatePostLoss ?? 0) * 100).toFixed(0)}% win rate in the ${sizing.postLossBehavior.windowTradesAnalyzed} trades right after a big loss`,
        confidenceTier: sizing.postLossBehavior.confidenceTier,
        robust: true,
      });
    }

    const avgSize = (sizing.avgSizeWinnersUsd + sizing.avgSizeLosersUsd) / 2;
    if (sizing.sizeSpectrumLabel === 'erratic') {
      candidates.push({
        category: 'sizing',
        label: 'Erratic bet sizing',
        impactUsd: -sizing.sizeCoV * avgSize,
        detail: `bet size varies ${(sizing.sizeCoV * 100).toFixed(0)}% - no consistent unit size`,
        confidenceTier: sizing.confidence.tier,
        robust: true,
      });
    } else if (sizing.sizeSpectrumLabel === 'disciplined') {
      candidates.push({
        category: 'sizing',
        label: 'Disciplined bet sizing',
        impactUsd: (1 - sizing.sizeCoV) * avgSize * 0.1,
        detail: `bet size stays consistent (size varies ${(sizing.sizeCoV * 100).toFixed(0)}%)`,
        confidenceTier: sizing.confidence.tier,
        robust: true,
      });
    }
  }

  // Strengths invite copying, so they're held to the higher bar: must pass the luck test too.
  // Weaknesses are cautionary - better to over-warn than let a real leak hide behind a strict gate.
  const strengths = candidates
    .filter((c) => c.impactUsd > 0 && c.robust)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 3);

  const weaknesses = candidates
    .filter((c) => c.impactUsd < 0)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 3);

  return { strengths, weaknesses };
}
