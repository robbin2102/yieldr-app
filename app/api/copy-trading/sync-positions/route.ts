import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for sync

const API_BASE = 'https://data-api.polymarket.com';

interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

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

interface TrackedTrader {
  wallet: string;
  label: string;
  isActive: boolean;
  isTracking: boolean;
}

// Fetch user activities
async function fetchActivities(wallet: string, days: number): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  let allActivities: Activity[] = [];
  let offset = 0;

  while (allActivities.length < 2000) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    for (const activity of batch) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        return allActivities;
      }
    }

    if (batch.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 50));
  }

  return allActivities;
}

// Fetch open positions with pagination
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

// Fetch closed positions
async function fetchClosedPositions(wallet: string, days: number): Promise<ClosedPosition[]> {
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

// Match trade to trader by activity
function matchTradeToTrader(
  myTrade: Activity,
  tradersData: { wallet: string; label: string; activities: Activity[]; openPositions: OpenPosition[] }[]
): { wallet: string; label: string; matchType: 'activity' | 'position' } | null {
  const TIME_WINDOW = 48 * 60 * 60; // 48 hours for copy trading

  // Try activity-based matching first
  let bestMatch: { wallet: string; label: string; timeDiff: number } | null = null;

  for (const trader of tradersData) {
    for (const traderTrade of trader.activities) {
      const sameMarket = traderTrade.conditionId === myTrade.conditionId;
      const sameOutcome = traderTrade.outcome === myTrade.outcome;
      const sameSide = traderTrade.side === myTrade.side;
      const traderFirst = traderTrade.timestamp <= myTrade.timestamp;

      if (sameMarket && sameOutcome && sameSide && traderFirst) {
        const timeDiff = myTrade.timestamp - traderTrade.timestamp;
        if (timeDiff <= TIME_WINDOW) {
          if (!bestMatch || timeDiff < bestMatch.timeDiff) {
            bestMatch = { wallet: trader.wallet, label: trader.label, timeDiff };
          }
        }
      }
    }
  }

  if (bestMatch) {
    return { wallet: bestMatch.wallet, label: bestMatch.label, matchType: 'activity' };
  }

  // Fallback: position-based matching (for older positions)
  if (myTrade.side === 'BUY') {
    let posMatch: { wallet: string; label: string; positionValue: number } | null = null;

    for (const trader of tradersData) {
      for (const position of trader.openPositions) {
        if (position.conditionId === myTrade.conditionId && position.outcome === myTrade.outcome) {
          if (!posMatch || position.currentValue > posMatch.positionValue) {
            posMatch = { wallet: trader.wallet, label: trader.label, positionValue: position.currentValue };
          }
        }
      }
    }

    if (posMatch) {
      return { wallet: posMatch.wallet, label: posMatch.label, matchType: 'position' };
    }
  }

  return null;
}

// POST - Sync user positions and match to traders
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, days = 30 } = body;

    if (!wallet) {
      return NextResponse.json({ success: false, error: 'Wallet address required' }, { status: 400 });
    }

    const userWallet = wallet.toLowerCase();
    const client = await clientPromise;
    const db = client.db(dbName);

    // Get tracked traders
    const trackedTraders = await db.collection('polymarket-trackedTraders')
      .find({ isActive: true, isTracking: true })
      .toArray() as unknown as TrackedTrader[];

    if (trackedTraders.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No traders being actively tracked. Start tracking traders first.',
      });
    }

    console.log(`[Sync] Syncing positions for ${userWallet}, ${trackedTraders.length} traders tracked`);

    // Fetch user data
    const [myActivities, myOpenPositions, myClosedPositions] = await Promise.all([
      fetchActivities(userWallet, days),
      fetchOpenPositions(userWallet),
      fetchClosedPositions(userWallet, days),
    ]);

    const myTrades = myActivities.filter(a => a.type === 'TRADE');
    console.log(`[Sync] User has ${myTrades.length} trades, ${myOpenPositions.length} open positions`);

    // Fetch trader data (activities + positions)
    const tradersData: { wallet: string; label: string; activities: Activity[]; openPositions: OpenPosition[] }[] = [];

    for (const trader of trackedTraders) {
      try {
        const [activities, positions] = await Promise.all([
          fetchActivities(trader.wallet, days),
          fetchOpenPositions(trader.wallet),
        ]);

        tradersData.push({
          wallet: trader.wallet,
          label: trader.label,
          activities: activities.filter(a => a.type === 'TRADE'),
          openPositions: positions,
        });

        await new Promise(r => setTimeout(r, 100)); // Rate limit
      } catch (err: any) {
        console.error(`[Sync] Error fetching ${trader.label}: ${err.message}`);
      }
    }

    // Match trades to traders
    const matchedPositions: any[] = [];
    const unmatchedTrades: Activity[] = [];
    let activityMatches = 0;
    let positionMatches = 0;

    for (const trade of myTrades) {
      const match = matchTradeToTrader(trade, tradersData);

      if (match) {
        if (match.matchType === 'activity') activityMatches++;
        else positionMatches++;

        // Find current position status
        const openPos = myOpenPositions.find(
          p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
        );
        const closedPos = myClosedPositions.find(
          p => p.conditionId === trade.conditionId && p.outcome === trade.outcome
        );

        let status: 'OPEN' | 'CLOSED' | 'UNKNOWN' = 'UNKNOWN';
        let currentValue: number | undefined;
        let cashPnl: number | undefined;
        let curPrice: number | undefined;

        if (openPos) {
          status = 'OPEN';
          currentValue = openPos.currentValue;
          cashPnl = openPos.cashPnl;
          curPrice = openPos.curPrice;
        } else if (closedPos) {
          status = 'CLOSED';
          cashPnl = closedPos.realizedPnl;
        }

        matchedPositions.push({
          userWallet,
          traderWallet: match.wallet,
          traderLabel: match.label,
          conditionId: trade.conditionId,
          asset: trade.asset,
          market: trade.title,
          outcome: trade.outcome,
          side: trade.side || 'UNKNOWN',
          size: trade.size,
          price: trade.price,
          usdcValue: trade.usdcSize,
          timestamp: new Date(trade.timestamp * 1000),
          status,
          currentValue,
          curPrice,
          pnl: cashPnl,
          pnlPercent: trade.usdcSize > 0 && cashPnl ? (cashPnl / trade.usdcSize) * 100 : 0,
          matchType: match.matchType,
          matchedAt: new Date(),
          txHash: trade.transactionHash,
        });
      } else {
        unmatchedTrades.push(trade);
      }
    }

    // Save to MongoDB
    const collection = db.collection('polymarket-copyPositions');
    let savedCount = 0;
    let updatedCount = 0;

    for (const pos of matchedPositions) {
      try {
        const result = await collection.updateOne(
          {
            userWallet: pos.userWallet,
            conditionId: pos.conditionId,
            outcome: pos.outcome,
            txHash: pos.txHash, // Use txHash to uniquely identify each trade
          },
          { $set: pos },
          { upsert: true }
        );

        if (result.upsertedCount > 0) savedCount++;
        else if (result.modifiedCount > 0) updatedCount++;
      } catch (err: any) {
        if (!err.message?.includes('duplicate key')) {
          console.error(`[Sync] Error saving: ${err.message}`);
        }
      }
    }

    // Calculate summary
    const totalPnl = matchedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
    const totalValue = matchedPositions.filter(p => p.status === 'OPEN').reduce((sum, p) => sum + (p.currentValue || 0), 0);
    const totalInvested = matchedPositions.filter(p => p.side === 'BUY').reduce((sum, p) => sum + p.usdcValue, 0);

    console.log(`[Sync] Complete: ${savedCount} new, ${updatedCount} updated, ${unmatchedTrades.length} unmatched`);

    return NextResponse.json({
      success: true,
      summary: {
        totalTrades: myTrades.length,
        matchedCount: matchedPositions.length,
        unmatchedCount: unmatchedTrades.length,
        activityMatches,
        positionMatches,
        savedNew: savedCount,
        updated: updatedCount,
        totalPnl,
        totalValue,
        totalInvested,
      },
      message: `Synced ${matchedPositions.length} positions, ${savedCount} new, ${updatedCount} updated`,
    });

  } catch (error: any) {
    console.error('[Sync] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET - Manual trigger
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const wallet = searchParams.get('wallet');

  if (!wallet) {
    return NextResponse.json({ success: false, error: 'Wallet required as query param' }, { status: 400 });
  }

  // Create a mock request with the wallet in body
  const mockRequest = new NextRequest(request.url, {
    method: 'POST',
    body: JSON.stringify({ wallet, days: 30 }),
    headers: { 'Content-Type': 'application/json' },
  });

  return POST(mockRequest);
}
