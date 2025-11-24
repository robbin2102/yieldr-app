import { NextRequest, NextResponse } from 'next/server';
import connectDB from '../../../../lib/mongoose';
import TradeEvent from '../../../../models/TradeEvent';

export const dynamic = 'force-dynamic';

/**
 * GET /api/avantis/recent-trades
 * Shows last 50 trades from database (OPEN and CLOSE)
 * Sorted by timestamp (most recent first)
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    // Fetch most recent trades
    const recentTrades = await TradeEvent.find({
      platform: 'Avantis',
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    // Format with all details
    const trades = recentTrades.map(trade => ({
      // Basic Info
      orderId: trade.orderId,
      eventType: trade.eventType,
      timestamp: trade.timestamp,

      // Wallet & Position
      trader: trade.trader,
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

      // Blockchain
      txHash: trade.txHash,
      blockNumber: trade.blockNumber,

      // Metadata
      createdAt: trade.createdAt,
    }));

    return NextResponse.json({
      success: true,
      data: {
        trades,
        count: trades.length,
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
