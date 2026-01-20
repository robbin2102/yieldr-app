/**
 * Detector - Monitors target wallet for new trades
 *
 * - Polls Polymarket /activity API every 3 seconds
 * - Always starts from NOW (no historical backfill - can't execute at old prices)
 * - Only executes real-time trades detected during polling
 * - Deduplication handled by MongoDB unique index on txHash
 */
export declare class Detector {
    private lastSeenTimestamp;
    private intervalId;
    private isPolling;
    private pollCount;
    private lastPollTime;
    constructor();
    start(): Promise<void>;
    stop(): void;
    private poll;
}
