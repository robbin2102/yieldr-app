import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';
import MonitoredWallet from '@/models/MonitoredWallet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface StopAgentRequest {
  walletAddress: string;
  market: 'LP' | 'PERP';
  platform?: 'HYPERLIQUID';
}

/**
 * POST /api/agent/stop
 * Stop monitoring agent for a wallet
 */
export async function POST(request: NextRequest) {
  try {
    await clientPromise;

    const body: StopAgentRequest = await request.json();
    const { walletAddress, market, platform } = body;

    // Validate input
    if (!walletAddress || !market) {
      return NextResponse.json(
        { success: false, error: 'walletAddress and market are required' },
        { status: 400 }
      );
    }

    const normalizedWallet = walletAddress.toLowerCase();

    // Find and stop the agent
    const result = await MonitoredWallet.findOneAndUpdate(
      {
        walletAddress: normalizedWallet,
        market,
        platform: market === 'PERP' ? platform : null
      },
      { status: 'stopped' },
      { new: true }
    );

    if (!result) {
      return NextResponse.json(
        { success: false, error: 'Agent not found' },
        { status: 404 }
      );
    }

    console.log(`Agent stopped for ${normalizedWallet} (${market}${platform ? ` - ${platform}` : ''})`);

    return NextResponse.json({
      success: true,
      message: 'Agent stopped successfully',
      data: {
        walletAddress: result.walletAddress,
        market: result.market,
        platform: result.platform,
        status: result.status
      }
    });
  } catch (error: any) {
    console.error('Error stopping agent:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to stop agent' },
      { status: 500 }
    );
  }
}
