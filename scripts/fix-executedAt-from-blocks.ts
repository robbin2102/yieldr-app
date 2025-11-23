/**
 * Fix executedAt timestamps by fetching from executedBlockNumber
 * This gets the actual position OPEN time from blockchain
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Fixing executedAt timestamps from block data...\n');

    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');
    const { getBlock } = await import('../services/avantis-listener/core/ViemClient');

    await connectDB();
    console.log('✓ MongoDB connected\n');

    // Find all CLOSED trades
    const closedTrades = await TradeEvent.find({ status: 'CLOSED' });

    if (closedTrades.length === 0) {
      console.log('No closed trades found');
      process.exit(0);
    }

    console.log('Found ' + closedTrades.length + ' closed trades\n');

    // Extract unique executedBlockNumbers for position OPEN times
    const uniqueExecutedBlocks = Array.from(
      new Set(
        closedTrades
          .filter((trade) => trade.executedBlockNumber)
          .map((trade) => trade.executedBlockNumber)
      )
    );

    // Extract unique closedBlockNumbers for position CLOSE times
    const uniqueClosedBlocks = Array.from(
      new Set(
        closedTrades
          .filter((trade) => trade.closedBlockNumber)
          .map((trade) => trade.closedBlockNumber)
      )
    );

    console.log('Fetching ' + uniqueExecutedBlocks.length + ' OPEN block timestamps...');
    console.log('Fetching ' + uniqueClosedBlocks.length + ' CLOSE block timestamps...\n');

    // Fetch all block timestamps in parallel
    const allBlockNumbers = [...new Set([...uniqueExecutedBlocks, ...uniqueClosedBlocks])];
    const blockTimestamps = new Map<number, Date>();

    const blockPromises = allBlockNumbers.map(async (blockNumber) => {
      try {
        const block = await getBlock(BigInt(blockNumber));
        return { blockNumber, timestamp: new Date(Number(block.timestamp) * 1000) };
      } catch (error) {
        console.error('Failed to fetch block ' + blockNumber + ':', error);
        return null;
      }
    });

    const blockResults = await Promise.all(blockPromises);

    for (const result of blockResults) {
      if (result) {
        blockTimestamps.set(result.blockNumber, result.timestamp);
      }
    }

    console.log('✓ Fetched ' + blockTimestamps.size + '/' + allBlockNumbers.length + ' block timestamps\n');
    console.log('Updating trades...\n');

    let correctedCount = 0;
    let errorCount = 0;

    for (const trade of closedTrades) {
      try {
        let needsUpdate = false;
        let correctOpenTime: Date | null = null;
        let correctCloseTime: Date | null = null;

        // Get correct OPEN time from executedBlockNumber
        if (trade.executedBlockNumber && blockTimestamps.has(trade.executedBlockNumber)) {
          correctOpenTime = blockTimestamps.get(trade.executedBlockNumber)!;
        }

        // Get correct CLOSE time from closedBlockNumber
        if (trade.closedBlockNumber && blockTimestamps.has(trade.closedBlockNumber)) {
          correctCloseTime = blockTimestamps.get(trade.closedBlockNumber)!;
        }

        if (!correctOpenTime || !correctCloseTime) {
          console.log('⚠️  Trade ' + trade.orderId + ': Missing block data');
          errorCount++;
          continue;
        }

        // Check if executedAt needs updating
        if (!trade.executedAt || trade.executedAt.getTime() !== correctOpenTime.getTime()) {
          trade.executedAt = correctOpenTime;
          needsUpdate = true;
        }

        // Check if closedAt needs updating
        if (trade.closedAt.getTime() !== correctCloseTime.getTime()) {
          trade.closedAt = correctCloseTime;
          needsUpdate = true;
        }

        // Recalculate duration
        const durationMs = correctCloseTime.getTime() - correctOpenTime.getTime();
        const durationSeconds = Math.floor(durationMs / 1000);

        if (trade.durationSeconds !== durationSeconds) {
          const oldDuration = trade.durationSeconds;
          trade.durationSeconds = durationSeconds;
          needsUpdate = true;

          if (needsUpdate) {
            await trade.save();
            correctedCount++;

            console.log('✓ Fixed trade ' + trade.orderId + ':');
            console.log('  executedAt (OPEN): ' + correctOpenTime.toISOString());
            console.log('  closedAt (CLOSE): ' + correctCloseTime.toISOString());
            console.log('  duration: ' + oldDuration + 's → ' + durationSeconds + 's (' + (durationSeconds / 3600).toFixed(1) + 'h)\n');
          }
        }
      } catch (error) {
        console.error('❌ Error processing trade ' + trade.orderId + ':', error);
        errorCount++;
      }
    }

    console.log('\n✅ Complete!');
    console.log('   - Trades corrected: ' + correctedCount);
    console.log('   - Trades with errors: ' + errorCount);
    console.log('   - Total processed: ' + closedTrades.length);

    process.exit(0);
  } catch (error) {
    console.error('❌ Fix failed:', error);
    process.exit(1);
  }
}

main();
