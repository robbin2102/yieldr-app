import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import LPMetrics from '@/models/LPMetrics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/lp/metrics?wallet=0x...
 * Fetch LP metrics for a wallet
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

    await clientPromise;

    const normalizedWallet = walletAddress.toLowerCase();
    const metrics = await LPMetrics.findOne({
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
    console.error('Error fetching LP metrics:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch metrics'
      },
      { status: 500 }
    );
  }
}
