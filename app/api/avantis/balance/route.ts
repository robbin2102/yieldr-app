import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8001';
const API_KEY    = process.env.API_KEY || '';

export async function GET(request: NextRequest) {
  try {
    const agentWalletAddress = request.nextUrl.searchParams.get('agent_wallet_address');
    const balanceUrl = agentWalletAddress
      ? `${PYTHON_URL}/trade/balance?agent_wallet_address=${encodeURIComponent(agentWalletAddress)}`
      : `${PYTHON_URL}/trade/balance`;

    const res = await fetch(balanceUrl, {
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(30_000),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || `Python service error ${res.status}`);
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[avantis/balance] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
