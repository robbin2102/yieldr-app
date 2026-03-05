import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import Agent from '@/models/Agent';
import MonitoringTask from '@/models/MonitoringTask';
import MonitoringTaskLog from '@/models/MonitoringTaskLog';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const wallet = searchParams.get('wallet');

    if (!wallet) {
      return NextResponse.json({ error: 'wallet is required' }, { status: 400 });
    }

    const agents = await Agent.find({ ownerWallet: wallet.toLowerCase() })
      .sort({ createdAt: -1 })
      .lean();

    if (!agents.length) {
      return NextResponse.json({ agents: [] });
    }

    const agentIds = (agents as any[]).map((a) => a.agentId);

    // Aggregate cycle counts per agent from tasks
    const taskAgg = await MonitoringTask.aggregate([
      { $match: { agentId: { $in: agentIds } } },
      {
        $group: {
          _id: '$agentId',
          totalCycles: { $sum: '$cycleCount' },
          totalAlerts: { $sum: '$alertCount' },
          activeTasks: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalTasks: { $sum: 1 },
        },
      },
    ]);

    const taskMap: Record<string, { totalCycles: number; totalAlerts: number; activeTasks: number; totalTasks: number }> = {};
    for (const t of taskAgg) {
      taskMap[t._id] = {
        totalCycles: t.totalCycles,
        totalAlerts: t.totalAlerts,
        activeTasks: t.activeTasks,
        totalTasks: t.totalTasks,
      };
    }

    // Get latest log per agent (most recent activity)
    const latestLogs = await MonitoringTaskLog.aggregate([
      { $match: { agentId: { $in: agentIds } } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$agentId', latestLog: { $first: '$$ROOT' } } },
    ]);

    const logMap: Record<string, any> = {};
    for (const l of latestLogs) {
      logMap[l._id] = {
        timestamp: l.latestLog.timestamp,
        summary: l.latestLog.summary,
        alerted: l.latestLog.alerted,
        error: l.latestLog.error || null,
      };
    }

    const result = (agents as any[]).map((agent) => {
      const stats = taskMap[agent.agentId] || { totalCycles: 0, totalAlerts: 0, activeTasks: 0, totalTasks: 0 };
      return {
        agentId: agent.agentId,
        name: agent.name,
        status: agent.status,
        markets: agent.markets,
        goals: agent.goals || [],
        alertsSent: agent.alertsSent || stats.totalAlerts,
        insightsGenerated: agent.insightsGenerated || 0,
        lastActiveAt: agent.lastActiveAt || null,
        cycleCount: stats.totalCycles,
        activeTasks: stats.activeTasks,
        totalTasks: stats.totalTasks,
        latestLog: logMap[agent.agentId] || null,
        portfolioSummary: agent.portfolioSummary,
        createdAt: agent.createdAt,
      };
    });

    return NextResponse.json({ agents: result });
  } catch (error) {
    console.error('Error listing agents:', error);
    return NextResponse.json({ error: 'Failed to list agents' }, { status: 500 });
  }
}
