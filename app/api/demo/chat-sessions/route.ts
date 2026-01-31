import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import ChatSession from '@/models/ChatSession';

// GET /api/demo/chat-sessions?wallet=0x...
// List all chat sessions for a wallet (most recent first)
export async function GET(request: NextRequest) {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet');
    if (!wallet) {
      return NextResponse.json({ success: false, error: 'wallet required' }, { status: 400 });
    }

    await connectDB();
    const sessions = await ChatSession.find({ walletAddress: wallet.toLowerCase() })
      .sort({ updatedAt: -1 })
      .select('_id title createdAt updatedAt messages')
      .lean();

    // Return sessions with message count and last message preview
    const result = sessions.map((s: any) => ({
      id: s._id.toString(),
      title: s.title,
      messageCount: s.messages?.length || 0,
      lastMessage: s.messages?.length > 0
        ? s.messages[s.messages.length - 1].content.slice(0, 100)
        : '',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return NextResponse.json({ success: true, sessions: result });
  } catch (error: any) {
    console.error('[chat-sessions] GET error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/demo/chat-sessions
// Create a new chat session
export async function POST(request: NextRequest) {
  try {
    const { wallet, title, messages } = await request.json();
    if (!wallet) {
      return NextResponse.json({ success: false, error: 'wallet required' }, { status: 400 });
    }

    await connectDB();
    const session = await ChatSession.create({
      walletAddress: wallet.toLowerCase(),
      title: title || 'New Chat',
      messages: messages || [],
    });

    return NextResponse.json({
      success: true,
      session: {
        id: session._id.toString(),
        title: session.title,
        walletAddress: session.walletAddress,
        createdAt: session.createdAt,
      },
    });
  } catch (error: any) {
    console.error('[chat-sessions] POST error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
