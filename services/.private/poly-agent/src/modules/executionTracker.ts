import { CopyTrade } from '../db/models/CopyTrade';
import { CopyTrader } from '../db/models/CopyTrader';

/**
 * ExecutionTracker — per-trader execution efficiency reports.
 *
 * Aggregates from ahf-copyTrades for a configurable lookback window.
 * Surfaces:
 *   - Detection and execution latency breakdown
 *   - Fill rate and price drift vs trader
 *   - Skip reason breakdown (BELOW_AVG, ALLOCATION_FULL, etc.)
 *   - Allocation remaining
 *
 * Can be called:
 *   - On demand via executionTracker.printReport()
 *   - On a scheduled interval (wired in index.ts)
 *   - Via a standalone script for post-run analysis
 */
export class ExecutionTracker {
  private reportIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(reportIntervalMs = 300_000) {  // default: print every 5 minutes
    this.reportIntervalMs = reportIntervalMs;
  }

  start(): void {
    this.timer = setInterval(() => this.printAllReports(), this.reportIntervalMs);
    console.log(`[ExecutionTracker] Reporting every ${this.reportIntervalMs / 60000}m`);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async printAllReports(windowHours = 24): Promise<void> {
    const traders = await CopyTrader.find({}).lean();
    if (traders.length === 0) return;

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const div = '─'.repeat(60);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  EXECUTION REPORT — last ${windowHours}h  (${new Date().toISOString().slice(0, 16)})`);
    console.log('═'.repeat(60));

    for (const trader of traders) {
      await this.printTraderReport(trader.wallet, since, div);
    }
  }

  async printTraderReport(wallet: string, since: Date, div: string): Promise<void> {
    const trader = await CopyTrader.findOne({ wallet }).lean();
    if (!trader) return;

    const trades = await CopyTrade.find({
      sourceWallet: wallet,
      createdAt: { $gte: since },
    }).lean();

    const detected  = trades.length;
    const skipped   = trades.filter(t => t.status === 'SKIPPED');
    const filled    = trades.filter(t => t.status === 'FILLED' || t.status === 'PARTIAL');
    const failed    = trades.filter(t => t.status === 'FAILED');
    const executing = trades.filter(t => t.status === 'EXECUTING');

    // Skip reason breakdown
    const skipReasons: Record<string, number> = {};
    for (const t of skipped) {
      const r = t.skipReason ?? 'UNKNOWN';
      skipReasons[r] = (skipReasons[r] ?? 0) + 1;
    }

    // Latency stats (only for filled trades with all timestamps)
    const withDiscovery = trades.filter(t => t.discoveryLatencyMs != null);
    const withSubmit    = filled.filter(t => t.submissionLatencyMs != null);
    const withFill      = filled.filter(t => t.fillLatencyMs != null);
    const withTotal     = filled.filter(t => t.totalLatencyMs != null);

    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const fmt = (n: number | null, unit: string) => n != null ? `${n.toFixed(0)}${unit}` : '—';

    const avgDiscovery   = avg(withDiscovery.map(t => t.discoveryLatencyMs!));
    const avgSubmit      = avg(withSubmit.map(t => t.submissionLatencyMs!));
    const avgFill        = avg(withFill.map(t => t.fillLatencyMs!));
    const avgTotal       = avg(withTotal.map(t => t.totalLatencyMs!));
    const avgDrift       = avg(filled.filter(t => t.priceDrift != null).map(t => t.priceDrift!));
    const avgAttempts    = avg(filled.filter(t => t.attempts != null).map(t => t.attempts!));
    const totalFillUsdc  = filled.reduce((s, t) => s + (t.filledUsdc ?? 0), 0);

    const remaining = trader.allocationUsdc - trader.spentUsdc;
    const fillRate  = detected > 0 ? ((filled.length / detected) * 100).toFixed(0) : '—';

    console.log(`\n  ${trader.label}  (${wallet.slice(0, 10)}...)`);
    console.log(`  ROCE: ${trader.roce}%  |  ${trader.strategyLabel}  |  avg bet: $${trader.avgBet}`);
    console.log(div);
    console.log(`  Detected    : ${detected}`);
    console.log(`  Skipped     : ${skipped.length}${skipped.length > 0 ? '  (' + Object.entries(skipReasons).map(([k, v]) => `${k}:${v}`).join(', ') + ')' : ''}`);
    console.log(`  Executing   : ${executing.length}`);
    console.log(`  Filled      : ${filled.length}  |  Failed: ${failed.length}  |  Fill rate: ${fillRate}%`);
    console.log(div);
    console.log(`  Discovery latency   : ${fmt(avgDiscovery, 'ms')}  (poll gap + API)`);
    console.log(`  Submission latency  : ${fmt(avgSubmit, 'ms')}`);
    console.log(`  Fill latency        : ${fmt(avgFill, 'ms')}`);
    console.log(`  Total latency       : ${fmt(avgTotal, 'ms')}  (trader tx → our fill)`);
    console.log(div);
    console.log(`  Price drift         : ${avgDrift != null ? (avgDrift >= 0 ? '+' : '') + avgDrift.toFixed(2) + '%' : '—'}  (positive = we paid more)`);
    console.log(`  Avg GTT attempts    : ${avgAttempts != null ? avgAttempts.toFixed(1) : '—'}`);
    console.log(div);
    console.log(`  USDC filled         : $${totalFillUsdc.toFixed(2)}`);
    console.log(`  Allocation used     : $${trader.spentUsdc.toFixed(2)} / $${trader.allocationUsdc}  ($${remaining.toFixed(2)} remaining)`);
    console.log(`  Active              : ${trader.active ? 'YES' : 'PAUSED'}`);
  }
}

/**
 * Standalone function for one-off report from a script or repl.
 */
export async function printExecutionReport(walletFilter?: string, windowHours = 24): Promise<void> {
  const tracker = new ExecutionTracker();
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const div = '─'.repeat(60);

  if (walletFilter) {
    await tracker.printTraderReport(walletFilter.toLowerCase(), since, div);
  } else {
    await tracker.printAllReports(windowHours);
  }
}
