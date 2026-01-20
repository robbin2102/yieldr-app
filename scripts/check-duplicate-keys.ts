/**
 * Check for duplicate upsert keys in API data
 *
 * This checks if multiple API positions have the same conditionId+timestamp
 * which would cause our upsert logic to overwrite positions
 */

import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions.js';

const TEST_WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function main() {
  console.log('\n🔍 CHECKING FOR DUPLICATE UPSERT KEYS\n');
  console.log('='.repeat(80) + '\n');

  const positions = await fetchClosedPositions(TEST_WALLET, 30);

  console.log(`✅ Fetched ${positions.length} positions from API\n`);

  // Group by our current upsert key: conditionId + timestamp
  const keyMap = new Map<string, any[]>();

  for (const pos of positions) {
    const key = `${pos.conditionId}_${pos.timestamp}`;

    if (!keyMap.has(key)) {
      keyMap.set(key, []);
    }
    keyMap.get(key)!.push(pos);
  }

  // Find duplicates
  const duplicates = Array.from(keyMap.entries())
    .filter(([_, positions]) => positions.length > 1);

  console.log('📊 RESULTS:\n');
  console.log(`Total unique keys: ${keyMap.size}`);
  console.log(`Total positions: ${positions.length}`);
  console.log(`Duplicate keys: ${duplicates.length}\n`);

  if (duplicates.length > 0) {
    console.log('❌ FOUND DUPLICATE KEYS!\n');
    console.log('This means our upsert filter is causing positions to overwrite each other.\n');

    // Show first 5 examples
    const samplesToShow = Math.min(5, duplicates.length);
    console.log(`Showing first ${samplesToShow} duplicate key groups:\n`);

    for (let i = 0; i < samplesToShow; i++) {
      const [key, positions] = duplicates[i];
      const [conditionId, timestamp] = key.split('_');

      console.log(`${i + 1}. Key: ${conditionId.slice(0, 10)}...${conditionId.slice(-6)}_${timestamp}`);
      console.log(`   Positions with this key: ${positions.length}`);
      console.log(`   Title: ${positions[0].title}`);
      console.log(`   Timestamp: ${new Date(parseInt(timestamp) * 1000).toISOString()}\n`);

      positions.forEach((p, idx) => {
        const bet = p.avgPrice * p.totalBought;
        console.log(`   [${idx + 1}] ${p.outcome} - Asset: ${p.asset.slice(0, 10)}...`);
        console.log(`       Bet: $${bet.toFixed(2)} | PnL: $${p.realizedPnl.toFixed(2)}`);
      });
      console.log('');
    }

    // Calculate how many positions would be lost
    const positionsLost = duplicates.reduce((sum, [_, positions]) =>
      sum + (positions.length - 1), 0
    );

    console.log(`💥 IMPACT: ${positionsLost} positions would be OVERWRITTEN by duplicates\n`);
    console.log('   Expected in MongoDB: ' + (positions.length - positionsLost));
    console.log('   Actual in MongoDB: 1363\n');

    console.log('='.repeat(80));
    console.log('🔧 FIX: Update upsert filter to include ASSET field\n');
    console.log('Current filter:');
    console.log('  { walletAddress, conditionId, closedAt }\n');
    console.log('Should be:');
    console.log('  { walletAddress, conditionId, asset, closedAt }\n');
    console.log('OR:');
    console.log('  { walletAddress, conditionId, outcomeIndex, closedAt }');
    console.log('='.repeat(80));

  } else {
    console.log('✅ No duplicate keys found!');
    console.log('   The upsert filter is working correctly.');
    console.log('   The issue must be elsewhere.');
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
