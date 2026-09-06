/**
 * MVP wallet-only edge detection test.
 *
 * Runs the full analyze pipeline (reconstruct -> entry/exit/sizing engines
 * -> composite score -> top findings -> edge decay) against a real wallet,
 * with NO coin-context enrichment (no GeckoTerminal/RPC calls beyond the
 * wallet's own trade legs) - this is the MVP mode wired in lib/edge/analyze.ts.
 *
 * Prints basic performance (PnL/win rate/ROI) first so it can be sanity-checked
 * against another source (e.g. the Fomo app) before trusting the deeper
 * entry/exit/sizing/decay breakdown below it.
 *
 * The report is also persisted to Mongo (EdgeScore collection) exactly like
 * a real analyze run - this script IS the pipeline, not a separate mock.
 *
 * Run:   npm run edge:test-mvp -- 0xWalletAddress
 * Needs: MONGODB_URI + ALCHEMY_BASE_RPC_URL and/or ALCHEMY_HOOD_RPC_URL in .env.local
 */

import { analyzeWallet } from '../lib/edge/analyze';
import mongoose from 'mongoose';

const WALLET = process.argv[2] || '0x0a6ebed0155edb4b21d92ad02897a626cd90119e';

function fmtUsd(n: number): string {
  return `${n >= 0 ? '' : '-'}$${Math.abs(n).toFixed(2)}`;
}
function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  console.log('=== MVP Wallet-Only Edge Detection Test ===');
  console.log(`Wallet: ${WALLET.toLowerCase()}`);
  console.log('(Pass a different wallet as first arg: npm run edge:test-mvp -- 0xABC...)\n');

  const report = await analyzeWallet(WALLET);

  console.log('\n──────────────────────────────────────────');
  console.log('BASIC PERFORMANCE (compare against Fomo app)');
  console.log('──────────────────────────────────────────');
  console.log(`  Trades analyzed     : ${report.performance.tradeCount}`);
  console.log(`  Realized PnL        : ${fmtUsd(report.performance.realizedPnlUsd)}`);
  console.log(`  Win rate            : ${fmtPct(report.performance.winRate)}`);
  console.log(`  Expectancy/trade    : ${fmtUsd(report.performance.expectancyUsd)}`);
  console.log(`  ROI                 : ${report.performance.roiPct.toFixed(1)}%`);
  console.log(`  Current holdings    : ${fmtUsd(report.performance.currentHoldingsUsd)}`);
  if (report.excludedTrades.length > 0) {
    console.log(`  Excluded tx groups  :`);
    for (const e of report.excludedTrades) console.log(`    ${e.count}x ${e.reason}`);
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`EDGE SCORE: ${report.edgeScore}/100  (confidence: ${report.confidence.tier}, ${report.confidence.trades} trades)`);
  console.log('──────────────────────────────────────────');

  console.log('\nENTRY');
  console.log(`  verdict          : ${report.categories.entry.verdict}`);
  console.log(`  primary driver   : ${report.categories.entry.primaryDriver}`);
  for (const b of report.categories.entry.conditionBreakdown) {
    console.log(
      `    - ${b.conditionLabel}: ${b.trades} trades, ${fmtPct(b.winRate)} win rate, ${fmtUsd(b.expectancyUsd)}/trade [${b.confidence.tier}] luck-test: ${b.luckTest.robust ? 'ROBUST' : 'not robust'} (${b.luckTest.distinctTokenCount} tokens, bootstrap+ ${b.luckTest.bootstrapPositiveExpectancyPct.toFixed(0)}%)`
    );
  }

  console.log('\nEXIT');
  console.log(`  verdict              : ${report.categories.exit.verdict}`);
  console.log(`  primary driver       : ${report.categories.exit.primaryDriver}`);
  console.log(`  peak capture (avg)   : ${report.categories.exit.peakCapturePct.toFixed(1)}% (wallet-derived proxy, multi-leg exits only)`);
  console.log(`  round-trip rate      : ${report.categories.exit.roundTripRatePct.toFixed(1)}%`);
  console.log(`  winner hold time     : ${(report.categories.exit.winnerHoldTimeSeconds / 60).toFixed(1)} min`);
  console.log(`  loss-side exit speed : ${(report.categories.exit.lossSideExitSpeedSeconds / 60).toFixed(1)} min`);
  for (const b of report.categories.exit.conditionBreakdown) {
    console.log(
      `    - ${b.conditionLabel}: ${b.trades} trades (${b.frequencyPct.toFixed(0)}%), ${fmtUsd(b.expectancyUsd)}/trade [${b.confidence.tier}] luck-test: ${b.luckTest.robust ? 'ROBUST' : 'not robust'} (${b.luckTest.distinctTokenCount} tokens, bootstrap+ ${b.luckTest.bootstrapPositiveExpectancyPct.toFixed(0)}%)`
    );
  }

  console.log('\nSIZING');
  console.log(`  verdict            : ${report.categories.sizing.verdict}`);
  console.log(`  primary driver     : ${report.categories.sizing.primaryDriver}`);
  console.log(`  conviction ratio   : ${report.categories.sizing.convictionRatio === Infinity ? '∞' : report.categories.sizing.convictionRatio.toFixed(2)}x`);
  console.log(`  size spectrum      : ${report.categories.sizing.sizeSpectrumLabel} (CoV ${report.categories.sizing.sizeCoV.toFixed(2)})`);
  console.log(`  scale-in shape     : ${report.categories.sizing.scaleInShapeLabel}`);
  console.log(`  averaging down     : ${report.categories.sizing.addAfterLossRatioPct.toFixed(0)}% of multi-buy positions`);
  const plb = report.categories.sizing.postLossBehavior;
  console.log(
    `  post-loss behavior : ${plb.label} (${plb.windowTradesAnalyzed} trades after ${plb.bigLossEventCount} big loss(es)${plb.avgSizeRatioPostLoss !== null ? `, size ratio ${plb.avgSizeRatioPostLoss.toFixed(2)}x` : ''})`
  );

  console.log('\n──────────────────────────────────────────');
  console.log('RISK-ADJUSTED STATS (position-size normalized, per trade - not regime-normalized)');
  console.log('──────────────────────────────────────────');
  const ra = report.riskAdjusted;
  console.log(`  n                  : ${ra.n} trades`);
  console.log(`  mean return        : ${ra.meanReturnPct.toFixed(1)}%`);
  console.log(`  median return      : ${ra.medianReturnPct.toFixed(1)}%`);
  console.log(`  std dev            : ${ra.stdDevReturnPct.toFixed(1)}%`);
  console.log(`  downside deviation : ${ra.downsideDeviationPct.toFixed(1)}%`);
  console.log(`  Sharpe (per-trade) : ${ra.sharpeRatio !== null ? ra.sharpeRatio.toFixed(2) : 'n/a'}`);
  console.log(`  Sortino (per-trade): ${ra.sortinoRatio !== null ? ra.sortinoRatio.toFixed(2) : 'n/a'}`);
  console.log(`  best/worst trade   : ${ra.bestTradeReturnPct?.toFixed(1) ?? 'n/a'}% / ${ra.worstTradeReturnPct?.toFixed(1) ?? 'n/a'}%`);

  console.log('\n──────────────────────────────────────────');
  console.log('LUCK TEST (wallet-level - is the overall edge real or one lucky trade/token?)');
  console.log('──────────────────────────────────────────');
  const lt = report.luckTest;
  console.log(`  robust                        : ${lt.robust ? 'YES' : 'no'}`);
  console.log(`  distinct tokens                : ${lt.distinctTokenCount}`);
  console.log(`  expectancy (all trades)        : ${fmtUsd(lt.expectancyAllUsd)}`);
  console.log(`  expectancy (excl. best trade)  : ${fmtUsd(lt.expectancyExcludingBestUsd)}`);
  console.log(`  best trade PnL                 : ${lt.bestTradePnlUsd !== null ? fmtUsd(lt.bestTradePnlUsd) : 'n/a'}`);
  console.log(`  % of profit from best trade    : ${lt.pctOfTotalPnlFromBestTrade !== null ? lt.pctOfTotalPnlFromBestTrade.toFixed(0) + '%' : 'n/a'}`);
  console.log(`  bootstrap % positive expectancy: ${lt.bootstrapPositiveExpectancyPct.toFixed(0)}%`);

  console.log('\n──────────────────────────────────────────');
  console.log('BETTABLE PATTERNS (Tier-1 composite signatures)');
  console.log('──────────────────────────────────────────');
  for (const p of report.bettablePatterns) {
    console.log(`  [${p.detected ? 'X' : ' '}] ${p.label} [${p.confidenceTier}]`);
    console.log(`      ${p.evidence}`);
  }

  console.log('\n──────────────────────────────────────────');
  console.log('TOP 3 STRENGTHS');
  console.log('──────────────────────────────────────────');
  if (report.topStrengths.length === 0) console.log('  (none found yet - needs more trades)');
  report.topStrengths.forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.category}] ${f.label} — ${f.detail} (impact ${fmtUsd(f.impactUsd)}, ${f.confidenceTier})`);
  });

  console.log('\nTOP 3 WEAKNESSES');
  if (report.topWeaknesses.length === 0) console.log('  (none found yet - needs more trades)');
  report.topWeaknesses.forEach((f, i) => {
    console.log(`  ${i + 1}. [${f.category}] ${f.label} — ${f.detail} (impact ${fmtUsd(f.impactUsd)}, ${f.confidenceTier})`);
  });

  console.log('\n──────────────────────────────────────────');
  console.log('EDGE DECAY');
  console.log('──────────────────────────────────────────');
  console.log(`  status               : ${report.edgeDecay.status}`);
  console.log(`  prior snapshots      : ${report.edgeDecay.priorSnapshotCount}`);
  if (report.edgeDecay.edgeScoreDelta !== null) {
    console.log(`  edge score delta     : ${report.edgeDecay.edgeScoreDelta >= 0 ? '+' : ''}${report.edgeDecay.edgeScoreDelta.toFixed(1)}`);
    console.log(`  win rate delta       : ${report.edgeDecay.winRateDeltaPct! >= 0 ? '+' : ''}${report.edgeDecay.winRateDeltaPct!.toFixed(1)}pp`);
    console.log(`  expectancy delta     : ${fmtUsd(report.edgeDecay.expectancyDeltaUsd!)}`);
  } else {
    console.log('  (not enough history yet - run this script again after more analyses accumulate)');
  }

  console.log('\n=== DONE (report persisted to EdgeScore collection) ===');
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
