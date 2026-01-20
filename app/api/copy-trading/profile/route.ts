import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

// GET - Fetch trader profile
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Fetch from traderProfiles collection (full profile data)
    const profile = await db.collection('polymarket-traderProfiles')
      .findOne({ wallet: wallet.toLowerCase() });

    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'Profile not found' },
        { status: 404 }
      );
    }

    // Also check tracking status from trackedTraders
    const trackedTrader = await db.collection('polymarket-trackedTraders')
      .findOne({ wallet: wallet.toLowerCase() });

    return NextResponse.json({
      success: true,
      profile: {
        wallet: profile.wallet,
        label: profile.label,
        profiledAt: profile.profiledAt,
        periodDays: profile.periodDays,

        // Activity stats
        totalActivities: profile.totalActivities,
        buyCount: profile.buyCount,
        sellCount: profile.sellCount,
        redeemCount: profile.redeemCount,

        // Classification
        tradesPerDay: profile.tradesPerDay,
        volumeLabel: profile.volumeLabel,
        strategyLabel: profile.strategyLabel,
        buyRatio: profile.buyRatio,

        // Performance
        closedPositionsCount: profile.closedPositionsCount,
        totalResolvedCount: profile.totalResolvedCount,
        wins: profile.wins,
        losses: profile.losses,
        winRate: profile.winRate,
        grossProfit: profile.grossProfit,
        grossLoss: profile.grossLoss,
        netPnl: profile.netPnl,
        profitFactor: profile.profitFactor,

        // Open positions
        openPositionsCount: profile.openPositionsCount,
        openValue: profile.openValue,
        unrealizedPnl: profile.unrealizedPnl,

        // Trade sizing
        avgTradeSize: profile.avgTradeSize,
        medianTradeSize: profile.medianTradeSize,
        maxTradeSize: profile.maxTradeSize,

        // Specialty
        specialty: profile.specialty,
        strengths: profile.strengths || [],
        weaknesses: profile.weaknesses || [],

        // High conviction
        asymmetricThreshold: profile.asymmetricThreshold,
        asymmetricTradesCount: profile.asymmetricTradesCount,
        recentHighConvictionTrades: profile.recentHighConvictionTrades || [],

        // Top positions
        topOpenPositions: profile.topOpenPositions || [],

        // Recent closed positions
        recentClosedPositions: profile.recentClosedPositions || [],

        // Tracking status
        isTracking: trackedTrader?.isTracking || false,
      },
    });

  } catch (error: any) {
    console.error('Error fetching profile:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
