import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import HyperliquidFill from '@/models/HyperliquidFill';
import HyperliquidPosition from '@/models/HyperliquidPosition';
import HyperliquidMetrics from '@/models/HyperliquidMetrics';
import HyperliquidPnlSnapshot from '@/models/HyperliquidPnlSnapshot';
import MonitoredWallet from '@/models/MonitoredWallet';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DELETE /api/hyperliquid/debug/reset-wallet?wallet=0x...
 * Delete all data for a wallet (fills, positions, metrics, monitoring)
 */
export async function DELETE(request: NextRequest) {
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

    console.log(`[Reset] 🗑️  Deleting all data for wallet ${normalizedWallet}...`);

    // Delete all related data
    const [fillsDeleted, positionsDeleted, metricsDeleted, snapshotsDeleted, monitoringDeleted] = await Promise.all([
      HyperliquidFill.deleteMany({ walletAddress: normalizedWallet }),
      HyperliquidPosition.deleteMany({ walletAddress: normalizedWallet }),
      HyperliquidMetrics.deleteMany({ walletAddress: normalizedWallet }),
      HyperliquidPnlSnapshot.deleteMany({ walletAddress: normalizedWallet }),
      MonitoredWallet.deleteMany({ walletAddress: normalizedWallet })
    ]);

    console.log(`[Reset] ✅ Deleted:`);
    console.log(`[Reset]    - ${fillsDeleted.deletedCount} fills`);
    console.log(`[Reset]    - ${positionsDeleted.deletedCount} positions`);
    console.log(`[Reset]    - ${metricsDeleted.deletedCount} metrics`);
    console.log(`[Reset]    - ${snapshotsDeleted.deletedCount} PnL snapshots`);
    console.log(`[Reset]    - ${monitoringDeleted.deletedCount} monitoring entries`);

    return NextResponse.json({
      success: true,
      deleted: {
        fills: fillsDeleted.deletedCount,
        positions: positionsDeleted.deletedCount,
        metrics: metricsDeleted.deletedCount,
        snapshots: snapshotsDeleted.deletedCount,
        monitoring: monitoringDeleted.deletedCount
      }
    });
  } catch (error: any) {
    console.error('[Reset] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to reset wallet data'
      },
      { status: 500 }
    );
  }
}
