import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongoose';
import MonitoringAlert from '@/models/MonitoringAlert';
import MonitoringTask from '@/models/MonitoringTask';

// Normalise an asset symbol: strip suffixes, uppercase
function normaliseSymbol(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[-/](USD[CT]?|PERP|USDT?)$/i, '')
    .replace(/[^A-Z0-9]/g, '');
}

function extractAssetSymbol(toolParams: Record<string, any>): string {
  const raw =
    toolParams?.asset   ||
    toolParams?.symbol  ||
    toolParams?.coin    ||
    toolParams?.ticker  ||
    toolParams?.market  ||
    '';
  return raw ? normaliseSymbol(String(raw)) : '';
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet')?.toLowerCase();

    if (!wallet) {
      return NextResponse.json({ error: 'wallet required' }, { status: 400 });
    }

    await connectDB();

    const alerts = await MonitoringAlert.find(
      { userId: wallet },
      { title: 1, message: 1, severity: 1, data: 1, cycleNumber: 1, read: 1, taskId: 1, agentId: 1, isSignal: 1, createdAt: 1 }
    )
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    // Join taskId → assetSymbol so the UI can match alerts to position cards
    const taskIds = [...new Set(alerts.map((a: any) => String(a.taskId)))];
    let taskSymbolMap: Record<string, string> = {};

    if (taskIds.length > 0) {
      try {
        const validObjectIds = taskIds
          .filter(id => id && id.length === 24)
          .map(id => new mongoose.Types.ObjectId(id));

        if (validObjectIds.length > 0) {
          const tasks = await MonitoringTask.find(
            { _id: { $in: validObjectIds } },
            { tools: 1 }
          ).lean();

          for (const t of tasks as any[]) {
            let symbol = '';
            for (const tool of t.tools || []) {
              const sym = extractAssetSymbol(tool.toolParams || {});
              if (sym) { symbol = sym; break; }
            }
            taskSymbolMap[String(t._id)] = symbol;
          }
        }
      } catch (err: any) {
        console.warn('[alerts] taskId join failed (non-fatal):', err.message);
      }
    }

    const unreadCount = alerts.filter((a: any) => !a.read).length;

    const result = (alerts as any[]).map(a => ({
      id: String(a._id),
      taskId: String(a.taskId),
      agentId: a.agentId ?? null,
      title: a.title,
      message: a.message,
      severity: a.severity,
      isSignal: a.isSignal ?? false,
      cycleNumber: a.cycleNumber,
      read: a.read,
      assetSymbol: taskSymbolMap[String(a.taskId)] || '',
      createdAt: a.createdAt,
    }));

    return NextResponse.json({ alerts: result, unreadCount, total: alerts.length });
  } catch (err: any) {
    console.error('[alerts] GET error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH — mark all alerts as read for this wallet
export async function PATCH(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet')?.toLowerCase();

    if (!wallet) {
      return NextResponse.json({ error: 'wallet required' }, { status: 400 });
    }

    await connectDB();

    await MonitoringAlert.updateMany(
      { userId: wallet, read: false },
      { $set: { read: true } }
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[alerts] PATCH error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
