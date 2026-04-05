import { ICopyTrader } from '../db/models/CopyTrader';
/**
 * MultiDetector — polls all active traders from ahf-copyTraders.
 *
 * Architecture:
 *   - Each trader runs its own async polling chain (setTimeout, not setInterval)
 *     → prevents overlapping polls for the same wallet
 *     → supports per-trader detectorIntervalMs override
 *
 *   - A watchdog timer checks every 60s for newly activated traders
 *     → add a trader to DB and it starts being copied within 60s, no restart
 *
 *   - Only TRADE(BUY) and TRADE(SELL) are forwarded to executor
 *     → REDEEM/MERGE/SPLIT are logged as NON_TRADE skips for visibility
 *
 * Per-trade event payload (DetectedTradeEvent):
 *   traderConfig      — full trader config (avgBet, allocation, etc.)
 *   detectedAt        — Date.now() when we saw this activity
 *   discoveryLatencyMs— detectedAt - activity.timestamp*1000
 *   ...activity fields
 */
export interface DetectedTradeEvent {
    traderConfig: ICopyTrader;
    detectedAt: number;
    discoveryLatencyMs: number;
    txHash: string;
    conditionId: string;
    tokenId: string;
    title: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    traderBetUsdc: number;
    traderPrice: number;
    traderSize: number;
    traderTs: number;
}
export declare class MultiDetector {
    private activeWallets;
    private watchdogTimer;
    private statusTimer;
    private stopped;
    private cycleHour;
    private cycleStart;
    private cycleTotal;
    private cycleTrades;
    private cycleByLabel;
    /**
     * Fetch with timeout + one retry on 408/5xx.
     * Logs full response body + key headers on any non-ok status for diagnosis.
     */
    private fetchActivity;
    start(): Promise<void>;
    stop(): void;
    private printCycleStatus;
    /** Reset cycle counters on the hour boundary */
    private checkHourReset;
    private startPollingChain;
    private pollTrader;
    /** Log REDEEM/MERGE/SPLIT as NON_TRADE skips for analysis */
    private logNonTrade;
    /** Check for newly activated traders and start their polling chains */
    private watchdog;
}
