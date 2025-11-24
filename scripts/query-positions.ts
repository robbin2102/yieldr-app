/**
 * Query Open Positions and Recent Trades
 * Usage: npx tsx scripts/query-positions.ts <walletAddress>
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  try {
    const { default: connectDB } = await import('../lib/mongoose');
    const { default: Position } = await import('../models/Position');
    const { default: TradeEvent } = await import('../models/TradeEvent');

    const wallet = process.argv[2];

    if (!wallet) {
      console.error('❌ Error: Wallet address required');
      console.log('\nUsage: npx tsx scripts/query-positions.ts <walletAddress>');
      console.log('Example: npx tsx scripts/query-positions.ts 0x780BB763e1463D2236FEC780b7BD6ADb40AAa120');
      process.exit(1);
    }

    console.log('='.repeat(70));
    console.log('Position & Trade Query');
    console.log('='.repeat(70));
    console.log(`\n📍 Wallet: ${wallet}\n`);

    // Connect to MongoDB
    await connectDB();
    console.log('✅ Connected to MongoDB\n');

    // Query open positions (universal collection)
    console.log('='.repeat(70));
    console.log('OPEN POSITIONS (All Platforms)');
    console.log('='.repeat(70) + '\n');

    const openPositions = await Position.find({
      walletAddress: wallet.toLowerCase(),
      status: 'active',
    }).sort({ createdAt: -1 });

    if (openPositions.length === 0) {
      console.log('No open positions found.\n');
    } else {
      console.log(`Total: ${openPositions.length} open positions\n`);

      // Group by platform
      const avantis = openPositions.filter(p => p.platform === 'Avantis');
      const hyperliquid = openPositions.filter(p => p.platform === 'Hyperliquid');
      const lp = openPositions.filter(p => p.type === 'LP');

      if (avantis.length > 0) {
        console.log(`🔹 Avantis Perps (${avantis.length}):\n`);
        for (const pos of avantis) {
          console.log(`${pos.pair} ${pos.direction}`);
          console.log(`  Trade Index: ${pos.positionId}`);
          console.log(`  Opened: ${pos.createdAt.toLocaleString()}`);
          console.log(`  Entry Price: $${pos.entryPrice?.toFixed(2)}`);
          console.log(`  Collateral: $${pos.margin?.toFixed(2)} USDC`);
          console.log(`  Leverage: ${pos.leverage}x`);
          console.log(`  Current PnL: $${pos.pnl?.toFixed(2)} (${pos.roi?.toFixed(2)}%)`);
          console.log(`  Tx: ${pos.txHash?.substring(0, 20)}...`);
          console.log();
        }
      }

      if (hyperliquid.length > 0) {
        console.log(`🔹 Hyperliquid Perps (${hyperliquid.length}):\n`);
        for (const pos of hyperliquid) {
          console.log(`${pos.pair} ${pos.direction}`);
          console.log(`  Entry: $${pos.entryPrice?.toFixed(2)} | Leverage: ${pos.leverage}x`);
          console.log(`  PnL: $${pos.pnl?.toFixed(2)}`);
          console.log();
        }
      }

      if (lp.length > 0) {
        console.log(`🔹 LP Positions (${lp.length}):\n`);
        for (const pos of lp) {
          console.log(`${pos.pool} on ${pos.platform}`);
          console.log(`  Liquidity: $${pos.liquidity?.toFixed(2)}`);
          console.log(`  PnL: $${pos.pnl?.toFixed(2)}`);
          console.log();
        }
      }
    }

    // Query recent closed trades (last 10)
    console.log('='.repeat(70));
    console.log('RECENT CLOSED TRADES (Last 10)');
    console.log('='.repeat(70) + '\n');

    const closedTrades = await TradeEvent.find({
      trader: wallet.toLowerCase(),
      eventType: 'CLOSE',
    }).sort({ timestamp: -1 }).limit(10);

    if (closedTrades.length === 0) {
      console.log('No closed trades found.\n');
    } else {
      for (const trade of closedTrades) {
        const pnlSign = (trade.pnlUsdc || 0) >= 0 ? '+' : '';
        const pnlColor = (trade.pnlUsdc || 0) >= 0 ? '✅' : '❌';

        console.log(`${trade.timestamp.toLocaleString()} | ${trade.pairSymbol} ${trade.direction}`);
        console.log(`  ${pnlColor} PnL: ${pnlSign}$${trade.pnlUsdc?.toFixed(2)} USDC (${pnlSign}${trade.roi?.toFixed(2)}%)`);
        console.log(`  Collateral: $${trade.collateralUsdc?.toFixed(2)}`);
        console.log(`  Close Price: $${trade.closePrice?.toFixed(2)}`);
        console.log(`  Order ID: ${trade.orderId}`);
        console.log();
      }
    }

    // Summary statistics
    console.log('='.repeat(70));
    console.log('SUMMARY STATISTICS');
    console.log('='.repeat(70) + '\n');

    const stats = await TradeEvent.aggregate([
      { $match: { trader: wallet.toLowerCase(), eventType: 'CLOSE' } },
      {
        $group: {
          _id: null,
          totalTrades: { $sum: 1 },
          totalPnl: { $sum: '$pnlUsdc' },
          avgPnl: { $avg: '$pnlUsdc' },
          avgRoi: { $avg: '$roi' },
          winners: { $sum: { $cond: [{ $gt: ['$pnlUsdc', 0] }, 1, 0] } },
          losers: { $sum: { $cond: [{ $lte: ['$pnlUsdc', 0] }, 1, 0] } },
        },
      },
    ]);

    if (stats.length > 0) {
      const s = stats[0];
      const winRate = (s.winners / s.totalTrades) * 100;

      console.log(`Total Closed Trades: ${s.totalTrades}`);
      console.log(`Total PnL: $${s.totalPnl.toFixed(2)} USDC`);
      console.log(`Average PnL: $${s.avgPnl.toFixed(2)} USDC`);
      console.log(`Average ROI: ${s.avgRoi.toFixed(2)}%`);
      console.log(`Win Rate: ${winRate.toFixed(2)}% (${s.winners}W / ${s.losers}L)`);
    } else {
      console.log('No statistics available yet.');
    }

    console.log('\n' + '='.repeat(70) + '\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();
