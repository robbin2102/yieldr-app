import { NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';
import MonitoringTask from '@/models/MonitoringTask';
import MonitoringAlert from '@/models/MonitoringAlert';

export async function GET() {
  try {
    await connectDB();

    // All agents that have at least 1 active monitoring task
    const activeTasks = await MonitoringTask.find(
      { status: 'active' },
      { agentId: 1, userId: 1, task: 1, tools: 1, intervalSeconds: 1, status: 1,
        nextRunAt: 1, lastRunAt: 1, alertCount: 1, cycleCount: 1, createdAt: 1 }
    ).lean();

    if (!activeTasks.length) {
      return NextResponse.json({ agents: [] });
    }

    // Unique agentIds from active tasks
    const agentIds = [...new Set(activeTasks.map((t: any) => t.agentId).filter(Boolean))];

    // Fetch matching agents
    const agents = await Agent.find(
      { agentId: { $in: agentIds } },
      { agentId: 1, name: 1, ownerWallet: 1, markets: 1, status: 1,
        alertsSent: 1, insightsGenerated: 1, lastActiveAt: 1, createdAt: 1 }
    ).lean();

    // Latest signal per agentId
    const latestAlerts = await MonitoringAlert.find(
      { agentId: { $in: agentIds } },
      { agentId: 1, title: 1, message: 1, severity: 1, isSignal: 1, createdAt: 1 }
    ).sort({ createdAt: -1 }).lean();

    const latestByAgent: Record<string, any> = {};
    for (const a of latestAlerts) {
      if (!latestByAgent[(a as any).agentId]) latestByAgent[(a as any).agentId] = a;
    }

    // Group tasks by agentId
    const tasksByAgent: Record<string, any[]> = {};
    for (const t of activeTasks) {
      const key = (t as any).agentId;
      if (key) {
        if (!tasksByAgent[key]) tasksByAgent[key] = [];
        tasksByAgent[key].push(t);
      }
    }

    const result = agents.map((ag: any) => ({
      agentId: ag.agentId,
      name: ag.name,
      ownerWallet: ag.ownerWallet,
      markets: ag.markets ?? ['perps'],
      status: ag.status,
      alertsSent: ag.alertsSent ?? 0,
      insightsGenerated: ag.insightsGenerated ?? 0,
      lastActiveAt: ag.lastActiveAt ?? null,
      activeTasks: (tasksByAgent[ag.agentId] ?? []).map((t: any) => ({
        id: String(t._id),
        taskTitle: t.task,
        intervalSeconds: t.intervalSeconds,
        status: t.status,
        cycleCount: t.cycleCount ?? 0,
        alertCount: t.alertCount ?? 0,
        lastRunAt: t.lastRunAt ?? null,
      })),
      latestSignal: latestByAgent[ag.agentId]
        ? {
            id: String(latestByAgent[ag.agentId]._id),
            title: latestByAgent[ag.agentId].title,
            severity: latestByAgent[ag.agentId].severity,
            isSignal: latestByAgent[ag.agentId].isSignal,
            createdAt: latestByAgent[ag.agentId].createdAt,
          }
        : null,
    }));

    return NextResponse.json({ agents: result });
  } catch (error) {
    console.error('Error fetching all agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}
