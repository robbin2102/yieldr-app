import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

function normalTitle(t: string): string {
  return (t ?? '').toLowerCase().trim().replace(/[?!.\s]+$/, '').replace(/\s+/g, ' ');
}

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    // All FILLED BUY trades = bot's position book
    const filledTrades = await db.collection('ahf-copyTrades')
      .find({ status: 'FILLED', side: 'BUY' })
      .toArray();

    if (filledTrades.length === 0) {
      return NextResponse.json({ success: true, positions: [], summary: {
        openCount: 0, openValue: 0, unrealizedPnl: 0,
        totalBotPnl: null, botROCE: null, pipelineAge: null,
      }});
    }

    // Group by title+outcome+sourceWallet
    const groupMap = new Map<string, {
      conditionId: string | null;
      title: string; outcome: string;
      sourceWallet: string; traderLabel: string;
      totalFilledUsdc: number; totalFilledSize: number;
      weightedPriceSum: number; tradeCount: number;
      lastFilled: number | null;
    }>();

    for (const t of filledTrades as any[]) {
      const key = `${t.title ?? ''}:${t.outcome ?? ''}:${t.sourceWallet ?? ''}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          conditionId: t.conditionId ?? null,
          title: t.title ?? '', outcome: t.outcome ?? '',
          sourceWallet: t.sourceWallet ?? '', traderLabel: t.traderLabel ?? '',
          totalFilledUsdc: 0, totalFilledSize: 0, weightedPriceSum: 0,
          tradeCount: 0, lastFilled: null,
        });
      }
      const g = groupMap.get(key)!;
      const fu = t.filledUsdc   ?? 0;
      const fs = t.filledSize   ?? 0;
      const fp = t.avgFillPrice ?? 0;
      g.totalFilledUsdc  += fu;
      g.totalFilledSize  += fs;
      g.weightedPriceSum += fp * fu;
      g.tradeCount++;
      if (t.filledAt != null && (g.lastFilled == null || t.filledAt > g.lastFilled)) {
        g.lastFilled = t.filledAt;
      }
    }

    const traderWallets = [...new Set([...groupMap.values()].map(g => g.sourceWallet.toLowerCase()))];

    // Get trader open positions from pipeline-materialized collection
    const traderPositions = await db.collection('polymarket-openPositions')
      .find({ wallet: { $in: traderWallets } })
      .toArray();

    // Build lookup maps: conditionId+outcome+wallet AND normalized-title+outcome+wallet
    const byConditionId = new Map<string, any>();
    const byTitle       = new Map<string, any>();
    for (const p of traderPositions as any[]) {
      const w = (p.wallet ?? '').toLowerCase();
      if (p.conditionId) byConditionId.set(`${p.conditionId}:${p.outcome}:${w}`, p);
      byTitle.set(`${normalTitle(p.title)}:${(p.outcome ?? '').toLowerCase()}:${w}`, p);
    }

    // Pipeline freshness
    const newestDate = (traderPositions as any[]).reduce((max: Date | null, p: any) => {
      const d = p.lastUpdatedAt ? new Date(p.lastUpdatedAt) : null;
      return !d ? max : (!max || d > max ? d : max);
    }, null);

    // Build position list — ONLY include where we can confirm curPrice > 0 (open)
    const positions: any[] = [];
    for (const g of groupMap.values()) {
      const w = g.sourceWallet.toLowerCase();
      const condKey  = g.conditionId ? `${g.conditionId}:${g.outcome}:${w}` : null;
      const titleKey = `${normalTitle(g.title)}:${g.outcome.toLowerCase()}:${w}`;
      const traderPos = (condKey && byConditionId.get(condKey)) ?? byTitle.get(titleKey);

      // Only show confirmed open positions (curPrice > 0 from trader's portfolio)
      if (!traderPos || !(traderPos.curPrice > 0)) continue;

      const avgFillPrice = g.totalFilledUsdc > 0
        ? g.weightedPriceSum / g.totalFilledUsdc : 0;
      const curPrice       = traderPos.curPrice as number;
      const estimatedPnl   = g.totalFilledSize > 0
        ? (curPrice - avgFillPrice) * g.totalFilledSize : 0;
      const currentValue   = curPrice * g.totalFilledSize;

      positions.push({
        title:           g.title,
        outcome:         g.outcome,
        conditionId:     g.conditionId,
        traderLabel:     g.traderLabel,
        sourceWallet:    g.sourceWallet,
        avgFillPrice,
        totalFilledUsdc: g.totalFilledUsdc,
        totalFilledSize: g.totalFilledSize,
        tradeCount:      g.tradeCount,
        lastFilled:      g.lastFilled,
        curPrice,
        currentValue,
        estimatedPnl,
      });
    }

    // Sort by estimated PnL desc
    positions.sort((a, b) => b.estimatedPnl - a.estimatedPnl);

    // Portfolio summary
    const openCount     = positions.length;
    const openValue     = positions.reduce((s, p) => s + p.currentValue, 0);
    const unrealizedPnl = positions.reduce((s, p) => s + p.estimatedPnl, 0);

    // Bot total PnL + ROCE from latest alloc events
    const latestAllocEvents = await db.collection('ahf-allocationEvents').aggregate([
      { $sort: { runAt: -1 } },
      { $group: { _id: '$wallet', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
    ]).toArray();

    const copyTraders = await db.collection('ahf-copyTraders').find({}).toArray();
    const totalAlloc = (copyTraders as any[]).reduce((s: number, t: any) => s + (t.allocationUsdc ?? 0), 0);
    const totalBotPnl = (latestAllocEvents as any[]).reduce((s: number, e: any) => s + (e.bPnl ?? 0), 0);
    const botROCE = totalAlloc > 0 ? (totalBotPnl / totalAlloc) * 100 : null;

    // 24h total trades (filled)
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const trades24h = await db.collection('ahf-copyTrades')
      .countDocuments({ status: 'FILLED', createdAt: { $gte: since24h } });

    const summary = {
      openCount,
      openValue,
      unrealizedPnl,
      totalBotPnl,
      botROCE,
      trades24h,
      pipelineAge: newestDate,
    };

    return NextResponse.json({ success: true, positions, summary });
  } catch (error: any) {
    console.error('Error fetching open positions:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
