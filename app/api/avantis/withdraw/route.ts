import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normalizeUrl(url: string) {
  return !url.startsWith('http://') && !url.startsWith('https://') ? `https://${url}` : url;
}
const PYTHON_URL      = normalizeUrl(process.env.PYTHON_SERVICE_URL || 'http://localhost:8001');
const API_KEY         = process.env.YIELDR_DATA_API_SECRET || process.env.API_KEY || '';
const INTERNAL_SECRET = process.env.YIELDR_INTERNAL_SECRET || '';

// POST /api/avantis/withdraw
// Body: { agentId: string, amount: number, asset: 'ETH'|'USDC', to_address: string }
// The agent CDP wallet signs and sends the transfer autonomously (no user signature needed).
// Requires internal Bearer auth.
export async function POST(request: NextRequest) {
  try {
    // Internal auth — only the chat route should call this
    if (INTERNAL_SECRET) {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${INTERNAL_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json();
    const { amount, asset, to_address } = body;

    if (!amount || !asset || !to_address) {
      return NextResponse.json(
        { error: 'Required: amount, asset, to_address' },
        { status: 400 }
      );
    }

    // Static EOA wallet (AGENT_WALLET_PRIVATE_KEY) handles signing in the Python service
    const res = await fetch(`${PYTHON_URL}/trade/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify({ amount, asset, to_address }),
      signal: AbortSignal.timeout(60_000),
    });

    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: data.detail || `Withdraw failed: HTTP ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[avantis/withdraw] error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
