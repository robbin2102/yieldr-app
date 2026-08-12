import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import { EdgeChatMessage } from '@/models/EdgeChatMessage';

const COMING_SOON_REPLY =
  "Grounded chat is still in dev - I'm just pushing analysis insights into this feed for now. Full Q&A over your trades is coming soon.";

export async function POST(req: NextRequest) {
  const { wallet, message } = await req.json();

  if (!wallet || !message) {
    return NextResponse.json({ error: 'wallet and message are required' }, { status: 400 });
  }

  await connectDB();
  await EdgeChatMessage.create({ wallet, role: 'user', message });
  await EdgeChatMessage.create({ wallet, role: 'agent', message: COMING_SOON_REPLY });

  return NextResponse.json({ reply: COMING_SOON_REPLY });
}
