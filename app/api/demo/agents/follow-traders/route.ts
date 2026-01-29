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

    // --- Top 3 perp traders: 2 from Hyperliquid + 1 from Avantis ---
    if (hasPerps) {
      // Hyperliquid: query hyperliquidmetrics, sort by pnl_30d desc
      const hlMetrics = db.collection('hyperliquidmetrics');
      const hlTop = await hlMetrics
        .find({})
        .sort({ pnl_30d: -1 })
        .limit(2)
        .toArray();

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

      // Avantis: query managers collection, sort by metrics.totalPnL30d desc
      const managers = db.collection('managers');
      const avTop = await managers
        .find({})
        .sort({ 'metrics.totalPnL30d': -1 })
        .limit(Math.max(1, 3 - hlTop.length))
        .toArray();

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
    }

    // --- Top 3 PM traders from polymarket-traderProfiles ---
    if (hasPredictions) {
      const pmProfiles = db.collection('polymarket-traderProfiles');
      const pmTop = await pmProfiles
        .find({})
        .sort({ netPnl: -1 })
        .limit(3)
        .toArray();

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
