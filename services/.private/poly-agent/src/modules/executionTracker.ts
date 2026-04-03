import { CopyTrade, ICopyTrade } from '../db/models/CopyTrade';
import { CopyTrader, ICopyTrader } from '../db/models/CopyTrader';

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

  constructor(reportIntervalMs = 3_600_000) {  // default: print every 1 hour
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
    const traders = (await CopyTrader.find({}).lean()) as unknown as ICopyTrader[];
    if (traders.length === 0) return;

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const ts = new Date().toISOString().slice(11, 16);

    console.log(`\n[${ts}] ── HOURLY REPORT (last ${windowHours}h) ─────────────────────────────`);
    for (const trader of traders) {
      await this.printTraderReport(trader.wallet, since);
    }
    console.log('─'.repeat(60));
  }

  async printTraderReport(wallet: string, since: Date): Promise<void> {
    const trader = (await CopyTrader.findOne({ wallet }).lean()) as unknown as ICopyTrader | null;
    if (!trader) return;

    const trades = (await CopyTrade.find({
      sourceWallet: wallet,
      createdAt: { $gte: since },
    }).lean()) as unknown as ICopyTrade[];

    const detected  = trades.length;
    const skipped   = trades.filter(t => t.status === 'SKIPPED');
    const filled    = trades.filter(t => t.status === 'FILLED' || t.status === 'PARTIAL');
    const failed    = trades.filter(t => t.status === 'FAILED');

    const totalFillUsdc = filled.reduce((s, t) => s + (t.filledUsdc ?? 0), 0);
    const remaining     = trader.allocationUsdc - trader.spentUsdc;
    const fillRate      = detected > 0 ? ((filled.length / detected) * 100).toFixed(0) + '%' : '—';
    const skipReasons   = skipped.reduce((acc, t) => {
      const r = t.skipReason ?? 'UNKNOWN';
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const skipDetail = Object.entries(skipReasons).map(([k, v]) => `${k}:${v}`).join(' ');

    // One compact line per trader
    console.log(
      `  ${trader.label.padEnd(20)} ` +
      `det:${detected} skip:${skipped.length}(${skipDetail}) ` +
      `fill:${filled.length} fail:${failed.length} rate:${fillRate} ` +
      `$${totalFillUsdc.toFixed(2)} filled | $${remaining.toFixed(2)} left`
    );
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
