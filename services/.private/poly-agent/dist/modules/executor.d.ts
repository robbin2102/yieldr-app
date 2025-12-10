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
 *
 * Note: NO RETRY LOGIC in Phase 1 testing
 * - If no orderbook data, trade is skipped permanently
 * - OrderbookCache subscribes for future trades on same token
 * - Retry logic will be added in Phase 2 after testing
 */
export declare class Executor {
    private clobClient;
    constructor(clobClient: ClobClient);
    initialize(): Promise<void>;
    private handleTrade;
    private skipTrade;
    /**
     * Execute trade after deduplication check
     */
    private handleTradeExecution;
}
