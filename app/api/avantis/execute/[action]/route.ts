import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import TradeSetup from '@/models/TradeSetup';
import MonitoringTask from '@/models/MonitoringTask';
import AgentTrade, { TradeAction } from '@/models/AgentTrade';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PYTHON_URL       = process.env.PYTHON_SERVICE_URL    || 'http://localhost:8001';
const DATA_API_SECRET  = process.env.YIELDR_DATA_API_SECRET || '';
const INTERNAL_SECRET  = process.env.YIELDR_INTERNAL_SECRET || '';

// Map Next.js action slug → Python endpoint path
const ACTION_MAP: Record<string, string> = {
  open:            'execute-open',
  close:           'execute-close',
  'update-tp-sl':  'execute-update-tp-sl',
  'update-margin': 'execute-update-margin',
  'cancel-limit':  'execute-cancel-limit',
};

// Map action slug + order_type → TradeAction for logging
function resolveTradeAction(action: string, orderType?: string): TradeAction {
  if (action === 'open') {
    return orderType && orderType !== 'MARKET' ? 'limit_open' : 'market_open';
  }
  const map: Record<string, TradeAction> = {
    close:           'market_close',
    'cancel-limit':  'limit_cancel',
    'update-tp-sl':  'update_tp_sl',
    'update-margin': 'update_margin',
  };
  return map[action] ?? 'market_open';
}

async function proxyToPython(endpoint: string, body: Record<string, any>) {
  const res = await fetch(`${PYTHON_URL}/trade/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': DATA_API_SECRET,
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
  // ── Auth: require internal secret ─────────────────────────────────────────
  // Only the app's own server-side code (MCP tools, server actions) may call
  // this route. Reject any request that does not carry the shared secret.
  if (INTERNAL_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${INTERNAL_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

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

  const { agentId, userId, ...tradeParams } = body;

  if (action === 'open' && (!agentId || !userId)) {
    return NextResponse.json(
      { error: 'agentId and userId required for execute-open' },
      { status: 400 }
    );
  }

  await connectDB();

  const tradeAction = resolveTradeAction(action, tradeParams.order_type);

  // ── Proxy to Python service ─────────────────────────────────────────────────
  let result: Record<string, any>;
  try {
    result = await proxyToPython(pythonEndpoint, tradeParams);
  } catch (err: any) {
    // Log failed attempt to agent_trades
    if (agentId && userId) {
      await AgentTrade.create({
        agentId,
        userId: userId.toLowerCase(),
        action:    tradeAction,
        pair:      tradeParams.pair,
        pairIndex: tradeParams.pair_index,
        tradeIndex: tradeParams.trade_index,
        orderIndex: tradeParams.order_index,
        direction:  tradeParams.direction,
        collateral: tradeParams.collateral,
        leverage:   tradeParams.leverage,
        tpPct:      tradeParams.tp_pct,
        slPct:      tradeParams.sl_pct,
        openPrice:  tradeParams.open_price,
        marginDelta: tradeParams.margin_delta,
        status:  'failed',
        error:   err.message,
        timestamp: new Date(),
      }).catch(() => {}); // non-blocking — never fail the response over logging
    }

    console.error(`[avantis/execute/${action}] error:`, err.message);
    return NextResponse.json(
      { error: err.message || 'Trade execution failed' },
      { status: 500 }
    );
  }

  // ── Post-execution MongoDB side effects ─────────────────────────────────────

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

    // Log to agent_trades
    await AgentTrade.create({
      agentId,
      userId:       userId.toLowerCase(),
      walletAddress: result.agent_wallet,
      action:       tradeAction,
      pair:         tradeParams.pair,
      pairIndex:    result.pair_index,
      tradeIndex:   result.trade_index ?? null,
      direction:    tradeParams.direction,
      collateral:   tradeParams.collateral,
      leverage:     tradeParams.leverage,
      tpPct:        tradeParams.tp_pct,
      slPct:        tradeParams.sl_pct,
      openPrice:    tradeParams.open_price,
      entryPrice:   result.entry_price,
      tpPrice:      result.tp_price,
      slPrice:      result.sl_price,
      txHash:       result.tx_hash,
      status:       'success',
      tradeSetupId: setup._id.toString(),
      timestamp:    new Date(),
    }).catch(() => {});

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
    const { trade_index, pair_index } = tradeParams;
    let tradeSetupId: string | undefined;

    if (trade_index != null && pair_index != null) {
      const updated = await TradeSetup.findOneAndUpdate(
        { tradeIndex: trade_index, pairIndex: pair_index, status: { $in: ['open', 'monitoring', 'closing'] } },
        {
          closeTxHash: result.tx_hash,
          closedAt:    new Date(),
          closeReason: body.closeReason || 'manual',
          exitPrice:   result.exit_price,
          pnl:         result.pnl,
          status:      'closed',
        },
        { new: true }
      );
      tradeSetupId = updated?._id?.toString();
    }

    await AgentTrade.create({
      agentId:    agentId || body.agentId,
      userId:     (userId || body.userId || '').toLowerCase(),
      action:     'market_close',
      pair:       tradeParams.pair,
      pairIndex:  pair_index,
      tradeIndex: trade_index,
      exitPrice:  result.exit_price,
      pnl:        result.pnl,
      txHash:     result.tx_hash,
      status:     'success',
      tradeSetupId,
      timestamp:  new Date(),
    }).catch(() => {});
  }

  if (action === 'update-tp-sl') {
    await AgentTrade.create({
      agentId:    agentId || body.agentId,
      userId:     (userId || body.userId || '').toLowerCase(),
      action:     'update_tp_sl',
      pair:       tradeParams.pair,
      pairIndex:  tradeParams.pair_index,
      tradeIndex: tradeParams.trade_index,
      tpPrice:    tradeParams.new_tp,
      slPrice:    tradeParams.new_sl,
      txHash:     result.tx_hash,
      status:     'success',
      timestamp:  new Date(),
    }).catch(() => {});
  }

  if (action === 'update-margin') {
    await AgentTrade.create({
      agentId:     agentId || body.agentId,
      userId:      (userId || body.userId || '').toLowerCase(),
      action:      'update_margin',
      pair:        tradeParams.pair,
      pairIndex:   tradeParams.pair_index,
      tradeIndex:  tradeParams.trade_index,
      marginDelta: tradeParams.margin_delta,
      txHash:      result.tx_hash,
      status:      'success',
      timestamp:   new Date(),
    }).catch(() => {});
  }

  if (action === 'cancel-limit') {
    await AgentTrade.create({
      agentId:    agentId || body.agentId,
      userId:     (userId || body.userId || '').toLowerCase(),
      action:     'limit_cancel',
      pairIndex:  tradeParams.pair_index,
      orderIndex: tradeParams.order_index,
      txHash:     result.tx_hash,
      status:     'success',
      timestamp:  new Date(),
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, trade: result });
}
