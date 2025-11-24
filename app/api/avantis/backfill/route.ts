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
    const startTime = Date.now();
    const body = await request.json();
    const { walletAddress, daysBack = 7 } = body; // Default 7 days for fast onboarding

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'walletAddress is required' },
        { status: 400 }
      );
    }

    console.log(`[API] ⏱️  Starting backfill for ${walletAddress} (${daysBack} days)`);

    // Connect to MongoDB
    const dbStartTime = Date.now();
    await connectDB();
    const dbConnectTime = Date.now() - dbStartTime;
    console.log(`[API] ✓ MongoDB connected in ${dbConnectTime}ms`);

    // Start backfill (this may take a while)
    const backfillStartTime = Date.now();
    const result = await backfillWalletHistory(walletAddress, daysBack);
    const backfillTime = Date.now() - backfillStartTime;

    const totalTime = Date.now() - startTime;

    console.log(`[API] ✅ Backfill complete for ${walletAddress}:`);
    console.log(`[API]    📊 Events found: ${result.eventsFound}`);
    console.log(`[API]    ⏱️  Backfill time: ${(backfillTime / 1000).toFixed(2)}s`);
    console.log(`[API]    ⏱️  Total API time: ${(totalTime / 1000).toFixed(2)}s`);

    return NextResponse.json({
      success: true,
      data: {
        wallet: result.wallet,
        eventsFound: result.eventsFound,
        executedEvents: result.executedEvents,
        startBlock: result.startBlock,
        endBlock: result.endBlock,
        durationMs: result.durationMs,
        durationSeconds: (result.durationMs / 1000).toFixed(2),
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
