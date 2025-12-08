import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import HyperliquidMetrics from '@/models/HyperliquidMetrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/hyperliquid/metrics?wallet=0x...
 * Fetch Hyperliquid metrics for a wallet
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('wallet');

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    await connectDB();

    const normalizedWallet = walletAddress.toLowerCase();
    const metrics = await HyperliquidMetrics.findOne({
      walletAddress: normalizedWallet
    });

    if (!metrics) {
      return NextResponse.json({
        success: false,
        error: 'Metrics not found. Agent may not be launched yet.'
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: metrics
    });
  } catch (error: any) {
    console.error('Error fetching Hyperliquid metrics:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch metrics'
      },
      { status: 500 }
    );
  }
}
