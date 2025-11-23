/**
 * Fix ALL timestamp issues: fetch correct block timestamps AND recalculate durations
 * This is the complete fix for negative durations
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local BEFORE any other imports
config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Fixing all close timestamps and durations...\n');

    // Dynamic imports to ensure env vars are loaded first
    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');
    const { getBlock } = await import('../services/avantis-listener/core/ViemClient');

    // Connect to MongoDB
    await connectDB();
    console.log('✓ MongoDB connected\n');

    // Find all CLOSED trades
    const closedTrades = await TradeEvent.find({ status: 'CLOSED' });

    if (closedTrades.length === 0) {
      console.log('No closed trades found');
      process.exit(0);
    }

    console.log(`Found ${closedTrades.length} closed trades\n');

    // Step 1: Fetch correct close timestamps from blocks
    console.log('Step 1: Fetching correct close timestamps from blocks...\n');

    const uniqueBlockNumbers = Array.from(
      new Set(
        closedTrades
          .filter((trade) => trade.closedBlockNumber)
          .map((trade) => trade.closedBlockNumber)
      )
    );

    console.log(`Fetching timestamps for ${uniqueBlockNumbers.length} unique blocks in parallel...\n`);

    const blockTimestamps = new Map<number, Date>();

    const blockPromises = uniqueBlockNumbers.map(async (blockNumber) => {
      try {
        const block = await getBlock(BigInt(blockNumber));
        return { blockNumber, timestamp: new Date(Number(block.timestamp) * 1000) };
      } catch (error) {
        console.error(`Failed to fetch block ${blockNumber}:`, error);
        return null;
      }
    });

    const blockResults = await Promise.all(blockPromises);

    for (const result of blockResults) {
      if (result) {
        blockTimestamps.set(result.blockNumber, result.timestamp);
      }
    }

    console.log(`✓ Fetched ${blockTimestamps.size}/${uniqueBlockNumbers.length} block timestamps\n`);

    // Step 2: Update closedAt and recalculate durations
    console.log('Step 2: Updating closedAt and recalculating durations...\n');

    let correctedCount = 0;
    let errorCount = 0;

    for (const trade of closedTrades) {
      try {
        // Get correct close timestamp from block
        if (!trade.closedBlockNumber || !blockTimestamps.has(trade.closedBlockNumber)) {
          console.log(`⚠️  Trade ${trade.orderId}: Missing closedBlockNumber or block timestamp`);
          errorCount++;
          continue;
        }

        const correctCloseTime = blockTimestamps.get(trade.closedBlockNumber)!;

        // Get open time
        const openedAt = trade.executedAt || trade.initiatedAt;

        if (!openedAt) {
          console.log(`⚠️  Trade ${trade.orderId}: Missing open timestamp`);
          errorCount++;
          continue;
        }

        // Calculate correct duration
        const durationMs = correctCloseTime.getTime() - openedAt.getTime();
        const durationSeconds = Math.floor(durationMs / 1000);

        // Only update if different
        const needsUpdate =
          trade.closedAt.getTime() !== correctCloseTime.getTime() ||
          trade.durationSeconds !== durationSeconds;

        if (needsUpdate) {
          const oldClosedAt = trade.closedAt;
          const oldDuration = trade.durationSeconds;

          trade.closedAt = correctCloseTime;
          trade.durationSeconds = durationSeconds;
          await trade.save();

          console.log(
            `✓ Fixed trade ${trade.orderId}:\n` +
            `  closedAt: ${oldClosedAt.toISOString()} → ${correctCloseTime.toISOString()}\n` +
            `  duration: ${oldDuration}s → ${durationSeconds}s (${(durationSeconds / 3600).toFixed(1)}h)`
          );

          correctedCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing trade ${trade.orderId}:`, error);
        errorCount++;
      }
    }

    console.log('\n✅ Complete!');
    console.log(`   - Trades corrected: ${correctedCount}`);
    console.log(`   - Trades with errors: ${errorCount}`);
    console.log(`   - Total processed: ${closedTrades.length}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Fix failed:', error);
    process.exit(1);
  }
}

main();
