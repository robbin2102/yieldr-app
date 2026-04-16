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

    // Build merged trader rows
    const traders = latestEvents.map((ev: any) => {
      const ct = traderByWallet.get(ev.wallet) ?? {};
      return {
        wallet:      ev.wallet,
        label:       ev.label,
        runAt:       ev.runAt,

        // PnL snapshot from alloc event
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

        // Decision
        action:      ev.action      ?? '',
        actionCode:  ev.actionCode  ?? '',
        failureType: ev.failureType ?? 'NONE',
        reason:      ev.reason      ?? '',

        // Allocation state
        allocBefore: ev.allocBefore ?? 0,
        allocAfter:  ev.allocAfter  ?? null,
        positionCap: ev.positionCap ?? 0,
        spentUsdc:   (ct as any).spentUsdc ?? ev.spentUsdc ?? 0,

        // Live config from copyTrader
        allocationUsdc: (ct as any).allocationUsdc ?? ev.allocBefore ?? 0,
        active:         (ct as any).active ?? true,
      };
    });

    // Sort: active first, then by label
    traders.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    // System-level aggregates
    const totalDetected = traders.reduce((s, t) => s + t.detected, 0);
    const totalFilled   = traders.reduce((s, t) => s + t.filled,   0);
    const totalMissed   = traders.reduce((s, t) => s + t.missedPnl, 0);
    const totalBPnl     = traders.reduce((s, t) => s + t.bPnl,     0);

    // Aggregate skip counts across all traders
    const aggSkipCounts: Record<string, number> = {};
    for (const t of traders) {
      if (t.skipCounts && typeof t.skipCounts === 'object') {
        for (const [k, v] of Object.entries(t.skipCounts as Record<string, number>)) {
          aggSkipCounts[k] = (aggSkipCounts[k] ?? 0) + Number(v);
        }
      }
    }

    const systemStats = {
      totalTraders:  traders.length,
      activeTraders: traders.filter(t => t.active).length,
      totalDetected,
      totalFilled,
      fillRate:      totalDetected > 0 ? totalFilled / totalDetected : 0,
      totalMissedPnl: totalMissed,
      totalBotPnl:   totalBPnl,
      aggSkipCounts,
    };

    return NextResponse.json({ success: true, traders, systemStats });
  } catch (error: any) {
    console.error('Error fetching bot stats:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
