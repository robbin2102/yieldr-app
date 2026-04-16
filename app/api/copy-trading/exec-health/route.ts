import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const CONV_FILTER_REASONS = ['BELOW_AVG', 'GROUPED_BELOW_AVG'];

const SUGGESTIONS: Record<string, string> = {
  ALLOCATION_FULL:   'Increase allocationUsdc for the trader — allocation cap is being hit',
  POSITION_CAP_FULL: 'Raise per-position cap (currently 30% of alloc) or add more allocation',
  WIDE_SPREAD:       'Illiquid market at copy time — expected; consider tightening maxSpreadPct',
  PRICEDRIFT_FAILED: 'Price moved too fast before fill — consider relaxing maxDriftPct',
  ORDER_FAILED:      'GTT order failed after retries — check GTT expiry setting and network',
  NO_ORDERBOOK:      'CLOB orderbook unavailable — check connectivity / CLOB API status',
  SELL_NO_POSITION:  'Bot copied a SELL but has no matching position — check position tracking',
  DUPLICATE:         'Duplicate txHash — expected deduplication, no action needed',
  NON_TRADE:         'REDEEM/MERGE/SPLIT activity — filtered by design, no action needed',
};

async function windowStats(db: any, since: Date | null) {
  const match: any = since ? { createdAt: { $gte: since } } : {};

  const [agg, skipAgg] = await Promise.all([
    db.collection('ahf-copyTrades').aggregate([
      { $match: match },
      { $group: {
        _id: null,
        detected:   { $sum: 1 },
        filled:     { $sum: { $cond: [{ $eq: ['$status', 'FILLED']  }, 1, 0] } },
        execSkips:  { $sum: { $cond: [
          { $and: [
            { $eq: ['$status', 'SKIPPED'] },
            { $not: [{ $in: ['$skipReason', CONV_FILTER_REASONS] }] },
          ]}, 1, 0,
        ]}},
        convFilter: { $sum: { $cond: [{ $in: ['$skipReason', CONV_FILTER_REASONS] }, 1, 0] }},
      }},
    ]).toArray(),
    db.collection('ahf-copyTrades').aggregate([
      { $match: { ...match, status: 'SKIPPED', skipReason: { $nin: CONV_FILTER_REASONS, $ne: null } } },
      { $group: { _id: '$skipReason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
  ]);

  const r = agg[0] ?? { detected: 0, filled: 0, execSkips: 0, convFilter: 0 };
  const execGate = r.filled + r.execSkips;
  const fillRate = execGate > 0 ? r.filled / execGate : null;

  return {
    detected:   r.detected,
    filled:     r.filled,
    execSkips:  r.execSkips,
    convFilter: r.convFilter,
    fillRate,
    skipBreakdown: Object.fromEntries(skipAgg.map((s: any) => [s._id, s.count])),
  };
}

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    const now = Date.now();
    const [w24h, w7d, w30d, wAll] = await Promise.all([
      windowStats(db, new Date(now - 24 * 60 * 60 * 1000)),
      windowStats(db, new Date(now -  7 * 24 * 60 * 60 * 1000)),
      windowStats(db, new Date(now - 30 * 24 * 60 * 60 * 1000)),
      windowStats(db, null),
    ]);

    const windows = [
      { label: '24h', ...w24h },
      { label: '7d',  ...w7d  },
      { label: '30d', ...w30d },
      { label: 'ALL', ...wAll },
    ];

    // Trend: compare 24h fill rate vs 7d fill rate
    let trend: 'improving' | 'degrading' | 'stable' | 'insufficient' = 'insufficient';
    let trendDelta = 0;
    if (w24h.fillRate != null && w7d.fillRate != null && w24h.detected >= 5) {
      trendDelta = w24h.fillRate - w7d.fillRate;
      trend = trendDelta > 0.05 ? 'improving' : trendDelta < -0.05 ? 'degrading' : 'stable';
    }

    // Top issues from all-time skip breakdown (most impactful)
    const issues = Object.entries(wAll.skipBreakdown)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 6)
      .map(([reason, count]) => ({
        reason,
        count,
        suggestion: SUGGESTIONS[reason] ?? 'Check logs for details',
      }));

    return NextResponse.json({ success: true, windows, trend, trendDelta, issues });
  } catch (error: any) {
    console.error('Error fetching exec health:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
