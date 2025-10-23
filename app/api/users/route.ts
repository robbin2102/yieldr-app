import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function POST(request: NextRequest) {
  try {
    const { walletAddress, role = 'manager', status = 'pending_verification' } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Normalize wallet address to lowercase
    const normalizedAddress = walletAddress.toLowerCase();

    // Check if user already exists
    const existingUser = await db.collection('users').findOne({
      walletAddress: normalizedAddress
    });

    if (existingUser) {
      console.log('User already exists:', normalizedAddress);
      return NextResponse.json({
        success: true,
        message: 'User already exists',
        user: existingUser
      });
    }

    // Create new user
    const newUser = {
      walletAddress: normalizedAddress,
      role,
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
      metrics: {}
    };

    await db.collection('users').insertOne(newUser);

    console.log('User created successfully:', normalizedAddress);

    return NextResponse.json({
      success: true,
      message: 'User registered successfully',
      user: newUser
    });

  } catch (error: any) {
    console.error('Error in user registration:', error);
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
        { success: false, error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    const user = await db.collection('users').findOne({
      walletAddress: walletAddress.toLowerCase()
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user
    });

  } catch (error: any) {
    console.error('Error fetching user:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
