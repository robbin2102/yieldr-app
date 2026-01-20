import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const API_BASE = 'https://data-api.polymarket.com';

interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

// Fetch user's open positions from Polymarket to get current P&L
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

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

    const cleanWallet = wallet.toLowerCase();
    const client = await clientPromise;
    const db = client.db(dbName);

    // First, check if we have saved copy positions in MongoDB
    const savedCopyPositions = await db.collection('polymarket-copyPositions')
      .find({ userWallet: cleanWallet })
      .sort({ timestamp: -1 })
      .toArray();

    // If we have saved copy positions, use those
    if (savedCopyPositions.length > 0) {
      // Fetch current open positions to update P&L
      let currentPositions: OpenPosition[] = [];
      try {
        currentPositions = await fetchOpenPositions(cleanWallet);
      } catch (e) {
        // If API fails, use saved data as-is
      }

      // Create lookup for current position data
      const currentPosMap = new Map(
        currentPositions.map(p => [`${p.outcome}`, p])
      );

      // Group by trader and update with current P&L
      const positionsByTrader: Record<string, any[]> = {};
      let totalPnl = 0;
      let totalValue = 0;
      let totalInvested = 0;
      let openCount = 0;
      let closedCount = 0;

      for (const pos of savedCopyPositions) {
        const traderLabel = pos.traderLabel || 'Unknown';
        if (!positionsByTrader[traderLabel]) {
          positionsByTrader[traderLabel] = [];
        }

        // Try to get current data
        const currentPos = currentPosMap.get(pos.outcome);

        // Update status based on current data
        let status = pos.status;
        let currentValue = pos.currentValue || 0;
        let cashPnl = pos.pnl || 0;
        let curPrice = pos.price || 0;

        if (currentPos) {
          status = 'OPEN';
          currentValue = currentPos.currentValue;
          cashPnl = currentPos.cashPnl;
          curPrice = currentPos.curPrice;
          openCount++;
        } else if (status === 'OPEN') {
          // Position was open but now gone = likely closed/redeemed
          status = 'CLOSED';
          closedCount++;
        } else {
          closedCount++;
        }

        positionsByTrader[traderLabel].push({
          conditionId: pos.conditionId,
          title: pos.market,
          outcome: pos.outcome,
          side: pos.side,
          size: pos.size,
          avgPrice: pos.price,
          curPrice,
          initialValue: pos.usdcValue,
          currentValue,
          cashPnl,
          percentPnl: pos.usdcValue > 0 ? (cashPnl / pos.usdcValue) * 100 : 0,
          status,
          timestamp: pos.timestamp,
          traderWallet: pos.traderWallet,
        });

        if (status === 'OPEN') {
          totalValue += currentValue;
          totalInvested += pos.usdcValue || 0;
        }
        totalPnl += cashPnl;
      }

      return NextResponse.json({
        success: true,
        source: 'mongodb',
        positionsByTrader,
        unmatchedPositions: [],
        summary: {
          totalPositions: savedCopyPositions.length,
          matchedPositions: savedCopyPositions.length,
          unmatchedCount: 0,
          openPositions: openCount,
          closedPositions: closedCount,
          totalPnl,
          totalValue,
          totalInvested,
          pnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
        },
      });
    }

    // No saved positions - return empty with instruction
    return NextResponse.json({
      success: true,
      source: 'none',
      positionsByTrader: {},
      unmatchedPositions: [],
      summary: {
        totalPositions: 0,
        matchedPositions: 0,
        unmatchedCount: 0,
        openPositions: 0,
        closedPositions: 0,
        totalPnl: 0,
        totalValue: 0,
        totalInvested: 0,
        pnlPercent: 0,
      },
      message: 'No copy positions tracked. Run: npx tsx scripts/track-copies.ts <your_wallet> 30 --save',
    });

  } catch (error: any) {
    console.error('Error fetching positions:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
