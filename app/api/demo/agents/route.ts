import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { name, ownerWallet, markets, positions, followedTraders } = body;

    if (!name || !ownerWallet) {
      return NextResponse.json(
        { error: 'Name and ownerWallet are required' },
        { status: 400 }
      );
    }

    const existingAgent = await Agent.findOne({
      ownerWallet: ownerWallet.toLowerCase(),
    });

    const agentData = {
      name,
      markets: markets || ['perps'],
      status: 'active',
      positions: {
        avantis: (positions?.avantisPositions || []).map((p: any) => ({
          protocol: 'avantis',
          asset: p.asset || p.pair || 'Unknown',
          direction: p.direction || (p.buy ? 'LONG' : 'SHORT'),
          size: p.positionSize || p.collateral || 0,
          entryPrice: p.entryPrice || p.openPrice || 0,
          currentPrice: p.currentPrice || 0,
          pnl: p.pnl || 0,
          leverage: p.leverage || 1,
        })),
        hyperliquid: (positions?.hlPositions || []).map((p: any) => ({
          protocol: 'hyperliquid',
          asset: p.coin || p.pair || 'Unknown',
          direction: p.side || p.direction || 'LONG',
          size: p.size || p.positionValue || 0,
          entryPrice: p.entryPrice || 0,
          currentPrice: p.currentPrice || 0,
          pnl: p.unrealizedPnl || p.pnl || 0,
          leverage: p.leverage || 1,
        })),
        polymarket: (positions?.pmPositions || []).map((p: any) => ({
          protocol: 'polymarket',
          asset: p.title || 'Unknown',
          direction: p.outcome === 'No' ? 'NO' : 'YES',
          size: p.size || 0,
          entryPrice: p.avgPrice || 0,
          currentPrice: p.currentPrice || 0,
          pnl: p.pnl || 0,
        })),
      },
      portfolioSummary: {
        totalValue: positions?.totalValue || 0,
        totalPnl: 0,
        positionCount:
          (positions?.counts?.avantis || 0) +
          (positions?.counts?.hyperliquid || 0) +
          (positions?.counts?.lp || 0) +
          (positions?.counts?.polymarket || 0),
      },
      followedTraders: followedTraders || [],
    };

    if (existingAgent) {
      Object.assign(existingAgent, agentData);
      await existingAgent.save();
      return NextResponse.json({ success: true, agent: existingAgent, updated: true });
    }

    const agent = new Agent({
      ownerWallet: ownerWallet.toLowerCase(),
      ...agentData,
    });
    await agent.save();
    return NextResponse.json({ success: true, agent, created: true });
  } catch (error) {
    console.error('Error creating agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'Wallet address required' }, { status: 400 });
    }

    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, agent });
  } catch (error) {
    console.error('Error fetching agent:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}
