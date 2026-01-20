import { NextRequest, NextResponse } from 'next/server';
import clientPromise, { dbName } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for cron

const API_BASE = 'https://data-api.polymarket.com';

interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  endDate?: string;
  redeemable?: boolean;
}

async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const LIMIT = 500;
  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= 10000) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetch(url);
    if (!response.ok) break;

    const batch = await response.json();
    if (batch.length === 0) break;

    allPositions = allPositions.concat(batch);
    if (batch.length < LIMIT) break;
    offset += LIMIT;

    await new Promise(r => setTimeout(r, 100)); // Rate limit
  }

  return allPositions;
}

// POST - Refresh all tracked trader positions (call from cron or manual)
export async function POST(request: NextRequest) {
  try {
    // Verify cron secret only in production with strict mode
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isDev = process.env.NODE_ENV === 'development';

    // Allow unauthenticated in dev mode, or if no secret is set
    if (cronSecret && !isDev && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const client = await clientPromise;
    const db = client.db(dbName);

    // Get all active tracked traders
    const traders = await db.collection('polymarket-trackedTraders')
      .find({ isActive: true })
      .toArray();

    console.log(`[Cron] Refreshing positions for ${traders.length} traders...`);

    let totalPositions = 0;
    const results: { wallet: string; label: string; count: number }[] = [];

    for (const trader of traders) {
      try {
        const positions = await fetchOpenPositions(trader.wallet);

        // Filter to active positions only (exclude resolved: <0.1¢ losses and >99¢ wins)
        const activePositions = positions.filter(p =>
          p.curPrice >= 0.001 && p.curPrice <= 0.99
        );

        if (activePositions.length > 0) {
          // Prepare bulk operations
          const operations = activePositions.map(pos => ({
            updateOne: {
              filter: {
                walletAddress: trader.wallet.toLowerCase(),
                conditionId: pos.conditionId,
                asset: pos.asset,
              },
              update: {
                $set: {
                  walletAddress: trader.wallet.toLowerCase(),
                  conditionId: pos.conditionId,
                  asset: pos.asset,
                  title: pos.title,
                  slug: pos.slug,
                  outcome: pos.outcome,
                  outcomeIndex: pos.outcomeIndex,
                  size: pos.size,
                  avgPrice: pos.avgPrice,
                  curPrice: pos.curPrice,
                  initialValue: pos.initialValue,
                  currentValue: pos.currentValue,
                  cashPnl: pos.cashPnl,
                  percentPnl: pos.percentPnl,
                  roi: pos.initialValue > 0 ? (pos.cashPnl / pos.initialValue) * 100 : 0,
                  endDate: pos.endDate ? new Date(pos.endDate) : undefined,
                  redeemable: pos.redeemable || false,
                  fetchedAt: new Date(),
                  updatedAt: new Date(),
                },
                $setOnInsert: {
                  createdAt: new Date(),
                },
              },
              upsert: true,
            },
          }));

          await db.collection('polymarket-openPositions').bulkWrite(operations);

          // Also delete stale positions (not in current fetch)
          const currentConditionIds = activePositions.map(p => `${p.conditionId}-${p.asset}`);
          await db.collection('polymarket-openPositions').deleteMany({
            walletAddress: trader.wallet.toLowerCase(),
            $expr: {
              $not: {
                $in: [{ $concat: ['$conditionId', '-', '$asset'] }, currentConditionIds]
              }
            }
          });
        }

        totalPositions += activePositions.length;
        results.push({
          wallet: trader.wallet,
          label: trader.label,
          count: activePositions.length,
        });

        console.log(`  ${trader.label}: ${activePositions.length} positions`);
      } catch (err: any) {
        console.error(`  ${trader.label}: Error - ${err.message}`);
        results.push({
          wallet: trader.wallet,
          label: trader.label,
          count: -1, // Error indicator
        });
      }

      // Rate limit between traders
      await new Promise(r => setTimeout(r, 200));
    }

    return NextResponse.json({
      success: true,
      message: `Refreshed ${totalPositions} positions for ${traders.length} traders`,
      results,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error('[Cron] Error refreshing positions:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET - Manual trigger (for testing)
export async function GET(request: NextRequest) {
  return POST(request);
}
