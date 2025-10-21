import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/models/User';

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    
    const { walletAddress, userType } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    // Check if user exists
    let user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });
    
    if (!user) {
      // Create new user
      user = await User.create({
        walletAddress: walletAddress.toLowerCase(),
        role: userType || 'manager',
        status: 'active'
      });
      
      console.log('✅ New user created:', walletAddress);
    } else {
      // Update last login
      user.updatedAt = new Date();
      await user.save();
      
      console.log('✅ User logged in:', walletAddress);
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user._id,
        walletAddress: user.walletAddress,
        role: user.role,
        username: user.username,
        status: user.status,
        createdAt: user.createdAt
      }
    });
  } catch (error: any) {
    console.error('❌ Error in user registration:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    const { searchParams } = new URL(request.url);
    const walletAddress = searchParams.get('address');

    if (!walletAddress) {
      return NextResponse.json(
        { error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const user = await User.findOne({ walletAddress: walletAddress.toLowerCase() });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user._id,
        walletAddress: user.walletAddress,
        role: user.role,
        username: user.username,
        status: user.status,
        createdAt: user.createdAt
      }
    });
  } catch (error: any) {
    console.error('❌ Error fetching user:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}
