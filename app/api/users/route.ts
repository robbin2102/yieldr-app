import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/models/User';

export async function POST(request: NextRequest) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    console.log('📝 Received wallet address:', walletAddress);

    // Connect to MongoDB
    await connectDB();

    // Check if user exists
    let user = await User.findOne({ 
      walletAddress: walletAddress.toLowerCase() 
    });

    if (!user) {
      // Create new user with required fields
      user = await User.create({
        walletAddress: walletAddress.toLowerCase(),
        role: 'manager', // Required by validation schema
        status: 'active',
        createdAt: new Date(), // Explicit Date object
      });
      console.log('✅ New user created in MongoDB:', user.walletAddress);
    } else {
      console.log('✅ Existing user found:', user.walletAddress);
    }

    return NextResponse.json({
      success: true,
      message: user.isNew ? 'User created' : 'User found',
      user: {
        id: user._id.toString(),
        walletAddress: user.walletAddress,
        role: user.role,
        status: user.status,
        username: user.username,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    console.error('❌ Error in user registration:', error);
    
    // Better error messages
    if (error.code === 'ENOTFOUND') {
      return NextResponse.json(
        { error: 'Cannot connect to MongoDB' },
        { status: 503 }
      );
    }
    
    if (error.code === 121) {
      return NextResponse.json(
        { error: 'Validation error: ' + error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error: ' + error.message },
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
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    await connectDB();

    const user = await User.findOne({ 
      walletAddress: walletAddress.toLowerCase() 
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user._id.toString(),
        walletAddress: user.walletAddress,
        role: user.role,
        status: user.status,
        username: user.username,
      },
    });
  } catch (error: any) {
    console.error('❌ Error fetching user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
