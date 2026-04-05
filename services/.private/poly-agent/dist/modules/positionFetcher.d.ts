/**
 * PositionFetcher — fetches the BOT's own open positions.
 *
 * Used only by the SELL guard in gttExecutor to verify we actually hold
 * a position before copying a SELL order.
 *
 * Trader open position fetching (for ratio computation) is handled by
 * RatioScheduler which runs at startup and midnight — not per-trade.
 */
export declare class PositionFetcher {
    getOurShares(tokenId: string): Promise<number>;
}
export declare const positionFetcher: PositionFetcher;
