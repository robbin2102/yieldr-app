// app/api/lp-positions/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const address = searchParams.get('address');
    
    if (!address) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    // Fetch LP positions from DeFi Krystal API
    // Chain IDs: 1 (Ethereum), 8453 (Base)
    const chainIds = '1,8453';
    const url = `https://api.krystal.app/all/v1/lp/userPositions?addresses=${address}&chainIds=${chainIds}`;
    
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Krystal API error: ${response.status}`);
    }

    const data = await response.json();

    // Parse and transform the data
    const parsedData = {
      summary: {
        totalOpenPositions: data.statsByChain?.all?.openPositionCount || 0,
        totalClosedPositions: data.statsByChain?.all?.closedPositionCount || 0,
        totalPnL: data.statsByChain?.all?.pnl || 0,
        totalROI: data.statsByChain?.all?.returnOnInvestment || 0,
        totalAPR: data.statsByChain?.all?.apr || 0,
        unclaimedFees: data.statsByChain?.all?.unclaimedFees || 0,
        totalFeeEarned: data.statsByChain?.all?.totalFeeEarned || 0,
        currentPositionValue: data.statsByChain?.all?.currentPositionValue || 0,
        initialValue: data.statsByChain?.all?.initialUnderlyingValue || 0,
      },
      byChain: {
        ethereum: data.statsByChain?.['1'] || null,
        base: data.statsByChain?.['8453'] || null,
      },
      positions: data.positions?.map((pos: any) => ({
        id: pos.id,
        chain: pos.chainName,
        protocol: pos.pool?.project || 'Unknown',
        status: pos.status,
        tokens: pos.currentAmounts?.map((amt: any) => ({
          symbol: amt.token.symbol,
          balance: amt.balance,
          value: amt.quotes.usd.value,
          price: amt.quotes.usd.price,
        })) || [],
        metrics: {
          pnl: pos.pnl,
          roi: pos.returnOnInvestment,
          apr: pos.apr,
          currentValue: pos.currentPositionValue,
          initialValue: pos.initialUnderlyingValue,
          unclaimedFees: pos.feePending?.reduce((sum: number, fee: any) => 
            sum + (fee.quotes.usd.value || 0), 0) || 0,
          impermanentLoss: pos.impermanentLoss,
        },
        pool: {
          address: pos.pool?.poolAddress,
          price: pos.pool?.price,
          tvl: pos.pool?.tvl,
          fees: pos.pool?.fees,
        },
        priceRange: {
          min: pos.minPrice,
          max: pos.maxPrice,
          current: pos.pool?.price,
        },
        timing: {
          opened: pos.openedTime,
          lastUpdate: pos.lastUpdateBlock,
        },
      })) || [],
    };

    return NextResponse.json({
      success: true,
      data: parsedData,
    });

  } catch (error: any) {
    console.error('Error fetching LP positions:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch LP positions',
        details: error.message 
      },
      { status: 500 }
    );
  }
}
