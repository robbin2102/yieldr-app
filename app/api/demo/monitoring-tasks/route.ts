import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongoose';
import MonitoringTask from '@/models/MonitoringTask';

// Map tool names to human-readable signal pill labels
const TOOL_LABEL_MAP: Record<string, string> = {
  get_funding_rate_current:   'Funding',
  get_funding_rate_history:   'Funding',
  get_derivatives_history:    'OI',
  get_market_snapshot:        'Chart',
  fetch_live_indicator:       'Indicator',
  web_search:                 'News',
  get_hl_live_positions:      'Positions',
  get_hl_live_positions_batch:'Positions',
  get_pm_live_positions:      'Odds',
  get_top_perp_traders:       'Traders',
  get_top_pm_traders:         'Traders',
  compare_traders:            'Traders',
  get_hl_trade_history:       'Trades',
  get_pm_closed_positions:    'Trades',
  get_hl_portfolio:           'Portfolio',
  get_coin_price:             'Price',
  get_macro_snapshot:         'Macro',
};

// Normalise an asset symbol: strip suffixes, uppercase
// e.g. "ETH-USD" → "ETH", "ethusd" → "ETH", "SOL/USDT" → "SOL"
function normaliseSymbol(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[-/](USD[CT]?|PERP|USDT?)$/i, '')
    .replace(/[^A-Z0-9]/g, '');
}

// Extract asset symbol from tool params (tries common field names)
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

// Derive signal pills from a task's tools array
function deriveSignalPills(tools: Array<{ toolName: string; toolParams: Record<string, any>; extractFields: string[] }>) {
  const seen = new Set<string>();
  const pills: { label: string; color: string }[] = [];

  for (const tool of tools) {
    let label = '';

    if (tool.toolName === 'fetch_live_indicator' && tool.toolParams?.indicator) {
      label = String(tool.toolParams.indicator).toUpperCase();
    } else {
      label = TOOL_LABEL_MAP[tool.toolName] || tool.toolName;
    }

    // For market snapshots, also expand extractFields into specific pills
    if (tool.toolName === 'get_market_snapshot' && tool.extractFields?.length) {
      for (const field of tool.extractFields) {
        const fieldLabel = field
          .split('.').pop()!
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toUpperCase()
          .slice(0, 12);
        if (!seen.has(fieldLabel)) {
          seen.add(fieldLabel);
          pills.push({ label: fieldLabel, color: 'b' });
        }
      }
      continue;
    }

    if (!seen.has(label)) {
      seen.add(label);
      // Assign color by type
      let color = 'b';
      if (label === 'Funding') color = 'y';
      else if (label === 'OI') color = 'g';
      else if (label === 'News') color = 'p';
      else if (label === 'Odds') color = 'p';
      else if (label === 'Traders') color = 'b';
      pills.push({ label, color });
    }
  }

  return pills;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet')?.toLowerCase();

    if (!wallet) {
      return NextResponse.json({ error: 'wallet required' }, { status: 400 });
    }

    await connectDB();

    const tasks = await MonitoringTask.find(
      { userId: wallet, status: { $in: ['active', 'paused', 'error'] } },
      {
        task: 1,
        monitorInstruction: 1,
        tools: 1,
        intervalSeconds: 1,
        status: 1,
        nextRunAt: 1,
        lastRunAt: 1,
        alertCount: 1,
        cycleCount: 1,
        createdAt: 1,
      }
    )
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const result = tasks.map((t: any) => {
      // Find the primary asset symbol across all tools in this task
      let assetSymbol = '';
      for (const tool of t.tools || []) {
        const sym = extractAssetSymbol(tool.toolParams || {});
        if (sym) { assetSymbol = sym; break; }
      }

      // Fallback: parse task title for known symbols
      if (!assetSymbol) {
        const titleMatch = (t.task || '').match(/\b(BTC|ETH|SOL|ARB|AVAX|BNB|MATIC|OP|LINK|DOGE|PEPE|WIF|JUP|TIA|INJ|SUI)\b/i);
        if (titleMatch) assetSymbol = titleMatch[1].toUpperCase();
      }

      return {
        id: String(t._id),
        taskTitle: t.task,
        assetSymbol,
        status: t.status,
        intervalSeconds: t.intervalSeconds,
        cycleCount: t.cycleCount || 0,
        alertCount: t.alertCount || 0,
        nextRunAt: t.nextRunAt,
        lastRunAt: t.lastRunAt || null,
        signalPills: deriveSignalPills(t.tools || []),
      };
    });

    return NextResponse.json({ tasks: result });
  } catch (err: any) {
    console.error('[monitoring-tasks] GET error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
