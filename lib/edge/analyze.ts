import connectDB from '@/lib/mongoose';
import { EdgeScore } from '@/models/EdgeScore';
import { activeChains, EDGE_LOOKBACK_DAYS, type EdgeChainId } from './chains';
import { reconstructWalletPortfolio } from './reconstruct';
import { enrichEntryContext } from './entryContext';
import { enrichExitContext } from './exitContext';
import { computeEntryCategory } from './entryEngine';
import { computeExitCategory } from './exitEngine';
import { computeSizingCategory } from './sizingEngine';
import { computeCompositeScore } from './compositeScore';
import { buildConfidenceBlock } from './stats';
import type { EdgeReport, ReconstructedPosition } from './types';
import type { ExcludedTradeReason } from './fetchTrades';
import type { TokenTraded } from './reconstruct';

export type AnalysisStage = 'scan_start' | 'portfolio' | 'entry' | 'exit' | 'sizing' | 'composite' | 'done';
export type StageCallback = (stage: AnalysisStage, data: unknown) => void;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isWin(p: ReconstructedPosition) {
  return (p.realizedPnlUsd ?? 0) > 0;
}

export async function analyzeWallet(wallet: string, onStage?: StageCallback): Promise<EdgeReport> {
  console.log(`[edge:analyze] START wallet=${wallet} chains=${activeChains().join(',')}`);
  onStage?.('scan_start', { wallet, chains: activeChains() });

  const chains = activeChains().filter((c): c is EdgeChainId => c !== 'solana');
  const portfolios = await Promise.all(chains.map((chain) => reconstructWalletPortfolio(chain, wallet)));

  const allPositions = portfolios.flatMap((p) => p.positions);
  const excludedTrades = mergeExcluded(portfolios.flatMap((p) => p.excludedTrades));
  const currentHoldingsUsd = portfolios.reduce((s, p) => s + p.currentHoldingsUsd, 0);
  const tokensTraded = portfolios.flatMap((p) => p.tokensTraded);
  console.log(
    `[edge:analyze] portfolios merged: ${allPositions.length} position(s) across ${portfolios.length} chain(s), ${tokensTraded.length} token(s) traded`
  );

  const closedRaw = allPositions.filter((p) => !p.isOpen && !p.isDust && p.realizedPnlUsd !== null);
  const realizedPnlUsd = closedRaw.reduce((s, p) => s + (p.realizedPnlUsd ?? 0), 0);
  const winRate = closedRaw.length > 0 ? closedRaw.filter(isWin).length / closedRaw.length : 0;
  const expectancyUsd = closedRaw.length > 0 ? realizedPnlUsd / closedRaw.length : 0;
  const capitalDeployed = closedRaw.reduce((s, p) => s + p.totalSizeUsd, 0);
  const roiPct = capitalDeployed > 0 ? (realizedPnlUsd / capitalDeployed) * 100 : 0;
  console.log(
    `[edge:analyze] closed trades=${closedRaw.length} realizedPnlUsd=${realizedPnlUsd.toFixed(2)} winRate=${(
      winRate * 100
    ).toFixed(1)}% capitalDeployed=${capitalDeployed.toFixed(2)}`
  );

  onStage?.('portfolio', {
    currentHoldingsUsd,
    realizedPnlUsd,
    winRate,
    tradeCount: closedRaw.length,
    roiPct,
    excludedTrades,
    tokensTraded,
  });

  // Enrichment does real IO (launch time, OHLC, point-in-time liquidity reads) per
  // closed position - concurrency-limited so a 300-trade wallet doesn't fan out
  // hundreds of simultaneous RPC/GeckoTerminal calls.
  const enrichedClosed = await mapWithConcurrency(closedRaw, 5, async (p) => {
    const withEntry = await enrichEntryContext(p.chain, p);
    return enrichExitContext(p.chain, withEntry);
  });
  console.log(`[edge:analyze] enriched ${enrichedClosed.length} closed position(s) with entry/exit context`);

  const entry = computeEntryCategory(enrichedClosed);
  console.log(`[edge:analyze] entry verdict=${entry.verdict} driver="${entry.primaryDriver}" buckets=${entry.conditionBreakdown.length}`);
  onStage?.('entry', entry);

  const exit = computeExitCategory(enrichedClosed);
  console.log(`[edge:analyze] exit verdict=${exit.verdict} peakCapture=${exit.peakCapturePct.toFixed(1)}% roundTrip=${exit.roundTripRatePct.toFixed(1)}%`);
  onStage?.('exit', exit);

  const sizing = computeSizingCategory(enrichedClosed);
  console.log(`[edge:analyze] sizing verdict=${sizing.verdict} convictionRatio=${sizing.convictionRatio.toFixed(2)}x`);
  onStage?.('sizing', sizing);

  const chronological = [...enrichedClosed].sort((a, b) => a.entryTs.getTime() - b.entryTs.getTime()).map(isWin);
  const walletConfidence = buildConfidenceBlock(
    closedRaw.filter(isWin).length,
    closedRaw.length,
    closedRaw.filter(isWin).length,
    closedRaw.length,
    chronological,
    winRate
  );

  const { edgeScore } = computeCompositeScore(entry, exit, sizing, walletConfidence);
  console.log(`[edge:analyze] DONE wallet=${wallet} edgeScore=${edgeScore} confidenceTier=${walletConfidence.tier}`);

  const report: EdgeReport = {
    wallet: wallet.toLowerCase(),
    chains,
    analysisWindow: {
      start: new Date(Date.now() - EDGE_LOOKBACK_DAYS * 86_400_000),
      end: new Date(),
      tradesAnalyzed: closedRaw.length,
    },
    excludedTrades,
    edgeScore,
    confidence: walletConfidence,
    performance: { realizedPnlUsd, winRate, expectancyUsd, tradeCount: closedRaw.length, currentHoldingsUsd, roiPct },
    categories: { entry, exit, sizing },
    flags: { isTeamWallet: false, isBundlerLinked: false },
    computedAt: new Date(),
  };

  onStage?.('composite', { edgeScore, confidence: walletConfidence });

  await persistReport(report);
  onStage?.('done', report);

  return report;
}

function mergeExcluded(items: ExcludedTradeReason[]): ExcludedTradeReason[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  for (const i of items) {
    counts.set(i.reason, (counts.get(i.reason) ?? 0) + i.count);
    samples.set(i.reason, [...(samples.get(i.reason) ?? []), ...i.sampleTxHashes].slice(0, 5));
  }
  return Array.from(counts, ([reason, count]) => ({ reason, count, sampleTxHashes: samples.get(reason) ?? [] }));
}

async function persistReport(report: EdgeReport) {
  await connectDB();
  await EdgeScore.findOneAndUpdate(
    { wallet: report.wallet },
    { $push: { history: report }, $set: { latestComputedAt: report.computedAt } },
    { upsert: true }
  );
}
