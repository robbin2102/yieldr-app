import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db(dbName);

    // All FILLED BUY trades — these are the bot's positions
    const filledTrades = await db.collection('ahf-copyTrades')
      .find({ status: 'FILLED', side: 'BUY' })
      .toArray();

    if (filledTrades.length === 0) {
      return NextResponse.json({ success: true, positions: [], summary: {
        totalPositions: 0, totalDeployed: 0, traderExitedCount: 0,
        estimatedPnl: null, pipelineAge: null,
      }});
    }

    // Group by title+outcome (most stable key across trade records)
    interface PositionGroup {
      conditionId: string | null;
      title: string;
      outcome: string;
      sourceWallet: string;
      traderLabel: string;
      totalFilledUsdc: number;
      totalFilledSize: number;
      weightedPriceSum: number;
      tradeCount: number;
      lastFilled: number | null;
    }
    const groupMap = new Map<string, PositionGroup>();

    for (const t of filledTrades as any[]) {
      const key = `${t.title ?? ''}:${t.outcome ?? ''}:${t.sourceWallet ?? ''}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          conditionId:     t.conditionId ?? null,
          title:           t.title ?? '',
          outcome:         t.outcome ?? '',
          sourceWallet:    t.sourceWallet ?? '',
          traderLabel:     t.traderLabel  ?? '',
          totalFilledUsdc: 0,
          totalFilledSize: 0,
          weightedPriceSum: 0,
          tradeCount:      0,
          lastFilled:      null,
        });
      }
      const g = groupMap.get(key)!;
      const fu = t.filledUsdc  ?? 0;
      const fs = t.filledSize  ?? 0;
      const fp = t.avgFillPrice ?? 0;
      g.totalFilledUsdc  += fu;
      g.totalFilledSize  += fs;
      g.weightedPriceSum += fp * fu;
      g.tradeCount++;
      if (t.filledAt != null && (g.lastFilled == null || t.filledAt > g.lastFilled)) {
        g.lastFilled = t.filledAt;
      }
    }

    // Get trader wallets to check their current positions
    const traderWallets = [...new Set([...groupMap.values()].map(g => g.sourceWallet.toLowerCase()))];

    // polymarket-openPositions stores trader's current positions (from pipeline materialize step)
    // Key: wallet+title+outcome (matches upsert key in materialize.ts)
    const traderPositions = await db.collection('polymarket-openPositions')
      .find({ wallet: { $in: traderWallets } })
      .toArray();

    // Map: "title:outcome:wallet" → position doc for trader-still-in check
    const traderPosMap = new Map<string, any>();
    for (const p of traderPositions as any[]) {
      const key = `${p.title ?? ''}:${p.outcome ?? ''}:${p.wallet ?? ''}`;
      traderPosMap.set(key, p);
    }

    // Get pipeline freshness
    const newestPosDate = traderPositions.length > 0
      ? traderPositions.reduce((max: Date | null, p: any) => {
          const d = p.lastUpdatedAt ? new Date(p.lastUpdatedAt) : null;
          return !d ? max : (!max || d > max ? d : max);
        }, null)
      : null;

    // Build position list
    const positions = [...groupMap.values()].map(g => {
      const avgFillPrice = g.totalFilledUsdc > 0
        ? g.weightedPriceSum / g.totalFilledUsdc : 0;

      // Check if trader still holds this position
      const traderKey   = `${g.title}:${g.outcome}:${g.sourceWallet.toLowerCase()}`;
      const traderPos   = traderPosMap.get(traderKey);
      const traderStillIn = !!traderPos;
      const curPrice    = traderPos?.curPrice ?? null;
      const traderSize  = traderPos?.size ?? null;

      // Estimate bot PnL using current price if available
      const estimatedPnl = (curPrice != null && g.totalFilledSize > 0)
        ? (curPrice - avgFillPrice) * g.totalFilledSize
        : null;

      return {
        title:           g.title,
        outcome:         g.outcome,
        conditionId:     g.conditionId,
        sourceWallet:    g.sourceWallet,
        traderLabel:     g.traderLabel,
        avgFillPrice,
        totalFilledUsdc: g.totalFilledUsdc,
        totalFilledSize: g.totalFilledSize,
        tradeCount:      g.tradeCount,
        lastFilled:      g.lastFilled,
        curPrice,
        traderStillIn,
        traderSize,
        estimatedPnl,
      };
    });

    // Sort: trader exited first (risk), then by deployed USDC desc
    positions.sort((a, b) => {
      if (!a.traderStillIn && b.traderStillIn) return -1;
      if (a.traderStillIn && !b.traderStillIn) return 1;
      return b.totalFilledUsdc - a.totalFilledUsdc;
    });

    const totalDeployed = positions.reduce((s, p) => s + p.totalFilledUsdc, 0);
    const knownPnl      = positions.filter(p => p.estimatedPnl != null);
    const estimatedPnl  = knownPnl.length > 0
      ? knownPnl.reduce((s, p) => s + (p.estimatedPnl ?? 0), 0)
      : null;

    const summary = {
      totalPositions:    positions.length,
      totalDeployed,
      traderExitedCount: positions.filter(p => !p.traderStillIn).length,
      estimatedPnl,
      pipelineAge:       newestPosDate,
    };

    return NextResponse.json({ success: true, positions, summary });
  } catch (error: any) {
    console.error('Error fetching open positions:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
