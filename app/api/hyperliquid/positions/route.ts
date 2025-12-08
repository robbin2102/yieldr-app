import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import HyperliquidPosition from '@/models/HyperliquidPosition';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/hyperliquid/positions?wallet=0x...
 * Fetch Hyperliquid positions for a wallet
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
    const positions = await HyperliquidPosition.find({
      walletAddress: normalizedWallet
    }).sort({ lastUpdated: -1 });

    return NextResponse.json({
      success: true,
      data: {
        totalPositions: positions.length,
        positions
      }
    });
  } catch (error: any) {
    console.error('Error fetching Hyperliquid positions:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to fetch positions'
      },
      { status: 500 }
    );
  }
}
