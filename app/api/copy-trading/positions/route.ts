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

interface ClosedPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

// Fetch user's open positions from Polymarket with pagination
async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= 5000) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as OpenPosition[];
    if (batch.length === 0) break;

    allPositions = allPositions.concat(batch);
    if (batch.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 50));
  }

  return allPositions;
}

// Fetch closed positions to get realized P&L
async function fetchClosedPositions(wallet: string, days: number = 90): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  let allPositions: ClosedPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=50&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        return allPositions;
      }
    }

    if (batch.length < 50) break;
    offset += 50;
    await new Promise(r => setTimeout(r, 50));
  }

  return allPositions;
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
      // Fetch current open positions and closed positions for accurate P&L
      let currentPositions: OpenPosition[] = [];
      let closedPositions: ClosedPosition[] = [];
      try {
        [currentPositions, closedPositions] = await Promise.all([
          fetchOpenPositions(cleanWallet),
          fetchClosedPositions(cleanWallet, 90),
        ]);
      } catch (e) {
        // If API fails, use saved data as-is
        console.error('Error fetching positions from API:', e);
      }

      // Create lookup maps using conditionId + outcome as key (unique identifier)
      const openPosMap = new Map(
        currentPositions.map(p => [`${p.conditionId}:${p.outcome}`, p])
      );
      const closedPosMap = new Map(
        closedPositions.map(p => [`${p.conditionId}:${p.outcome}`, p])
      );

      // CONSOLIDATE: Group saved trades by conditionId + outcome to combine duplicates
      // Multiple trades for the same position should show as ONE position with combined values
      const consolidatedMap = new Map<string, {
        trades: typeof savedCopyPositions;
        conditionId: string;
        outcome: string;
        market: string;
        traderLabel: string;
        traderWallet: string;
      }>();

      for (const pos of savedCopyPositions) {
        const key = `${pos.conditionId}:${pos.outcome}`;
        if (!consolidatedMap.has(key)) {
          consolidatedMap.set(key, {
            trades: [],
            conditionId: pos.conditionId,
            outcome: pos.outcome,
            market: pos.market,
            traderLabel: pos.traderLabel || 'Unknown',
            traderWallet: pos.traderWallet,
          });
        }
        consolidatedMap.get(key)!.trades.push(pos);
      }

      // Process consolidated positions
      const positionsByTrader: Record<string, any[]> = {};
      let totalPnl = 0;
      let totalValue = 0;
      let totalInvested = 0;
      let openCount = 0;
      let closedCount = 0;

      for (const [key, consolidated] of consolidatedMap) {
        const traderLabel = consolidated.traderLabel;
        if (!positionsByTrader[traderLabel]) {
          positionsByTrader[traderLabel] = [];
        }

        // Calculate totals from all trades for this position
        let totalSize = 0;
        let totalUsdcInvested = 0;
        let weightedPrice = 0;
        let latestTimestamp = new Date(0);
        let primarySide = 'BUY';

        for (const trade of consolidated.trades) {
          if (trade.side === 'BUY') {
            totalSize += trade.size || 0;
            totalUsdcInvested += trade.usdcValue || 0;
            weightedPrice += (trade.price || 0) * (trade.usdcValue || 0);
          } else if (trade.side === 'SELL') {
            totalSize -= trade.size || 0;
            // For sells, we reduce our investment basis
            totalUsdcInvested -= trade.usdcValue || 0;
            primarySide = 'MIXED';
          }
          if (new Date(trade.timestamp) > latestTimestamp) {
            latestTimestamp = new Date(trade.timestamp);
          }
        }

        const avgPrice = totalUsdcInvested > 0 ? weightedPrice / totalUsdcInvested : 0;

        // Get current status from API
        const openPos = openPosMap.get(key);
        const closedPos = closedPosMap.get(key);

        let status: 'OPEN' | 'CLOSED' | 'SOLD' = 'CLOSED';
        let currentValue = 0;
        let cashPnl = 0;
        let curPrice = 0;

        if (openPos && openPos.size > 0.1) {
          // Position is still open
          status = 'OPEN';
          currentValue = openPos.currentValue;
          cashPnl = openPos.cashPnl;
          curPrice = openPos.curPrice;
          openCount++;
        } else if (closedPos) {
          // Position was closed - use realized P&L from API
          status = 'CLOSED';
          cashPnl = closedPos.realizedPnl;
          closedCount++;
        } else if (totalSize <= 0) {
          // Position was sold (size reduced to 0 or negative from sells)
          status = 'SOLD';
          // For sold positions, calculate P&L from sell trades
          let sellProceeds = 0;
          let buyTotal = 0;
          for (const trade of consolidated.trades) {
            if (trade.side === 'SELL') {
              sellProceeds += trade.usdcValue || 0;
            } else {
              buyTotal += trade.usdcValue || 0;
            }
          }
          cashPnl = sellProceeds - buyTotal;
          closedCount++;
        } else {
          // Position no longer exists - might have been redeemed
          status = 'CLOSED';
          closedCount++;
        }

        // Use the larger of calculated investment or actual trades value
        const investedAmount = Math.max(totalUsdcInvested, 0);

        positionsByTrader[traderLabel].push({
          conditionId: consolidated.conditionId,
          title: consolidated.market,
          outcome: consolidated.outcome,
          side: primarySide === 'MIXED' ? 'MIXED' : 'BUY',
          size: Math.max(totalSize, 0),
          avgPrice: avgPrice || (consolidated.trades[0]?.price || 0),
          curPrice,
          initialValue: investedAmount,
          currentValue,
          cashPnl,
          percentPnl: investedAmount > 0 ? (cashPnl / investedAmount) * 100 : 0,
          status,
          timestamp: latestTimestamp,
          traderWallet: consolidated.traderWallet,
          tradeCount: consolidated.trades.length,
        });

        // Only count open positions for portfolio value
        if (status === 'OPEN') {
          totalValue += currentValue;
          totalInvested += investedAmount;
        }
        totalPnl += cashPnl;
      }

      // Sort positions within each trader by timestamp (newest first)
      for (const trader of Object.keys(positionsByTrader)) {
        positionsByTrader[trader].sort((a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
      }

      return NextResponse.json({
        success: true,
        source: 'mongodb',
        positionsByTrader,
        unmatchedPositions: [],
        summary: {
          totalPositions: consolidatedMap.size,
          matchedPositions: consolidatedMap.size,
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
