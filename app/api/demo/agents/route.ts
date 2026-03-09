import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { name, ownerWallet, markets, positions, followedTraders, cachedTokenBalances, cachedTokensTotalUsd } = body;

    if (!name || !ownerWallet) {
      return NextResponse.json(
        { error: 'Name and ownerWallet are required' },
        { status: 400 }
      );
    }

    const existingAgent = await Agent.findOne({
      ownerWallet: ownerWallet.toLowerCase(),
    });

    const agentData: any = {
      name,
      markets: markets || ['perps'],
      status: 'active',
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

    // Add token cache if provided
    if (cachedTokenBalances !== undefined) {
      agentData.cachedTokenBalances = cachedTokenBalances;
    }
    if (cachedTokensTotalUsd !== undefined) {
      agentData.cachedTokensTotalUsd = cachedTokensTotalUsd;
    }

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

export async function PATCH(request: NextRequest) {
  try {
    await connectDB();
    const { wallet, name } = await request.json();
    if (!wallet || !name) {
      return NextResponse.json({ error: 'wallet and name are required' }, { status: 400 });
    }
    const agent = await Agent.findOne({ ownerWallet: wallet.toLowerCase() });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    agent.name = name.trim().slice(0, 30);
    await agent.save();
    return NextResponse.json({ success: true, agent });
  } catch (error) {
    console.error('Error renaming agent:', error);
    return NextResponse.json({ error: 'Failed to rename agent' }, { status: 500 });
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
