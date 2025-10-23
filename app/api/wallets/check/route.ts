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
    const normalizedAddress = walletAddress.toLowerCase();

    // Check if wallet exists as primary wallet in users
    const userWithWallet = await db.collection('users').findOne({
      walletAddress: normalizedAddress
    });

    // Check if wallet exists in any manager's wallets array
    const managerWithWallet = await db.collection('managers').findOne({
      wallets: normalizedAddress
    });

    if (userWithWallet || managerWithWallet) {
      const owner = userWithWallet || managerWithWallet;
      return NextResponse.json({
        success: false,
        inUse: true,
        message: 'This wallet is already connected to another account',
        owner: {
          username: owner.username,
          walletAddress: owner.walletAddress
        }
      });
    }

    return NextResponse.json({
      success: true,
      inUse: false,
      message: 'Wallet is available'
    });

  } catch (error: any) {
    console.error('Error checking wallet:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
