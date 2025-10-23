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

    // Correct DefiKrystal API endpoint
    const krystalApiUrl = `https://api.krystal.app/all/v1/lp/userPositions?addresses=${walletAddress}&chainIds=8453,1`;
    
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

      // FIXED: Extract platform from correct location
      const platform = pos.pool?.project || pos.pool?.projectKey || 'Unknown';

      return {
        platform: platform, // Now correctly extracted
        pool: `${token0?.symbol || '?'}-${token1?.symbol || '?'}`,
        chain: pos.chainName || 'base',
        liquidity: liquidity,
        token0: token0?.symbol,
        token1: token1?.symbol,
        pnl: pos.pnl || 0,
        roi: pos.returnOnInvestment || 0,
        apr: pos.apr || 0,
        status: pos.status || 'active',
        positionId: pos.id,
        minPrice: pos.minPrice,
        maxPrice: pos.maxPrice,
        unclaimedFees: pos.unclaimedFees || 0
      };
    });

    const totalLiquidity = stats.currentLiquidityValue || formattedPositions.reduce((sum: number, pos: any) => sum + pos.liquidity, 0);
    const totalPnL = stats.pnl || formattedPositions.reduce((sum: number, pos: any) => sum + pos.pnl, 0);
    const avgROI = stats.returnOnInvestment || 0;

    console.log('Formatted LP positions:', formattedPositions.length);

    return NextResponse.json({
      success: true,
      data: {
        totalPositions: stats.openPositionCount || formattedPositions.length,
        positions: formattedPositions,
        summary: {
          totalLiquidity,
          totalPnL,
          avgROI,
          totalFeeEarned: stats.totalFeeEarned || 0,
          unclaimedFees: stats.unclaimedFees || 0,
          apr: stats.apr || 0
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
