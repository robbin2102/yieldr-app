/**
 * Reconciler - Compares positions every 60 seconds
 *
 * Flow:
 * 1. Fetch trader's positions from Polymarket /positions API
 * 2. Fetch our positions from /positions API
 * 3. For each trader position:
 *    - Calculate expected size (trader size × copyRatio)
 *    - Compare to actual size
 * 4. If gap > 5% and > 1 share: log to MongoDB
 *
 * Note: v1 only LOGS gaps, does not auto-fix them
 */
export declare class Reconciler {
    private intervalId;
    start(): void;
    stop(): void;
    reconcile(): Promise<void>;
}
