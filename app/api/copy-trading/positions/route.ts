import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const API_BASE = 'https://data-api.polymarket.com';
const DEFAULT_WALLET = '0x01ba1dfbf9dd83a6ee27eb4c33f2d540232ca4ba';

interface Position {
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

interface Activity {
  conditionId: string;
  outcome: string;
  side: string;
  timestamp: number;
}

// Fetch user's open positions from Polymarket
async function fetchOpenPositions(wallet: string): Promise<Position[]> {
  const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=500`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// Fetch user's activities for matching
async function fetchActivities(wallet: string, days: number = 30): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const url = `${API_BASE}/activity?user=${wallet}&limit=500&sortBy=TIMESTAMP&sortDirection=DESC`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);

  const activities = await response.json();
  return activities.filter((a: any) => a.timestamp >= startTs);
}

// Fetch trader activities for matching
async function fetchTraderActivities(wallet: string, days: number = 30): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const url = `${API_BASE}/activity?user=${wallet}&limit=500&sortBy=TIMESTAMP&sortDirection=DESC`;

  const response = await fetch(url);
  if (!response.ok) return [];

  const activities = await response.json();
  return activities.filter((a: any) => a.timestamp >= startTs && a.type === 'TRADE');
}

// Match a position to a trader based on activity history
function matchPositionToTrader(
  position: Position,
  myActivities: Activity[],
  traders: { wallet: string; label: string; activities: Activity[] }[]
): string | null {
  const TIME_WINDOW = 30 * 60; // 30 minutes

  // Find my buy activity for this position
  const myBuy = myActivities.find(
    a => a.conditionId === position.conditionId &&
         a.outcome === position.outcome &&
         a.side === 'BUY'
  );

  if (!myBuy) return null;

  // Find trader who bought the same thing before me
  let bestMatch: { label: string; timeDiff: number } | null = null;

  for (const trader of traders) {
    for (const traderActivity of trader.activities) {
      if (
        traderActivity.conditionId === position.conditionId &&
        traderActivity.outcome === position.outcome &&
        traderActivity.side === 'BUY' &&
        traderActivity.timestamp <= myBuy.timestamp
      ) {
        const timeDiff = myBuy.timestamp - traderActivity.timestamp;
        if (timeDiff <= TIME_WINDOW) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = { label: trader.label, timeDiff };
          }
        }
      }
    }
  }

  return bestMatch?.label || null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet') || DEFAULT_WALLET;
    const days = parseInt(searchParams.get('days') || '30');

    const client = await clientPromise;
    const db = client.db('polymarket-test');

    // Fetch tracked traders from DB
    const trackedTraders = await db.collection('polymarket-trackedTraders')
      .find({ isActive: true })
      .toArray();

    // Fetch user positions and activities
    const [positions, myActivities] = await Promise.all([
      fetchOpenPositions(wallet),
      fetchActivities(wallet, days),
    ]);

    // Filter out resolved positions (curPrice ~= 0)
    const activePositions = positions.filter(p => p.curPrice >= 0.001);

    // Fetch trader activities for matching
    const tradersWithActivities = await Promise.all(
      trackedTraders.map(async (trader) => ({
        wallet: trader.wallet,
        label: trader.label,
        activities: await fetchTraderActivities(trader.wallet, days),
      }))
    );

    // Match positions to traders
    const positionsByTrader: Record<string, Position[]> = {};
    const unmatchedPositions: Position[] = [];

    for (const position of activePositions) {
      const matchedTrader = matchPositionToTrader(
        position,
        myActivities,
        tradersWithActivities
      );

      if (matchedTrader) {
        if (!positionsByTrader[matchedTrader]) {
          positionsByTrader[matchedTrader] = [];
        }
        positionsByTrader[matchedTrader].push(position);
      } else {
        unmatchedPositions.push(position);
      }
    }

    // Calculate summary stats
    const totalPnl = activePositions.reduce((sum, p) => sum + p.cashPnl, 0);
    const totalValue = activePositions.reduce((sum, p) => sum + p.currentValue, 0);
    const totalInvested = activePositions.reduce((sum, p) => sum + p.initialValue, 0);

    return NextResponse.json({
      success: true,
      positionsByTrader,
      unmatchedPositions,
      summary: {
        totalPositions: activePositions.length,
        matchedPositions: activePositions.length - unmatchedPositions.length,
        unmatchedCount: unmatchedPositions.length,
        totalPnl,
        totalValue,
        totalInvested,
        pnlPercent: totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0,
      },
    });

  } catch (error: any) {
    console.error('Error fetching positions:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
