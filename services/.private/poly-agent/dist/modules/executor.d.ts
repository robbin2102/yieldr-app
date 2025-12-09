import { ClobClient } from '@polymarket/clob-client';
/**
 * Executor - Executes copy trades with FOK orders
 *
 * Flow:
 * 1. Receive 'trade:detected' event from Detector
 * 2. Try to insert to MongoDB (unique index handles dedup)
 * 3. Run in-memory risk checks (<5ms)
 * 4. Build and submit FOK order to CLOB
 * 5. Emit 'trade:submitted' for Confirmer to track
 *
 * Risk checks (all in-memory, no blocking):
 * - Calculate copy size (trader size × copyRatio)
 * - Check minimum size threshold
 * - Get best price from orderbook cache
 * - Cap at max position size
 */
export declare class Executor {
    private clobClient;
    constructor(clobClient: ClobClient);
    initialize(): Promise<void>;
    private handleTrade;
    private skipTrade;
    /**
     * Retry SKIPPED trades when orderbook data becomes available
     */
    private retrySkippedTrades;
    /**
     * Execute trade after deduplication check
     * Separated from handleTrade so it can be called for retries
     */
    private handleTradeExecution;
}
