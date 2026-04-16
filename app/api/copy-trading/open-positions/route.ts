import { NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const DATA_API   = process.env.POLYMARKET_DATA_API ?? 'https://data-api.polymarket.com';
const BOT_WALLET = (process.env.BOT_WALLET_ADDRESS ?? '').toLowerCase();

function normalTitle(t: string): string {
  return (t ?? '').toLowerCase().trim().replace(/[?!.\s]+$/, '').replace(/\s+/g, ' ');
}

export async function GET() {
  try {
    if (!BOT_WALLET) {
      return NextResponse.json({ success: false, error: 'BOT_WALLET_ADDRESS not configured' }, { status: 500 });
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Fetch bot's actual on-chain positions from Polymarket data API
    const posRes = await fetch(
      `${DATA_API}/positions?user=${BOT_WALLET}&sizeThreshold=0.01&limit=500`,
    );
    const posRaw = await posRes.json() as any;
    const rawAll: any[] = Array.isArray(posRaw) ? posRaw : (posRaw.data ?? []);

    // Keep positions with value > $1 and price > 0 (includes resolved at $1.00)
    const openRaw = rawAll.filter((p: any) => {
      const size     = parseFloat(p.size         ?? '0');
      const curPrice = parseFloat(p.curPrice     ?? p.currentPrice ?? '0');
      const curVal   = parseFloat(p.currentValue ?? String(size * curPrice));
      return curVal > 1 && curPrice > 0;
    });

    // Parallel: all detected trades (for traderHolding calc) + filled buys (for label) + meta
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [allTrades, allocEvents, copyTraders, trades24h] = await Promise.all([
      db.collection('ahf-copyTrades')
        .find({}, { projection: { title: 1, outcome: 1, side: 1, traderBetUsdc: 1, traderLabel: 1, sourceWallet: 1, skipReason: 1 } })
        .toArray(),
      db.collection('ahf-allocationEvents').aggregate([
        { $sort: { runAt: -1 } },
        { $group: { _id: '$wallet', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ]).toArray(),
      db.collection('ahf-copyTraders').find({}).toArray(),
      db.collection('ahf-copyTrades').countDocuments({ status: 'FILLED', createdAt: { $gte: since24h } }),
    ]);

    // Compute traderHolding from trade history: tBought > tSold means trader still in
    // (more reliable than pipeline polymarket-openPositions which only covers leaderboard wallets)
    const holdMap = new Map<string, { tBought: number; tSold: number; traderLabel: string }>();
    for (const t of allTrades as any[]) {
      if (t.skipReason === 'NON_TRADE') continue;
      const key = `${normalTitle(t.title ?? '')}:${(t.outcome ?? '').toLowerCase()}`;
      if (!holdMap.has(key)) {
        holdMap.set(key, {
          tBought: 0, tSold: 0,
          traderLabel: t.traderLabel ?? (t.sourceWallet as string)?.slice(0, 8) ?? '—',
        });
      }
      const h = holdMap.get(key)!;
      if (t.side === 'BUY')  h.tBought += t.traderBetUsdc ?? 0;
      if (t.side === 'SELL') h.tSold   += t.traderBetUsdc ?? 0;
      if (!h.traderLabel && t.traderLabel) h.traderLabel = t.traderLabel;
    }

    // Build position list
    const positions = openRaw.map((p: any) => {
      const size         = parseFloat(p.size         ?? '0');
      const curPrice     = parseFloat(p.curPrice     ?? p.currentPrice ?? '0');
      const avgPrice     = parseFloat(p.avgPrice     ?? p.averagePrice ?? '0');
      const currentValue = parseFloat(p.currentValue ?? String(size * curPrice));
      const initialValue = parseFloat(p.initialValue ?? String(size * avgPrice));
      const cashPnl      = parseFloat(p.cashPnl      ?? String(currentValue - initialValue));

      const key          = `${normalTitle(p.title ?? '')}:${(p.outcome ?? '').toLowerCase()}`;
      const hold         = holdMap.get(key);
      const traderLabel  = hold?.traderLabel ?? '—';
      // Trader still holding if they bought meaningfully more than they sold
      const traderHolding = hold ? hold.tBought > hold.tSold * 1.05 : false;

      return {
        title:           p.title ?? 'Unknown',
        outcome:         p.outcome ?? '—',
        traderLabel,
        traderHolding,
        avgFillPrice:    avgPrice,
        totalFilledUsdc: initialValue,
        totalFilledSize: size,
        curPrice,
        currentValue,
        estimatedPnl:    cashPnl,
      };
    }).sort((a: any, b: any) => b.estimatedPnl - a.estimatedPnl);

    // Portfolio summary
    const openCount     = positions.length;
    const openValue     = positions.reduce((s: number, p: any) => s + p.currentValue, 0);
    const unrealizedPnl = positions.reduce((s: number, p: any) => s + p.estimatedPnl, 0);

    const totalAlloc  = (copyTraders as any[]).reduce((s: number, t: any) => s + (t.allocationUsdc ?? 0), 0);
    const totalBotPnl = (allocEvents as any[]).reduce((s: number, e: any) => s + (e.bPnl ?? 0), 0);
    const botROCE     = totalAlloc > 0 ? (totalBotPnl / totalAlloc) * 100 : null;

    return NextResponse.json({
      success: true,
      positions,
      summary: { openCount, openValue, unrealizedPnl, totalBotPnl, botROCE, trades24h },
    });
  } catch (error: any) {
    console.error('Error fetching open positions:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
