/**
 * Check what the actual block timestamp is for a trade's close block
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');
    const { getBlock } = await import('../services/avantis-listener/core/ViemClient');

    await connectDB();

    // Get the specific trade
    const trade = await TradeEvent.findOne({ orderId: '3828687' });

    if (!trade) {
      console.log('Trade not found');
      process.exit(1);
    }

    console.log('Trade 3828687:');
    console.log('  initiatedAt:', trade.initiatedAt?.toISOString());
    console.log('  executedAt:', trade.executedAt?.toISOString());
    console.log('  closedAt:', trade.closedAt?.toISOString());
    console.log('  closedBlockNumber:', trade.closedBlockNumber);
    console.log('  durationSeconds:', trade.durationSeconds);

    if (trade.closedBlockNumber) {
      const block = await getBlock(BigInt(trade.closedBlockNumber));
      const blockTimestamp = new Date(Number(block.timestamp) * 1000);

      console.log('\nBlock ' + trade.closedBlockNumber + ' timestamp:', blockTimestamp.toISOString());

      const openTime = trade.executedAt || trade.initiatedAt;
      if (openTime) {
        const correctDuration = Math.floor((blockTimestamp.getTime() - openTime.getTime()) / 1000);
        console.log('\nCorrect duration should be:', correctDuration + 's (' + (correctDuration / 3600).toFixed(1) + 'h)');
      }
    }

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
