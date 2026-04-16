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
        active:         (ct as any).active ?? true,
      };
    });

    traders.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    // System aggregates
    const totalDetected = traders.reduce((s, t) => s + t.detected, 0);
    const totalFilled   = traders.reduce((s, t) => s + t.filled,   0);
    const totalMissed   = traders.reduce((s, t) => s + t.missedPnl, 0);
    const totalBPnl     = traders.reduce((s, t) => s + t.bPnl,     0);

    const aggSkipCounts: Record<string, number> = {};
    for (const t of traders) {
      if (t.skipCounts && typeof t.skipCounts === 'object') {
        for (const [k, v] of Object.entries(t.skipCounts as Record<string, number>)) {
          aggSkipCounts[k] = (aggSkipCounts[k] ?? 0) + Number(v);
        }
      }
    }

    const systemStats = {
      totalTraders:   traders.length,
      activeTraders:  traders.filter(t => t.active).length,
      totalDetected,
      totalFilled,
      fillRate:       totalDetected > 0 ? totalFilled / totalDetected : 0,
      totalMissedPnl: totalMissed,
      totalBotPnl:    totalBPnl,
      aggSkipCounts,
    };

    return NextResponse.json({ success: true, traders, systemStats });
  } catch (error: any) {
    console.error('Error fetching bot stats:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
