import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

// GET - List all tracked traders with their open positions
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const includePositions = searchParams.get('positions') !== 'false'; // Default true

    const client = await clientPromise;
    const db = client.db(dbName);

    const traders = await db.collection('polymarket-trackedTraders')
      .find({ isActive: true })
      .sort({ lastSeenTimestamp: -1 })
      .toArray();

    // Fetch open positions for all traders in one query
    let positionsByWallet: Record<string, any[]> = {};
    if (includePositions && traders.length > 0) {
      const wallets = traders.map(t => t.wallet.toLowerCase());
      const allPositions = await db.collection('polymarket-openPositions')
        .find({
          walletAddress: { $in: wallets },
          curPrice: { $gte: 0.01 }, // Active positions only
        })
        .sort({ currentValue: -1 })
        .toArray();

      // Group by wallet
      for (const pos of allPositions) {
        const wallet = pos.walletAddress;
        if (!positionsByWallet[wallet]) {
          positionsByWallet[wallet] = [];
        }
        positionsByWallet[wallet].push(pos);
      }
    }

    const formattedTraders = traders.map(trader => {
      const positions = positionsByWallet[trader.wallet.toLowerCase()] || [];
      const totalPositionValue = positions.reduce((sum, p) => sum + (p.currentValue || 0), 0);

      // Show top 5 positions by value (no 10% threshold - let UI handle filtering)
      const topPositions = positions.slice(0, 5).map(p => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        currentValue: p.currentValue,
        cashPnl: p.cashPnl,
        percentPnl: p.percentPnl,
      }));

      return {
        _id: trader._id.toString(),
        wallet: trader.wallet,
        label: trader.label,
        notes: trader.notes,
        volumeLabel: trader.volumeLabel,
        strategyLabel: trader.strategyLabel,
        specialty: trader.specialty,
        winRate: trader.winRate,
        profitFactor: trader.profitFactor,
        avgTradeSize: trader.avgTradeSize,
        netPnl: trader.netPnl,
        copyMultiplier: trader.copyMultiplier,
        maxCopySize: trader.maxCopySize,
        lastSeenTimestamp: trader.lastSeenTimestamp,
        isActive: trader.isActive,
        isTracking: trader.isTracking || false,
        totalAlerts: trader.totalAlerts,
        totalCopied: trader.totalCopied,
        totalPnl: trader.totalPnl,
        addedAt: trader.addedAt,
        profiledAt: trader.profiledAt,
        // New position data
        positionCount: positions.length,
        totalPositionValue,
        totalUnrealizedPnl: positions.reduce((sum, p) => sum + (p.cashPnl || 0), 0),
        topPositions,
        positionsUpdatedAt: positions[0]?.fetchedAt,
      };
    });

    return NextResponse.json({
      success: true,
      traders: formattedTraders,
      count: formattedTraders.length,
    });

  } catch (error: any) {
    console.error('Error fetching traders:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// POST - Add a new trader to track
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, label, notes, copyMultiplier, maxCopySize } = body;

    if (!wallet || !label) {
      return NextResponse.json(
        { success: false, error: 'Missing wallet or label' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Check if already exists
    const existing = await db.collection('polymarket-trackedTraders')
      .findOne({ wallet: wallet.toLowerCase() });

    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Trader already tracked' },
        { status: 400 }
      );
    }

    const newTrader = {
      wallet: wallet.toLowerCase(),
      label,
      notes: notes || '',
      volumeLabel: 'MEDIUM',
      strategyLabel: 'BUY_AND_HOLD',
      copyMultiplier: copyMultiplier || 1.0,
      maxCopySize: maxCopySize || 10000,
      skipSmallBets: true,
      smallBetThreshold: 50,
      enableHighConvictionAlerts: false,
      asymmetricMultiplier: 10,
      lastSeenTimestamp: Math.floor(Date.now() / 1000),
      isActive: true,
      totalAlerts: 0,
      totalCopied: 0,
      totalPnl: 0,
      addedAt: new Date(),
      lastUpdatedAt: new Date(),
    };

    const result = await db.collection('polymarket-trackedTraders')
      .insertOne(newTrader);

    return NextResponse.json({
      success: true,
      trader: { ...newTrader, _id: result.insertedId.toString() },
    });

  } catch (error: any) {
    console.error('Error adding trader:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// PATCH - Update trader settings or start/stop tracking
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, action, updates } = body;

    if (!wallet) {
      return NextResponse.json(
        { success: false, error: 'Missing wallet' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Handle start/stop tracking actions
    if (action === 'startTracking') {
      // Get latest activity timestamp from API to start tracking from
      let lastSeenTimestamp = Math.floor(Date.now() / 1000);
      try {
        const apiUrl = `https://data-api.polymarket.com/activity?user=${wallet.toLowerCase()}&limit=1&sortBy=TIMESTAMP&sortDirection=DESC`;
        const response = await fetch(apiUrl);
        if (response.ok) {
          const activities = await response.json();
          if (activities.length > 0) {
            lastSeenTimestamp = activities[0].timestamp;
          }
        }
      } catch (e) {
        // Use current timestamp if API fails
      }

      const result = await db.collection('polymarket-trackedTraders')
        .updateOne(
          { wallet: wallet.toLowerCase() },
          {
            $set: {
              isTracking: true,
              lastSeenTimestamp,
              lastUpdatedAt: new Date(),
            }
          }
        );

      return NextResponse.json({
        success: true,
        action: 'startTracking',
        modifiedCount: result.modifiedCount,
      });
    }

    if (action === 'stopTracking') {
      const result = await db.collection('polymarket-trackedTraders')
        .updateOne(
          { wallet: wallet.toLowerCase() },
          {
            $set: {
              isTracking: false,
              lastUpdatedAt: new Date(),
            }
          }
        );

      return NextResponse.json({
        success: true,
        action: 'stopTracking',
        modifiedCount: result.modifiedCount,
      });
    }

    // Handle regular updates
    const allowedUpdates = [
      'label', 'notes', 'copyMultiplier', 'maxCopySize',
      'skipSmallBets', 'smallBetThreshold', 'isActive',
      'enableHighConvictionAlerts', 'asymmetricMultiplier',
    ];

    const safeUpdates: any = { lastUpdatedAt: new Date() };
    if (updates) {
      for (const key of allowedUpdates) {
        if (updates[key] !== undefined) {
          safeUpdates[key] = updates[key];
        }
      }
    }

    const result = await db.collection('polymarket-trackedTraders')
      .updateOne(
        { wallet: wallet.toLowerCase() },
        { $set: safeUpdates }
      );

    return NextResponse.json({
      success: true,
      modifiedCount: result.modifiedCount,
    });

  } catch (error: any) {
    console.error('Error updating trader:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// DELETE - Remove trader from tracking
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json(
        { success: false, error: 'Missing wallet' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Soft delete - set isActive to false
    const result = await db.collection('polymarket-trackedTraders')
      .updateOne(
        { wallet: wallet.toLowerCase() },
        { $set: { isActive: false, lastUpdatedAt: new Date() } }
      );

    return NextResponse.json({
      success: true,
      modifiedCount: result.modifiedCount,
    });

  } catch (error: any) {
    console.error('Error removing trader:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
