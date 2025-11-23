/**
 * Diagnose missing executedAt timestamps in closed trades
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    const { default: TradeEvent } = await import('../models/TradeEvent');
    const { default: connectDB } = await import('../lib/mongoose');

    await connectDB();

    // Find all CLOSED trades
    const closedTrades = await TradeEvent.find({ status: 'CLOSED' }).select(
      'orderId initiatedAt executedAt closedAt durationSeconds'
    );

    console.log('Total closed trades: ' + closedTrades.length + '\n');

    let missingExecutedAt = 0;
    let hasExecutedAt = 0;

    for (const trade of closedTrades) {
      if (!trade.executedAt) {
        missingExecutedAt++;
        console.log('Trade ' + trade.orderId + ': MISSING executedAt');
        console.log('  initiatedAt: ' + (trade.initiatedAt?.toISOString() || 'N/A'));
        console.log('  executedAt: undefined');
        console.log('  closedAt: ' + (trade.closedAt?.toISOString() || 'N/A'));
        console.log('  duration: ' + trade.durationSeconds + 's\n');
      } else {
        hasExecutedAt++;
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log('Trades with executedAt: ' + hasExecutedAt);
    console.log('Trades MISSING executedAt: ' + missingExecutedAt);
    console.log('Percentage missing: ' + ((missingExecutedAt / closedTrades.length) * 100).toFixed(1) + '%');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
