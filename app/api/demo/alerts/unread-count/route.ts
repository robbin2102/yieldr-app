import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoringAlert from '@/models/MonitoringAlert';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
    }

    const unreadCount = await MonitoringAlert.countDocuments({
      userId: wallet.toLowerCase(),
      read: false,
    });

    return NextResponse.json({ unreadCount });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    return NextResponse.json({ error: 'Failed to fetch unread count' }, { status: 500 });
  }
}
