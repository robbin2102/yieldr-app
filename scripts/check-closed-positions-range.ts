/**
 * Check date range and PnL of closed positions in MongoDB
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function checkClosedPositions() {
  await connectDB();

  console.log('\n📊 CLOSED POSITIONS ANALYSIS\n');
  console.log('=' .repeat(80));

  // Get count
  const count = await PolymarketClosedPosition.countDocuments({
    walletAddress: WALLET.toLowerCase()
  });

  console.log(`Total closed positions: ${count}`);

  // Get earliest and latest
  const earliest = await PolymarketClosedPosition
    .findOne({ walletAddress: WALLET.toLowerCase() })
    .sort({ closedAt: 1 })
    .select('closedAt realizedPnl title');

  const latest = await PolymarketClosedPosition
    .findOne({ walletAddress: WALLET.toLowerCase() })
    .sort({ closedAt: -1 })
    .select('closedAt realizedPnl title');

  console.log(`\nEarliest: ${earliest?.closedAt}`);
  console.log(`Latest:   ${latest?.closedAt}`);

  // Calculate days
  if (earliest && latest) {
    const days = Math.floor(
      (latest.closedAt.getTime() - earliest.closedAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    console.log(`Range:    ${days} days`);
  }

  // Get total PnL
  const result = await PolymarketClosedPosition.aggregate([
    { $match: { walletAddress: WALLET.toLowerCase() } },
    {
      $group: {
        _id: null,
        totalPnl: { $sum: '$realizedPnl' },
        wins: {
          $sum: {
            $cond: [{ $gt: ['$realizedPnl', 0] }, 1, 0]
          }
        },
        losses: {
          $sum: {
            $cond: [{ $lte: ['$realizedPnl', 0] }, 1, 0]
          }
        }
      }
    }
  ]);

  console.log(`\n💰 PnL Summary:`);
  console.log(`Total Realized PnL: $${result[0]?.totalPnl.toFixed(2) || 0}`);
  console.log(`Wins:   ${result[0]?.wins || 0}`);
  console.log(`Losses: ${result[0]?.losses || 0}`);

  // Show last 30 days cutoff
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  console.log(`\n📅 30-Day Cutoff: ${thirtyDaysAgo.toISOString()}`);

  const thirtyDayCount = await PolymarketClosedPosition.countDocuments({
    walletAddress: WALLET.toLowerCase(),
    closedAt: { $gte: thirtyDaysAgo }
  });

  const thirtyDayResult = await PolymarketClosedPosition.aggregate([
    {
      $match: {
        walletAddress: WALLET.toLowerCase(),
        closedAt: { $gte: thirtyDaysAgo }
      }
    },
    {
      $group: {
        _id: null,
        totalPnl: { $sum: '$realizedPnl' }
      }
    }
  ]);

  console.log(`Positions in last 30 days: ${thirtyDayCount}`);
  console.log(`PnL last 30 days: $${thirtyDayResult[0]?.totalPnl.toFixed(2) || 0}`);

  console.log('\n' + '='.repeat(80));

  process.exit(0);
}

checkClosedPositions().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
