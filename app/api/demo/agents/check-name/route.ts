import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';

/**
 * GET /api/demo/agents/check-name?name=AlphaHunter
 * Returns whether the agent name is already taken.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const name = request.nextUrl.searchParams.get('name');
    if (!name) {
      return NextResponse.json({ error: 'Name required' }, { status: 400 });
    }

    const existing = await Agent.findOne({ name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } });
    return NextResponse.json({ available: !existing });
  } catch (error) {
    console.error('Error checking name:', error);
    return NextResponse.json({ error: 'Failed to check name' }, { status: 500 });
  }
}
