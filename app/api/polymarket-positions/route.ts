import { NextRequest, NextResponse } from 'next/server';

const PM_GAMMA_API = 'https://gamma-api.polymarket.com';
const PM_DATA_API = 'https://data-api.polymarket.com';

/**
 * GET /api/polymarket-positions?address=0x...
 *
 * 1. Resolves EOA -> proxy wallet via Polymarket profile API
 * 2. Fetches positions directly from Polymarket data-api (no MCP dependency)
 */
export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  if (!address) {
    return NextResponse.json({ success: false, error: 'Missing address parameter' }, { status: 400 });
  }

  try {
    // Step 1: Resolve proxy wallet from EOA
    let proxyWallet = address;
    try {
      console.log(`[PM] Looking up profile for EOA: ${address}`);
      const profileRes = await fetch(`${PM_GAMMA_API}/public-profile?address=${address}`, {
        headers: { 'Accept': 'application/json' },
      });
      console.log(`[PM] Profile API status: ${profileRes.status}`);
      if (profileRes.ok) {
        const profile = await profileRes.json();
        console.log(`[PM] Profile response keys: ${Object.keys(profile).join(', ')}`);
        if (profile.proxyWallet) {
          proxyWallet = profile.proxyWallet;
          console.log(`[PM] Resolved proxy wallet: ${address} -> ${proxyWallet}`);
        } else {
          console.log(`[PM] No proxyWallet in profile response`);
        }
      } else {
        const errText = await profileRes.text().catch(() => '');
        console.log(`[PM] Profile lookup failed (${profileRes.status}): ${errText.slice(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`[PM] Profile lookup error: ${e.message}`);
    }

    // Step 2: Fetch positions directly from Polymarket data-api
    const allPositions: any[] = [];
    let offset = 0;
    const limit = 500;

    while (true) {
      const url = `${PM_DATA_API}/positions?user=${proxyWallet}&limit=${limit}&offset=${offset}`;
      console.log(`[PM] Fetching positions: ${url}`);

      const posRes = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });

      if (!posRes.ok) {
        const errText = await posRes.text().catch(() => '');
        console.error(`[PM] Positions API error (${posRes.status}): ${errText.slice(0, 200)}`);
        break;
      }

      const data = await posRes.json();
      if (!Array.isArray(data) || data.length === 0) {
        console.log(`[PM] No more positions at offset ${offset}`);
        break;
      }

      allPositions.push(...data);
      console.log(`[PM] Fetched ${data.length} positions at offset ${offset}`);

      if (data.length < limit) break;
      offset += limit;
    }

    // Filter active positions (price between 0.1% and 99.9%)
    const activePositions = allPositions.filter((p: any) => {
      const curPrice = parseFloat(p.curPrice || '0');
      return curPrice >= 0.001 && curPrice <= 0.999;
    });

    console.log(`[PM] Total: ${allPositions.length}, Active: ${activePositions.length}`);

    // Map to simplified format
    const positions = activePositions.map((p: any) => ({
      conditionId: p.conditionId,
      title: p.title || 'Unknown Market',
      outcome: p.outcome || 'Unknown',
      size: parseFloat(p.size || '0'),
      avgPrice: parseFloat(p.avgPrice || '0'),
      currentPrice: parseFloat(p.curPrice || '0'),
      initialValue: parseFloat(p.initialValue || '0'),
      currentValue: parseFloat(p.currentValue || '0'),
      pnl: parseFloat(p.cashPnl || '0'),
      pnlPercent: parseFloat(p.percentPnl || '0'),
    }));

    const totalValue = positions.reduce((sum: number, p: any) => sum + p.currentValue, 0);
    const totalPnL = positions.reduce((sum: number, p: any) => sum + p.pnl, 0);

    return NextResponse.json({
      success: true,
      data: {
        wallet: proxyWallet.toLowerCase(),
        totalPositions: positions.length,
        positions,
        summary: {
          totalValue,
          totalPnL,
        },
      },
    });
  } catch (error: any) {
    console.error('[PM] Error:', error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
