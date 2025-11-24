import { NextRequest, NextResponse } from 'next/server';
import { backfillWallet } from '../../../../services/avantis-listener/Backfiller';
import { initializePairsCache } from '../../../../services/avantis-listener/config/pairs';
import { getLatestBlockNumber } from '../../../../services/avantis-listener/core/ViemClient';
import connectDB from '../../../../lib/mongoose';
import Position from '../../../../models/Position';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes max execution time

const MINUTES_TO_CHECK = 10;
const BLOCKS_PER_MINUTE = 120; // Base chain: 2 blocks/sec = 120 blocks/min
const BLOCKS_TO_CHECK = MINUTES_TO_CHECK * BLOCKS_PER_MINUTE; // 1200 blocks

// Exclude test wallet from monitoring
const EXCLUDE_WALLETS = [
  '0x780bb763e1463d2236fec780b7bd6adb40aaa120', // Test wallet
];

/**
 * POST /api/avantis/check-recent-events
 * Check last 10 minutes of events for all active Avantis wallets
 *
 * This endpoint is called by Vercel cron every 5 minutes
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    console.log('[Cron] Starting recent events check...');

    // Connect to MongoDB
    await connectDB();
    console.log('[Cron] ✓ MongoDB connected');

    // Initialize pairs cache
    await initializePairsCache();
    console.log('[Cron] ✓ Pairs cache initialized');

    // Load all wallets with active Avantis positions
    const allWallets = await Position.distinct('walletAddress', {
      platform: 'Avantis',
      status: 'active',
    });

    // Filter out excluded wallets
    const wallets = allWallets.filter(
      wallet => !EXCLUDE_WALLETS.includes(wallet.toLowerCase())
    );

    console.log(`[Cron] Found ${wallets.length} wallets to check (${allWallets.length - wallets.length} excluded)`);

    if (wallets.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No active Avantis wallets found',
        walletsChecked: 0,
        eventsFound: 0,
        durationMs: Date.now() - startTime,
      });
    }

    // Calculate block range (last 10 minutes)
    const latestBlock = await getLatestBlockNumber();
    const startBlock = latestBlock - BigInt(BLOCKS_TO_CHECK);

    console.log(`[Cron] Block range: ${startBlock} to ${latestBlock} (${BLOCKS_TO_CHECK} blocks)`);

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
          blocks: BLOCKS_TO_CHECK,
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
    schedule: 'Every 5 minutes (Vercel cron)',
  });
}
