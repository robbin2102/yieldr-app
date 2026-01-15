import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import HyperliquidFill from '@/models/HyperliquidFill';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/hyperliquid/trades?wallet=0x...&limit=100
 * Fetch Hyperliquid trades (fills) for a wallet
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');
    const limitParam = searchParams.get('limit');
    const coinParam = searchParams.get('coin'); // Optional filter by coin

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    await connectDB();

    const normalizedWallet = walletAddress.toLowerCase();
    const limit = limitParam ? parseInt(limitParam) : 100;

    const query: any = { walletAddress: normalizedWallet };
    if (coinParam) {
      query.coin = coinParam;
    }

    const trades = await HyperliquidFill.find(query)
      .sort({ time: -1 })
      .limit(limit);

    // Filter for trades with closedPnl (actual closed trades)
    const closedTrades = trades.filter(t => t.closedPnl && parseFloat(t.closedPnl) !== 0);

    return NextResponse.json({
      success: true,
      data: {
        totalTrades: trades.length,
        closedTrades: closedTrades.length,
        trades
      }
    });
  } catch (error: any) {
    console.error('Error fetching Hyperliquid trades:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch trades'
      },
      { status: 500 }
    );
  }
}
