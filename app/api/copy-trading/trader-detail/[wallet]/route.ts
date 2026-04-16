import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  try {
    const { wallet: rawWallet } = await params;
    const wallet = rawWallet.toLowerCase();
    const client = await clientPromise;
    const db = client.db(dbName);

    // Parallel fetch: edge profile, copy config, alloc history, raw trades, trader open positions
    const [edgeDoc, copyConfig, allocHistory, rawTrades, traderOpenPositions] = await Promise.all([
      db.collection('ahf-edgeRankedTraders').findOne({ wallet }),
      db.collection('ahf-copyTraders').findOne({ wallet }),
      db.collection('ahf-allocationEvents')
        .find({ wallet })
        .sort({ runAt: -1 })
        .limit(20)
        .toArray(),
      db.collection('ahf-copyTrades')
        .find({ sourceWallet: wallet })
        .sort({ createdAt: -1 })
        .toArray(),
      db.collection('polymarket-openPositions')
        .find({ wallet })
        .toArray(),
    ]);

    if (!copyConfig && rawTrades.length === 0) {
      return NextResponse.json({ success: false, error: 'Trader not found' }, { status: 404 });
    }

    // Build current price map from trader's open positions (pipeline-materialized)
    // Key: title:outcome → { curPrice, size, currentValue }
    const priceMap = new Map<string, any>();
    for (const p of traderOpenPositions as any[]) {
      priceMap.set(`${p.title ?? ''}:${p.outcome ?? ''}`, p);
    }

    // Group trades by market (title+outcome as key — most stable)
    interface MarketGroup {
      conditionId: string | null;
      title: string;
      outcome: string;
      // Trader side (all detected trades)
      tBought: number;
      tSold: number;
      tEntrySum: number;   // weighted: price * traderBetUsdc for BUY
      tBuyCount: number;
      // Bot side (FILLED trades only)
      bFilledUsdc: number;
      bFilledSize: number;
      bEntrySum: number;   // weighted: avgFillPrice * filledUsdc
      // Skips
      skipCounts: Record<string, number>;
      totalDetected: number;
      totalFilled: number;
      lastActivity: Date;
    }

    const marketMap = new Map<string, MarketGroup>();

    for (const t of rawTrades as any[]) {
      const key = `${t.title ?? ''}:${t.outcome ?? ''}`;
      if (!marketMap.has(key)) {
        marketMap.set(key, {
          conditionId:  t.conditionId ?? null,
          title:        t.title ?? '',
          outcome:      t.outcome ?? '',
          tBought: 0, tSold: 0, tEntrySum: 0, tBuyCount: 0,
          bFilledUsdc: 0, bFilledSize: 0, bEntrySum: 0,
          skipCounts: {},
          totalDetected: 0, totalFilled: 0,
          lastActivity: t.createdAt ?? new Date(0),
        });
      }
      const m = marketMap.get(key)!;
      m.totalDetected++;
      if (t.createdAt && new Date(t.createdAt) > m.lastActivity) {
        m.lastActivity = new Date(t.createdAt);
      }

      if (t.side === 'BUY' && t.skipReason !== 'NON_TRADE') {
        const betUsdc = t.traderBetUsdc ?? 0;
        m.tBought   += betUsdc;
        m.tEntrySum += (t.traderPrice ?? 0) * betUsdc;
        m.tBuyCount++;
      } else if (t.side === 'SELL' && t.skipReason !== 'NON_TRADE') {
        m.tSold += t.traderBetUsdc ?? 0;
      }

      if (t.status === 'FILLED') {
        m.totalFilled++;
        const fu = t.filledUsdc  ?? 0;
        const fs = t.filledSize  ?? 0;
        const fp = t.avgFillPrice ?? 0;
        m.bFilledUsdc += fu;
        m.bFilledSize += fs;
        m.bEntrySum   += fp * fu;
      }

      if (t.status === 'SKIPPED' && t.skipReason) {
        m.skipCounts[t.skipReason] = (m.skipCounts[t.skipReason] ?? 0) + 1;
      }
    }

    // Build final market list with derived fields
    const markets = [...marketMap.values()].map(m => {
      const tEntry = m.tBuyCount > 0 && m.tBought > 0
        ? m.tEntrySum / m.tBought : null;
      const bEntry = m.bFilledUsdc > 0
        ? m.bEntrySum / m.bFilledUsdc : null;

      const priceKey   = `${m.title}:${m.outcome}`;
      const priceInfo  = priceMap.get(priceKey);
      const curPrice   = priceInfo?.curPrice ?? null;
      const traderStillIn = !!priceInfo;

      // Estimated bot PnL: (curPrice - bEntry) × bFilledSize
      const bPnl = (curPrice != null && bEntry != null && m.bFilledSize > 0)
        ? (curPrice - bEntry) * m.bFilledSize
        : null;

      return {
        conditionId:    m.conditionId,
        title:          m.title,
        outcome:        m.outcome,
        tEntry,
        tBought:        m.tBought > 0 ? m.tBought : null,
        tSold:          m.tSold   > 0 ? m.tSold   : null,
        bEntry,
        bFilledUsdc:    m.bFilledUsdc > 0 ? m.bFilledUsdc : null,
        bFilledSize:    m.bFilledSize > 0 ? m.bFilledSize : null,
        bPnl,
        curPrice,
        traderStillIn,
        skipCounts:     m.skipCounts,
        totalSkips:     Object.values(m.skipCounts).reduce((s, n) => s + n, 0),
        totalDetected:  m.totalDetected,
        totalFilled:    m.totalFilled,
        lastActivity:   m.lastActivity,
      };
    });

    // Sort by tBought desc (largest trader activity first)
    markets.sort((a, b) => (b.tBought ?? 0) - (a.tBought ?? 0));

    const edgeProfile = edgeDoc ? {
      displayName:  edgeDoc.display_name ?? null,
      specialty:    edgeDoc.specialty    ?? 'Other',
      winRate:      edgeDoc.win_rate     ?? 0,
      expectedWR:   edgeDoc.expected_wr  ?? 0,
      n:            edgeDoc.n            ?? 0,
      edge:         edgeDoc.edge         ?? 0,
      pVal:         edgeDoc.p_val        ?? 1,
      confidence:   edgeDoc.confidence   ?? 'watch',
      overallRank:  edgeDoc.overall_rank ?? null,
      roce30d:      edgeDoc.roce_30d     ?? 0,
      pnl30d:       edgeDoc.pnl_30d      ?? 0,
      pf:           edgeDoc.pf           ?? 1,
      daysWonRate:  edgeDoc.days_won_rate ?? null,
      sortino:      edgeDoc.sortino      ?? null,
      actPerDay:    edgeDoc.act_per_day  ?? null,
      lastActive:   edgeDoc.last_active  ?? null,
      insider:      edgeDoc.insider      ?? 'none',
      insiderScore: edgeDoc.insider_score ?? 0,
      spcWr:        edgeDoc.spc_wr       ?? null,
    } : null;

    const config = copyConfig ? {
      label:          (copyConfig as any).label,
      allocationUsdc: (copyConfig as any).allocationUsdc,
      spentUsdc:      (copyConfig as any).spentUsdc,
      active:         (copyConfig as any).active,
      avgBet:         (copyConfig as any).avgBet,
      maxBetUsdc:     (copyConfig as any).maxBetUsdc,
      allocAction:    (copyConfig as any).allocAction,
      allocReason:    (copyConfig as any).allocReason,
      allocFailureType: (copyConfig as any).allocFailureType,
      allocCheckedAt: (copyConfig as any).allocCheckedAt,
    } : null;

    const label = config?.label ?? (allocHistory[0] as any)?.label ?? wallet.slice(0, 8);

    return NextResponse.json({
      success: true,
      wallet,
      label,
      edgeProfile,
      config,
      allocHistory,
      markets,
      tradeCount: rawTrades.length,
    });
  } catch (error: any) {
    console.error('Error fetching trader detail:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
