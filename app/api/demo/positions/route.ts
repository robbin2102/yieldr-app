import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Position from '@/models/Position';

const BANKR_WALLET_ADDRESS = '0xcdc44ffda057aca49bb9c8b7d54de212742729c7';
const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'https://yieldr-app-production.up.railway.app';
const BASE_RPC_URL = process.env.QUICKNODE_BASE_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org';

/**
 * GET /api/demo/positions?wallet=0x...
 * Returns active agent positions from MongoDB.
 * Frontend polls this every 30s when positions are open.
 */
export async function GET(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get('wallet');
  if (!wallet) {
    return NextResponse.json({ error: 'wallet param required' }, { status: 400 });
  }

  await connectDB();
  const positions = await Position.find({
    walletAddress: wallet.toLowerCase(),
    agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
    status: 'active',
  }).sort({ createdAt: -1 }).lean();

  return NextResponse.json({ positions, agentWallet: BANKR_WALLET_ADDRESS });
}

/**
 * POST /api/demo/positions?wallet=0x...
 * Fetches live positions from Avantis via Railway Python service (QuickNode RPC),
 * updates MongoDB, and returns fresh data.
 * Called by frontend every 30s for active positions.
 *
 * Uses the same battle-tested /fetch-positions endpoint used in onboarding —
 * NOT Bankr (which has a 100 msg/day limit on the free plan).
 */
export async function POST(request: NextRequest) {
  const wallet = request.nextUrl.searchParams.get('wallet');
  if (!wallet) {
    return NextResponse.json({ error: 'wallet param required' }, { status: 400 });
  }

  try {
    // Fetch live positions from Railway Python service for the Bankr agent wallet
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    const res = await fetch(`${PYTHON_SERVICE_URL}/fetch-positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: BANKR_WALLET_ADDRESS,
        rpcUrl: BASE_RPC_URL,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return NextResponse.json({ error: `Position service error: ${res.status}` }, { status: 502 });
    }

    const data = await res.json();

    if (!data.success || !data.data?.positions) {
      // No positions from Avantis — mark all active as closed
      await connectDB();
      const closedCount = await Position.updateMany(
        { agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(), platform: 'Avantis', status: 'active' },
        { $set: { status: 'closed', updatedAt: new Date() } }
      );
      return NextResponse.json({
        positions: [],
        totalPositions: 0,
        closedStale: closedCount.modifiedCount,
        agentWallet: BANKR_WALLET_ADDRESS,
      });
    }

    const avantisPositions = data.data.positions;
    const summary = data.data.summary || {};

    // Upsert each position from Avantis into MongoDB
    await connectDB();
    const activePairIndexes: number[] = [];

    for (const pos of avantisPositions) {
      activePairIndexes.push(pos.pairIndex);
      await Position.findOneAndUpdate(
        {
          agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
          platform: 'Avantis',
          positionId: `avantis-${pos.pairIndex}-${pos.tradeIndex}`,
        },
        {
          $set: {
            walletAddress: wallet.toLowerCase(),
            agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
            type: 'PERP',
            platform: 'Avantis',
            positionId: `avantis-${pos.pairIndex}-${pos.tradeIndex}`,
            status: 'active',
            pair: pos.asset || `pair_${pos.pairIndex}`,
            direction: pos.direction || 'LONG',
            leverage: pos.leverage || 1,
            positionSize: pos.positionSize || 0,
            margin: pos.margin || 0,
            entryPrice: pos.entryPrice || 0,
            currentPrice: pos.currentPrice || 0,
            liquidationPrice: pos.liquidationPrice || null,
            pnl: pos.pnl || 0,
            roi: pos.roi || 0,
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true, new: true }
      );
    }

    // Mark positions that are no longer on-chain as closed
    await Position.updateMany(
      {
        agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
        platform: 'Avantis',
        status: 'active',
        positionId: { $nin: avantisPositions.map((p: any) => `avantis-${p.pairIndex}-${p.tradeIndex}`) },
      },
      { $set: { status: 'closed', updatedAt: new Date() } }
    );

    // Return fresh positions from MongoDB
    const updatedPositions = await Position.find({
      walletAddress: wallet.toLowerCase(),
      agentWallet: BANKR_WALLET_ADDRESS.toLowerCase(),
      status: 'active',
    }).sort({ createdAt: -1 }).lean();

    return NextResponse.json({
      positions: updatedPositions,
      totalPositions: avantisPositions.length,
      summary,
      agentWallet: BANKR_WALLET_ADDRESS,
    });
  } catch (err: any) {
    console.error(`[positions/refresh] Error: ${err.message}`);
    if (err.name === 'AbortError') {
      return NextResponse.json({ error: 'Position fetch timeout (>30s)' }, { status: 504 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
