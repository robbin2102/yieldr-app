import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    // All edge-ranked traders, sorted by rank
    const edgeTraders = await db.collection('ahf-edgeRankedTraders')
      .find({})
      .sort({ overall_rank: 1 })
      .toArray();

    // Copy trader config for isCopying + allocation status
    const copyTraders = await db.collection('ahf-copyTraders').find({}).toArray();
    const copyByWallet = new Map(copyTraders.map((t: any) => [t.wallet.toLowerCase(), t]));

    // When was the most recent pipeline update?
    const newest = edgeTraders.reduce((max: Date | null, t: any) => {
      const d = t.updatedAt ? new Date(t.updatedAt) : null;
      if (!d) return max;
      return !max || d > max ? d : max;
    }, null);

    const cutoff24h = newest ? new Date(newest.getTime() - 24 * 60 * 60 * 1000) : null;

    const traders = edgeTraders.map((t: any) => {
      const ct = copyByWallet.get((t.wallet ?? '').toLowerCase());
      const isNew = cutoff24h && t.updatedAt && new Date(t.updatedAt) >= cutoff24h;

      return {
        wallet:        t.wallet,
        displayName:   t.display_name ?? null,
        specialty:     t.specialty    ?? 'Other',
        winRate:       t.win_rate     ?? 0,
        expectedWR:    t.expected_wr  ?? 0,
        n:             t.n            ?? 0,
        edge:          t.edge         ?? 0,
        pVal:          t.p_val        ?? 1,
        confidence:    t.confidence   ?? 'watch',
        rankScore:     t.rank_score   ?? 0,
        overallRank:   t.overall_rank ?? 0,
        roce30d:       t.roce_30d     ?? 0,
        pnl30d:        t.pnl_30d      ?? 0,
        pf:            t.pf           ?? 1,
        daysWonRate:   t.days_won_rate ?? null,
        sortino:       t.sortino      ?? null,
        actPerDay:     t.act_per_day  ?? null,
        lastActive:    t.last_active  ?? null,
        insider:       t.insider      ?? 'none',
        insiderScore:  t.insider_score ?? 0,
        spcWr:         t.spc_wr       ?? null,
        updatedAt:     t.updatedAt,
        isNewInRun:    !!isNew,

        // Copy state
        isCopying:      !!ct?.active,
        allocationUsdc: ct?.allocationUsdc ?? 0,
        spentUsdc:      ct?.spentUsdc      ?? 0,
        allocAction:    ct?.allocAction    ?? '',
        allocReason:    ct?.allocReason    ?? '',
      };
    });

    return NextResponse.json({ success: true, traders, pipelineRunAt: newest });
  } catch (error: any) {
    console.error('Error fetching edge ranked traders:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// PATCH — start | stop | remove a trader
//   start  : active=true, removed=false
//   stop   : active=false (keeps record, can be resumed)
//   remove : active=false, removed=true — hides from all detectors/UI.
//            Detector (src/index.ts) already filters CopyTrader.find({ active: true })
//            so removed rows never enter the detector loop.
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { wallet, action } = body;
    if (!wallet || !['start', 'stop', 'remove', 'alloc'].includes(action)) {
      return NextResponse.json({ success: false, error: 'wallet and action (start|stop|remove|alloc) required' }, { status: 400 });
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    const update: Record<string, any> = { updatedAt: new Date() };
    if (action === 'start')  { update.active = true;  update.removed = false; }
    if (action === 'stop')   { update.active = false; }
    if (action === 'remove') { update.active = false; update.removed = true; }
    if (action === 'alloc') {
      const newAlloc = Number(body.allocationUsdc);
      if (!Number.isFinite(newAlloc) || newAlloc < 0)
        return NextResponse.json({ success: false, error: 'allocationUsdc must be a non-negative number' }, { status: 400 });
      update.allocationUsdc = newAlloc;
    }

    await db.collection('ahf-copyTraders').updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: update },
      { upsert: false },
    );

    return NextResponse.json({ success: true, wallet, action });
  } catch (error: any) {
    console.error('Error toggling copy trader:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
