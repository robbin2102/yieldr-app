import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';
import MonitoringTask from '@/models/MonitoringTask';
import MonitoringAlert from '@/models/MonitoringAlert';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  try {
    const { agentId } = await params;
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet')?.toLowerCase();

    if (!agentId) {
      return NextResponse.json({ error: 'agentId required' }, { status: 400 });
    }

    await connectDB();

    // Fetch agent
    const agentQuery: any = { agentId };
    if (wallet) agentQuery.ownerWallet = wallet;
    const agent = await Agent.findOne(agentQuery).lean();
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Fetch monitoring task(s) for this agent
    const tasks = await MonitoringTask.find(
      { agentId },
      {
        task: 1, monitorInstruction: 1, alphaTitle: 1, alphaDescription: 1,
        tools: 1, intervalSeconds: 1,
        status: 1, nextRunAt: 1, lastRunAt: 1, alertCount: 1, cycleCount: 1,
        cycleHistory: 1, createdAt: 1,
      }
    ).sort({ createdAt: -1 }).limit(10).lean();

    // Primary task (most recent active, or first)
    const primaryTask = (tasks.find((t: any) => t.status === 'active') ?? tasks[0]) as any;

    // Build per-task alpha + latestRead for Section 01 (replaces old Current Market Read)
    // Only include active (and error) monitors — exclude paused ones
    const taskAlphas = tasks.filter((t: any) => t.status !== 'paused').map((t: any) => {
      let latestRead: { timestamp: string | null; summary: string | null; indicators: any[] } = {
        timestamp: null, summary: null, indicators: [],
      };
      if (t.cycleHistory?.length) {
        const last = t.cycleHistory[t.cycleHistory.length - 1];
        latestRead = {
          timestamp: last.timestamp ? new Date(last.timestamp).toISOString() : null,
          summary: last.summary ?? null,
          indicators: last.indicators ?? [],
        };
      }
      return {
        id: String(t._id),
        title: t.task,
        alphaTitle: t.alphaTitle ?? null,
        alphaDescription: t.alphaDescription ?? null,
        intervalSeconds: t.intervalSeconds,
        status: t.status,
        nextRunAt: t.nextRunAt,
        lastRunAt: t.lastRunAt ?? null,
        cycleCount: t.cycleCount || 0,
        alertCount: t.alertCount || 0,
        latestRead,
      };
    });

    // Fetch signals & alerts for this agent (most recent 20)
    const signals = await MonitoringAlert.find(
      { agentId },
      { title: 1, message: 1, severity: 1, isSignal: 1, indicators: 1, cycleNumber: 1, read: 1, createdAt: 1 }
    ).sort({ createdAt: -1 }).limit(20).lean();

    // Aggregate stats across all tasks
    const totalCycles = tasks.reduce((sum: number, t: any) => sum + (t.cycleCount || 0), 0);
    const totalAlerts = tasks.reduce((sum: number, t: any) => sum + (t.alertCount || 0), 0);
    const signalCount = (signals as any[]).filter((s: any) => s.isSignal).length;

    return NextResponse.json({
      agent: {
        agentId: (agent as any).agentId,
        name: (agent as any).name,
        ownerWallet: (agent as any).ownerWallet,
        markets: (agent as any).markets,
        status: (agent as any).status,
        alertsSent: (agent as any).alertsSent ?? 0,
        insightsGenerated: (agent as any).insightsGenerated ?? 0,
        createdAt: (agent as any).createdAt,
      },
      task: primaryTask ? {
        id: String(primaryTask._id),
        title: primaryTask.task,
        alphaTitle: primaryTask.alphaTitle ?? null,
        alphaDescription: primaryTask.alphaDescription ?? null,
        intervalSeconds: primaryTask.intervalSeconds,
        status: primaryTask.status,
        nextRunAt: primaryTask.nextRunAt,
        lastRunAt: primaryTask.lastRunAt ?? null,
        cycleCount: totalCycles,
        alertCount: totalAlerts,
        signalCount,
        createdAt: primaryTask.createdAt,
      } : null,
      // All tasks with per-task alpha + latestRead (powers Alpha Intelligence section)
      taskAlphas,
      // Legacy latestRead from primary task (kept for backwards compat)
      latestRead: taskAlphas[0]?.latestRead ?? { timestamp: null, summary: null, indicators: [] },
      signals: (signals as any[]).map((s: any) => ({
        id: String(s._id),
        title: s.title,
        message: s.message,
        severity: s.severity,
        isSignal: s.isSignal ?? false,
        indicators: s.indicators ?? [],
        cycleNumber: s.cycleNumber,
        read: s.read,
        createdAt: s.createdAt,
      })),
    });
  } catch (err: any) {
    console.error('[agents/detail] GET error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
