import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');
    const trader = searchParams.get('trader');
    const type = searchParams.get('type'); // TRADE, REDEEM, etc.
    const unacknowledgedOnly = searchParams.get('unacknowledged') === 'true';

    const client = await clientPromise;
    const db = client.db(dbName);

    // Get list of actively tracked traders (isTracking: true and isActive: true)
    const trackedTraders = await db.collection('polymarket-trackedTraders')
      .find({ isActive: true, isTracking: true })
      .project({ wallet: 1 })
      .toArray();
    const trackedWallets = trackedTraders.map(t => t.wallet.toLowerCase());

    // Build query - only show alerts from tracked traders
    const query: any = {};

    if (trader) {
      query.traderWallet = trader.toLowerCase();
    } else if (trackedWallets.length > 0) {
      // Only show alerts from actively tracked traders
      query.traderWallet = { $in: trackedWallets };
    } else {
      // No tracked traders, return empty
      return NextResponse.json({
        success: true,
        alerts: [],
        count: 0,
      });
    }

    if (type) query.type = type;
    if (unacknowledgedOnly) query.acknowledged = false;

    // Fetch alerts sorted by newest first
    const alerts = await db.collection('polymarket-tradeAlerts')
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    // Map to frontend format
    const formattedAlerts = alerts.map(alert => ({
      _id: alert._id.toString(),
      traderWallet: alert.traderWallet,
      traderLabel: alert.traderLabel || alert.traderWallet.slice(0, 8),
      type: alert.type,
      side: alert.side,
      title: alert.market,
      outcome: alert.outcome,
      price: alert.price,
      usdcSize: alert.usdcValue,
      timestamp: alert.timestamp,
      isHighConviction: alert.isHighConviction,
      sizeMultiplier: alert.sizeMultiplier,
      copyRecommendation: alert.copyRecommendation,
      acknowledged: alert.acknowledged,
      copied: alert.copied,
    }));

    return NextResponse.json({
      success: true,
      alerts: formattedAlerts,
      count: formattedAlerts.length,
    });

  } catch (error: any) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// Mark alert as acknowledged or copied
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { alertId, action, copyDetails } = body;

    if (!alertId || !action) {
      return NextResponse.json(
        { success: false, error: 'Missing alertId or action' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    const update: any = { updatedAt: new Date() };

    if (action === 'acknowledge') {
      update.acknowledged = true;
      update.acknowledgedAt = new Date();
    } else if (action === 'copy') {
      update.copied = true;
      update.copiedAt = new Date();
      if (copyDetails) {
        update.copiedSize = copyDetails.size;
        update.copiedPrice = copyDetails.price;
        update.copiedTxHash = copyDetails.txHash;
      }
    } else if (action === 'skip') {
      update.acknowledged = true;
      update.acknowledgedAt = new Date();
      update.copyRecommendation = 'SKIP';
    }

    const result = await db.collection('polymarket-tradeAlerts')
      .updateOne(
        { _id: new (await import('mongodb')).ObjectId(alertId) },
        { $set: update }
      );

    return NextResponse.json({
      success: true,
      modifiedCount: result.modifiedCount,
    });

  } catch (error: any) {
    console.error('Error updating alert:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
