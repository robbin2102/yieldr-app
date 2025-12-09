/**
 * Detector - Monitors target wallet for new trades
 *
 * - Polls Polymarket /activity API every 3 seconds
 * - Resumes from last seen trade in MongoDB
 * - Emits 'trade:detected' event for each new trade
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
