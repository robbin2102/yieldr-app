import { NextRequest, NextResponse } from 'next/server';
import { getWalletTrades, getOpenPositions, getClosedPositions } from '../../../../services/avantis-listener';
import connectDB from '../../../../lib/mongoose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/avantis/trades?address=0x...&status=all&limit=100
 * Get trade history for a wallet
 *
 * Query params:
 * - address: wallet address (required)
 * - status: all | open | closed (default: all)
 * - limit: number of trades to return (default: 100)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');
    const status = searchParams.get('status') || 'all';
    const limit = parseInt(searchParams.get('limit') || '100');

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    console.log(`[API] Fetching trades for ${walletAddress} (status: ${status}, limit: ${limit})`);

    // Connect to MongoDB
    await connectDB();

    // Fetch trades based on status filter
    let trades;
    if (status === 'open') {
      trades = await getOpenPositions(walletAddress);
    } else if (status === 'closed') {
      trades = await getClosedPositions(walletAddress, limit);
    } else {
      trades = await getWalletTrades(walletAddress, limit);
    }

    console.log(`[API] Found ${trades.length} trades for ${walletAddress}`);

    return NextResponse.json({
      success: true,
      data: {
        wallet: walletAddress,
        status,
        count: trades.length,
        trades,
      },
    });
  } catch (error: any) {
    console.error('[API] Error fetching trades:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch trades',
      },
      { status: 500 }
    );
  }
}
