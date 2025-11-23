/**
 * Recalculate durationSeconds for all closed trades
 * Fixes negative durations by using correct executedAt and closedAt times
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables from .env.local BEFORE any other imports
config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    console.log('🔧 Recalculating trade durations...\n');

    // Dynamic imports to ensure env vars are loaded first
    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');

    // Connect to MongoDB
    await connectDB();
    console.log('✓ MongoDB connected\n');

    // Find all CLOSED trades
    const closedTrades = await TradeEvent.find({ status: 'CLOSED' });

    if (closedTrades.length === 0) {
      console.log('No closed trades found');
      process.exit(0);
    }

    console.log(`Found ${closedTrades.length} closed trades\n`);

    let correctedCount = 0;
    let errorCount = 0;

    for (const trade of closedTrades) {
      try {
        // Get the open time (when position was executed)
        const openedAt = trade.executedAt || trade.initiatedAt;
        const closedAt = trade.closedAt;

        if (!openedAt || !closedAt) {
          console.log(`⚠️  Trade ${trade.orderId}: Missing timestamps`);
          errorCount++;
          continue;
        }

        // Calculate correct duration in seconds
        const durationMs = closedAt.getTime() - openedAt.getTime();
        const durationSeconds = Math.floor(durationMs / 1000);

        // Only update if different
        if (trade.durationSeconds !== durationSeconds) {
          const oldDuration = trade.durationSeconds;
          trade.durationSeconds = durationSeconds;
          await trade.save();

          if (oldDuration < 0) {
            console.log(
              `✓ Fixed trade ${trade.orderId}: ${oldDuration}s → ${durationSeconds}s (${(durationSeconds / 3600).toFixed(1)}h)`
            );
          }

          correctedCount++;
        }
      } catch (error) {
        console.error(`❌ Error processing trade ${trade.orderId}:`, error);
        errorCount++;
      }
    }

    console.log('\n✅ Duration recalculation complete!');
    console.log(`   - Trades corrected: ${correctedCount}`);
    console.log(`   - Trades with errors: ${errorCount}`);
    console.log(`   - Total processed: ${closedTrades.length}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Duration recalculation failed:', error);
    process.exit(1);
  }
}

main();
