import { ClobClient } from '@polymarket/clob-client';
/**
 * Executor - Executes copy trades with FOK orders
 *
 * CRITICAL FINANCIAL SYSTEM BEHAVIOR:
 * - NEVER skip trades - every trade the target wallet makes is copied
 * - If orderbook not cached: fetch synchronously via REST API (~100-200ms latency)
 * - Only fail if REST API fetch fails after retries (extremely rare)
 *
 * Flow:
 * 1. Receive 'trade:detected' event from Detector
 * 2. Try to insert to MongoDB (unique index handles dedup)
 * 3. Calculate copy size (trader size × copyRatio, fractional shares allowed)
 * 4. Get best price from orderbook (fetch if not cached)
 * 5. Cap at max position size if needed
 * 6. Build and submit FOK order to CLOB
 * 7. Emit 'trade:submitted' for Confirmer to track fills
 *
 * Position Sizing:
 * - Copy ALL trades regardless of size (even 0.5 shares → 0.005 shares at 1%)
 * - Trader may place 100 small orders that add up - we copy all of them
 * - Only limit is MAX_POSITION_USDC per trade
 */
export declare class Executor {
    private clobClient;
    constructor(clobClient: ClobClient);
    initialize(): Promise<void>;
    private handleTrade;
    private skipTrade;
    /**
     * Execute trade after deduplication check
     *
     * CRITICAL: We NEVER skip trades in a financial system.
     * All trades are copied at the configured ratio, regardless of size.
     */
    private handleTradeExecution;
    /**
     * Get our position size for a specific token
     * Fetches from /positions API and returns shares owned (0 if no position)
     */
    private getOurPosition;
}
