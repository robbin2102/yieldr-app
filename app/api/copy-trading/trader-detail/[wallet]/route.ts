import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const DATA_API   = process.env.POLYMARKET_DATA_API ?? 'https://data-api.polymarket.com';
const BOT_WALLET = (process.env.BOT_WALLET_ADDRESS ?? '').toLowerCase();

function normalTitle(t: string): string {
  return (t ?? '').toLowerCase().trim().replace(/[?!.\s]+$/, '').replace(/\s+/g, ' ');
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ wallet: string }> },
) {
  try {
    const { wallet: rawWallet } = await params;
    const wallet = rawWallet.toLowerCase();
    const client = await clientPromise;
    const db = client.db(dbName);

    // Parallel fetch: mongo data + trader's live positions + bot's live positions from Polymarket API
    const [edgeDoc, copyConfig, allocHistory, rawTrades, traderPosRaw, botPosRaw] = await Promise.all([
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
      fetch(`${DATA_API}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`)
        .then(r => r.json()).catch(() => []),
      BOT_WALLET
        ? fetch(`${DATA_API}/positions?user=${BOT_WALLET}&sizeThreshold=0.01&limit=500`)
            .then(r => r.json()).catch(() => [])
        : Promise.resolve([]),
    ]);

    if (!copyConfig && rawTrades.length === 0) {
      return NextResponse.json({ success: false, error: 'Trader not found' }, { status: 404 });
    }

    // Trader's real on-chain positions → traderStillIn set (normalTitle+outcome)
    const traderPositions: any[] = Array.isArray(traderPosRaw) ? traderPosRaw : (traderPosRaw?.data ?? []);
    const traderHoldSet = new Set<string>();
    for (const p of traderPositions) {
      const cv = parseFloat(p.currentValue ?? '0');
      if (cv > 0.01) {
        traderHoldSet.add(`${normalTitle(p.title ?? '')}:${(p.outcome ?? '').toLowerCase()}`);
      }
    }

    // Bot live price map: normalTitle+outcome → curPrice (source of truth for open positions)
    const botPositions: any[] = Array.isArray(botPosRaw) ? botPosRaw : (botPosRaw?.data ?? []);
    const botPriceMap = new Map<string, number>();
    for (const p of botPositions) {
      const cp = parseFloat(p.curPrice ?? p.currentPrice ?? '0');
      if (cp > 0) {
        botPriceMap.set(`${normalTitle(p.title ?? '')}:${(p.outcome ?? '').toLowerCase()}`, cp);
      }
    }

    // Group trades by market (title+outcome)
    interface MarketGroup {
      conditionId: string | null;
      title: string;
      outcome: string;
      tBought: number;
      tSold: number;
      tEntrySum: number;
      tBuyCount: number;
      bFilledUsdc: number;
      bFilledSize: number;
      bEntrySum: number;
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
        m.bFilledUsdc += t.filledUsdc  ?? 0;
        m.bFilledSize += t.filledSize  ?? 0;
        m.bEntrySum   += (t.avgFillPrice ?? 0) * (t.filledUsdc ?? 0);
      }

      if (t.status === 'SKIPPED' && t.skipReason) {
        m.skipCounts[t.skipReason] = (m.skipCounts[t.skipReason] ?? 0) + 1;
      }
    }

    // Build final market list
    const markets = [...marketMap.values()].map(m => {
      const tEntry = m.tBuyCount > 0 && m.tBought > 0
        ? m.tEntrySum / m.tBought : null;
      const bEntry = m.bFilledUsdc > 0
        ? m.bEntrySum / m.bFilledUsdc : null;

      // curPrice: bot's live positions first (accurate); fall back to trader's live positions
      const normKey    = `${normalTitle(m.title)}:${m.outcome.toLowerCase()}`;
      const curPrice   = botPriceMap.get(normKey) ?? null;

      // traderStillIn: trader's actual wallet still holds this position (on-chain data)
      const traderStillIn = traderHoldSet.has(normKey);

      // Bot PnL: (curPrice - bEntry) × bFilledSize
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
      label:            (copyConfig as any).label,
      allocationUsdc:   (copyConfig as any).allocationUsdc,
      spentUsdc:        (copyConfig as any).spentUsdc,
      active:           (copyConfig as any).active,
      avgBet:           (copyConfig as any).avgBet,
      maxBetUsdc:       (copyConfig as any).maxBetUsdc,
      allocAction:      (copyConfig as any).allocAction,
      allocReason:      (copyConfig as any).allocReason,
      allocFailureType: (copyConfig as any).allocFailureType,
      allocCheckedAt:   (copyConfig as any).allocCheckedAt,
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
