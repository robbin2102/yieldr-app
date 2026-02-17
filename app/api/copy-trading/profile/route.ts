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

        // Period coverage info (shows actual date range when API limit is hit)
        periodInfo: profile.periodInfo || null,

        // Cash Flow P&L - Most accurate calculation
        // P&L = (Sells + Redeems + Ending Value) - Buys
        cashFlowPnL: profile.cashFlowPnL || null,

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
        realizedPnl: profile.realizedPnl,
        totalPnl: profile.totalPnl,
        profitFactor: profile.profitFactor,

        // Open positions - recalculate after filtering resolved
        // Use 0.001 (0.1¢) threshold to allow sub-1¢ positions to show as active
        openPositionsCount: (profile.topOpenPositions || []).filter((p: any) =>
          p.curPrice >= 0.001 && p.curPrice <= 0.99
        ).length,
        openValue: (profile.topOpenPositions || [])
          .filter((p: any) => p.curPrice >= 0.001 && p.curPrice <= 0.99)
          .reduce((sum: number, p: any) => sum + (p.currentValue || 0), 0),
        unrealizedPnl: (profile.topOpenPositions || [])
          .filter((p: any) => p.curPrice >= 0.001 && p.curPrice <= 0.99)
          .reduce((sum: number, p: any) => sum + (p.cashPnl || 0), 0),

        // Trade sizing
        avgTradeSize: profile.avgTradeSize,
        medianTradeSize: profile.medianTradeSize,
        maxTradeSize: profile.maxTradeSize,

        // Specialty
        specialty: profile.specialty,
        strengths: profile.strengths || [],
        weaknesses: profile.weaknesses || [],

        // High conviction - return all trades (no limit)
        asymmetricThreshold: profile.asymmetricThreshold,
        asymmetricTradesCount: profile.recentHighConvictionTrades?.length || profile.asymmetricTradesCount || 0,
        recentHighConvictionTrades: profile.recentHighConvictionTrades || [],

        // Top positions - filter out resolved (<0.1¢ and >99¢) on-the-fly
        topOpenPositions: (profile.topOpenPositions || []).filter((p: any) =>
          p.curPrice >= 0.001 && p.curPrice <= 0.99
        ),

        // Recent closed positions - include newly resolved positions
        recentClosedPositions: [
          ...(profile.recentClosedPositions || []),
          // Add positions that have now resolved (were open, now <0.1¢ or >99¢)
          ...(profile.topOpenPositions || [])
            .filter((p: any) => p.curPrice < 0.001 || p.curPrice > 0.99)
            .map((p: any) => ({
              title: p.title,
              outcome: p.outcome,
              size: p.size,
              avgPrice: p.avgPrice,
              realizedPnl: p.curPrice > 0.99
                ? (p.currentValue - (p.size * p.avgPrice)) // Won: value - cost
                : -(p.size * p.avgPrice), // Lost: negative cost
              timestamp: new Date().toISOString(),
              status: p.curPrice > 0.99 ? 'WON' : 'LOST',
            })),
        ].slice(0, 20), // Limit to 20 most recent

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
