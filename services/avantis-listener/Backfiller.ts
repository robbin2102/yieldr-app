/**
 * Backfiller - Simplified
 * Fetches BOTH MarketExecuted AND LimitExecuted events
 * No correlation needed - each event is self-contained
 */

import { getLogs, getLatestBlockNumber, getBlock } from './core/ViemClient';
import { CONTRACTS, MARKET_EXECUTED_EVENT, LIMIT_EXECUTED_EVENT, BLOCK_CONFIG, APP_EVENTS, TradeStatus } from './config';
import { batchParseMarketExecuted, batchParseLimitExecuted } from './EventParser';
import { processMarketExecuted, eventEmitter } from './EventCorrelator';
import type { BackfillOptions } from './core/types';
import TradeEvent from '../../models/TradeEvent';

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a single chunk of blocks - Simplified
 * Fetches BOTH MarketExecuted AND LimitExecuted events
 */
async function processChunk(
  chunk: { fromBlock: bigint; toBlock: bigint },
  wallet: string,
  chunkIndex: number,
  totalChunks: number
): Promise<{ executed: number; endBlock: bigint; executedEvents: any[] }> {
  const { fromBlock: chunkStart, toBlock: chunkEnd } = chunk;

  try {
    // Fetch events in sub-chunks (for better reliability)
    const executedSubChunkSize = BLOCK_CONFIG.EXECUTED_SUB_CHUNK_SIZE;
    const subChunks = createChunks(chunkStart, chunkEnd, executedSubChunkSize);

    // Parallel fetch of BOTH MarketExecuted AND LimitExecuted events for all sub-chunks
    const [marketExecutedLogsArrays, limitExecutedLogsArrays] = await Promise.all([
      // Fetch MarketExecuted events
      Promise.all(
        subChunks.map((subChunk) =>
          getLogs({
            address: CONTRACTS.EVENTS,
            event: MARKET_EXECUTED_EVENT,
            fromBlock: subChunk.fromBlock,
            toBlock: subChunk.toBlock,
          })
        )
      ),
      // Fetch LimitExecuted events
      Promise.all(
        subChunks.map((subChunk) =>
          getLogs({
            address: CONTRACTS.EVENTS,
            event: LIMIT_EXECUTED_EVENT,
            fromBlock: subChunk.fromBlock,
            toBlock: subChunk.toBlock,
          })
        )
      ),
    ]);

    // Flatten and parse results
    const marketExecutedLogs = marketExecutedLogsArrays.flat();
    const limitExecutedLogs = limitExecutedLogsArrays.flat();

    const parsedMarketExecuted = batchParseMarketExecuted(marketExecutedLogs).filter(
      (event) => event.trader.toLowerCase() === wallet.toLowerCase()
    );

    const parsedLimitExecuted = batchParseLimitExecuted(limitExecutedLogs).filter(
      (event) => event.trader.toLowerCase() === wallet.toLowerCase()
    );

    // Combine both event types
    const allEvents = [...parsedMarketExecuted, ...parsedLimitExecuted];

    if (allEvents.length > 0) {
      console.log(
        `[Backfiller] Chunk ${chunkIndex}/${totalChunks}: Found ${parsedMarketExecuted.length} market + ${parsedLimitExecuted.length} limit = ${allEvents.length} total events`
      );
    }

    // Return combined events for later chronological processing
    return {
      executed: allEvents.length,
      endBlock: chunkEnd,
      executedEvents: allEvents,
    };
  } catch (error) {
    console.error(`[Backfiller] Error processing chunk ${chunkIndex}:`, error);
    eventEmitter.emit(APP_EVENTS.BACKFILL_ERROR, {
      wallet,
      chunk: chunkIndex,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { executed: 0, endBlock: chunkEnd, executedEvents: [] };
  }
}

/**
 * Backfill historical events for a wallet
 */
export async function backfillWallet(options: BackfillOptions): Promise<BackfillResult> {
  const {
    wallet,
    daysBack = 90,
    chunkSize = BLOCK_CONFIG.CHUNK_SIZE,
    parallelChunks = BLOCK_CONFIG.PARALLEL_CHUNKS,
  } = options;

  const startTime = Date.now();
  console.log(`[Backfiller] Starting backfill for wallet ${wallet} (${daysBack} days)`);

  try {
    // Calculate block range
    const { startBlock, endBlock } = await calculateBlockRange(options, daysBack);

    console.log(
      `[Backfiller] Block range: ${startBlock} to ${endBlock} (${endBlock - startBlock} blocks)`
    );

    // Calculate 7-day milestone block for progress tracking
    const sevenDayMilestoneBlock = daysBack > 7
      ? endBlock - BigInt(BLOCK_CONFIG.BLOCKS_PER_DAY * 7)
      : startBlock;
    let sevenDayMilestoneReached = false;
    let sevenDayMilestoneTime = 0;

    // Split into chunks
    const chunks = createChunks(startBlock, endBlock, chunkSize);
    console.log(`[Backfiller] Processing ${chunks.length} chunks in parallel batches of ${parallelChunks}`);

    let totalExecuted = 0;
    let processedChunks = 0;
    const allExecutedEvents: any[] = []; // Collect all executed events

    // Process chunks in parallel batches
    for (let i = 0; i < chunks.length; i += parallelChunks) {
      const batchChunks = chunks.slice(i, i + parallelChunks);
      const batchNumber = Math.floor(i / parallelChunks) + 1;
      const totalBatches = Math.ceil(chunks.length / parallelChunks);

      console.log(
        `[Backfiller] Processing batch ${batchNumber}/${totalBatches} (${batchChunks.length} chunks in parallel)`
      );

      // Process batch in parallel
      const batchResults = await Promise.all(
        batchChunks.map((chunk, idx) => processChunk(chunk, wallet, i + idx + 1, chunks.length))
      );

      // Aggregate results and collect events
      for (const result of batchResults) {
        totalExecuted += result.executed;
        processedChunks++;

        // Collect executed events for later processing
        if (result.executedEvents) {
          allExecutedEvents.push(...result.executedEvents);
        }

        // Check if we've crossed the 7-day milestone
        if (!sevenDayMilestoneReached && daysBack > 7 && result.endBlock >= sevenDayMilestoneBlock) {
          sevenDayMilestoneReached = true;
          sevenDayMilestoneTime = Date.now() - startTime;
          console.log(
            `[Backfiller] ✓ First 7 days complete in ${(sevenDayMilestoneTime / 1000).toFixed(1)}s`
          );
        }

        const percentComplete = (processedChunks / chunks.length) * 100;
        eventEmitter.emit(APP_EVENTS.BACKFILL_PROGRESS, {
          wallet,
          processedBlocks: processedChunks * chunkSize,
          totalBlocks: Number(endBlock - startBlock),
          percentComplete,
          eventsFound: totalExecuted,
          currentBlock: Number(result.endBlock),
        });
      }

      console.log(
        `[Backfiller] Batch ${batchNumber}/${totalBatches} complete - Progress: ${((processedChunks / chunks.length) * 100).toFixed(1)}%`
      );
    }

    // Process all collected events in chronological order (by block number)
    console.log(`[Backfiller] Processing ${allExecutedEvents.length} MarketExecuted events...`);

    const openEvents = allExecutedEvents.filter(e => e.open === true);
    const closeEvents = allExecutedEvents.filter(e => e.open === false);
    console.log(`[Backfiller] Found ${openEvents.length} OPEN and ${closeEvents.length} CLOSE events`);

    // Sort all events by block number (chronological order)
    const sortedEvents = allExecutedEvents.sort((a, b) => {
      return Number(a.executedBlockNumber) - Number(b.executedBlockNumber);
    });

    console.log(`[Backfiller] Processing events in chronological order by block number...`);

    // Track statistics
    let openSaved = 0;
    let closeSaved = 0;
    let duplicates = 0;

    // Process events in chronological order
    for (const event of sortedEvents) {
      // Check if this event already exists
      const existed = await TradeEvent.exists({ orderId: event.orderId });

      if (existed) {
        duplicates++;
      } else {
        if (event.open) {
          openSaved++;
        } else {
          closeSaved++;
        }
      }

      await processMarketExecuted(event);
    }

    console.log(`[Backfiller] ✓ All events processed`);
    console.log(`[Backfiller] Statistics:`);
    console.log(`[Backfiller]   - OPEN events saved: ${openSaved}`);
    console.log(`[Backfiller]   - CLOSE events saved: ${closeSaved}`);
    console.log(`[Backfiller]   - Duplicates skipped: ${duplicates}`);
    console.log(`[Backfiller]   - Total events saved: ${openSaved + closeSaved}`);

    // If backfill was more than 7 days and milestone was reached, log remaining time
    if (daysBack > 7 && sevenDayMilestoneReached) {
      console.log(`[Backfiller] Processing remaining ${daysBack - 7} days...`);
    }

    const durationMs = Date.now() - startTime;

    const result: BackfillResult = {
      wallet,
      startBlock: Number(startBlock),
      endBlock: Number(endBlock),
      totalBlocks: Number(endBlock - startBlock),
      eventsFound: totalExecuted,
      executedEvents: totalExecuted,
      durationMs,
      success: true,
    };

    // Emit completion event
    eventEmitter.emit(APP_EVENTS.BACKFILL_COMPLETE, {
      wallet,
      totalBlocks: result.totalBlocks,
      totalEvents: result.eventsFound,
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

/**
 * Correct timestamps for events by fetching actual block timestamps
 * NOTE: With the simplified approach, timestamps are fetched during event processing
 * This function is kept for backwards compatibility or manual corrections
 * @param wallet - Wallet address to correct (optional, corrects all if not provided)
 */
export async function correctCloseTimestamps(wallet?: string): Promise<{
  corrected: number;
  uniqueBlocks: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  console.log('[Backfiller] Starting event timestamp correction...');

  try {
    // Query close events
    const query = wallet
      ? { eventType: 'CLOSE', trader: wallet.toLowerCase() }
      : { eventType: 'CLOSE' };

    const closeEvents = await TradeEvent.find(query).select('orderId blockNumber timestamp');

    if (closeEvents.length === 0) {
      console.log('[Backfiller] No close events found to correct');
      return { corrected: 0, uniqueBlocks: 0, durationMs: Date.now() - startTime };
    }

    console.log(`[Backfiller] Found ${closeEvents.length} close events to correct`);

    // Extract unique block numbers
    const uniqueBlockNumbers = Array.from(
      new Set(
        closeEvents
          .filter((event) => event.blockNumber)
          .map((event) => event.blockNumber)
      )
    );

    console.log(`[Backfiller] Fetching timestamps for ${uniqueBlockNumbers.length} unique blocks in parallel...`);

    // Batch fetch all blocks in parallel
    const blockTimestamps = new Map<number, Date>();

    const blockPromises = uniqueBlockNumbers.map(async (blockNumber) => {
      try {
        const block = await getBlock(BigInt(blockNumber));
        return { blockNumber, timestamp: new Date(Number(block.timestamp) * 1000) };
      } catch (error) {
        console.error(`[Backfiller] Failed to fetch block ${blockNumber}:`, error);
        return null;
      }
    });

    const blockResults = await Promise.all(blockPromises);

    // Build map of block number to timestamp
    for (const result of blockResults) {
      if (result) {
        blockTimestamps.set(result.blockNumber, result.timestamp);
      }
    }

    console.log(`[Backfiller] Successfully fetched ${blockTimestamps.size}/${uniqueBlockNumbers.length} block timestamps`);

    // Update events with correct timestamps
    let correctedCount = 0;
    for (const event of closeEvents) {
      if (event.blockNumber && blockTimestamps.has(event.blockNumber)) {
        const correctTimestamp = blockTimestamps.get(event.blockNumber)!;

        // Only update if timestamp is different
        if (event.timestamp.getTime() !== correctTimestamp.getTime()) {
          event.timestamp = correctTimestamp;
          await event.save();
          correctedCount++;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[Backfiller] ✓ Timestamp correction complete - ${correctedCount}/${closeEvents.length} events updated in ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      corrected: correctedCount,
      uniqueBlocks: uniqueBlockNumbers.length,
      durationMs,
    };
  } catch (error) {
    console.error('[Backfiller] Timestamp correction failed:', error);
    throw error;
  }
}
