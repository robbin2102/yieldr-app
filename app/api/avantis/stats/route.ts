import { NextRequest, NextResponse } from 'next/server';
import { getPerformanceSummary } from '../../../../services/avantis-listener/MetricsComputer';
import connectDB from '../../../../lib/mongoose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/avantis/stats?address=0x...
 * Get performance statistics for a wallet
 *
 * Returns:
 * - Overall statistics (total trades, win rate, PnL, etc.)
 * - Daily PnL breakdown (last 30 days)
 * - Weekly PnL breakdown (last 12 weeks)
 * - Trading pair breakdown
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    console.log(`[API] Computing statistics for ${walletAddress}`);

    // Connect to MongoDB
    await connectDB();

    // Get performance summary
    const summary = await getPerformanceSummary(walletAddress);

    console.log(`[API] Statistics computed for ${walletAddress}:`, {
      totalTrades: summary.statistics.totalTrades,
      totalPnl: summary.statistics.totalPnl.toFixed(2),
      winRate: summary.statistics.winRate.toFixed(2),
    });

    return NextResponse.json({
      success: true,
      data: {
        wallet: walletAddress,
        ...summary,
      },
    });
  } catch (error: any) {
    console.error('[API] Error computing statistics:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to compute statistics',
      },
      { status: 500 }
    );
  }
}
