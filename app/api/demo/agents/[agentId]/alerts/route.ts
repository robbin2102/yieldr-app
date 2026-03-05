import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import MonitoringAlert from '@/models/MonitoringAlert';

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await connectDB();

    const { agentId } = await context.params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '30', 10), 100);

    const alerts = await MonitoringAlert.find({ agentId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const formatted = (alerts as any[]).map((a) => ({
      id: a._id.toString(),
      taskId: a.taskId.toString(),
      agentId: a.agentId,
      title: a.title,
      message: a.message,
      severity: a.severity,
      data: a.data || {},
      cycleNumber: a.cycleNumber,
      read: a.read,
      createdAt: a.createdAt,
    }));

    return NextResponse.json({ alerts: formatted, total: formatted.length });
  } catch (error) {
    console.error('Error fetching agent alerts:', error);
    return NextResponse.json({ error: 'Failed to fetch alerts' }, { status: 500 });
  }
}
