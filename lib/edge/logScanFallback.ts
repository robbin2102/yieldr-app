import { erc20Abi, type PublicClient } from 'viem';

/**
 * Fallback wallet-transfer scan via raw eth_getLogs, used when
 * `alchemy_getAssetTransfers` isn't available on a given RPC endpoint
 * (e.g. a HOOD app that's a plain JSON-RPC proxy rather than a full
 * Alchemy-enhanced chain). Every EVM chain supports eth_getLogs, so this
 * always works as a baseline - just slower and without USD-normalized
 * amounts (decimals are resolved separately, batched + cached below).
 *
 * Uses a raw `eth_getLogs` request rather than viem's typed `getLogs`
 * helper - the typed helper's overloads expect an `event`/`abi` shape,
 * not a bare topics array, which is all we need here.
 */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CHUNK_SIZE = BigInt(2000);
const ONE = BigInt(1);
const PARALLEL = 5;

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string; // hex
}

export interface ScannedTransfer {
  hash: string;
  from: string;
  to: string;
  rawValue: bigint;
  tokenAddress: string;
  blockNumber: bigint;
}

async function rawGetLogs(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
  try {
    const logs = await (client as any).request({
      method: 'eth_getLogs',
      params: [
        {
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [TRANSFER_TOPIC],
        },
      ],
    });
    return logs ?? [];
  } catch {
    return [];
  }
}

export async function scanTransfersViaLogs(
  client: PublicClient,
  wallet: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ outgoing: ScannedTransfer[]; incoming: ScannedTransfer[] }> {
  const chunks: Array<{ from: bigint; to: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = start + CHUNK_SIZE - ONE;
    chunks.push({ from: start, to: end > toBlock ? toBlock : end });
  }

  const outgoing: ScannedTransfer[] = [];
  const incoming: ScannedTransfer[] = [];
  const walletLower = wallet.toLowerCase();

  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const batch = chunks.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map((c) => rawGetLogs(client, c.from, c.to)));

    for (const log of results.flat()) {
      if (!log.topics[1] || !log.topics[2] || log.data === '0x') continue;
      const from = `0x${log.topics[1].slice(-40)}`.toLowerCase();
      const to = `0x${log.topics[2].slice(-40)}`.toLowerCase();
      if (from !== walletLower && to !== walletLower) continue;

      const entry: ScannedTransfer = {
        hash: log.transactionHash,
        from,
        to,
        rawValue: BigInt(log.data),
        tokenAddress: log.address.toLowerCase(),
        blockNumber: BigInt(log.blockNumber),
      };
      if (from === walletLower) outgoing.push(entry);
      if (to === walletLower) incoming.push(entry);
    }
  }

  return { outgoing, incoming };
}

const decimalsCache = new Map<string, number>();

export async function getDecimals(client: PublicClient, tokenAddress: `0x${string}`): Promise<number> {
  const key = tokenAddress.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const decimals = await client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' });
    decimalsCache.set(key, decimals);
    return decimals;
  } catch {
    decimalsCache.set(key, 18);
    return 18;
  }
}

const blockTimestampCache = new Map<string, Date>();

export async function getBlockTimestamp(client: PublicClient, blockNumber: bigint): Promise<Date> {
  const key = blockNumber.toString();
  const cached = blockTimestampCache.get(key);
  if (cached) return cached;
  const block = await client.getBlock({ blockNumber });
  const ts = new Date(Number(block.timestamp) * 1000);
  blockTimestampCache.set(key, ts);
  return ts;
}
