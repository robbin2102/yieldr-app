import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');
    
    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address required' },
        { status: 400 }
      );
    }

    // Call DeFi Krystal API
    const krystalApiUrl = `https://api.krystal.app/v1/lp/userPositions?userAddress=${walletAddress}&chains=base,ethereum`;
    
    console.log('Fetching LP positions from Krystal:', krystalApiUrl);
    
    const response = await fetch(krystalApiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      throw new Error(`Krystal API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    console.log('Krystal API response:', JSON.stringify(data, null, 2));

    // Transform Krystal response to our format
    const positions = data.data?.positions || [];
    
    const formattedPositions = positions.map((pos: any) => ({
      platform: pos.platform || pos.protocol,
      pool: pos.pool || `${pos.token0?.symbol}-${pos.token1?.symbol}`,
      chain: pos.chain,
      liquidity: parseFloat(pos.liquidityUSD || pos.positionValue || 0),
      token0: pos.token0?.symbol,
      token1: pos.token1?.symbol,
      pnl: parseFloat(pos.pnl || 0),
      roi: parseFloat(pos.roi || 0),
      apr: parseFloat(pos.apr || 0),
      status: pos.status || 'active'
    }));

    const totalLiquidity = formattedPositions.reduce((sum: number, pos: any) => sum + pos.liquidity, 0);
    const totalPnL = formattedPositions.reduce((sum: number, pos: any) => sum + pos.pnl, 0);

    return NextResponse.json({
      success: true,
      data: {
        totalPositions: formattedPositions.length,
        positions: formattedPositions,
        summary: {
          totalLiquidity,
          totalPnL,
          avgROI: formattedPositions.length > 0 
            ? formattedPositions.reduce((sum: number, pos: any) => sum + pos.roi, 0) / formattedPositions.length 
            : 0
        }
      }
    });
    
  } catch (error: any) {
    console.error('Error fetching LP positions:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error.message,
        data: {
          totalPositions: 0,
          positions: [],
          summary: { totalLiquidity: 0, totalPnL: 0, avgROI: 0 }
        }
      },
      { status: 500 }
    );
  }
}
