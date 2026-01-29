import { NextRequest, NextResponse } from 'next/server';

const MCP_URL = process.env.MCP_SERVER_URL || 'https://mcp-demo-production-59da.up.railway.app';
const PM_GAMMA_API = 'https://gamma-api.polymarket.com';

/**
 * GET /api/polymarket-positions?address=0x...
 *
 * Resolves the Polymarket proxy wallet from the EOA (parent) wallet,
 * then fetches positions via the MCP server.
 *
 * Polymarket uses proxy wallets (Safe or Magic proxy) that are separate
 * from the user's MetaMask/EOA address. The data-api needs the proxy address.
 */
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  if (!address) {
    return NextResponse.json({ success: false, error: 'Missing address parameter' }, { status: 400 });
  }

  try {
    // Step 1: Resolve proxy wallet from EOA via Polymarket profile API
    let proxyWallet = address;
    try {
      const profileRes = await fetch(`${PM_GAMMA_API}/public-profile?address=${address}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        if (profile.proxyWallet) {
          proxyWallet = profile.proxyWallet;
          console.log(`[PM] Resolved proxy wallet: ${address} -> ${proxyWallet}`);
        } else {
          console.log(`[PM] No proxyWallet in profile, trying EOA directly`);
        }
      } else {
        console.log(`[PM] Profile lookup failed (${profileRes.status}), trying EOA directly`);
      }
    } catch (e: any) {
      console.log(`[PM] Profile lookup error: ${e.message}, trying EOA directly`);
    }

    // Step 2: Fetch positions using proxy wallet (or EOA as fallback)
    const res = await fetch(`${MCP_URL}/tools/get_pm_live_positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: proxyWallet }),
    });

    if (!res.ok) {
      console.error(`[PM] MCP returned ${res.status}`);
      return NextResponse.json({ success: false, error: `MCP error: ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    console.log(`[PM] Found ${data.totalPositions || 0} positions for proxy ${proxyWallet}`);
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    console.error('[PM] Error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
