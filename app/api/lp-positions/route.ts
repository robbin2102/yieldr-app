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

    // Normalize address
    const normalizedAddress = walletAddress.toLowerCase();

    // Krystal API endpoint
    const krystalApiUrl = `https://api.krystal.app/all/v1/lp/userPositions?addresses=${normalizedAddress}&chainIds=8453`;
    
    console.log('Fetching LP positions from Krystal:', krystalApiUrl);
    
    const response = await fetch(krystalApiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Yieldr/1.0; +https://app.yieldr.org)',
        'Origin': 'https://app.yieldr.org',
        'Referer': 'https://app.yieldr.org/'
      }
    });

    if (!response.ok) {
      console.error('Krystal API error:', response.status, response.statusText);
      throw new Error(`Krystal API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    console.log('Krystal API response positions count:', data.positions?.length || 0);

    // Extract positions from response
    const positions = data.positions || [];
    const stats = data.statsByChain?.all || data.statsByChain?.[8453] || {};
    
    // Format positions for our app
    const formattedPositions = positions.map((pos: any) => {
      const token0 = pos.currentAmounts?.[0]?.token;
      const token1 = pos.currentAmounts?.[1]?.token;
      
      const liquidity = pos.currentAmounts?.reduce((sum: number, amount: any) => {
        return sum + (amount.quotes?.usd?.value || 0);
      }, 0) || 0;

      const platform = pos.pool?.project || pos.pool?.projectKey || 'Unknown';

      return {
        platform: platform,
        pair: `${token0?.symbol || '?'}/${token1?.symbol || '?'}`,
        token0: {
          symbol: token0?.symbol || '',
          amount: pos.currentAmounts?.[0]?.balance || '0',
          value: pos.currentAmounts?.[0]?.quotes?.usd?.value || 0
        },
        token1: {
          symbol: token1?.symbol || '',
          amount: pos.currentAmounts?.[1]?.balance || '0',
          value: pos.currentAmounts?.[1]?.quotes?.usd?.value || 0
        },
        liquidity: liquidity,
        pnl: pos.pnl || 0,
        roi: pos.returnOnInvestment || 0,
        apr: pos.apr || 0,
        status: pos.status || 'UNKNOWN',
        unclaimedFees: pos.feePending?.reduce((sum: number, fee: any) => 
          sum + (fee.quotes?.usd?.value || 0), 0) || 0,
        protocol: platform,
        positionId: pos.id
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        totalPositions: positions.length,
        positions: formattedPositions,
        summary: {
          totalLiquidity: stats.currentPositionValue || 0,
          totalPnL: stats.pnl || 0,
          avgROI: stats.returnOnInvestment || 0,
          unclaimedFees: stats.unclaimedFees || 0,
          apr: stats.apr || 0,
          openPositions: stats.openPositionCount || 0
        }
      }
    });

  } catch (error: any) {
    console.error('Error fetching LP positions:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: error.message || 'Failed to fetch LP positions',
        data: {
          totalPositions: 0,
          positions: [],
          summary: {
            totalLiquidity: 0,
            totalPnL: 0,
            avgROI: 0
          }
        }
      },
      { status: 500 }
    );
  }
}
