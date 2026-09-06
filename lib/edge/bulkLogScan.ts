import type { PublicClient } from 'viem';
import { withRateLimitRetry } from './rpcRetry';

/**
 * Targeted per-block log fetching for the V4 enrichment path.
 *
 * PREVIOUS DESIGN (removed): scan a continuous block range from the
 * wallet's earliest to latest candidate, filtered by PoolManager address +
 * Swap topic. That sounds scoped to "our data" but isn't - it returns
 * every Swap on that PoolManager by every trader during the whole window,
 * which on an active DEX is enormous regardless of how few trades this
 * wallet made. That's what kept exploding into hundreds of sub-requests
 * under adaptive bisection and triggering rate-limit storms - the design
 * was scanning the wrong thing, not just scanning it inefficiently.
 *
 * THIS DESIGN: we already know the exact block number of every one of the
 * wallet's candidate trades (from alchemy_getAssetTransfers). A trade's
 * Swap/Transfer logs live in that SAME block (same transaction), so there
 * is no reason to scan anything else. One eth_getLogs call per unique
 * block, filtered to (PoolManager address OR known reference-token
 * addresses) AND (Swap topic OR Transfer topic) - each such call returns
 * only what happened in that single block, which is small and fast no
 * matter how busy the chain is. Total requests = number of unique blocks
 * the wallet actually traded in, not a function of window size at all.
 */

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

/** Max eth_getLogs calls in flight at once - single-block calls are cheap, so this can be higher than the old range-scan concurrency. */
const MAX_CONCURRENT_REQUESTS = 8;
const PROGRESS_EVERY = 200; // blocks

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const requestSemaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);

async function fetchLogsForBlock(
  client: PublicClient,
  addresses: string[],
  topics: string[],
  blockNumber: bigint
): Promise<RawLog[]> {
  return withRateLimitRetry(
    async () => {
      const release = await requestSemaphore.acquire();
      try {
        const logs = await (client as any).request({
          method: 'eth_getLogs',
          params: [
            {
              fromBlock: `0x${blockNumber.toString(16)}`,
              toBlock: `0x${blockNumber.toString(16)}`,
              address: addresses,
              topics: [topics],
            },
          ],
        });
        return logs ?? [];
      } finally {
        release();
      }
    },
    { label: `eth_getLogs block=${blockNumber}` }
  );
}

export interface BlockLogsResult {
  swapLogsByHash: Map<string, RawLog[]>;
  transferLogsByHash: Map<string, RawLog[]>;
}

/**
 * Fetches Swap events at `poolManager` and Transfer events at each
 * `referenceTokenAddresses` entry, for exactly the given block numbers -
 * one eth_getLogs call per unique block, concurrency-capped, with
 * step-by-step progress logging so a long scan is visibly moving instead
 * of looking hung.
 */
export async function bulkFetchLogsForBlocks(
  client: PublicClient,
  chainLabel: string,
  poolManager: string,
  swapTopic: string,
  transferTopic: string,
  referenceTokenAddresses: string[],
  blockNumbers: bigint[]
): Promise<BlockLogsResult> {
  const uniqueBlocks = Array.from(new Set(blockNumbers.map((b) => b.toString()))).map((s) => BigInt(s));
  const addresses = [poolManager, ...referenceTokenAddresses];
  const topics = [swapTopic, transferTopic];

  console.log(
    `[edge:bulkLogScan] ${chainLabel} scanning ${uniqueBlocks.length} unique block(s) (from ${blockNumbers.length} candidates) — addresses=[poolManager + ${referenceTokenAddresses.length} reference token(s)], concurrency=${MAX_CONCURRENT_REQUESTS}`
  );

  const swapLogsByHash = new Map<string, RawLog[]>();
  const transferLogsByHash = new Map<string, RawLog[]>();
  const startedAt = Date.now();
  let done = 0;
  let failedBlocks = 0;
  let totalLogsFound = 0;

  await Promise.all(
    uniqueBlocks.map(async (block) => {
      let logs: RawLog[] = [];
      try {
        logs = await fetchLogsForBlock(client, addresses, topics, block);
      } catch (err: any) {
        failedBlocks++;
        console.log(`[edge:bulkLogScan] ${chainLabel} block=${block} FAILED after retries: ${err?.message ?? err}`);
      }

      for (const log of logs) {
        const h = log.transactionHash.toLowerCase();
        const isSwap = log.address?.toLowerCase() === poolManager.toLowerCase() && log.topics?.[0] === swapTopic;
        const target = isSwap ? swapLogsByHash : transferLogsByHash;
        const arr = target.get(h) ?? [];
        arr.push(log);
        target.set(h, arr);
      }

      done++;
      totalLogsFound += logs.length;
      if (done % PROGRESS_EVERY === 0 || done === uniqueBlocks.length) {
        const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
        const rate = done / Math.max(0.1, (Date.now() - startedAt) / 1000);
        const etaS = rate > 0 ? Math.round((uniqueBlocks.length - done) / rate) : 0;
        console.log(
          `[edge:bulkLogScan] ${chainLabel} progress: ${done}/${uniqueBlocks.length} blocks (${((done / uniqueBlocks.length) * 100).toFixed(0)}%), ${totalLogsFound} log(s) found so far, ${failedBlocks} failed, ${elapsedS}s elapsed${done < uniqueBlocks.length ? `, eta=${etaS}s` : ''}`
        );
      }
    })
  );

  console.log(
    `[edge:bulkLogScan] ${chainLabel} DONE: ${uniqueBlocks.length} block(s) scanned, ${swapLogsByHash.size} tx(s) with Swap logs, ${transferLogsByHash.size} tx(s) with reference-token Transfer logs, ${failedBlocks} block(s) failed, ${((Date.now() - startedAt) / 1000).toFixed(1)}s total`
  );

  return { swapLogsByHash, transferLogsByHash };
}
