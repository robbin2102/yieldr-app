import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normalizeUrl(url: string) {
  return !url.startsWith('http://') && !url.startsWith('https://') ? `https://${url}` : url;
}
const PYTHON_URL = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
const API_KEY    = process.env.API_KEY || '';

// POST /api/avantis/fund
// Body: { agentId: string, amount: number, user_wallet_address: string }
// Returns unsigned ERC20 transfer calldata for user's wallet to sign via wagmi.
// Destination is always the agent's own CDP wallet (per-agent isolation).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentId, amount, user_wallet_address } = body;

    if (!amount || !user_wallet_address) {
      return NextResponse.json(
        { error: 'Required: amount, user_wallet_address' },
        { status: 400 }
      );
    }

    // Resolve the agent's dedicated CDP wallet address from MongoDB
    let agentWalletAddress: string | undefined;
    if (agentId) {
      await connectDB();
      const agent = await Agent.findOne({ agentId })
        .select('agentWalletAddress')
        .lean() as { agentWalletAddress?: string } | null;
      agentWalletAddress = agent?.agentWalletAddress;
    }

    const res = await fetch(`${PYTHON_URL}/trade/fund-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({
        amount,
        user_wallet_address,
        ...(agentWalletAddress ? { agent_wallet_address: agentWalletAddress } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || `Python service error ${res.status}`);
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[avantis/fund] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
