import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoredWallet from '@/models/MonitoredWallet';
import * as hyperliquidMonitor from '@/services/monitors/hyperliquid/monitor';
import * as lpMonitor from '@/services/monitors/lp/monitor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60; // 60 seconds max for Vercel Pro

/**
 * GET /api/monitors/check-wallets
 * Vercel cron job endpoint to check monitored wallets
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Optional: Verify cron secret for security
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      console.warn('Unauthorized cron request');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    await connectDB();

    // Find wallets that need checking
    const now = new Date();
    const dueWallets = await MonitoredWallet.find({
      status: 'active',
      nextCheck: { $lte: now }
    }).sort({ nextCheck: 1 }); // Oldest first

    if (dueWallets.length === 0) {
      console.log('[Cron] No wallets due for checking');
      return NextResponse.json({
        success: true,
        message: 'No wallets due for checking',
        checked: 0,
        duration: Date.now() - startTime
      });
    }

    console.log(`[Cron] Checking ${dueWallets.length} wallets...`);

    // Process wallets in parallel
    const results = await Promise.allSettled(
      dueWallets.map(async (wallet) => {
        try {
          if (wallet.market === 'PERP' && wallet.platform === 'HYPERLIQUID') {
            return await hyperliquidMonitor.checkWallet(wallet);
          } else if (wallet.market === 'LP') {
            return await lpMonitor.checkWallet(wallet);
          } else {
            return {
              success: false,
              error: 'Unknown market/platform combination',
              walletAddress: wallet.walletAddress
            };
          }
        } catch (error: any) {
          console.error(`Error checking wallet ${wallet.walletAddress}:`, error);
          return {
            success: false,
            error: error.message,
            walletAddress: wallet.walletAddress
          };
        }
      })
    );

    // Count successes and failures
    const successful = results.filter(
      r => r.status === 'fulfilled' && r.value.success
    ).length;
    const failed = results.length - successful;

    const duration = Date.now() - startTime;

    console.log(
      `[Cron] Completed: ${successful} successful, ${failed} failed, ${duration}ms`
    );

    return NextResponse.json({
      success: true,
      message: `Checked ${dueWallets.length} wallets`,
      checked: dueWallets.length,
      successful,
      failed,
      duration,
      results: results.map((r, i) => ({
        walletAddress: dueWallets[i].walletAddress,
        market: dueWallets[i].market,
        platform: dueWallets[i].platform,
        status: r.status,
        ...(r.status === 'fulfilled' ? r.value : { error: r.reason })
      }))
    });
  } catch (error: any) {
    console.error('[Cron] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to check wallets',
        duration: Date.now() - startTime
      },
      { status: 500 }
    );
  }
}
