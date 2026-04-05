import { ClobClient } from '@polymarket/clob-client';
export declare class GTTExecutor {
    private clobClient;
    private feeRateCache;
    private negRiskCache;
    private positionReserved;
    constructor(clobClient: ClobClient);
    private handleTrade;
    /**
     * Sums traderSize from all FILLED/EXECUTING BUY docs for a given trader+token.
     * Falls back to conditionId match if no tokenId results (trader bought other outcome).
     */
    /**
     * Returns our net USDC spent on a specific position (BUY fills minus SELL fills).
     * Used to enforce the 20% per-position cap.
     */
    private getPositionSpent;
    private getTraderTotalBoughtShares;
    /**
     * Place a single GTD maker order and emit 'trade:submitted'.
     * Confirmer picks it up and waits for the WebSocket fill push.
     */
    private placeOrder;
    /**
     * Called by Confirmer when a GTD order expires without filling.
     * Places a new order with fresh orderbook price, up to maxOrderRetries.
     */
    private handleOrderExpired;
    private markFailed;
    private skip;
    /**
     * Returns the negRisk flag for a market, using a disk-persisted cache keyed by conditionId.
     * Keyed by conditionId (not tokenId) so all outcome tokens of the same market share one entry —
     * a 3-outcome negRisk market fetches metadata once, not 3 times.
     *
     * On cache miss: fetches GET /markets/<conditionId> and persists to disk.
     * On API failure for an unknown market: throws so the order is skipped with a visible error.
     * Defaulting to false would sign against the wrong exchange for negRisk markets — a reverted
     * on-chain tx with no obvious log trail. A skipped order is always preferable.
     */
    private getNegRiskCached;
    private sleep;
}
