import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import ChatSession from '@/models/ChatSession';

// GET /api/demo/chat-sessions/[id]
// Get a single chat session with all messages
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await connectDB();
    const session = await ChatSession.findById(id).lean();

    if (!session) {
      return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      session: {
        id: (session as any)._id.toString(),
        walletAddress: (session as any).walletAddress,
        title: (session as any).title,
        messages: (session as any).messages,
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
