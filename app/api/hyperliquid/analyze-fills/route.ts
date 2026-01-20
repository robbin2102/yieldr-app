import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import HyperliquidFill from '@/models/HyperliquidFill';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/hyperliquid/analyze-fills?wallet=0x...&coin=ETH&limit=30
 * Analyze fills to understand position changes
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');
    const coin = searchParams.get('coin');
    const limitParam = searchParams.get('limit');

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    await connectDB();

    const normalizedWallet = walletAddress.toLowerCase();
    const limit = limitParam ? parseInt(limitParam) : 30;

    const query: any = { walletAddress: normalizedWallet };
    if (coin) {
      query.coin = coin;
    }

    const fills = await HyperliquidFill.find(query)
      .sort({ time: 1 }) // Chronological order
      .limit(limit);

    // Analyze the fills
    const analysis = fills.map((fill, idx) => {
      const prevFill = idx > 0 ? fills[idx - 1] : null;
      const startPos = parseFloat(fill.startPosition);
      const sz = parseFloat(fill.sz);
      const endPos = fill.side === 'B' ? startPos + sz : startPos - sz;

      const prevPos = prevFill ? parseFloat(prevFill.startPosition) : 0;
      const posChange = startPos - prevPos;

      let action = '';
      if (prevFill) {
        if (Math.abs(posChange) < 0.0001) {
          action = 'No change in position';
        } else if (posChange > 0) {
          action = 'Position increased (added to long or closed short)';
        } else {
          action = 'Position decreased (closed long or added to short)';
        }
      } else {
        action = 'First trade';
      }

      return {
        time: new Date(fill.time).toISOString(),
        coin: fill.coin,
        side: fill.side, // B = Buy, A = Sell
        dir: fill.dir,
        startPosition: fill.startPosition,
        sz: fill.sz,
        endPosition: endPos.toFixed(4),
        px: fill.px,
        closedPnl: fill.closedPnl,
        action,
        tid: fill.tid
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        totalFills: fills.length,
        analysis
      }
    });
  } catch (error: any) {
    console.error('Error analyzing fills:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to analyze fills'
      },
      { status: 500 }
    );
  }
}
