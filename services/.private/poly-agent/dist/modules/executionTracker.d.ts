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
export declare class ExecutionTracker {
    private reportIntervalMs;
    private timer;
    constructor(reportIntervalMs?: number);
    start(): void;
    stop(): void;
    printAllReports(windowHours?: number): Promise<void>;
    printTraderReport(wallet: string, since: Date): Promise<void>;
}
/**
 * Standalone function for one-off report from a script or repl.
 */
export declare function printExecutionReport(walletFilter?: string, windowHours?: number): Promise<void>;
