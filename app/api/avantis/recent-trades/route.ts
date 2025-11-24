import { NextRequest, NextResponse } from 'next/server';
import connectDB from '../../../../lib/mongoose';
import TradeEvent from '../../../../models/TradeEvent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/avantis/recent-trades
 * Shows recent trades from database (OPEN and CLOSE)
 * Sorted by timestamp (most recent first)
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const hours = parseInt(searchParams.get('hours') || '24');
    const limit = parseInt(searchParams.get('limit') || '1000');

    // Fetch trades from last N hours
    const timeAgo = new Date(Date.now() - hours * 60 * 60 * 1000);

    const recentTrades = await TradeEvent.find({
      platform: 'Avantis',
      timestamp: { $gte: timeAgo },
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    // Format with all details
    const trades = recentTrades.map(trade => ({
      // Priority 1: Time
      timestamp: trade.timestamp,

      // Priority 2: Event Type & Pair
      eventType: trade.eventType,
      pairSymbol: trade.pairSymbol,
      direction: trade.direction,

      // Priority 3: Position Details
      positionSizeUsdc: trade.positionSizeUsdc,
      collateralUsdc: trade.collateralUsdc,
      leverage: trade.leverage,

      // Priority 4: Prices
      openPrice: trade.openPrice,
      closePrice: trade.closePrice,
      tp: trade.tp,
      sl: trade.sl,

      // Priority 5: P&L
      pnlUsdc: trade.pnlUsdc,
      roi: trade.roi,

      // Priority 6: IDs
      orderId: trade.orderId,
      tradeIndex: trade.tradeIndex,

      // Priority 7: Wallet
      trader: trade.trader,

      // Priority 8: Blockchain
      txHash: trade.txHash,
      blockNumber: trade.blockNumber,
    }));

    return NextResponse.json({
      success: true,
      data: {
        trades,
        count: trades.length,
        hoursRange: hours,
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('[RecentTrades] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
