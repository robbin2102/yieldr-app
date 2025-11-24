import { NextRequest, NextResponse } from 'next/server';
import connectDB from '../../../../lib/mongoose';
import TradeEvent from '../../../../models/TradeEvent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/avantis/cron-history
 * Shows recent trades captured by cron job (last hour)
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

    // Group by 10-minute intervals (cron runs)
    const grouped = recentTrades.reduce((acc, trade) => {
      const cronWindow = Math.floor(trade.timestamp.getTime() / (10 * 60 * 1000));
      if (!acc[cronWindow]) {
        acc[cronWindow] = [];
      }
      acc[cronWindow].push(trade);
      return acc;
    }, {} as Record<number, any[]>);

    // Format output
    const cronRuns = Object.entries(grouped).map(([window, trades]) => {
      const windowTime = new Date(parseInt(window) * 10 * 60 * 1000);

      return {
        cronWindowStart: windowTime.toISOString(),
        cronWindowEnd: new Date(windowTime.getTime() + 10 * 60 * 1000).toISOString(),
        eventsFound: trades.length,
        trades: trades.map(t => ({
          orderId: t.orderId,
          type: t.eventType,
          pair: t.pairSymbol,
          direction: t.direction,
          size: t.positionSizeUsdc,
          leverage: t.leverage,
          price: t.eventType === 'OPEN' ? t.openPrice : t.closePrice,
          pnl: t.pnlUsdc,
          roi: t.roi,
          timestamp: t.timestamp,
          wallet: `${t.trader.substring(0, 10)}...`,
        })),
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        lastHour: cronRuns,
        totalTrades: recentTrades.length,
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('[CronHistory] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
