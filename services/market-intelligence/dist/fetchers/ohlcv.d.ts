export interface OhlcvData {
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    daily_high: number | null;
    daily_low: number | null;
    daily_close: number | null;
}
/**
 * Fetch and store 15m OHLCV candles for all tracked coins.
 * Called by the cron scheduler at :03, :18, :33, :48.
 */
export declare function fetchAndStoreOhlcv(coins: string[]): Promise<void>;
/**
 * Read the latest 15m candle for a symbol from ohlcv_15m.
 * Also queries the last 96 candles (24h) to derive daily high/low for pivot fallback.
 * Called by the snapshot builder during Phase 4.
 */
export declare function getLatestOhlcv(symbol: string): Promise<OhlcvData>;
