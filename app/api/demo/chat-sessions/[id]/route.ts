import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import ChatSession from '@/models/ChatSession';

// GET /api/demo/chat-sessions/[id]?limit=30&skip=0
// Get a single chat session. Supports pagination to avoid loading huge message arrays.
// - limit: max messages to return (default: all). When set, returns the LAST N messages.
// - skip: how many messages from the start to skip (for loading earlier batches)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const limitParam = request.nextUrl.searchParams.get('limit');
    const skipParam = request.nextUrl.searchParams.get('skip');

    await connectDB();
    const session = await ChatSession.findById(id).lean();

    if (!session) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    const allMessages: any[] = (session as any).messages || [];
    const totalMessages = allMessages.length;

    let messages = allMessages;
    let hasMore = false;

    if (limitParam) {
      const limit = Math.max(1, parseInt(limitParam, 10) || 30);
      // When no skip given, default to the last `limit` messages
      const skip = skipParam !== null
        ? Math.max(0, parseInt(skipParam, 10))
        : Math.max(0, totalMessages - limit);
      messages = allMessages.slice(skip, skip + limit);
      hasMore = skip > 0;
    }

    return NextResponse.json({
      success: true,
      session: {
        id: (session as any)._id.toString(),
        walletAddress: (session as any).walletAddress,
        title: (session as any).title,
        messages,
        totalMessages,
        hasMore,
        createdAt: (session as any).createdAt,
        updatedAt: (session as any).updatedAt,
      },
    });
  } catch (error: any) {
    console.error('[chat-sessions] GET by id error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// PATCH /api/demo/chat-sessions/[id]
// Append messages to a session or update title
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    await connectDB();

    const update: any = { updatedAt: new Date() };

    if (body.title) {
      update.title = body.title;
    }

    // Append new messages
    if (body.messages && Array.isArray(body.messages) && body.messages.length > 0) {
      const session = await ChatSession.findById(id);
      if (!session) {
        return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      for (const msg of body.messages) {
        session.messages.push({
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp || new Date(),
        });
      }

      if (body.title) session.title = body.title;
      await session.save();

      return NextResponse.json({
        success: true,
        session: {
          id: session._id.toString(),
          messageCount: session.messages.length,
        },
      });
    }

    // Title-only update
    const session = await ChatSession.findByIdAndUpdate(id, update, { new: true });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      session: {
        id: session._id.toString(),
        title: session.title,
      },
    });
  } catch (error: any) {
    console.error('[chat-sessions] PATCH error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE /api/demo/chat-sessions/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await connectDB();
    const session = await ChatSession.findByIdAndDelete(id);

    if (!session) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[chat-sessions] DELETE error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
