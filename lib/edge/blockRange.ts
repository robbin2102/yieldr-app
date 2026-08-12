/**
 * Chain-agnostic "block at timestamp" resolution via binary search.
 *
 * The existing services/transaction-fetcher-*.ts files assume a fixed
 * block time (BLOCKS_PER_DAY) to convert a day-window into a block range.
 * That assumption doesn't hold for HOOD, whose block time is unknown to us,
 * so this resolves ranges from real on-chain timestamps instead - it works
 * for any EVM chain without configuration.
 */
import type { PublicClient } from 'viem';

/** Binary-search the latest block whose timestamp is <= targetTs (seconds). */
export async function blockAtOrBefore(
  client: PublicClient,
  targetTs: number,
  latestBlockNumber: bigint
): Promise<bigint> {
  const TWO = BigInt(2);
  const ONE = BigInt(1);
  let lo = BigInt(0);
  let hi = latestBlockNumber;
  let best = BigInt(0);

  while (lo <= hi) {
    const mid = lo + (hi - lo) / TWO;
    const block = await client.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) <= targetTs) {
      best = mid;
      lo = mid + ONE;
    } else {
      hi = mid - ONE;
    }
  }
  return best;
}

export interface BlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

export async function resolveBlockRangeForWindow(
  client: PublicClient,
  windowDays: number
): Promise<BlockRange> {
  const toBlock = await client.getBlockNumber();
  if (windowDays <= 0) return { fromBlock: toBlock, toBlock };

  const nowSec = Math.floor(Date.now() / 1000);
  const targetTs = nowSec - windowDays * 86_400;
  const fromBlock = await blockAtOrBefore(client, targetTs, toBlock);
  return { fromBlock, toBlock };
}
