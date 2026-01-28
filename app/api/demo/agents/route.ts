import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    const body = await request.json();
    const { name, ownerWallet, goals, positions, followedTraders } = body;

    if (!name || !ownerWallet) {
      return NextResponse.json(
        { error: 'Name and ownerWallet are required' },
        { status: 400 }
      );
    }

    // Check if agent already exists for this wallet
    const existingAgent = await Agent.findOne({
      ownerWallet: ownerWallet.toLowerCase(),
    });

    if (existingAgent) {
      // Update existing agent
      existingAgent.name = name;
      existingAgent.goals = goals || ['invest'];
      existingAgent.status = 'active';
      existingAgent.portfolioSummary = {
        totalValue: positions?.totalValue || 0,
        totalPnl: 0,
        positionCount:
          (positions?.avantis || 0) +
          (positions?.hyperliquid || 0) +
          (positions?.polymarket || 0),
      };
      existingAgent.followedTraders = (followedTraders || []).map((wallet: string) => ({
        wallet: wallet.toLowerCase(),
        protocol: 'polymarket', // Default, will be updated later
        followedAt: new Date(),
      }));

      await existingAgent.save();

      return NextResponse.json({
        success: true,
        agent: existingAgent,
        updated: true,
      });
    }

    // Create new agent
    const agent = new Agent({
      name,
      ownerWallet: ownerWallet.toLowerCase(),
      goals: goals || ['invest'],
      status: 'active',
      positions: {
        avantis: [],
        hyperliquid: [],
        polymarket: [],
      },
      portfolioSummary: {
        totalValue: positions?.totalValue || 0,
        totalPnl: 0,
        positionCount:
          (positions?.avantis || 0) +
          (positions?.hyperliquid || 0) +
          (positions?.polymarket || 0),
      },
      followedTraders: (followedTraders || []).map((wallet: string) => ({
        wallet: wallet.toLowerCase(),
        protocol: 'polymarket',
        followedAt: new Date(),
      })),
    });

    await agent.save();

    return NextResponse.json({
      success: true,
      agent,
      created: true,
    });
  } catch (error) {
    console.error('Error creating agent:', error);
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    const agent = await Agent.findOne({
      ownerWallet: wallet.toLowerCase(),
    });

    if (!agent) {
      return NextResponse.json(
        { error: 'Agent not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      agent,
    });
  } catch (error) {
    console.error('Error fetching agent:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agent' },
      { status: 500 }
    );
  }
}
