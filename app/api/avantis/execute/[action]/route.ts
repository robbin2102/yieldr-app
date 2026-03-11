import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import TradeSetup from '@/models/TradeSetup';
import MonitoringTask from '@/models/MonitoringTask';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PYTHON_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8001';
const API_KEY    = process.env.API_KEY || '';

// Map Next.js action slug → Python endpoint path
const ACTION_MAP: Record<string, string> = {
  open:            'execute-open',
  close:           'execute-close',
  'update-tp-sl':  'execute-update-tp-sl',
  'update-margin': 'execute-update-margin',
  'cancel-limit':  'execute-cancel-limit',
};

async function proxyToPython(endpoint: string, body: Record<string, any>) {
  const res = await fetch(`${PYTHON_URL}/trade/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.detail || `Python service error ${res.status}`);
  }
  return data;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { action: string } }
) {
  const { action } = params;
  const pythonEndpoint = ACTION_MAP[action];

  if (!pythonEndpoint) {
    return NextResponse.json(
      { error: `Unknown action: ${action}. Valid: ${Object.keys(ACTION_MAP).join(', ')}` },
      { status: 400 }
    );
  }

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // agentId + userId required for TradeSetup lifecycle
  const { agentId, userId, ...tradeParams } = body;

  if (action === 'open' && (!agentId || !userId)) {
    return NextResponse.json(
      { error: 'agentId and userId required for execute-open' },
      { status: 400 }
    );
  }

  try {
    // ── Proxy to Python service ───────────────────────────────────────────────
    const result = await proxyToPython(pythonEndpoint, tradeParams);

    // ── Post-execution MongoDB side effects ───────────────────────────────────
    await connectDB();

    if (action === 'open') {
      // Create TradeSetup doc
      const setup = await TradeSetup.create({
        agentId,
        userId: userId.toLowerCase(),
        pair:       tradeParams.pair,
        direction:  tradeParams.direction,
        collateral: tradeParams.collateral,
        leverage:   tradeParams.leverage,
        tpPct:      tradeParams.tp_pct,
        slPct:      tradeParams.sl_pct,
        orderType:  tradeParams.order_type || 'MARKET',
        openPrice:  tradeParams.open_price,

        // Filled from execution result
        txHash:             result.tx_hash,
        pairIndex:          result.pair_index,
        tradeIndex:         result.trade_index ?? null,
        entryPrice:         result.entry_price,
        tpPrice:            result.tp_price,
        slPrice:            result.sl_price,
        openingFeeUsdc:     result.opening_fee_usdc,
        lossProtectionPct:  result.loss_protection_pct,
        agentWalletAddress: result.agent_wallet,
        executedAt:         new Date(),
        status:             'open',
      });

      // Auto-create a monitoring task linked to this trade if requested
      if (body.createMonitor) {
        const intervalSeconds = body.monitorIntervalSeconds || 300;
        const task = await MonitoringTask.create({
          userId:  userId.toLowerCase(),
          agentId,
          agentName: body.agentName || agentId,
          task: `Monitor ${tradeParams.pair} ${tradeParams.direction} trade`,
          monitorInstruction: body.monitorInstruction || `Monitor open ${tradeParams.direction} trade on ${tradeParams.pair}. Alert if TP or SL is approaching or if market conditions change significantly.`,
          mode:               body.monitorMode || 'monitor',
          linkedTradeSetupId: setup._id.toString(),
          linkedPairIndex:    result.pair_index,
          linkedTradeIndex:   result.trade_index ?? null,
          tools: [],
          signals: [],
          entryLogic: 'AND',
          exitLogic:  'ANY',
          intervalSeconds,
          nextRunAt: new Date(Date.now() + intervalSeconds * 1000),
          status: 'active',
        });

        await TradeSetup.findByIdAndUpdate(setup._id, {
          monitoringTaskId: task._id.toString(),
          status: 'monitoring',
        });

        return NextResponse.json({
          success: true,
          trade: result,
          tradeSetupId: setup._id.toString(),
          monitoringTaskId: task._id.toString(),
        });
      }

      return NextResponse.json({
        success: true,
        trade: result,
        tradeSetupId: setup._id.toString(),
      });
    }

    if (action === 'close') {
      // Update TradeSetup on close — find by tradeIndex + pairIndex
      const { trade_index, pair_index } = tradeParams;
      if (trade_index != null && pair_index != null) {
        await TradeSetup.findOneAndUpdate(
          { tradeIndex: trade_index, pairIndex: pair_index, status: { $in: ['open', 'monitoring', 'closing'] } },
          {
            closeTxHash:  result.tx_hash,
            closedAt:     new Date(),
            closeReason:  body.closeReason || 'manual',
            status:       'closed',
          }
        );
      }
    }

    return NextResponse.json({ success: true, trade: result });

  } catch (err: any) {
    console.error(`[avantis/execute/${action}] error:`, err.message);
    return NextResponse.json(
      { error: err.message || 'Trade execution failed' },
      { status: 500 }
    );
  }
}
