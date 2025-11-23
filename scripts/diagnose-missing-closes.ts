/**
 * Diagnose why positions are showing as EXECUTED instead of CLOSED
 * This will help identify missing close events
 */

import TradeEvent from '../models/TradeEvent';
import connectDB from '../lib/mongoose';
import { getLogs } from '../services/avantis-listener/core/ViemClient';
import { CONTRACTS, MARKET_EXECUTED_EVENT } from '../services/avantis-listener/config';

async function main() {
  try {
    console.log('🔍 Diagnosing missing close events...\n');

    // Connect to MongoDB
    await connectDB();
    console.log('✓ MongoDB connected\n');

    const walletAddress = process.argv[2] || '0x780bb763e1463d2236fec780b7bd6adb40aaa120';

    // Find all EXECUTED positions
    const executedPositions = await TradeEvent.find({
      trader: walletAddress.toLowerCase(),
      status: 'EXECUTED',
    }).sort({ executedAt: 1 });

    console.log(`Found ${executedPositions.length} EXECUTED positions\n`);

    if (executedPositions.length === 0) {
      console.log('✅ No stuck EXECUTED positions!');
      process.exit(0);
    }

    // Group by age
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const recent = executedPositions.filter(p => p.executedAt > oneWeekAgo);
    const oneToTwoWeeks = executedPositions.filter(p => p.executedAt <= oneWeekAgo && p.executedAt > twoWeeksAgo);
    const old = executedPositions.filter(p => p.executedAt <= twoWeeksAgo);

    console.log('📊 EXECUTED Positions by Age:');
    console.log(`   - Last 7 days: ${recent.length}`);
    console.log(`   - 7-14 days ago: ${oneToTwoWeeks.length}`);
    console.log(`   - Older than 14 days: ${old.length}\n`);

    // Check the oldest 5 positions to see if close events exist on-chain
    console.log('🔎 Checking for close events on-chain (oldest 5 positions)...\n');

    for (let i = 0; i < Math.min(5, old.length); i++) {
      const position = old[i];
      console.log(`Position ${i + 1}: orderId ${position.orderId}`);
      console.log(`   Opened: ${position.executedAt?.toISOString()}`);
      console.log(`   Pair: ${position.pairSymbol}`);
      console.log(`   Direction: ${position.direction}`);
      console.log(`   Checking for close events...`);

      try {
        // Search for MarketExecuted close events for this orderId
        // We'll search from the open block to latest
        const fromBlock = BigInt(position.executedBlockNumber || 0);
        const latestBlock = await getLogs({
          address: CONTRACTS.EVENTS,
          event: MARKET_EXECUTED_EVENT,
          fromBlock: fromBlock,
          toBlock: 'latest',
        });

        // Filter for this orderId and open=false
        const closeEvents = latestBlock.filter((log: any) => {
          const args = log.args as any;
          return args.orderId?.toString() === position.orderId && args.open === false;
        });

        if (closeEvents.length > 0) {
          console.log(`   ⚠️  FOUND ${closeEvents.length} close event(s) on-chain!`);
          console.log(`       This position should be CLOSED but is stuck as EXECUTED`);
          console.log(`       Close event block: ${closeEvents[0].blockNumber}`);
        } else {
          console.log(`   ✓ No close event found - position is genuinely open`);
        }

      } catch (error) {
        console.log(`   ❌ Error checking: ${error instanceof Error ? error.message : error}`);
      }

      console.log('');
    }

    // Summary
    console.log('\n📋 Summary:');
    console.log(`   Total EXECUTED positions: ${executedPositions.length}`);
    console.log(`   Expected open positions: ~6 (based on Avantis dashboard)`);
    console.log(`   Positions that might be missing close events: ${executedPositions.length - 6}`);

    console.log('\n💡 Next Steps:');
    console.log('   1. If close events were found on-chain, we need to re-backfill to catch them');
    console.log('   2. If no close events found, these positions are genuinely open');
    console.log('   3. Check if the 30-day backfill is actually covering the full range');

    process.exit(0);
  } catch (error) {
    console.error('❌ Diagnostic failed:', error);
    process.exit(1);
  }
}

main();
