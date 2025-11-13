import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();
    const { walletAddress, lpPositions, avantisPositions, hyperliquidPositions, metrics } = data;

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Fetch existing positions to preserve their createdAt timestamps
    const existingPositions = await db.collection('positions')
      .find({ walletAddress: walletAddress.toLowerCase() })
      .toArray();

    // Create a map of existing positions by unique key (platform + positionId)
    const existingMap = new Map();
    existingPositions.forEach((pos: any) => {
      const key = `${pos.platform}-${pos.positionId}`;
      existingMap.set(key, pos.createdAt || new Date());
    });

    // Helper function to get createdAt (preserve existing or use current time)
    const getCreatedAt = (platform: string, positionId: string) => {
      const key = `${platform}-${positionId}`;
      return existingMap.get(key) || new Date();
    };

    // FIXED: Delete only old positions for THIS wallet, not all positions
    await db.collection('positions').deleteMany({
      walletAddress: walletAddress.toLowerCase()
    });

    // Prepare positions for storage
    const allPositions = [
      ...lpPositions.map((pos: any) => ({
        walletAddress: walletAddress.toLowerCase(),
        type: 'LP',
        platform: pos.platform || 'Unknown',
        pool: pos.pool,
        chain: pos.chain,
        liquidity: pos.liquidity,
        token0: pos.token0,
        token1: pos.token1,
        pnl: pos.pnl,
        roi: pos.roi,
        apr: pos.apr,
        status: pos.status,
        positionId: pos.positionId,
        unclaimedFees: pos.unclaimedFees || 0,
        createdAt: getCreatedAt(pos.platform || 'Unknown', pos.positionId),
        updatedAt: new Date()
      })),
      ...avantisPositions.map((pos: any) => ({
        walletAddress: walletAddress.toLowerCase(),
        type: 'PERP',
        platform: 'Avantis',
        pair: pos.asset,
        direction: pos.direction,
        leverage: pos.leverage,
        positionSize: pos.positionSize,
        margin: pos.margin,
        entryPrice: pos.entryPrice,
        currentPrice: pos.currentPrice,  // ADDED: Store current price from Python service
        liquidationPrice: pos.liquidationPrice,
        pnl: pos.pnl,
        roi: pos.roi,
        status: 'active',
        positionId: pos.tradeIndex,
        createdAt: getCreatedAt('Avantis', pos.tradeIndex),
        updatedAt: new Date()
      })),

    ...(hyperliquidPositions || []).map((pos: any) => ({
      walletAddress: walletAddress.toLowerCase(),
      type: 'PERP',
      platform: 'Hyperliquid',
      pair: pos.pair,
      direction: pos.direction,
      leverage: pos.leverage,
      positionSize: pos.positionSize,
      margin: pos.margin,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      liquidationPrice: pos.liquidationPrice,
      pnl: pos.pnl,
      roi: pos.roi,
      status: pos.status || 'active',
      positionId: pos.positionId,
      createdAt: getCreatedAt('Hyperliquid', pos.positionId),
      updatedAt: new Date(),
    }))
    ];

    // Insert all positions
    if (allPositions.length > 0) {
      await db.collection('positions').insertMany(allPositions);
    }

    // Update user metrics
    await db.collection('users').updateOne(
      { walletAddress: walletAddress.toLowerCase() },
      { 
        $set: {
          metrics: {
            totalPnL30d: metrics.totalPnL,
            roi30d: metrics.totalROI,
            totalAUM: metrics.totalAUM,
            totalPositions: allPositions.length,
            lpPositions: lpPositions.length,
            perpPositions: avantisPositions.length + (hyperliquidPositions || []).length,
            avantisPositions: avantisPositions.length,
            hyperliquidPositions: (hyperliquidPositions || []).length,

            lastUpdated: new Date()
          },
          updatedAt: new Date()
        }
      }
    );

    console.log(`Saved ${allPositions.length} positions for wallet:`, walletAddress);
    console.log(`  ├─ LP positions: ${lpPositions.length}`);
    console.log(`  ├─ Avantis positions: ${avantisPositions.length}`);
    console.log(`  └─ Hyperliquid positions: ${(hyperliquidPositions || []).length}`);

    return NextResponse.json({
      success: true,
      message: 'Positions saved successfully',
      data: {
        totalPositions: allPositions.length,
        lpPositions: lpPositions.length,
        perpPositions: avantisPositions.length
      }
    });

  } catch (error: any) {
    console.error('Error saving positions:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Fetch all positions for this wallet
    const positions = await db.collection('positions')
      .find({ walletAddress: walletAddress.toLowerCase() })
      .sort({ updatedAt: -1 })
      .toArray();

    // Separate by type
    const lpPositions = positions.filter(p => p.type === 'LP');
    const perpPositions = positions.filter(p => p.type === 'PERP');

    // Calculate metrics
    const totalPnL = positions.reduce((sum, pos) => sum + (pos.pnl || 0), 0);
    const totalAUM = lpPositions.reduce((sum, pos) => sum + (pos.liquidity || 0), 0) +
                     perpPositions.reduce((sum, pos) => sum + (pos.margin || 0), 0);
    const totalROI = totalAUM > 0 ? (totalPnL / totalAUM * 100) : 0;

    return NextResponse.json({
      success: true,
      data: {
        lpPositions,
        perpPositions,
        totalPositions: positions.length,
        metrics: {
          totalPnL,
          totalAUM,
          totalROI
        }
      }
    });

  } catch (error: any) {
    console.error('Error fetching positions:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
