import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';
import Agent from '@/models/Agent';

/**
 * POST /api/demo/agents/follow-traders
 * Directly queries MongoDB for top 3 perp traders (HL + Avantis)
 * and top 3 PM traders (Polymarket), then updates agent.followedTraders.
 *
 * Body: { wallet: string }
 */
export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return NextResponse.json({ error: 'DB not connected' }, { status: 500 });
    }

    const { wallet } = await request.json();
    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const followedTraders: Array<{
      wallet: string;
      platform: string;
      username?: string;
      pnl30d: number;
      winRate: number;
      roi30d?: number;
      totalPositions: number;
      totalAUM?: number;
      followedAt: Date;
    }> = [];

    const markets = agent.markets || ['perps'];
    const hasPerps = markets.includes('perps');
    const hasPredictions = markets.includes('predictions');

    // Run all queries in parallel
    const [hlTop, avTop, pmTop] = await Promise.all([
      hasPerps
        ? db.collection('hyperliquidmetrics').find({}).sort({ pnl_30d: -1 }).limit(2).toArray()
        : Promise.resolve([]),
      hasPerps
        ? db.collection('managers').find({}).sort({ 'metrics.totalPnL30d': -1 }).limit(1).toArray()
        : Promise.resolve([]),
      hasPredictions
        ? db.collection('polymarket-traderProfiles').find({}).sort({ netPnl: -1 }).limit(3).toArray()
        : Promise.resolve([]),
    ]);

    for (const t of hlTop) {
      followedTraders.push({
        wallet: t.walletAddress || t.wallet || 'unknown',
        platform: 'hyperliquid',
        pnl30d: t.pnl_30d || 0,
        winRate: t.positionWinRate || 0,
        totalPositions: t.totalPositions || 0,
        totalAUM: parseFloat(t.accountValue) || 0,
        followedAt: new Date(),
      });
    }

    for (const t of avTop) {
      followedTraders.push({
        wallet: t.walletAddress || 'unknown',
        platform: 'avantis',
        username: t.username,
        pnl30d: t.metrics?.totalPnL30d || 0,
        winRate: t.metrics?.winRate || 0,
        roi30d: t.metrics?.roi30d || 0,
        totalPositions: t.metrics?.totalTrades || 0,
        totalAUM: t.metrics?.totalAUM || 0,
        followedAt: new Date(),
      });
    }

    for (const t of pmTop) {
      followedTraders.push({
        wallet: t.wallet || 'unknown',
        platform: 'polymarket',
        pnl30d: t.netPnl || 0,
        winRate: t.winRate || 0,
        totalPositions: t.totalActivities || 0,
        totalAUM: t.openValue || 0,
        followedAt: new Date(),
      });
    }

    // Update agent
    agent.followedTraders = followedTraders;
    await agent.save();

    return NextResponse.json({
      success: true,
      followedTraders,
      count: followedTraders.length,
    });
  } catch (error) {
    console.error('Error following traders:', error);
    return NextResponse.json({ error: 'Failed to follow traders' }, { status: 500 });
  }
}
