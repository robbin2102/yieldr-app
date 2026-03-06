import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { ObjectId } from 'mongodb';
import connectDB from '@/lib/mongoose';
import MonitoringTask from '@/models/MonitoringTask';

// Map tool names to human-readable signal pill labels
const TOOL_LABEL_MAP: Record<string, string> = {
  get_funding_rate_current:    'Funding',
  get_funding_rate_history:    'Funding',
  get_derivatives_history:     'OI',
  get_market_snapshot:         'Snapshot',
  fetch_live_indicator:        'Indicator',
  web_search:                  'News',
  get_hl_live_positions:       'Positions',
  get_hl_live_positions_batch: 'Positions',
  get_avantis_live_positions:  'Positions',
  get_pm_live_positions:       'Odds',
  get_top_perp_traders:        'Traders',
  get_top_pm_traders:          'Traders',
  compare_traders:             'Traders',
  get_hl_trade_history:        'Trades',
  get_pm_closed_positions:     'Trades',
  get_hl_portfolio:            'Portfolio',
  get_coin_price:              'Price',
  get_macro_snapshot:          'Macro',
};

// Friendly labels for field-path tail segments (from get_market_snapshot extractFields)
const FIELD_LABEL_MAP: Record<string, string> = {
  last:              'Price',
  latest:            'Latest',
  current:           'Current',
  current_usdt:      'OI',
  total_usd:         'OI',
  change_4h_pct:     'OI Δ4h',
  change_24h_pct:    'OI Δ24h',
  long_pct:          'Long%',
  short_pct:         'Short%',
  ratio:             'L/S Ratio',
  bias:              'Bias',
  trend:             'Trend',
  annualized:        'Funding APR',
  annualized_pct:    'Funding APR',
  rsi_14:            'RSI',
  macd:              'MACD',
  bbands:            'BB',
  adx:               'ADX',
  trend_score:       'Trend',
  momentum_score:    'Momentum',
  volatility_regime: 'Volatility',
  avg_24h:           'Avg 24h',
  avg_7d:            'Avg 7d',
};

// Normalise an asset symbol: strip suffixes, uppercase
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

// Prettify an unknown tool name into a readable label
function prettifyToolName(name: string): string {
  return name
    .replace(/^get_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 14);
}

// Derive signal pills from a task's tools array
function deriveSignalPills(tools: Array<{ toolName: string; toolParams: Record<string, any>; extractFields: string[] }>) {
  const seen = new Set<string>();
  const pills: { label: string; color: string }[] = [];

  for (const tool of tools) {
    let label = '';

    // fetch_live_indicator: show indicator names from toolParams.indicators[] or toolParams.indicator
    if (tool.toolName === 'fetch_live_indicator') {
      const inds: string[] = tool.toolParams?.indicators || (tool.toolParams?.indicator ? [tool.toolParams.indicator] : []);
      if (inds.length > 0) {
        for (const ind of inds.slice(0, 3)) {
          const lbl = ind.toUpperCase().slice(0, 10);
          if (!seen.has(lbl)) { seen.add(lbl); pills.push({ label: lbl, color: 'b' }); }
        }
        continue;
      }
      label = 'Indicator';
    } else {
      label = TOOL_LABEL_MAP[tool.toolName] || prettifyToolName(tool.toolName);
    }

    // For market snapshots: expand extractFields into named pills
    if (tool.toolName === 'get_market_snapshot' && tool.extractFields?.length) {
      for (const field of tool.extractFields.slice(0, 4)) {
        const tail = field.split('.').pop()!;
        const fieldLabel = FIELD_LABEL_MAP[tail] ||
          tail.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase().slice(0, 12);
        if (!seen.has(fieldLabel)) {
          seen.add(fieldLabel);
          pills.push({ label: fieldLabel, color: 'b' });
        }
      }
      continue;
    }

    // For derivatives_history: show sub-labels from extractFields if present
    if (tool.toolName === 'get_derivatives_history' && tool.extractFields?.length) {
      const subLabels = new Set<string>();
      for (const field of tool.extractFields) {
        const tail = field.split('.').pop()!;
        if (tail.includes('open_interest') || tail.includes('oi') || tail === 'current_usdt') subLabels.add('OI');
        if (tail.includes('long_short') || tail.includes('long_pct') || tail.includes('short_pct')) subLabels.add('L/S');
        if (tail.includes('funding')) subLabels.add('Funding');
      }
      const derivedLabels = [...subLabels];
      if (derivedLabels.length > 0) {
        for (const lbl of derivedLabels) {
          if (!seen.has(lbl)) {
            seen.add(lbl);
            const color = lbl === 'OI' ? 'g' : lbl === 'Funding' ? 'y' : 'b';
            pills.push({ label: lbl, color });
          }
        }
        continue;
      }
    }

    if (!seen.has(label)) {
      seen.add(label);
      let color = 'b';
      if (label === 'Funding') color = 'y';
      else if (label === 'OI' || label === 'OI Δ4h' || label === 'OI Δ24h') color = 'g';
      else if (label === 'News' || label === 'Odds') color = 'p';
      else if (label === 'Price' || label === 'Macro') color = 'b';
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
        agentId: 1,
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
        agentId: t.agentId ?? null,
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

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = searchParams.get('wallet')?.toLowerCase();
    const taskId  = searchParams.get('id');

    if (!wallet || !taskId) {
      return NextResponse.json({ error: 'wallet and id required' }, { status: 400 });
    }

    await connectDB();
    const db = mongoose.connection.db!;
    const result = await db.collection('monitoring_tasks').deleteOne({
      _id: new ObjectId(taskId),
      userId: wallet,
    });

    if (result.deletedCount === 0) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[monitoring-tasks] DELETE error:', err.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
