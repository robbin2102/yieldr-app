import { NextRequest, NextResponse } from 'next/server';

const MCP_URL = process.env.MCP_SERVER_URL || 'https://mcp-demo-production-59da.up.railway.app';

/**
 * GET /api/polymarket-positions?address=0x...
 * Proxies to MCP server to avoid CORS issues from browser
 */
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  if (!address) {
    return NextResponse.json({ success: false, error: 'Missing address parameter' }, { status: 400 });
  }

  try {
    const res = await fetch(`${MCP_URL}/tools/get_pm_live_positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: address }),
    });

    if (!res.ok) {
      console.error(`[PM Proxy] MCP returned ${res.status}`);
      return NextResponse.json({ success: false, error: `MCP error: ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('[PM Proxy] Error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
