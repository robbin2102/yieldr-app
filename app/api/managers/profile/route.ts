import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const username = searchParams.get('username');
    const walletAddress = searchParams.get('walletAddress');

    if (!username && !walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Username or wallet address is required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');
    
    let manager;

    if (walletAddress) {
      // Search by wallet address (lowercase for consistency)
      manager = await db.collection('managers').findOne({ 
        walletAddress: walletAddress.toLowerCase() 
      });
      console.log('GET by walletAddress:', walletAddress, 'Found:', !!manager);
    } else if (username) {
      // Search by username (lowercase for consistency)
      manager = await db.collection('managers').findOne({ 
        username: username.toLowerCase() 
      });
      console.log('GET by username:', username, 'Found:', !!manager);
    }

    if (!manager) {
      return NextResponse.json(
        { success: false, error: 'Manager not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: manager
    });

  } catch (error: any) {
    console.error('Error fetching manager profile:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const data = await request.json();

    if (!data.username || !data.walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Username and wallet address are required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    const newManager = {
      username: data.username,
      walletAddress: data.walletAddress.toLowerCase(),
      wallets: [data.walletAddress.toLowerCase()],
      profilePicture: data.profilePicture,
      tradingTypes: data.tradingTypes || [],
      topAssets: data.topAssets || [],
      capitalRange: data.capitalRange,
      fees: data.fees,
      totalEarnings: 0,
      coInvestorsCount: 0,
      metrics: data.metrics || {},
      marketOutlook: data.marketOutlook || '',
      investmentThesis: data.investmentThesis || '',
      positionStrategy: data.positionStrategy || '',
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'active'
    };

    await db.collection('managers').insertOne(newManager);

    return NextResponse.json({
      success: true,
      data: newManager
    });

  } catch (error: any) {
    console.error('Error creating manager profile:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const data = await request.json();

    if (!data.username) {
      return NextResponse.json(
        { success: false, error: 'Username is required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    const updates: any = {
      updatedAt: new Date()
    };

    if (data.fees !== undefined) updates.fees = data.fees;
    if (data.marketOutlook !== undefined) updates.marketOutlook = data.marketOutlook;
    if (data.investmentThesis !== undefined) updates.investmentThesis = data.investmentThesis;
    if (data.positionStrategy !== undefined) updates.positionStrategy = data.positionStrategy;
    if (data.metrics !== undefined) updates.metrics = data.metrics;
    if (data.totalEarnings !== undefined) updates.totalEarnings = data.totalEarnings;
    if (data.coInvestorsCount !== undefined) updates.coInvestorsCount = data.coInvestorsCount;
    if (data.lastFeeUpdate !== undefined) updates.lastFeeUpdate = new Date(data.lastFeeUpdate);

    const result = await db.collection('managers').updateOne(
      { username: data.username },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return NextResponse.json(
        { success: false, error: 'Manager not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Manager profile updated'
    });

  } catch (error: any) {
    console.error('Error updating manager profile:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
