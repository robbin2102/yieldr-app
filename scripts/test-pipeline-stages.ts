/**
 * Staged pipeline test - runs each part of the fetch/decode pipeline
 * independently, with its own console diagnostics and its own timer, so a
 * problem (or a slow part) can be pinned to a specific stage instead of
 * inferred from one giant end-to-end log dump.
 *
 * Stages:
 *   1. Bulk transfer fetch      - alchemy_getAssetTransfers (paginated)
 *   2. Classify candidates      - split into balanced / sell / relay-buy
 *   3. Receipt fetch            - cached + concurrency-capped RPC calls
 *   4. Parse swaps from receipts - the actual Swap/Transfer-log decoding
 *   5. Full fetchWalletSwapLegs - pricing included (re-runs 1-4 internally,
 *                                 but receipts are now cached from stage 3)
 *   6. Full reconstruction      - FIFO position building
 *
 * Run:   npm run edge:test-stages -- 0xWallet [base|hood|both]
 * Needs: MONGODB_URI + ALCHEMY_BASE_RPC_URL and/or ALCHEMY_HOOD_RPC_URL in .env.local
 */
import { getPublicClient, effectiveLookbackDays, type EdgeChainId } from '../lib/edge/chains';
import { resolveBlockRangeForWindow } from '../lib/edge/blockRange';
import {
  fetchViaAlchemyEnhancedApi,
  fetchWalletSwapLegs,
  classifySwapCandidates,
  fetchReceiptsForHashes,
  parseSwapFromReceipt,
  POOL_MANAGER_BY_CHAIN,
  type NormalizedTransfer,
} from '../lib/edge/fetchTrades';
import { REFERENCE_TOKENS, NATIVE_PSEUDO_ADDRESS } from '../lib/edge/referenceTokens';
import { reconstructWalletPortfolio } from '../lib/edge/reconstruct';
import mongoose from 'mongoose';

const WALLET = (process.argv[2] || '0x0a6ebed0155edb4b21d92ad02897a626cd90119e').toLowerCase();
const CHAIN_ARG = (process.argv[3] || 'both').toLowerCase();
const CHAINS_TO_RUN: EdgeChainId[] = CHAIN_ARG === 'both' ? ['base', 'hood'] : [CHAIN_ARG as EdgeChainId];

interface StageTiming {
  name: string;
  ms: number;
}

async function timeStage<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; timing: StageTiming }> {
  console.log(`\n──────────────────────────────────────────`);
  console.log(`STAGE: ${name}`);
  console.log(`──────────────────────────────────────────`);
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  console.log(`[stage timing] "${name}" took ${(ms / 1000).toFixed(1)}s`);
  return { result, timing: { name, ms } };
}

async function runChain(chain: EdgeChainId) {
  console.log(`\n============================================`);
  console.log(`  CHAIN: ${chain.toUpperCase()}  wallet=${WALLET}`);
  console.log(`============================================`);

  const timings: StageTiming[] = [];
  const client = getPublicClient(chain);
  const windowDays = effectiveLookbackDays(chain);
  const { fromBlock, toBlock } = await resolveBlockRangeForWindow(client, windowDays);
  console.log(`window=${windowDays}d blocks=${fromBlock}-${toBlock}`);

  // ── Stage 1: bulk transfer fetch ──────────────────────────────────
  const { result: transfers, timing: t1 } = await timeStage('1. Bulk transfer fetch (alchemy_getAssetTransfers)', () =>
    fetchViaAlchemyEnhancedApi(chain, WALLET, `0x${fromBlock.toString(16)}`, `0x${toBlock.toString(16)}`)
  );
  timings.push(t1);
  const nativeCount = transfers.filter((t: NormalizedTransfer) => t.tokenAddress === NATIVE_PSEUDO_ADDRESS).length;
  console.log(`  -> ${transfers.length} raw transfer(s) (${nativeCount} native, ${transfers.length - nativeCount} erc20)`);
  if (transfers.length === 0) {
    console.log('  No transfers found for this wallet/chain/window - stopping here.');
    printSummary(chain, timings);
    return;
  }

  // ── Stage 2: classify ─────────────────────────────────────────────
  const { result: candidates, timing: t2 } = await timeStage('2. Classify candidates', () =>
    Promise.resolve(classifySwapCandidates(WALLET, transfers))
  );
  timings.push(t2);
  const byHashCount = new Set(transfers.map((t: NormalizedTransfer) => t.hash)).size;
  const sellCount = candidates.filter((c) => c.direction === 'sell').length;
  const buyCount = candidates.filter((c) => c.direction === 'buy').length;
  console.log(
    `  -> ${byHashCount} distinct tx(s): ${byHashCount - candidates.length} balanced (already priceable), ${sellCount} sell candidate(s), ${buyCount} relay-buy candidate(s)`
  );

  if (!POOL_MANAGER_BY_CHAIN[chain] || candidates.length === 0) {
    console.log('  No PoolManager configured or no candidates need enrichment - stopping here.');
    printSummary(chain, timings);
    return;
  }

  // ── Stage 3: receipt fetch ────────────────────────────────────────
  const { result: receiptResult, timing: t3 } = await timeStage('3. Receipt fetch (cached + rate-limit-aware)', () =>
    fetchReceiptsForHashes(chain, client, candidates.map((c) => c.hash))
  );
  timings.push(t3);
  console.log(
    `  -> cache hits=${receiptResult.cacheHits}/${candidates.length}, newly fetched=${receiptResult.newlyFetchedCount}, failed=${receiptResult.failedCount}`
  );

  // ── Stage 4: parse ────────────────────────────────────────────────
  const poolManager = POOL_MANAGER_BY_CHAIN[chain]!;
  const wethAddress = REFERENCE_TOKENS[chain]?.find((t) => t.symbol === 'WETH')?.address ?? null;

  const { result: parseStats, timing: t4 } = await timeStage('4. Parse swaps from receipts', async () => {
    let matched = 0;
    let amountMismatch = 0;
    let zeroData = 0;
    let diagLogged = 0;
    const MAX_DIAG = 5;

    for (const candidate of candidates) {
      const receipt = receiptResult.receiptsByHash.get(candidate.hash.toLowerCase());
      if (!receipt) {
        zeroData++;
        continue;
      }
      const r = await parseSwapFromReceipt({ chain, client, poolManager, wethAddress, wallet: WALLET, candidate, receipt });
      if (r.enriched) {
        matched++;
      } else if (r.totalSwapsSeen > 0) {
        amountMismatch++;
        if (diagLogged < MAX_DIAG) {
          diagLogged++;
          console.log(
            `  [mismatch] hash=${candidate.hash.slice(0, 10)} ${candidate.direction} - ${r.totalSwapsSeen} swap event(s), closest ${r.closestDiffBps !== null ? (r.closestDiffBps / 100).toFixed(2) + '%' : 'n/a'} off`
          );
        }
      } else {
        zeroData++;
        if (diagLogged < MAX_DIAG) {
          diagLogged++;
          const logs = receipt.logs ?? [];
          const pairs = Array.from(new Set(logs.map((l: any) => `${l.address?.slice(0, 10)}…:${l.topics?.[0]?.slice(0, 10)}…`)));
          console.log(
            `  [zero-data] hash=${candidate.hash.slice(0, 10)} ${candidate.direction} - receipt has ${logs.length} log(s). Distinct pairs: ${pairs.slice(0, 8).join(', ') || '(none)'}`
          );
        }
      }
    }
    return { matched, amountMismatch, zeroData };
  });
  timings.push(t4);
  const capturePct = candidates.length > 0 ? ((parseStats.matched / candidates.length) * 100).toFixed(1) : '0.0';
  console.log(
    `  -> CAPTURE RATE: ${parseStats.matched}/${candidates.length} (${capturePct}%), ${parseStats.amountMismatch} amount-mismatch, ${parseStats.zeroData} zero-data`
  );

  // ── Stage 5: full fetchWalletSwapLegs (integration check incl. pricing) ──
  const { result: legsResult, timing: t5 } = await timeStage(
    '5. Full fetchWalletSwapLegs (pricing incl. - integration check)',
    () => fetchWalletSwapLegs(chain, WALLET)
  );
  timings.push(t5);
  const totalLegs = Array.from(legsResult.legsByToken.values()).reduce((s, l) => s + l.length, 0);
  console.log(`  -> ${legsResult.legsByToken.size} token(s) priced, ${totalLegs} leg(s) total`);
  for (const e of legsResult.excluded) console.log(`     excluded: ${e.count}x ${e.reason}`);

  // ── Stage 6: full reconstruction (integration check) ──────────────
  const { result: portfolio, timing: t6 } = await timeStage(
    '6. Full reconstructWalletPortfolio (FIFO - integration check)',
    () => reconstructWalletPortfolio(chain, WALLET)
  );
  timings.push(t6);
  const closedCount = portfolio.positions.filter((p) => !p.isOpen && !p.isDust).length;
  console.log(
    `  -> ${portfolio.positions.length} position(s) (${closedCount} closed, non-dust), currentHoldingsUsd=${portfolio.currentHoldingsUsd.toFixed(2)}`
  );

  printSummary(chain, timings);
}

function printSummary(chain: EdgeChainId, timings: StageTiming[]) {
  console.log(`\n--- ${chain.toUpperCase()} TIMING SUMMARY ---`);
  for (const t of timings) console.log(`  ${t.name.padEnd(55)} ${(t.ms / 1000).toFixed(1)}s`);
  const total = timings.reduce((s, t) => s + t.ms, 0);
  console.log(`  ${'TOTAL'.padEnd(55)} ${(total / 1000).toFixed(1)}s`);
}

async function main() {
  console.log(`=== PIPELINE STAGE TEST ===`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Chains: ${CHAINS_TO_RUN.join(', ')}`);
  console.log(`(Usage: npm run edge:test-stages -- 0xWallet [base|hood|both])`);

  for (const chain of CHAINS_TO_RUN) {
    try {
      await runChain(chain);
    } catch (err) {
      console.error(`[${chain}] FAILED:`, err);
    }
  }

  console.log('\n=== DONE ===');
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
