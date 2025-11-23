/**
 * Backfiller
 * Fetches historical events in chunks with progress tracking
 */

import { getLogs, getLatestBlockNumber, getBlock } from './core/ViemClient';
import { CONTRACTS, MARKET_ORDER_INITIATED_EVENT, MARKET_EXECUTED_EVENT, BLOCK_CONFIG, APP_EVENTS, TradeStatus } from './config';
import { batchParseMarketOrderInitiated, batchParseMarketExecuted } from './EventParser';
import { processMarketOrderInitiated, processMarketExecuted, eventEmitter } from './EventCorrelator';
import type { BackfillOptions } from './core/types';
import type { Log } from 'viem';
import TradeEvent from '../../models/TradeEvent';

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process a single chunk of blocks
 */
async function processChunk(
  chunk: { fromBlock: bigint; toBlock: bigint },
  wallet: string,
  chunkIndex: number,
  totalChunks: number
): Promise<{ initiated: number; executed: number; endBlock: bigint }> {
  const { fromBlock: chunkStart, toBlock: chunkEnd } = chunk;

  try {
    // Fetch initiated events - FILTER BY TRADER ADDRESS
    const initiatedLogs = await getLogs({
      address: CONTRACTS.TRADING,
      event: MARKET_ORDER_INITIATED_EVENT,
      args: {
        trader: wallet as `0x${string}`, // Filter by indexed trader parameter
      },
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });

    // Skip if no events found (no need to fetch MarketExecuted)
    if (initiatedLogs.length === 0) {
      return { initiated: 0, executed: 0, endBlock: chunkEnd };
    }

    console.log(
      `[Backfiller] Chunk ${chunkIndex}/${totalChunks}: Found ${initiatedLogs.length} initiated events`
    );

    // Parse events
    const parsedInitiated = batchParseMarketOrderInitiated(initiatedLogs);

    // Process initiated events
    for (const event of parsedInitiated) {
      await processMarketOrderInitiated(event);
    }

    // Fetch executed events in parallel sub-chunks
    const orderIds = parsedInitiated.map((e) => e.orderId);
    const executedSubChunkSize = BLOCK_CONFIG.EXECUTED_SUB_CHUNK_SIZE;
    const subChunks = createChunks(chunkStart, chunkEnd, executedSubChunkSize);

    // Parallel fetch of all sub-chunks
    const executedLogsArrays = await Promise.all(
      subChunks.map((subChunk) =>
        getLogs({
          address: CONTRACTS.EVENTS,
          event: MARKET_EXECUTED_EVENT,
          fromBlock: subChunk.fromBlock,
          toBlock: subChunk.toBlock,
        })
      )
    );

    // Flatten results
    const executedLogs = executedLogsArrays.flat();

    // Parse and filter by wallet and orderIds
    const parsedExecuted = batchParseMarketExecuted(executedLogs).filter(
      (event) =>
        event.trader.toLowerCase() === wallet.toLowerCase() || orderIds.includes(event.orderId)
    );

    console.log(
      `[Backfiller] Chunk ${chunkIndex}/${totalChunks}: Matched ${parsedExecuted.length}/${executedLogs.length} executed events`
    );

    // Return parsed events instead of processing them immediately
    // This allows us to process all OPEN events before CLOSE events
    return {
      initiated: parsedInitiated.length,
      executed: parsedExecuted.length,
      endBlock: chunkEnd,
      executedEvents: parsedExecuted, // Return events for later processing
    };
  } catch (error) {
    console.error(`[Backfiller] Error processing chunk ${chunkIndex}:`, error);
    eventEmitter.emit(APP_EVENTS.BACKFILL_ERROR, {
      wallet,
      chunk: chunkIndex,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { initiated: 0, executed: 0, endBlock: chunkEnd, executedEvents: [] };
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

    let totalInitiated = 0;
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
        totalInitiated += result.initiated;
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
          eventsFound: totalInitiated + totalExecuted,
          currentBlock: Number(result.endBlock),
        });
      }

      console.log(
        `[Backfiller] Batch ${batchNumber}/${totalBatches} complete - Progress: ${((processedChunks / chunks.length) * 100).toFixed(1)}%`
      );
    }

    // Process all collected events in chronological order (by block number)
    // This ensures that for any given tradeKey, OPEN comes before CLOSE naturally
    console.log(`[Backfiller] Processing ${allExecutedEvents.length} executed events...`);

    const openEvents = allExecutedEvents.filter(e => e.open === true);
    const closeEvents = allExecutedEvents.filter(e => e.open === false);
    console.log(`[Backfiller] Found ${openEvents.length} OPEN and ${closeEvents.length} CLOSE events`);

    // Sort all events by block number (chronological order)
    const sortedEvents = allExecutedEvents.sort((a, b) => {
      return Number(a.executedBlockNumber) - Number(b.executedBlockNumber);
    });

    console.log(`[Backfiller] Processing events in chronological order by block number...`);

    // Track statistics
    let openedCount = 0;
    let closedCount = 0;
    let closeFailedCount = 0;
    let duplicateOpenCount = 0;

    // Process events in chronological order
    for (const event of sortedEvents) {
      const tradeKey = `${event.trader.toLowerCase()}-${event.pairIndex}-${event.tradeIndex}`;
      const existed = await TradeEvent.exists({ tradeKey });

      if (event.open) {
        if (existed) {
          duplicateOpenCount++;
          console.log(`[Backfiller] ⚠️  Duplicate OPEN for tradeKey ${tradeKey} at block ${event.executedBlockNumber}`);
        } else {
          openedCount++;
        }
      } else {
        if (existed) {
          closedCount++;
        } else {
          closeFailedCount++;
          console.log(`[Backfiller] ⚠️  CLOSE failed (no open) for tradeKey ${tradeKey} at block ${event.executedBlockNumber}`);
        }
      }

      await processMarketExecuted(event);
    }

    console.log(`[Backfiller] ✓ All events processed`);
    console.log(`[Backfiller] Statistics:`);
    console.log(`[Backfiller]   - New positions OPENED: ${openedCount}`);
    console.log(`[Backfiller]   - Positions CLOSED: ${closedCount}`);
    console.log(`[Backfiller]   - Duplicate OPENs (updates): ${duplicateOpenCount}`);
    console.log(`[Backfiller]   - CLOSE failed (no open position): ${closeFailedCount}`);

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

/**
 * Correct close timestamps for closed trades by fetching actual block timestamps
 * @param wallet - Wallet address to correct (optional, corrects all if not provided)
 */
export async function correctCloseTimestamps(wallet?: string): Promise<{
  corrected: number;
  uniqueBlocks: number;
  durationMs: number;
}> {
  const startTime = Date.now();

  console.log('[Backfiller] Starting close timestamp correction...');

  try {
    // Query closed trades
    const query = wallet
      ? { status: TradeStatus.CLOSED, trader: wallet.toLowerCase() }
      : { status: TradeStatus.CLOSED };

    const closedTrades = await TradeEvent.find(query).select('orderId closedBlockNumber closedAt');

    if (closedTrades.length === 0) {
      console.log('[Backfiller] No closed trades found to correct');
      return { corrected: 0, uniqueBlocks: 0, durationMs: Date.now() - startTime };
    }

    console.log(`[Backfiller] Found ${closedTrades.length} closed trades to correct`);

    // Extract unique block numbers
    const uniqueBlockNumbers = Array.from(
      new Set(
        closedTrades
          .filter((trade) => trade.closedBlockNumber)
          .map((trade) => trade.closedBlockNumber)
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

    // Update trades with correct timestamps
    let correctedCount = 0;
    for (const trade of closedTrades) {
      if (trade.closedBlockNumber && blockTimestamps.has(trade.closedBlockNumber)) {
        const correctTimestamp = blockTimestamps.get(trade.closedBlockNumber)!;

        // Only update if timestamp is different
        if (trade.closedAt.getTime() !== correctTimestamp.getTime()) {
          trade.closedAt = correctTimestamp;
          await trade.save();
          correctedCount++;
        }
      }
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[Backfiller] ✓ Close timestamp correction complete - ${correctedCount}/${closedTrades.length} trades updated in ${(durationMs / 1000).toFixed(1)}s`
    );

    return {
      corrected: correctedCount,
      uniqueBlocks: uniqueBlockNumbers.length,
      durationMs,
    };
  } catch (error) {
    console.error('[Backfiller] Close timestamp correction failed:', error);
    throw error;
  }
}
