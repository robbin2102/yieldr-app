/**
 * Check for duplicate positions using the NEW filter
 * (conditionId + asset + timestamp)
 *
 * This checks if partial closes or multiple transactions create duplicates
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions.js';

const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n🔍 CHECKING FOR DUPLICATES WITH ASSET FIELD\n');
  console.log('='.repeat(80) + '\n');

  const positions = await fetchClosedPositions(TEST_WALLET, 30);

  console.log(`✅ Fetched ${positions.length} positions from API\n`);

  // Group by our NEW upsert key: conditionId + asset + timestamp
  const keyMap = new Map<string, any[]>();

  for (const pos of positions) {
    const key = `${pos.conditionId}_${pos.asset}_${pos.timestamp}`;

    if (!keyMap.has(key)) {
      keyMap.set(key, []);
    }
    keyMap.get(key)!.push(pos);
  }

  // Find duplicates
  const duplicates = Array.from(keyMap.entries())
    .filter(([_, positions]) => positions.length > 1);

  console.log('📊 RESULTS:\n');
  console.log(`Total unique keys (conditionId + asset + timestamp): ${keyMap.size}`);
  console.log(`Total positions from API: ${positions.length}`);
  console.log(`Duplicate keys: ${duplicates.length}\n`);

  if (duplicates.length > 0) {
    console.log('❌ FOUND DUPLICATES EVEN WITH ASSET FIELD!\n');
    console.log('This means multiple positions have the same conditionId+asset+timestamp.\n');
    console.log('This happens with PARTIAL CLOSES - same position closed multiple times.\n');

    // Show first 10 examples
    const samplesToShow = Math.min(10, duplicates.length);
    console.log(`Showing first ${samplesToShow} duplicate groups:\n`);

    for (let i = 0; i < samplesToShow; i++) {
      const [key, positions] = duplicates[i];

      console.log(`${i + 1}. ${positions[0].title}`);
      console.log(`   Outcome: ${positions[0].outcome}`);
      console.log(`   Timestamp: ${new Date(positions[0].timestamp * 1000).toISOString()}`);
      console.log(`   Duplicate count: ${positions.length}\n`);

      positions.forEach((p, idx) => {
        const bet = p.avgPrice * p.totalBought;
        console.log(`   [${idx + 1}] Shares: ${p.totalBought.toFixed(2)} @ $${p.avgPrice.toFixed(4)}`);
        console.log(`       Bet: $${bet.toFixed(2)} | PnL: $${p.realizedPnl.toFixed(2)}`);
      });
      console.log('');
    }

    // Calculate impact
    const positionsLost = duplicates.reduce((sum, [_, positions]) =>
      sum + (positions.length - 1), 0
    );

    console.log(`💥 IMPACT: ${positionsLost} positions would be OVERWRITTEN\n`);
    console.log('   API total: ' + positions.length);
    console.log('   Expected in MongoDB (after overwrites): ' + (positions.length - positionsLost));
    console.log('   Actual in MongoDB: 1353\n');

    // Calculate total PnL lost
    const lostPnl = duplicates.reduce((sum, [_, positions]) => {
      // All but the last position in each group would be overwritten
      const overwritten = positions.slice(0, -1);
      return sum + overwritten.reduce((s, p) => s + p.realizedPnl, 0);
    }, 0);

    console.log(`💸 Total PnL lost to overwrites: $${lostPnl.toFixed(2)}\n`);

    console.log('='.repeat(80));
    console.log('🔧 SOLUTION: Need to handle partial closes differently!\n');
    console.log('Option 1: Sum up all closes for same conditionId+asset (aggregate PnL)');
    console.log('Option 2: Add a unique transaction ID to the filter');
    console.log('Option 3: Store each partial close separately with an index');
    console.log('='.repeat(80));

  } else {
    console.log('✅ No duplicates found with conditionId+asset+timestamp!\n');
    console.log('The filter should work correctly. Let me check actual MongoDB data...\n');

    // If no duplicates, the issue might be in how we're saving
    console.log('Expected in MongoDB: ' + positions.length);
    console.log('This should match the API count exactly.');
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
