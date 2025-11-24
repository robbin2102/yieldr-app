import { NextRequest, NextResponse } from 'next/server';
import connectDB from '../../../../lib/mongoose';
import TradeEvent from '../../../../models/TradeEvent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/avantis/cron-history
 * Shows recent trades captured by cron job (last hour) with full details
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    // Get trades from last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentTrades = await TradeEvent.find({
      platform: 'Avantis',
      timestamp: { $gte: oneHourAgo },
    })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    // Format as table with all available fields
    const tradesTable = recentTrades.map(trade => ({
      // Basic Info
      orderId: trade.orderId,
      eventType: trade.eventType,
      timestamp: trade.timestamp,

      // Wallet & Platform
      trader: trade.trader,
      platform: trade.platform,

      // Position Details
      pairSymbol: trade.pairSymbol,
      pairIndex: trade.pairIndex,
      tradeIndex: trade.tradeIndex,
      direction: trade.direction,

      // Size & Leverage
      positionSizeUsdc: trade.positionSizeUsdc,
      collateralUsdc: trade.collateralUsdc,
      leverage: trade.leverage,

      // Prices
      openPrice: trade.openPrice,
      closePrice: trade.closePrice,
      tp: trade.tp,
      sl: trade.sl,

      // P&L (for CLOSE events)
      pnlUsdc: trade.pnlUsdc,
      roi: trade.roi,

      // Blockchain Data
      txHash: trade.txHash,
      blockNumber: trade.blockNumber,

      // Metadata
      createdAt: trade.createdAt,
    }));

    // Group by 10-minute windows for summary
    const grouped = recentTrades.reduce((acc, trade) => {
      const cronWindow = Math.floor(new Date(trade.timestamp).getTime() / (10 * 60 * 1000));
      if (!acc[cronWindow]) {
        acc[cronWindow] = {
          windowStart: new Date(cronWindow * 10 * 60 * 1000).toISOString(),
          windowEnd: new Date((cronWindow + 1) * 10 * 60 * 1000).toISOString(),
          count: 0,
          opens: 0,
          closes: 0,
        };
      }
      acc[cronWindow].count++;
      if (trade.eventType === 'OPEN') acc[cronWindow].opens++;
      if (trade.eventType === 'CLOSE') acc[cronWindow].closes++;
      return acc;
    }, {} as Record<number, any>);

    const cronSummary = Object.values(grouped);

    return NextResponse.json({
      success: true,
      summary: {
        totalTrades: recentTrades.length,
        timeRange: 'Last 60 minutes',
        lastUpdated: new Date().toISOString(),
        cronWindows: cronSummary,
      },
      trades: tradesTable,
    });
  } catch (error: any) {
    console.error('[CronHistory] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
