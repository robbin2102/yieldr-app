import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';
import MonitoringTask from '@/models/MonitoringTask';
import MonitoringAlert from '@/models/MonitoringAlert';
import MonitoringTaskLog from '@/models/MonitoringTaskLog';

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await connectDB();

    const { agentId } = await context.params;

    const agent = await Agent.findOne({ agentId }).lean() as any;
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const [tasks, alerts, logs] = await Promise.all([
      MonitoringTask.find({ agentId }).sort({ createdAt: -1 }).lean(),
      MonitoringAlert.find({ agentId })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      MonitoringTaskLog.find({ agentId })
        .sort({ timestamp: -1 })
        .limit(50)
        .lean(),
    ]);

    return NextResponse.json({
      agent: {
        agentId: agent.agentId,
        name: agent.name,
        status: agent.status,
        markets: agent.markets,
        goals: agent.goals || [],
        alertsSent: agent.alertsSent || 0,
        insightsGenerated: agent.insightsGenerated || 0,
        lastActiveAt: agent.lastActiveAt || null,
        portfolioSummary: agent.portfolioSummary,
        followedTraders: agent.followedTraders || [],
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
      tasks: (tasks as any[]).map((t) => ({
        id: t._id.toString(),
        task: t.task,
        monitorInstruction: t.monitorInstruction,
        tools: t.tools,
        intervalSeconds: t.intervalSeconds,
        status: t.status,
        nextRunAt: t.nextRunAt,
        lastRunAt: t.lastRunAt || null,
        lastAlertAt: t.lastAlertAt || null,
        alertCount: t.alertCount,
        cycleCount: t.cycleCount,
        errorCount: t.errorCount,
        lastError: t.lastError || null,
        cycleHistory: t.cycleHistory || [],
        createdAt: t.createdAt,
      })),
      alerts: (alerts as any[]).map((a) => ({
        id: a._id.toString(),
        taskId: a.taskId.toString(),
        title: a.title,
        message: a.message,
        severity: a.severity,
        data: a.data || {},
        cycleNumber: a.cycleNumber,
        read: a.read,
        createdAt: a.createdAt,
      })),
      logs: (logs as any[]).map((l) => ({
        id: l._id.toString(),
        taskId: l.taskId.toString(),
        timestamp: l.timestamp,
        summary: l.summary,
        alerted: l.alerted,
        alertId: l.alertId ? l.alertId.toString() : null,
        error: l.error || null,
      })),
    });
  } catch (error) {
    console.error('Error fetching agent detail:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    await connectDB();

    const { agentId } = await context.params;
    const body = await request.json();
    const { status } = body;

    if (!status || !['active', 'paused'].includes(status)) {
      return NextResponse.json(
        { error: 'status must be "active" or "paused"' },
        { status: 400 }
      );
    }

    const agent = await Agent.findOne({ agentId });
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Update agent status
    agent.status = status;
    await agent.save();

    // Update all monitoring tasks for this agent
    await MonitoringTask.updateMany(
      { agentId, status: { $in: ['active', 'paused'] } },
      { $set: { status, updatedAt: new Date() } }
    );

    return NextResponse.json({
      success: true,
      agentId,
      status,
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}
