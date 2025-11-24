import { NextRequest, NextResponse } from 'next/server';
import { backfillWallet } from '../../../../services/avantis-listener/Backfiller';
import { initializePairsCache } from '../../../../services/avantis-listener/config/pairs';
import { getLatestBlockNumber } from '../../../../services/avantis-listener/core/ViemClient';
import connectDB from '../../../../lib/mongoose';
import Position from '../../../../models/Position';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds (requires Vercel Pro plan)

const MINUTES_TO_CHECK = 10;
const BLOCKS_PER_MINUTE = 120; // Base chain: 2 blocks/sec = 120 blocks/min
const BLOCKS_TO_CHECK = MINUTES_TO_CHECK * BLOCKS_PER_MINUTE; // 1200 blocks

// No wallet exclusions for cron job - includes all wallets

/**
 * POST /api/avantis/check-recent-events
 * Check last 10 minutes of events for all active Avantis wallets
 *
 * This endpoint is called by Vercel cron every 5 minutes
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Check for custom minutes parameter (for testing)
    const { searchParams } = new URL(request.url);
    const customMinutes = searchParams.get('minutes');
    const minutesToCheck = customMinutes ? parseInt(customMinutes) : MINUTES_TO_CHECK;
    const blocksToCheck = minutesToCheck * BLOCKS_PER_MINUTE;

    console.log(`[Cron] Starting recent events check (${minutesToCheck} minutes)...`);

    // Connect to MongoDB
    await connectDB();
    console.log('[Cron] ✓ MongoDB connected');

    // Debug: Log MongoDB connection details
    const dbName = Position.db?.name;
    const collectionName = Position.collection?.name;
    console.log(`[Cron] Debug - DB: ${dbName}, Collection: ${collectionName}`);

    // Initialize pairs cache
    await initializePairsCache();
    console.log('[Cron] ✓ Pairs cache initialized');

    // Debug: Check total documents in positions collection
    const totalDocs = await Position.countDocuments({});
    const avantisTotal = await Position.countDocuments({ platform: 'Avantis' });
    const avantisActive = await Position.countDocuments({ platform: 'Avantis', status: 'active' });

    console.log(`[Cron] Debug - Total positions: ${totalDocs}, Avantis: ${avantisTotal}, Active: ${avantisActive}`);

    // Load all wallets with active Avantis positions
    const wallets = await Position.distinct('walletAddress', {
      platform: 'Avantis',
      status: 'active',
    });

    console.log(`[Cron] Found ${wallets.length} wallets to check`);

    if (wallets.length === 0) {
      console.log('[Cron] ⚠️  No active Avantis wallets found - check MongoDB connection and data');

      return NextResponse.json({
        success: true,
        message: 'No active Avantis wallets found',
        walletsChecked: 0,
        eventsFound: 0,
        debug: {
          dbName,
          collectionName,
          totalPositions: totalDocs,
          avantisPositions: avantisTotal,
          activeAvantisPositions: avantisActive,
        },
        durationMs: Date.now() - startTime,
      });
    }

    // Calculate block range
    const latestBlock = await getLatestBlockNumber();
    const startBlock = latestBlock - BigInt(blocksToCheck);

    console.log(`[Cron] Block range: ${startBlock} to ${latestBlock} (${blocksToCheck} blocks)`);

    // Process all wallets in parallel
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const result = await backfillWallet({
            wallet,
            startBlock: Number(startBlock),
            endBlock: Number(latestBlock),
            chunkSize: 2000,
            parallelChunks: 2,
          });

          return {
            wallet,
            eventsFound: result.eventsFound,
            success: result.success,
          };
        } catch (error: any) {
          console.error(`[Cron] Error checking wallet ${wallet}:`, error.message);
          return {
            wallet,
            eventsFound: 0,
            success: false,
            error: error.message,
          };
        }
      })
    );

    const durationMs = Date.now() - startTime;
    const successful = results.filter(r => r.success).length;
    const totalEvents = results.reduce((sum, r) => sum + r.eventsFound, 0);
    const walletsWithEvents = results.filter(r => r.eventsFound > 0);

    console.log(`[Cron] ✅ Check complete:`);
    console.log(`[Cron]    Wallets checked: ${wallets.length}`);
    console.log(`[Cron]    Successful: ${successful}`);
    console.log(`[Cron]    Total events: ${totalEvents}`);
    console.log(`[Cron]    Duration: ${(durationMs / 1000).toFixed(1)}s`);

    if (walletsWithEvents.length > 0) {
      console.log(`[Cron]    Wallets with new events:`);
      walletsWithEvents.forEach(r => {
        console.log(`[Cron]      • ${r.wallet.substring(0, 10)}... - ${r.eventsFound} events`);
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        walletsChecked: wallets.length,
        successful,
        failed: wallets.length - successful,
        totalEvents,
        blockRange: {
          from: Number(startBlock),
          to: Number(latestBlock),
          blocks: blocksToCheck,
          minutes: minutesToCheck,
        },
        walletsWithEvents: walletsWithEvents.map(r => ({
          wallet: r.wallet,
          eventsFound: r.eventsFound,
        })),
        durationMs,
        durationSeconds: (durationMs / 1000).toFixed(2),
      },
    });
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    console.error('[Cron] Fatal error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Recent events check failed',
        durationMs,
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/avantis/check-recent-events
 * Health check endpoint
 */
export async function GET(request: NextRequest) {
  return NextResponse.json({
    endpoint: 'check-recent-events',
    status: 'ready',
    description: 'Checks last 10 minutes of Avantis events for all active wallets',
    method: 'POST',
    schedule: 'Every 10 minutes (Vercel cron)',
  });
}
