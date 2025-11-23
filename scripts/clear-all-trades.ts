/**
 * Clear all trades from database
 * USE WITH CAUTION - This deletes all data!
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');

    await connectDB();
    console.log('✓ MongoDB connected\n');

    const count = await TradeEvent.countDocuments();
    console.log('Found ' + count + ' trades in database\n');

    console.log('⚠️  WARNING: This will DELETE ALL trades!');
    console.log('Deleting in 3 seconds...\n');

    await new Promise(resolve => setTimeout(resolve, 3000));

    const result = await TradeEvent.deleteMany({});
    console.log('✓ Deleted ' + result.deletedCount + ' trades\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed:', error);
    process.exit(1);
  }
}

main();
