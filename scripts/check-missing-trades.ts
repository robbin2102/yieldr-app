/**
 * Check for missing trades in the Nov 18-22 range
 * Usage: npx tsx scripts/check-missing-trades.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

const WALLET = '0x9c40c5c236bc2d67e07d9781196050d53fe78908';

// Basescan transactions from user's log
const basescanTransactions = [
  { block: 38493896, txHash: '0x2f5edcfceb0f6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '1,182.22 USDC', date: 'Nov 22' },
  { block: 38493831, txHash: '0xdd24de9d7aec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '990.02 USDC', date: 'Nov 22' },
  { block: 38493776, txHash: '0x27c38fcad3ec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '1,186.49 USDC', date: 'Nov 22' },
  { block: 38493768, txHash: '0xd9b56c2756ec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '1,957.89 USDC', date: 'Nov 22' },
  { block: 38460543, txHash: '0x002de0ab4fec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '1,966.77 USDC', date: 'Nov 21' },
  { block: 38393636, txHash: '0x527bfba5ebec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '979.60 USDC', date: 'Nov 19/20' },
  { block: 38349323, txHash: '0x8dc711287aec6aa56d2e4be1d0f1d8e1c2f1d8e1', value: '644.02 USDC', date: 'Nov 18' },
];

async function main() {
  try {
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: TradeEvent } = await import('../models/TradeEvent');

    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✓ Connected to MongoDB\n');

    // Get all events in the block range
    const minBlock = 38349323;
    const maxBlock = 38493896;

    const events = await TradeEvent.find({
      trader: WALLET.toLowerCase(),
      blockNumber: { $gte: minBlock, $lte: maxBlock },
    }).sort({ blockNumber: 1 });

    console.log(`=== Events in MongoDB for blocks ${minBlock} to ${maxBlock} ===`);
    console.log(`Total events found: ${events.length}\n`);

    // Group by block number
    const eventsByBlock = new Map<number, any[]>();
    for (const event of events) {
      if (!eventsByBlock.has(event.blockNumber)) {
        eventsByBlock.set(event.blockNumber, []);
      }
      eventsByBlock.get(event.blockNumber)!.push(event);
    }

    console.log('Events by block:');
    for (const [block, blockEvents] of Array.from(eventsByBlock.entries()).sort((a, b) => a[0] - b[0])) {
      console.log(`  Block ${block}:`);
      for (const event of blockEvents) {
        const details = event.eventType === 'CLOSE'
          ? `PnL: ${event.pnlUsdc?.toFixed(2)} USDC, ROI: ${event.roi?.toFixed(2)}%`
          : `Open: ${event.openPrice}`;
        console.log(`    - ${event.eventType}: ${event.pairSymbol} ${event.direction} (${details})`);
      }
    }

    console.log('\n=== Comparing with Basescan transactions ===');

    for (const tx of basescanTransactions) {
      const hasEvents = eventsByBlock.has(tx.block);
      const status = hasEvents ? '✓ FOUND' : '✗ MISSING';
      console.log(`${status} - Block ${tx.block} (${tx.date}): ${tx.value}`);
      if (hasEvents) {
        const blockEvents = eventsByBlock.get(tx.block)!;
        console.log(`         → ${blockEvents.length} event(s) in MongoDB`);
      }
    }

    console.log('\n=== Missing blocks that need investigation ===');
    const missingBlocks = basescanTransactions.filter(tx => !eventsByBlock.has(tx.block));

    if (missingBlocks.length === 0) {
      console.log('All Basescan transactions have corresponding events in MongoDB!');
    } else {
      console.log(`Found ${missingBlocks.length} missing blocks:`);
      for (const tx of missingBlocks) {
        console.log(`  - Block ${tx.block} (${tx.date}): ${tx.value}`);
      }

      console.log('\n=== Suggested Resolution ===');
      console.log('Run targeted re-backfill for these specific block ranges:');

      // Group consecutive blocks into ranges
      const sortedMissing = missingBlocks.sort((a, b) => a.block - b.block);
      console.log(`  - Blocks ${sortedMissing[0].block} to ${sortedMissing[sortedMissing.length - 1].block}`);
    }

    // Also check Nov 19 specifically (known missing day)
    console.log('\n=== Checking Nov 19 specifically (known missing) ===');
    const nov19Start = 38393000; // Approximate
    const nov19End = 38420000;   // Approximate

    const nov19Events = await TradeEvent.find({
      trader: WALLET.toLowerCase(),
      blockNumber: { $gte: nov19Start, $lte: nov19End },
    });

    console.log(`Events in Nov 19 range (blocks ${nov19Start}-${nov19End}): ${nov19Events.length}`);
    if (nov19Events.length === 0) {
      console.log('→ CONFIRMED: Entire Nov 19 is missing from MongoDB');
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('Exiting...');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
