import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoringAlert from '@/models/MonitoringAlert';
import Agent from '@/models/Agent';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');
    const since = searchParams.get('since');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);

    if (!wallet) {
      return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
    }

    const query: Record<string, any> = { userId: wallet.toLowerCase() };
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        query.createdAt = { $gte: sinceDate };
      }
    }

    const [alerts, unreadCount, agents] = await Promise.all([
      MonitoringAlert.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      MonitoringAlert.countDocuments({ userId: wallet.toLowerCase(), read: false }),
      Agent.find({ ownerWallet: wallet.toLowerCase() }, { agentId: 1, name: 1 }).lean(),
    ]);

    const agentNameMap: Record<string, string> = {};
    for (const a of agents as any[]) {
      agentNameMap[a.agentId] = a.name;
    }

    const formatted = (alerts as any[]).map((a) => ({
      id: a._id.toString(),
      taskId: a.taskId.toString(),
      agentId: a.agentId,
      agentName: agentNameMap[a.agentId] || null,
      title: a.title,
      message: a.message,
      severity: a.severity,
      data: a.data || {},
      createdAt: a.createdAt,
      read: a.read,
    }));

    return NextResponse.json({ alerts: formatted, unreadCount });
  } catch (error) {
    console.error('Error fetching alerts:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}
