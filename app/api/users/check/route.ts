import { NextRequest, NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function POST(request: NextRequest) {
  try {
    const { walletAddress } = await request.json();

    if (!walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Wallet address is required' },
        { status: 400 }
      );
    }

    const client = await clientPromise;
    const db = client.db('yieldr');

    // Check if user exists
    const user = await db.collection('users').findOne({
      walletAddress: walletAddress.toLowerCase()
    });

    if (user) {
      return NextResponse.json({
        success: true,
        exists: true,
        user: {
          walletAddress: user.walletAddress,
          role: user.role,
          status: user.status
        }
      });
    }

    return NextResponse.json({
      success: true,
      exists: false
    });

  } catch (error: any) {
    console.error('Error checking user:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
