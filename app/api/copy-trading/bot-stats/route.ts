import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    // Latest allocation event per trader
    const latestEvents = await db.collection('ahf-allocationEvents').aggregate([
      { $sort: { runAt: -1 } },
      { $group: { _id: '$wallet', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
    ]).toArray();

    // Current state from copyTraders (live alloc/spent/active)
    const copyTraders = await db.collection('ahf-copyTraders').find({}).toArray();
    const traderByWallet = new Map(copyTraders.map((t: any) => [t.wallet, t]));

    // 24h activity counts per trader from ahf-copyTrades
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const act24h = await db.collection('ahf-copyTrades').aggregate([
      { $match: { createdAt: { $gte: since24h } } },
      { $group: {
        _id: '$sourceWallet',
        tAct24h: { $sum: 1 },
        bAct24h: { $sum: { $cond: [{ $eq: ['$status', 'FILLED'] }, 1, 0] } },
      }},
    ]).toArray();
    const act24hMap = new Map(act24h.map((a: any) => [a._id, a]));

    // Build merged trader rows
    const traders = latestEvents.map((ev: any) => {
      const ct  = traderByWallet.get(ev.wallet) ?? {};
      const a24 = act24hMap.get(ev.wallet) ?? { tAct24h: 0, bAct24h: 0 };
      return {
        wallet:      ev.wallet,
        label:       ev.label,
        runAt:       ev.runAt,

        // PnL snapshot
        tBought:     ev.tBought   ?? 0,
        tRealized:   ev.tRealized ?? 0,
        tOpenVal:    ev.tOpenVal  ?? 0,
        tTotal:      ev.tTotal    ?? 0,
        bCost:       ev.bCost     ?? 0,
        bPnl:        ev.bPnl      ?? 0,

        // ROCE
        traderROCE:  ev.traderROCE ?? 0,
        botROCE:     ev.botROCE    ?? 0,

        // Edge
        edgeScore:      ev.edgeScore      ?? null,
        edgeSpecialty:  ev.edgeSpecialty  ?? null,
        edgeConfidence: ev.edgeConfidence ?? null,

        // Execution
        detected:     ev.detected    ?? 0,
        filled:       ev.filled      ?? 0,
        execSkipRate: ev.execSkipRate ?? 0,
        belowAvgRate: ev.belowAvgRate ?? 0,
        skipCounts:   ev.skipCounts   ?? {},
        missedPnl:    ev.missedPnl    ?? 0,

        // 24h activity
        tAct24h: a24.tAct24h,
        bAct24h: a24.bAct24h,

        // Decision
        action:      ev.action      ?? '',
        actionCode:  ev.actionCode  ?? '',
        failureType: ev.failureType ?? 'NONE',
        reason:      ev.reason      ?? '',

        // Allocation
        allocBefore:    ev.allocBefore ?? 0,
        allocAfter:     ev.allocAfter  ?? null,
        positionCap:    ev.positionCap ?? 0,
        spentUsdc:      (ct as any).spentUsdc ?? ev.spentUsdc ?? 0,
        allocationUsdc: (ct as any).allocationUsdc ?? ev.allocBefore ?? 0,
        active:         (ct as any).active  ?? true,
        removed:        (ct as any).removed === true,
      };
    });

    // Tier: active (copying) / paused (active but throttled) / stopped (not active)
    // PAUSED_ACTIONS covers the states where allocation is held/reduced but we still
    // want to see live detections. HARD_STOP implies active=false, so it lands in stopped.
    const PAUSED_ACTIONS = ['SOFT_STOP', 'SCALE_DOWN', 'WATCH', 'FIX_ENTRY', 'HOLD'];
    for (const t of traders as any[]) {
      const code = (t.actionCode || '').toUpperCase();
      if (!t.active)                                t.tier = 'stopped';
      else if (PAUSED_ACTIONS.some(a => code.includes(a))) t.tier = 'paused';
      else                                          t.tier = 'active';
    }

    // Hide fully-removed traders (active=false AND removed=true) from the summary.
    const visible = (traders as any[]).filter(t => !t.removed);

    visible.sort((a: any, b: any) => {
      const order = { active: 0, paused: 1, stopped: 2 } as Record<string, number>;
      if (order[a.tier] !== order[b.tier]) return order[a.tier] - order[b.tier];
      return a.label.localeCompare(b.label);
    });

    // System aggregates (exclude removed traders)
    const totalDetected = visible.reduce((s: number, t: any) => s + t.detected, 0);
    const totalFilled   = visible.reduce((s: number, t: any) => s + t.filled,   0);
    const totalMissed   = visible.reduce((s: number, t: any) => s + t.missedPnl, 0);
    const totalBPnl     = visible.reduce((s: number, t: any) => s + t.bPnl,     0);

    const aggSkipCounts: Record<string, number> = {};
    for (const t of visible as any[]) {
      if (t.skipCounts && typeof t.skipCounts === 'object') {
        for (const [k, v] of Object.entries(t.skipCounts as Record<string, number>)) {
          aggSkipCounts[k] = (aggSkipCounts[k] ?? 0) + Number(v);
        }
      }
    }

    const systemStats = {
      totalTraders:   visible.length,
      activeTraders:  visible.filter((t: any) => t.tier === 'active').length,
      pausedTraders:  visible.filter((t: any) => t.tier === 'paused').length,
      stoppedTraders: visible.filter((t: any) => t.tier === 'stopped').length,
      totalDetected,
      totalFilled,
      fillRate:       totalDetected > 0 ? totalFilled / totalDetected : 0,
      totalMissedPnl: totalMissed,
      totalBotPnl:    totalBPnl,
      aggSkipCounts,
    };

    return NextResponse.json({ success: true, traders: visible, systemStats });
  } catch (error: any) {
    console.error('Error fetching bot stats:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
