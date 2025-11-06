/**
 * Position Monitoring Cron Endpoint
 *
 * Triggered by Vercel Cron every 60 seconds to monitor manager positions.
 * Fetches positions, detects changes, logs closed positions, and updates analytics.
 *
 * Security: Only allows requests from Vercel Cron (via Authorization header)
 *
 * @route GET /api/cron/monitor-positions
 */

import { NextRequest, NextResponse } from 'next/server';
import { runMonitoringCycle } from '@/services/monitoring/orchestrator';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Max 60 seconds execution time

/**
 * GET handler - triggered by Vercel Cron
 */
export async function GET(request: NextRequest) {
  try {
    // Security check: Verify request is from Vercel Cron
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      console.error('[Cron] CRON_SECRET not configured');
      return NextResponse.json(
        {
          success: false,
          error: 'Server configuration error',
        },
        { status: 500 }
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      console.warn('[Cron] Unauthorized request attempt');
      return NextResponse.json(
        {
          success: false,
          error: 'Unauthorized',
        },
        { status: 401 }
      );
    }

    // Run monitoring cycle
    console.log('[Cron] Starting monitoring cycle...');
    const result = await runMonitoringCycle();

    // Return results
    return NextResponse.json({
      success: result.success,
      timestamp: new Date().toISOString(),
      managersProcessed: result.managersProcessed,
      totalPositions: result.totalPositions,
      closedPositions: result.closedPositions,
      analyticsUpdated: result.analyticsUpdated,
      duration: result.duration,
      errors: result.errors,
    });
  } catch (error: any) {
    console.error('[Cron] Fatal error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

/**
 * POST handler - for manual triggers (testing)
 */
export async function POST(request: NextRequest) {
  try {
    // Security check: Verify request is from Vercel Cron or has valid secret
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      return NextResponse.json(
        {
          success: false,
          error: 'Server configuration error',
        },
        { status: 500 }
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        {
          success: false,
          error: 'Unauthorized',
        },
        { status: 401 }
      );
    }

    console.log('[Cron] Manual trigger received');
    const result = await runMonitoringCycle();

    return NextResponse.json({
      success: result.success,
      timestamp: new Date().toISOString(),
      managersProcessed: result.managersProcessed,
      totalPositions: result.totalPositions,
      closedPositions: result.closedPositions,
      analyticsUpdated: result.analyticsUpdated,
      duration: result.duration,
      errors: result.errors,
    });
  } catch (error: any) {
    console.error('[Cron] Fatal error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
