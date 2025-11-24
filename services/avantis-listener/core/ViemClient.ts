/**
 * Viem Client for Base Chain
 * Handles RPC connection, retries, and blockchain queries
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { RETRY_CONFIG } from '../config/constants';
import type { RetryOptions } from './types';

/**
 * Singleton Viem client instance
 */
let publicClient: ReturnType<typeof createPublicClient> | null = null;

/**
 * Get or create Viem public client
 * @returns PublicClient instance
 */
export function getViemClient(): ReturnType<typeof createPublicClient> {
  if (publicClient) {
    return publicClient;
  }

  const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL;

  if (!rpcUrl) {
    throw new Error('QUICKNODE_BASE_RPC_URL environment variable is not set');
  }

  console.log('[ViemClient] Initializing Viem client for Base chain...');

  publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl, {
      retryCount: RETRY_CONFIG.MAX_RETRIES,
      retryDelay: RETRY_CONFIG.INITIAL_DELAY_MS,
    }),
  });

  console.log('[ViemClient] ✓ Viem client initialized');

  return publicClient;
}

/**
 * Get latest block number
 * @returns Latest block number
 */
export async function getLatestBlockNumber(): Promise<bigint> {
  const client = getViemClient();
  const blockNumber = await client.getBlockNumber();
  return blockNumber;
}

/**
 * Get block by number
 * @param blockNumber - Block number to fetch
 * @returns Block data
 */
export async function getBlock(blockNumber: bigint) {
  const client = getViemClient();
  return await client.getBlock({ blockNumber });
}

/**
 * Get transaction receipt
 * @param hash - Transaction hash
 * @returns Transaction receipt
 */
export async function getTransactionReceipt(hash: `0x${string}`) {
  const client = getViemClient();
  return await client.getTransactionReceipt({ hash });
}

/**
 * Sleep utility
 * @param ms - Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute function with exponential backoff retry
 * @param fn - Function to execute
 * @param options - Retry options
 * @returns Result of function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelayMs = RETRY_CONFIG.INITIAL_DELAY_MS,
    maxDelayMs = RETRY_CONFIG.MAX_DELAY_MS,
    exponentialBase = RETRY_CONFIG.EXPONENTIAL_BASE,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxRetries) {
        console.error(`[ViemClient] Max retries (${maxRetries}) reached. Giving up.`);
        break;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        initialDelayMs * Math.pow(exponentialBase, attempt),
        maxDelayMs
      );

      console.warn(
        `[ViemClient] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}. Retrying in ${delay}ms...`
      );

      await sleep(delay);
    }
  }

  throw lastError || new Error('Operation failed after retries');
}

/**
 * Get logs with retry logic
 * @param params - GetLogs parameters
 * @returns Event logs
 */
export async function getLogs(params: {
  address: `0x${string}` | `0x${string}`[];
  event?: any;
  fromBlock?: bigint;
  toBlock?: bigint;
}) {
  const client = getViemClient();

  return await withRetry(async () => {
    return await client.getLogs(params);
  });
}

/**
 * Watch event with automatic reconnection
 * @param params - WatchEvent parameters
 * @returns Unwatch function
 */
export function watchEvent(params: {
  address: `0x${string}`;
  event: any;
  onLogs: (logs: any[]) => void;
  onError?: (error: Error) => void;
  poll?: boolean;
  pollingInterval?: number;
}) {
  const client = getViemClient();

  const unwatch = client.watchEvent({
    address: params.address,
    event: params.event,
    onLogs: params.onLogs,
    onError: params.onError,
    poll: params.poll ?? true, // Use polling by default for stability
    pollingInterval: params.pollingInterval ?? 2000, // Poll every 2 seconds (Base block time)
  });

  return unwatch;
}

/**
 * Verify RPC connection
 * @returns true if connected
 */
export async function verifyConnection(): Promise<boolean> {
  try {
    const blockNumber = await getLatestBlockNumber();
    console.log(`[ViemClient] ✓ Connected to Base chain. Latest block: ${blockNumber}`);
    return true;
  } catch (error) {
    console.error('[ViemClient] ✗ Connection failed:', error);
    return false;
  }
}

/**
 * Get chain ID
 * @returns Chain ID
 */
export async function getChainId(): Promise<number> {
  const client = getViemClient();
  return await client.getChainId();
}

/**
 * Reset client (for testing or reconnection)
 */
export function resetClient(): void {
  publicClient = null;
  console.log('[ViemClient] Client reset');
}
