import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

// Force dynamic rendering - never cache this API route
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const client = await clientPromise;
    const db = client.db('yieldr');
    
    // Fetch all active managers, sorted by total AUM
    const managers = await db.collection('managers')
      .find({ status: 'active' })
      .sort({ 'metrics.totalAUM': -1 })
      .limit(50)
      .toArray();

    console.log('Found managers:', managers.length);

    // Format managers for display
    const formattedManagers = managers.map(manager => {
      const avantis = manager.metrics?.avantisPositions || 0;
      const hl = manager.metrics?.hyperliquidPositions || 0;
      const tradingPlatform = manager.tradingPlatform ||
        (avantis === 0 && hl === 0 ? 'unknown' : avantis >= hl ? 'avantis' : 'hyperliquid');

      return {
        username: manager.username,
        profilePicture: manager.profilePicture,
        tradingTypes: manager.tradingTypes || [],
        topAssets: manager.topAssets || [],
        capitalRange: manager.capitalRange || '< $10k',
        fees: manager.fees || { performanceFee: 0, aumFee: 0 },
        tradingPlatform,
        metrics: {
          totalPnL30d: manager.metrics?.totalPnL30d || 0,
          roi30d: manager.metrics?.roi30d || 0,
          totalAUM: manager.metrics?.totalAUM || 0,
          winRate: manager.metrics?.winRate || 0,
          totalTrades: manager.metrics?.totalTrades || 0,
          hyperliquidPositions: hl,
          avantisPositions: avantis,
          lpPositions: manager.metrics?.lpPositions || 0
        }
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        managers: formattedManagers,
        totalCount: formattedManagers.length
      }
    });

  } catch (error: any) {
    console.error('Error fetching managers:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
