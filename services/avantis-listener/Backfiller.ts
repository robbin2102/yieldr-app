/**
 * Backfiller
 * Fetches historical events in chunks with progress tracking
 */

import { getLogs, getLatestBlockNumber } from './core/ViemClient';
import { CONTRACTS, MARKET_ORDER_INITIATED_EVENT, MARKET_EXECUTED_EVENT, BLOCK_CONFIG, APP_EVENTS } from './config';
import { batchParseMarketOrderInitiated, batchParseMarketExecuted } from './EventParser';
import { processMarketOrderInitiated, processMarketExecuted, eventEmitter } from './EventCorrelator';
import type { BackfillOptions } from './core/types';
import type { Log } from 'viem';

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill historical events for a wallet
 */
export async function backfillWallet(options: BackfillOptions): Promise<BackfillResult> {
  const {
    wallet,
    daysBack = 90,
    chunkSize = BLOCK_CONFIG.CHUNK_SIZE,
    delayMs = BLOCK_CONFIG.CHUNK_DELAY_MS,
  } = options;

  const startTime = Date.now();
  console.log(`[Backfiller] Starting backfill for wallet ${wallet} (${daysBack} days)`);

  try {
    // Calculate block range
    const { startBlock, endBlock } = await calculateBlockRange(options, daysBack);

    console.log(
      `[Backfiller] Block range: ${startBlock} to ${endBlock} (${endBlock - startBlock} blocks)`
    );

    // Split into chunks
    const chunks = createChunks(startBlock, endBlock, chunkSize);
    console.log(`[Backfiller] Processing ${chunks.length} chunks of ${chunkSize} blocks`);

    let totalInitiated = 0;
    let totalExecuted = 0;
    let processedBlocks = 0;

    // Process each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkStart = chunk.fromBlock;
      const chunkEnd = chunk.toBlock;

      console.log(
        `[Backfiller] Processing chunk ${i + 1}/${chunks.length} (blocks ${chunkStart} to ${chunkEnd})`
      );

      try {
        // Fetch initiated events
        const initiatedLogs = await getLogs({
          address: CONTRACTS.TRADING,
          event: MARKET_ORDER_INITIATED_EVENT,
          fromBlock: chunkStart,
          toBlock: chunkEnd,
        });

        console.log(`[Backfiller] Found ${initiatedLogs.length} MarketOrderInitiated events`);

        // Parse and filter by wallet
        const parsedInitiated = batchParseMarketOrderInitiated(initiatedLogs).filter(
          (event) => event.trader.toLowerCase() === wallet.toLowerCase()
        );

        console.log(`[Backfiller] ${parsedInitiated.length} events match wallet ${wallet}`);

        // Process initiated events
        for (const event of parsedInitiated) {
          await processMarketOrderInitiated(event);
          totalInitiated++;
        }

        // Fetch executed events for these orderIds
        if (parsedInitiated.length > 0) {
          const orderIds = parsedInitiated.map((e) => e.orderId);

          const executedLogs = await getLogs({
            address: CONTRACTS.EVENTS,
            event: MARKET_EXECUTED_EVENT,
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          });

          console.log(`[Backfiller] Found ${executedLogs.length} MarketExecuted events`);

          // Parse and filter by wallet and orderIds
          const parsedExecuted = batchParseMarketExecuted(executedLogs).filter(
            (event) =>
              event.trader.toLowerCase() === wallet.toLowerCase() ||
              orderIds.includes(event.orderId)
          );

          console.log(`[Backfiller] ${parsedExecuted.length} execution events match`);

          // Process executed events
          for (const event of parsedExecuted) {
            await processMarketExecuted(event);
            totalExecuted++;
          }
        }

        // Update progress
        processedBlocks += Number(chunkEnd - chunkStart);
        const percentComplete = ((i + 1) / chunks.length) * 100;

        // Emit progress event
        eventEmitter.emit(APP_EVENTS.BACKFILL_PROGRESS, {
          wallet,
          processedBlocks,
          totalBlocks: Number(endBlock - startBlock),
          percentComplete,
          eventsFound: totalInitiated + totalExecuted,
          currentBlock: Number(chunkEnd),
        });

        console.log(
          `[Backfiller] Progress: ${percentComplete.toFixed(1)}% (${i + 1}/${chunks.length} chunks)`
        );

        // Delay before next chunk to avoid rate limits
        if (i < chunks.length - 1) {
          await sleep(delayMs);
        }
      } catch (error) {
        console.error(`[Backfiller] Error processing chunk ${i + 1}:`, error);

        // Emit error but continue with next chunk
        eventEmitter.emit(APP_EVENTS.BACKFILL_ERROR, {
          wallet,
          chunk: i + 1,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const durationMs = Date.now() - startTime;

    const result: BackfillResult = {
      wallet,
      startBlock: Number(startBlock),
      endBlock: Number(endBlock),
      totalBlocks: Number(endBlock - startBlock),
      eventsFound: totalInitiated + totalExecuted,
      initiatedEvents: totalInitiated,
      executedEvents: totalExecuted,
      durationMs,
      success: true,
    };

    // Emit completion event
    eventEmitter.emit(APP_EVENTS.BACKFILL_COMPLETE, {
      wallet,
      totalBlocks: result.totalBlocks,
      totalEvents: result.eventsFound,
      tradesFound: totalInitiated,
      startBlock: result.startBlock,
      endBlock: result.endBlock,
      durationMs,
    });

    console.log(
      `[Backfiller] ✓ Backfill complete for ${wallet} - Found ${result.eventsFound} events in ${(durationMs / 1000).toFixed(1)}s`
    );

    return result;
  } catch (error) {
    console.error('[Backfiller] Backfill failed:', error);

    eventEmitter.emit(APP_EVENTS.BACKFILL_ERROR, {
      wallet,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    throw error;
  }
}

/**
 * Calculate block range for backfilling
 */
async function calculateBlockRange(
  options: BackfillOptions,
  daysBack: number
): Promise<{ startBlock: bigint; endBlock: bigint }> {
  let startBlock: bigint;
  let endBlock: bigint;

  if (options.startBlock !== undefined && options.endBlock !== undefined) {
    // Use provided block range
    startBlock = BigInt(options.startBlock);
    endBlock = BigInt(options.endBlock);
  } else {
    // Calculate from current block
    const latestBlock = await getLatestBlockNumber();
    const blocksToFetch = BigInt(daysBack * BLOCK_CONFIG.BLOCKS_PER_DAY);

    endBlock = options.endBlock !== undefined ? BigInt(options.endBlock) : latestBlock;
    startBlock =
      options.startBlock !== undefined
        ? BigInt(options.startBlock)
        : endBlock - blocksToFetch;

    // Ensure startBlock is not negative
    if (startBlock < 0n) {
      startBlock = 0n;
    }
  }

  return { startBlock, endBlock };
}

/**
 * Create chunk ranges
 */
function createChunks(
  startBlock: bigint,
  endBlock: bigint,
  chunkSize: number
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  const chunks: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  let currentBlock = startBlock;
  const chunkSizeBigInt = BigInt(chunkSize);

  while (currentBlock < endBlock) {
    const nextBlock = currentBlock + chunkSizeBigInt;
    const toBlock = nextBlock > endBlock ? endBlock : nextBlock;

    chunks.push({
      fromBlock: currentBlock,
      toBlock: toBlock,
    });

    currentBlock = toBlock;
  }

  return chunks;
}

/**
 * Backfill result interface
 */
export interface BackfillResult {
  wallet: string;
  startBlock: number;
  endBlock: number;
  totalBlocks: number;
  eventsFound: number;
  initiatedEvents: number;
  executedEvents: number;
  durationMs: number;
  success: boolean;
}

/**
 * Backfill multiple wallets
 */
export async function backfillMultipleWallets(
  wallets: string[],
  options: Omit<BackfillOptions, 'wallet'> = {}
): Promise<BackfillResult[]> {
  console.log(`[Backfiller] Starting backfill for ${wallets.length} wallets`);

  const results: BackfillResult[] = [];

  for (const wallet of wallets) {
    try {
      const result = await backfillWallet({ ...options, wallet });
      results.push(result);
    } catch (error) {
      console.error(`[Backfiller] Failed to backfill wallet ${wallet}:`, error);
      results.push({
        wallet,
        startBlock: 0,
        endBlock: 0,
        totalBlocks: 0,
        eventsFound: 0,
        initiatedEvents: 0,
        executedEvents: 0,
        durationMs: 0,
        success: false,
      });
    }
  }

  console.log(
    `[Backfiller] ✓ Completed backfill for ${wallets.length} wallets - ${results.filter((r) => r.success).length} successful`
  );

  return results;
}
