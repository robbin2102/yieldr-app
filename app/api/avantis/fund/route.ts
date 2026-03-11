import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8001';
const API_KEY    = process.env.API_KEY || '';

// POST /api/avantis/fund
// Body: { amount: number, user_wallet_address: string }
// Returns unsigned ERC20 transfer calldata for user's wallet to sign via wagmi
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, user_wallet_address } = body;

    if (!amount || !user_wallet_address) {
      return NextResponse.json(
        { error: 'Required: amount, user_wallet_address' },
        { status: 400 }
      );
    }

    const res = await fetch(`${PYTHON_URL}/trade/fund-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({ amount, user_wallet_address }),
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
