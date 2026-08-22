import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongoose';
import { EdgeScore } from '@/models/EdgeScore';
import { EdgeReasoningLog } from '@/models/EdgeReasoningLog';
import { analyzeWallet } from '@/lib/edge/analyze';
import { generateEdgeReasoning } from '@/lib/edge/reasoningAgent';
import { EDGE_REASONING_INTERVAL_HOURS } from '@/lib/edge/config';

/**
 * Periodic "does this trader still have an edge" run.
 *
 * Triggered by Vercel Cron on a fixed, frequent schedule (see vercel.json) -
 * but the ACTUAL cadence per wallet is gated here by
 * EDGE_REASONING_INTERVAL_HOURS (env-configurable), the same pattern used
 * by api/cron/check-traders.ts. This lets ops tune the reasoning cadence
 * without touching the cron schedule or redeploying.
 *
 * For each wallet whose last reasoning run is older than the interval (or
 * has never run): re-analyze fresh, ask the OpenAI reasoning agent for a
 * <=300-word verdict, and log it to EdgeReasoningLog for the UI to render.
 */
export const maxDuration = 300;

const CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  await connectDB();

  const cutoff = new Date(Date.now() - EDGE_REASONING_INTERVAL_HOURS * 60 * 60 * 1000);
  const dueWallets = await EdgeScore.find(
    { $or: [{ lastReasoningAt: null }, { lastReasoningAt: { $lt: cutoff } }] },
    { wallet: 1 }
  ).lean();

  if (dueWallets.length === 0) {
    return NextResponse.json({ message: 'No wallets due for reasoning', processed: 0 });
  }

  console.log(`[edge:cron:reason] ${dueWallets.length} wallet(s) due (interval=${EDGE_REASONING_INTERVAL_HOURS}h)`);

  const results = await mapWithConcurrency(dueWallets, CONCURRENCY, async (w: any) => {
    const wallet = w.wallet as string;
    try {
      const report = await analyzeWallet(wallet);
      const { verdict, reasoning } = await generateEdgeReasoning(report);

      await EdgeReasoningLog.create({
        wallet,
        edgeScore: report.edgeScore,
        verdict,
        reasoning,
        edgeDecayStatus: report.edgeDecay.status,
        reportComputedAt: report.computedAt,
      });
      await EdgeScore.updateOne({ wallet }, { $set: { lastReasoningAt: new Date() } });

      console.log(`[edge:cron:reason] ${wallet} verdict=${verdict} edgeScore=${report.edgeScore}`);
      return { wallet, verdict, edgeScore: report.edgeScore, ok: true };
    } catch (err: any) {
      console.error(`[edge:cron:reason] ${wallet} failed:`, err?.message ?? err);
      return { wallet, ok: false, error: err?.message ?? 'unknown error' };
    }
  });

  return NextResponse.json({
    processed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
