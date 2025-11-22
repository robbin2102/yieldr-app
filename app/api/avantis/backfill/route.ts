import { NextRequest, NextResponse } from 'next/server';
import { backfillWalletHistory } from '../../../../services/avantis-listener';
import connectDB from '../../../../lib/mongoose';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/avantis/backfill
 * Trigger historical backfill for a wallet
 *
 * Body: { walletAddress: string, daysBack?: number }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { walletAddress, daysBack = 7 } = body; // Default 7 days for fast onboarding

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'walletAddress is required' },
        { status: 400 }
      );
    }

    console.log(`[API] Starting backfill for ${walletAddress} (${daysBack} days)`);

    // Connect to MongoDB
    await connectDB();

    // Start backfill (this may take a while)
    const result = await backfillWalletHistory(walletAddress, daysBack);

    console.log(`[API] Backfill complete for ${walletAddress}:`, {
      eventsFound: result.eventsFound,
      durationMs: result.durationMs,
    });

    return NextResponse.json({
      success: true,
      data: {
        wallet: result.wallet,
        eventsFound: result.eventsFound,
        initiatedEvents: result.initiatedEvents,
        executedEvents: result.executedEvents,
        startBlock: result.startBlock,
        endBlock: result.endBlock,
        durationMs: result.durationMs,
      },
    });
  } catch (error: any) {
    console.error('[API] Backfill error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Backfill failed',
      },
      { status: 500 }
    );
  }
}
