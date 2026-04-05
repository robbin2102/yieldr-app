"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionTracker = void 0;
exports.printExecutionReport = printExecutionReport;
const CopyTrade_1 = require("../db/models/CopyTrade");
const CopyTrader_1 = require("../db/models/CopyTrader");
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
class ExecutionTracker {
    constructor(reportIntervalMs = 3600000) {
        this.timer = null;
        this.reportIntervalMs = reportIntervalMs;
    }
    start() {
        this.timer = setInterval(() => this.printAllReports(), this.reportIntervalMs);
        console.log(`[ExecutionTracker] Reporting every ${this.reportIntervalMs / 60000}m`);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async printAllReports(windowHours = 24) {
        const traders = (await CopyTrader_1.CopyTrader.find({}).lean());
        if (traders.length === 0)
            return;
        const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
        const ts = new Date().toISOString().slice(11, 16);
        console.log(`\n[${ts}] ── HOURLY REPORT (last ${windowHours}h) ─────────────────────────────`);
        for (const trader of traders) {
            await this.printTraderReport(trader.wallet, since);
        }
        console.log('─'.repeat(60));
    }
    async printTraderReport(wallet, since) {
        const trader = (await CopyTrader_1.CopyTrader.findOne({ wallet }).lean());
        if (!trader)
            return;
        const trades = (await CopyTrade_1.CopyTrade.find({
            sourceWallet: wallet,
            createdAt: { $gte: since },
        }).lean());
        const detected = trades.length;
        const skipped = trades.filter(t => t.status === 'SKIPPED');
        const filled = trades.filter(t => t.status === 'FILLED' || t.status === 'PARTIAL');
        const failed = trades.filter(t => t.status === 'FAILED');
        const totalFillUsdc = filled.reduce((s, t) => s + (t.filledUsdc ?? 0), 0);
        const remaining = trader.allocationUsdc - trader.spentUsdc;
        const fillRate = detected > 0 ? ((filled.length / detected) * 100).toFixed(0) + '%' : '—';
        const skipReasons = skipped.reduce((acc, t) => {
            const r = t.skipReason ?? 'UNKNOWN';
            acc[r] = (acc[r] ?? 0) + 1;
            return acc;
        }, {});
        const skipDetail = Object.entries(skipReasons).map(([k, v]) => `${k}:${v}`).join(' ');
        // One compact line per trader
        console.log(`  ${trader.label.padEnd(20)} ` +
            `det:${detected} skip:${skipped.length}(${skipDetail}) ` +
            `fill:${filled.length} fail:${failed.length} rate:${fillRate} ` +
            `$${totalFillUsdc.toFixed(2)} filled | $${remaining.toFixed(2)} left`);
    }
}
exports.ExecutionTracker = ExecutionTracker;
/**
 * Standalone function for one-off report from a script or repl.
 */
async function printExecutionReport(walletFilter, windowHours = 24) {
    const tracker = new ExecutionTracker();
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const div = '─'.repeat(60);
    if (walletFilter) {
        await tracker.printTraderReport(walletFilter.toLowerCase(), since);
    }
    else {
        await tracker.printAllReports(windowHours);
    }
}
//# sourceMappingURL=executionTracker.js.map