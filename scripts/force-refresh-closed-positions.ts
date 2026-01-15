/**
 * Force refresh closed positions (ignores staleness check)
 */

import dotenv from 'dotenv';
import path from 'path';

// Load environment variables FIRST
const envPath = path.resolve(process.cwd(), '.env.local');
dotenv.config({ path: envPath });

import connectDB from '../lib/mongoose.js';
import PolymarketClosedPosition from '../models/PolymarketClosedPosition.js';
import { fetchClosedPositions } from '../services/polymarket-tracker/api/closedPositions.js';

const WALLET = '0xecd55daa7c6900683b804d1d4db935fbfabe43f4';

async function forceRefresh() {
  await connectDB();

  console.log('\n🔄 FORCE REFRESHING CLOSED POSITIONS\n');
  console.log('=' .repeat(80));

  // Show current state
  const before = await PolymarketClosedPosition.countDocuments({
    walletAddress: WALLET.toLowerCase()
  });

  const latestBefore = await PolymarketClosedPosition
    .findOne({ walletAddress: WALLET.toLowerCase() })
    .sort({ closedAt: -1 })
    .select('closedAt');

  console.log(`\nBEFORE REFRESH:`);
  console.log(`  Total positions: ${before}`);
  console.log(`  Latest close: ${latestBefore?.closedAt.toISOString() || 'N/A'}`);

  // Fetch fresh data
  console.log(`\n📡 Fetching fresh closed positions from API...`);
  const positions = await fetchClosedPositions(WALLET);

  console.log(`✅ Fetched ${positions.length} positions from API`);

  // Delete old data
  console.log(`\n🗑️  Deleting old positions...`);
  await PolymarketClosedPosition.deleteMany({
    walletAddress: WALLET.toLowerCase()
  });

  // Save fresh data
  console.log(`💾 Saving fresh positions...`);

  const operations = positions.map((pos) => {
    const totalBet = pos.avgPrice * pos.totalBought;
    const amountWon = totalBet + pos.realizedPnl;
    const roi = totalBet > 0 ? (pos.realizedPnl / totalBet) * 100 : 0;

    return {
      updateOne: {
        filter: {
          walletAddress: WALLET.toLowerCase(),
          conditionId: pos.conditionId,
          closedAt: new Date(pos.timestamp * 1000),
        },
        update: {
          $set: {
            walletAddress: WALLET.toLowerCase(),
            conditionId: pos.conditionId,
            asset: pos.asset,
            title: pos.title,
            slug: pos.slug,
            outcome: pos.outcome,
            outcomeIndex: pos.outcomeIndex,
            totalBought: pos.totalBought,
            avgPrice: pos.avgPrice,
            realizedPnl: pos.realizedPnl,
            totalBet,
            amountWon,
            roi,
            won: pos.realizedPnl > 0,
            closedAt: new Date(pos.timestamp * 1000),
            endDate: pos.endDate ? new Date(pos.endDate) : undefined,
            fetchedAt: new Date(),
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
        upsert: true,
      },
    };
  });

  const result = await PolymarketClosedPosition.bulkWrite(operations);

  // Show after state
  const after = await PolymarketClosedPosition.countDocuments({
    walletAddress: WALLET.toLowerCase()
  });

  const latestAfter = await PolymarketClosedPosition
    .findOne({ walletAddress: WALLET.toLowerCase() })
    .sort({ closedAt: -1 })
    .select('closedAt');

  // Calculate new PnL
  const totalPnl = await PolymarketClosedPosition.aggregate([
    { $match: { walletAddress: WALLET.toLowerCase() } },
    {
      $group: {
        _id: null,
        totalPnl: { $sum: '$realizedPnl' },
        totalBet: { $sum: '$totalBet' },
      }
    }
  ]);

  console.log(`\n✅ AFTER REFRESH:`);
  console.log(`  Total positions: ${after}`);
  console.log(`  Latest close: ${latestAfter?.closedAt.toISOString() || 'N/A'}`);
  console.log(`  New positions: ${result.upsertedCount}`);
  console.log(`  Updated positions: ${result.modifiedCount}`);

  if (totalPnl.length > 0) {
    console.log(`\n💰 TOTAL PnL: $${totalPnl[0].totalPnl.toFixed(2)}`);
    console.log(`  Total Bet: $${totalPnl[0].totalBet.toFixed(2)}`);
    console.log(`  ROI: ${((totalPnl[0].totalPnl / totalPnl[0].totalBet) * 100).toFixed(2)}%`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n✅ Refresh complete! Run the service again to see updated metrics.\n');

  process.exit(0);
}

forceRefresh().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
