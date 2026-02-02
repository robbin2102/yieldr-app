import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';

/**
 * GET /api/usage/[walletAddress]
 * Returns token usage stats for a wallet: lifetime, current month, and recent sessions.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ walletAddress: string }> }
) {
  try {
    const { walletAddress } = await params;
    if (!walletAddress) {
      return new Response(JSON.stringify({ error: 'Wallet address required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const wallet = walletAddress.toLowerCase();
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) {
      return new Response(JSON.stringify({ error: 'DB not connected' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Fetch user usage and recent sessions in parallel
    const [userUsage, recentSessions] = await Promise.all([
      db.collection('user_usage').findOne({ walletAddress: wallet }),
      db.collection('chatSessions')
        .find(
          { walletAddress: wallet, 'tokenUsage.totalInputTokens': { $gt: 0 } },
          { projection: { title: 1, 'tokenUsage.totalInputTokens': 1, 'tokenUsage.totalOutputTokens': 1, 'tokenUsage.totalCost': 1, 'tokenUsage.messageCount': 1, createdAt: 1 } }
        )
        .sort({ updatedAt: -1 })
        .limit(20)
        .toArray(),
    ]);

    const lifetime = userUsage?.lifetime || { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, totalMessages: 0, totalToolCalls: 0 };
    const currentMonth = userUsage?.monthly?.[monthKey] || { inputTokens: 0, outputTokens: 0, cost: 0, messages: 0 };

    return new Response(JSON.stringify({
      success: true,
      data: {
        walletAddress: wallet,
        lifetime,
        currentMonth,
        recentSessions: recentSessions.map(s => ({
          id: s._id,
          title: s.title,
          inputTokens: s.tokenUsage?.totalInputTokens || 0,
          outputTokens: s.tokenUsage?.totalOutputTokens || 0,
          cost: s.tokenUsage?.totalCost || 0,
          messages: s.tokenUsage?.messageCount || 0,
          createdAt: s.createdAt,
        })),
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[usage] Error:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
