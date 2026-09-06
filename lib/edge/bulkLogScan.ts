import type { PublicClient } from 'viem';
import { isRateLimitError } from './rpcRetry';

/**
 * Bulk eth_getLogs fetching for the V4 enrichment path - replaces
 * per-transaction eth_getTransactionReceipt calls with a small number of
 * scoped log scans across the whole analysis window.
 *
 * The block-count of the window is NOT the limiting factor here (a wallet
 * trades maybe 100x/day, so at most ~10k relevant trades in 90 days,
 * regardless of how fast the chain's blocks tick) - what actually limits an
 * eth_getLogs call is the provider's response-size/result-count cap. That
 * cap isn't published or constant across providers, so instead of guessing
 * a fixed block-count chunk size, this starts with the whole range and
 * adaptively bisects only when the provider actually rejects the call -
 * self-tuning to whatever the real limit is, on any chain.
 *
 * Bisection fans out recursively (each split spawns two more), so without
 * a concurrency cap a wide range can explode into hundreds of parallel
 * requests - which then all get rate-limited at once and all retry on the
 * same clock, colliding again. A semaphore bounds how many eth_getLogs
 * calls are ever in flight at once, no matter how deep the recursion goes.
 */

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

const MAX_SPLIT_DEPTH = 40; // generous - each split halves the range, so this covers an absurdly large window before giving up
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 2000;
/** Max eth_getLogs calls in flight at once, across the whole bisection tree - the fix for the self-inflicted rate-limit storm. */
const MAX_CONCURRENT_REQUESTS = 4;

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

/** Small random jitter so many callers rate-limited at the same moment don't all retry on the exact same clock tick and collide again. */
function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.25);
}

async function rawGetLogs(
  client: PublicClient,
  address: string | string[] | undefined,
  topics: (string | null)[],
  fromBlock: bigint,
  toBlock: bigint
): Promise<RawLog[]> {
  const release = await requestSemaphore.acquire();
  try {
    return await (client as any).request({
      method: 'eth_getLogs',
      params: [
        {
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          ...(address ? { address } : {}),
          topics,
        },
      ],
    });
  } finally {
    release();
  }
}

/**
 * Fetches logs for [fromBlock, toBlock] in one call; on any error (range
 * too large, too many results, provider timeout - the exact reason varies
 * by provider and isn't worth special-casing) splits the range in half and
 * retries both halves. A 429 is handled separately: that means "you're
 * requesting too fast", so it backs off and retries the SAME range rather
 * than bisecting into more parallel requests (which would make the rate
 * limit worse, not better). The semaphore above caps how many requests -
 * original or split - are ever in flight at once.
 */
async function getLogsAdaptive(
  client: PublicClient,
  address: string | string[] | undefined,
  topics: (string | null)[],
  fromBlock: bigint,
  toBlock: bigint,
  depth = 0,
  rateLimitAttempt = 0
): Promise<RawLog[]> {
  try {
    const logs = await rawGetLogs(client, address, topics, fromBlock, toBlock);
    return logs ?? [];
  } catch (err: any) {
    if (isRateLimitError(err)) {
      if (rateLimitAttempt >= MAX_RATE_LIMIT_RETRIES) {
        console.log(
          `[edge:bulkLogScan] giving up on range ${fromBlock}-${toBlock} after ${rateLimitAttempt} rate-limit retries`
        );
        return [];
      }
      const delay = jitter(RATE_LIMIT_BASE_DELAY_MS * 2 ** rateLimitAttempt);
      console.log(
        `[edge:bulkLogScan] rate limited on range ${fromBlock}-${toBlock}, retrying in ${delay}ms (attempt ${rateLimitAttempt + 1}/${MAX_RATE_LIMIT_RETRIES})`
      );
      await new Promise((r) => setTimeout(r, delay));
      return getLogsAdaptive(client, address, topics, fromBlock, toBlock, depth, rateLimitAttempt + 1);
    }

    if (fromBlock >= toBlock || depth >= MAX_SPLIT_DEPTH) {
      console.log(
        `[edge:bulkLogScan] giving up on range ${fromBlock}-${toBlock} (depth=${depth}): ${err?.message ?? err}`
      );
      return [];
    }
    const mid = fromBlock + (toBlock - fromBlock) / BigInt(2);
    const [left, right] = await Promise.all([
      getLogsAdaptive(client, address, topics, fromBlock, mid, depth + 1),
      getLogsAdaptive(client, address, topics, mid + BigInt(1), toBlock, depth + 1),
    ]);
    return [...left, ...right];
  }
}

function groupByTxHash(logs: RawLog[]): Map<string, RawLog[]> {
  const map = new Map<string, RawLog[]>();
  for (const log of logs) {
    const h = log.transactionHash.toLowerCase();
    const arr = map.get(h) ?? [];
    arr.push(log);
    map.set(h, arr);
  }
  return map;
}

/**
 * Bulk-fetches every Swap event at `poolManager` and every Transfer event
 * for each address in `referenceTokenAddresses`, across [fromBlock,
 * toBlock], and returns both grouped by transaction hash. This covers the
 * two log types enrichUniswapV4Legs actually needs (the V4 Swap match +
 * findReferenceTokenTransfer's Transfer scan) without touching any
 * transaction this wallet wasn't even involved in - callers still filter
 * down to their own candidate hashes afterward.
 */
export async function bulkFetchSwapAndReferenceTransferLogs(
  client: PublicClient,
  poolManager: string,
  swapTopic: string,
  transferTopic: string,
  referenceTokenAddresses: string[],
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ swapLogsByHash: Map<string, RawLog[]>; transferLogsByHash: Map<string, RawLog[]> }> {
  const [swapLogs, ...transferLogSets] = await Promise.all([
    getLogsAdaptive(client, poolManager, [swapTopic], fromBlock, toBlock),
    ...referenceTokenAddresses.map((addr) => getLogsAdaptive(client, addr, [transferTopic], fromBlock, toBlock)),
  ]);

  return {
    swapLogsByHash: groupByTxHash(swapLogs),
    transferLogsByHash: groupByTxHash(transferLogSets.flat()),
  };
}
