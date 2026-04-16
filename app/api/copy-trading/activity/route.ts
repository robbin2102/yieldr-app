import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    const trades = await db.collection('ahf-copyTrades')
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    const activity = trades.map((t: any) => ({
      _id:           t._id.toString(),
      traderLabel:   t.traderLabel   ?? '',
      title:         t.title         ?? '',
      outcome:       t.outcome       ?? '',
      side:          t.side          ?? 'BUY',
      traderBetUsdc: t.traderBetUsdc ?? 0,
      traderPrice:   t.traderPrice   ?? null,
      copyBetUsdc:   t.copyBetUsdc   ?? 0,
      status:        t.status        ?? 'DETECTED',
      skipReason:    t.skipReason    ?? null,
      skipDetail:    t.skipDetail    ?? null,
      createdAt:     t.createdAt,
      filledUsdc:    t.filledUsdc    ?? null,
      avgFillPrice:  t.avgFillPrice  ?? null,
      totalLatencyMs: t.totalLatencyMs ?? null,
    }));

    return NextResponse.json({ success: true, activity });
  } catch (error: any) {
    console.error('Error fetching activity:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
