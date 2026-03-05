import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoringTaskLog from '@/models/MonitoringTaskLog';

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await connectDB();

    const { agentId } = await context.params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);

    const logs = await MonitoringTaskLog.find({ agentId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const formatted = (logs as any[]).map((l) => ({
      id: l._id.toString(),
      taskId: l.taskId.toString(),
      agentId: l.agentId,
      timestamp: l.timestamp,
      summary: l.summary,
      alerted: l.alerted,
      alertId: l.alertId ? l.alertId.toString() : null,
      data: l.data || {},
      error: l.error || null,
    }));

    return NextResponse.json({ logs: formatted, total: formatted.length });
  } catch (error) {
    console.error('Error fetching agent logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}
