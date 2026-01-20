import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import LPPositionHistory from '@/models/LPPositionHistory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/lp/history?wallet=0x...&limit=50
 * Fetch LP position history for a wallet
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');
    const limitParam = searchParams.get('limit');

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    await connectDB();

    const normalizedWallet = walletAddress.toLowerCase();
    const limit = limitParam ? parseInt(limitParam) : 50;

    const history = await LPPositionHistory.find({
      walletAddress: normalizedWallet
    })
      .sort({ exitTimestamp: -1 })
      .limit(limit);

    return NextResponse.json({
      success: true,
      data: {
        totalClosedPositions: history.length,
        history
      }
    });
  } catch (error: any) {
    console.error('Error fetching LP history:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch history'
      },
      { status: 500 }
    );
  }
}
